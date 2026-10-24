# ruff: noqa: F811
"""Workflow boundaries use the existing scripted model and isolated repositories."""

import asyncio
import importlib
from copy import deepcopy

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import Session

from backend import research_repo, research_sandbox, research_stages
from backend import research_worker as worker
from backend import research_workflows as workflows
from backend.agent_tools import execute
from backend.agent_worker import research_tools
from backend.models import (
    AgentRun,
    Base,
    ResearchProject,
    ResearchSprint,
    ResearchWorkflow,
    ResearchWorkspace,
)
from backend.tests.test_research_worker import (  # noqa: F401
    cloud_env,
    env,
    lab,
    planned,
    sprints,
)

BASE = "/api/v1/research/workflows"


@pytest.mark.parametrize("source", ["library", "active", "saved", "project"])
def test_workflow_deduplication_on_stored_reads(source):
    """Read old JSON through the real adapters, without a runner or repository."""
    from backend import team_rules, team_workflows

    flow = team_rules.builtin_workflows()["research"]
    routing = team_rules.initial_state(flow)["linear"].pop(team_workflows.key(flow))
    if source == "library":
        flow.update(id="stored", builtin=False)
    wk = team_workflows.key(flow)
    original = next(r for r in flow["rules"] if r["id"] == "research:approved-start")
    edited = {
        **deepcopy(original),
        "id": "research:0:approved",
        "enabled": False,
        "limit": {"per_thread": 7},
        "position": {"x": 10, "y": 20},
    }
    flow["rules"].append(edited)
    routing[original["id"]] = {"from": "start", "to": "step:1"}
    routing[edited["id"]] = {"from": "confirm:0", "to": "step:1"}
    initial = {"linear": {wk: routing}}
    execution = {"steps": [{"name": "Owner's step", "outputs": ["evidence.md"]}]}
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as d:
            if source == "library":
                row = ResearchWorkflow(
                    id=flow["id"],
                    owner="owner",
                    name=flow["name"],
                    version=1,
                    definition={
                        **flow,
                        "initial_state": initial,
                        "execution": execution,
                    },
                )
            elif source == "project":
                row = ResearchProject(
                    owner="owner",
                    question="Question",
                    model_config_id="unused",
                    session_id="unused",
                    workflow=flow,
                    workflow_state={"rule_state": initial, "execution": execution},
                )
            else:
                row = ResearchWorkspace(
                    owner="owner",
                    name="Team",
                    workflow=flow
                    if source == "active"
                    else {**flow, "id": "other", "rules": []},
                    workflow_state={**initial, "definitions": {flow["id"]: flow}},
                )
            d.add(row)
            d.commit()

            def read():
                if source == "project":
                    workflows.adopt_project(d, row)
                    return row.workflow
                return team_workflows.definition(
                    d,
                    "owner",
                    flow["id"],
                    workspace=row if source != "library" else None,
                )

            for _ in range(2):
                result = read()
                matches = [
                    r
                    for r in result["rules"]
                    if r["when"] == original["when"] and r["then"] == original["then"]
                ]
                assert matches == [edited]
                d.commit()
                d.refresh(row)
            stored_state = (
                row.definition["initial_state"]
                if source == "library"
                else row.workflow_state["rule_state"]
                if source == "project"
                else row.workflow_state
            )
            assert original["id"] not in stored_state["linear"][wk]
            assert {
                r["from"]
                for r in team_rules.route_options(
                    stored_state["linear"][wk][edited["id"]]
                )
            } == {"start", "confirm:0"}
            if source == "library":
                assert row.definition["execution"] == execution
            if source == "project":
                assert row.workflow_state["execution"] == execution
    finally:
        engine.dispose()


@pytest.fixture
def workflow_lab(lab, monkeypatch):
    app, project, run = lab

    def files(settings, pid, name, args, d=None):
        root = research_sandbox.workdir(settings, pid).resolve()
        path = root / args.get("path", ".")
        assert root == path.resolve() or root in path.resolve().parents
        if name == "write":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(args["content"])
        elif name == "read":
            if not path.is_file():
                return {
                    "isError": True,
                    "content": [{"type": "text", "text": "missing file"}],
                }
            return {"content": [{"type": "text", "text": path.read_text()}]}
        return {"content": [{"type": "text", "text": "ok"}]}

    monkeypatch.setattr(research_sandbox, "pi_call", files)
    return app, project, run


def use(app, project, steps):
    with app.state.maker() as d:
        p = d.get(ResearchProject, project["id"])
        row = ResearchWorkflow(
            owner=p.owner, name="Custom", definition={"steps": steps}
        )
        d.add(row)
        d.flush()
        workflows.snapshot(d, p, row.id)
        p.compute_id = "host"
        d.commit()
        return row.id


def state(app, project):
    with app.state.maker() as d:
        return deepcopy(d.get(ResearchProject, project["id"]).workflow_state)


def finish(run, path="result.md", text="source-grounded result"):
    return run(
        [
            (
                "tool",
                "finish_step",
                {
                    "summary": text,
                    "outputs": [{"path": path, "title": "Result", "content": text}],
                },
            ),
            ("text", "done"),
        ]
    )


def test_agent_outputs_are_written_committed_and_handed_to_next_step(workflow_lab):
    app, project, run = workflow_lab
    use(
        app,
        project,
        [
            workflows.step("First", "agent", outputs=["result.md"]),
            workflows.step("Next", "agent"),
        ],
    )
    worker.tick(app)
    model = finish(run)
    assert "# 工作流执行者" in model.requests[0]["messages"][0]["content"]
    names = {t["function"]["name"] for t in model.requests[0]["tools"]}
    assert {"finish_step", "write", "bash", "project_overview"} <= names
    assert not {"advise", "run_job", "start_research", "review_step"} & names
    item = state(app, project)["steps"][0]
    assert item["status"] == "completed" and item["commit_sha"]
    root = research_sandbox.workdir(app.state.settings, project["id"])
    assert (root / "result.md").read_text().endswith("source-grounded result\n")
    assert (
        "source-grounded result"
        in research_repo.git(root, "show", f"{item['commit_sha']}:result.md").stdout
    )
    worker.tick(app)
    _, next_run = planned(app, project["id"])
    assert (
        "source-grounded result" in next_run.prompt and "result.md" in next_run.prompt
    )
    finish(run, "next.md")
    with app.state.maker() as d:
        p = d.get(ResearchProject, project["id"])
        assert (p.stage, p.status) == ("done", "finished")


def test_confirmation_stops_and_redo_restarts_only_this_step(workflow_lab, env):
    app, project, run = workflow_lab
    use(
        app,
        project,
        [
            workflows.step("Confirm", "agent", confirmation=True),
            workflows.step("Next", "agent"),
        ],
    )
    worker.tick(app)
    finish(run)
    for _ in range(2):
        worker.tick(app)
    assert len(sprints(app, project["id"])) == 1
    a = env[1]
    decisions = a.get(f"/api/v1/research/projects/{project['id']}/decisions").json()
    request = next(r for r in decisions if r["open"])
    response = a.post(
        f"/api/v1/research/projects/{project['id']}/decisions/{request['id']}",
        json={"approve": False, "note": "revise"},
    )
    assert response.status_code == 200, response.text
    assert state(app, project)["steps"][0]["attempt"] == 2
    worker.tick(app)
    finish(run, text="revised")
    request = next(
        r
        for r in a.get(f"/api/v1/research/projects/{project['id']}/decisions").json()
        if r["open"]
    )
    response = a.post(
        f"/api/v1/research/projects/{project['id']}/decisions/{request['id']}",
        json={"approve": True},
    )
    assert response.status_code == 200, response.text
    worker.tick(app)
    assert len(sprints(app, project["id"])) == 3
    assert state(app, project)["current"] == 1


def test_review_is_readonly_returns_previous_and_bounds_retries(workflow_lab):
    app, project, run = workflow_lab
    use(
        app,
        project,
        [
            workflows.step("Draft", "agent"),
            workflows.step("Review", "review", max_retries=1),
        ],
    )
    worker.tick(app)
    finish(run)
    worker.tick(app)
    _review, queued = planned(app, project["id"])
    names = {t["name"] for t in research_tools("review")}
    assert "review_step" in names
    assert not names & {
        "bash",
        "write",
        "edit",
        "finish_step",
        "start_research",
        "run_job",
    }
    context = queued.runtime["research"]
    with pytest.raises(ValueError):
        asyncio.run(
            execute(
                app,
                queued.owner,
                queued.session_id,
                "write",
                {"path": "bad", "content": "bad"},
                "x",
                True,
                research=context,
            )
        )
    run(
        [
            ("tool", "review_step", {"pass": False, "notes": "Add citations"}),
            ("text", "done"),
        ]
    )
    assert state(app, project)["current"] == 0
    worker.tick(app)
    assert "Add citations" in planned(app, project["id"])[1].prompt
    finish(run)
    worker.tick(app)
    run(
        [
            (
                "tool",
                "review_step",
                {"pass": False, "notes": "Still missing citations"},
            ),
            ("text", "done"),
        ]
    )
    worker.tick(app)
    with app.state.maker() as d:
        assert d.get(ResearchProject, project["id"]).status == "waiting"
    assert state(app, project)["steps"][1]["status"] == "blocked"
    assert len(sprints(app, project["id"])) == 4


def test_review_pass_completes_workflow(workflow_lab):
    app, project, run = workflow_lab
    use(
        app,
        project,
        [workflows.step("Draft", "agent"), workflows.step("Review", "review")],
    )
    worker.tick(app)
    finish(run)
    worker.tick(app)
    model = run(
        [
            ("tool", "review_step", {"pass": True, "notes": "Evidence checked"}),
            ("text", "done"),
        ]
    )
    assert "# 工作流评审者" in model.requests[0]["messages"][0]["content"]
    assert state(app, project)["current"] == 2
    assert all(item["commit_sha"] for item in state(app, project)["steps"])


def test_plan_and_experiment_use_existing_approval_boundaries(workflow_lab, env):
    app, project, run = workflow_lab
    use(
        app,
        project,
        [
            workflows.step("Plan", "plan"),
            workflows.step("Experiment", "experiment", max_rounds=20),
            workflows.step("Report", "agent"),
        ],
    )
    worker.tick(app)
    run(
        [
            (
                "tool",
                "propose_plan",
                {
                    "question": "Does L2 help?",
                    "summary": "Test plan",
                    "metric": "accuracy",
                    "hypotheses": [{"title": "L2 helps", "kill_if": "no gain"}],
                    "compute_id": "host",
                },
            ),
            ("text", "Approve the plan"),
        ]
    )
    worker.tick(app)
    assert len(sprints(app, project["id"])) == 1
    a = env[1]
    response = a.post(
        f"/api/v1/research/projects/{project['id']}/plan/approve", json={"version": 1}
    )
    assert response.status_code == 200, response.text
    worker.tick(app)
    assert planned(app, project["id"])[0].role == "executor"
    run([("tool", "end_sprint", {"summary": "Experiment completed"}), ("text", "done")])
    with app.state.maker() as d:
        p = d.get(ResearchProject, project["id"])
        sprint = d.get(ResearchSprint, sprints(app, project["id"])[-1].id)
        research_stages.propose_conclusion(
            d, p, sprint, {"status": "concluded", "summary": "Measured result"}
        )
        d.commit()
    worker.tick(app)
    assert len(sprints(app, project["id"])) == 2
    request = next(
        r
        for r in a.get(f"/api/v1/research/projects/{project['id']}/decisions").json()
        if r["open"]
    )
    response = a.post(
        f"/api/v1/research/projects/{project['id']}/decisions/{request['id']}",
        json={"approve": True},
    )
    assert response.status_code == 200, response.text
    worker.tick(app)
    assert planned(app, project["id"])[0].role == "workflow"
    assert state(app, project)["steps"][0]["commit_sha"]
    assert state(app, project)["steps"][1]["commit_sha"]
    assert "Measured result" in planned(app, project["id"])[1].prompt


def test_missing_finish_step_stops_at_round_limit(workflow_lab):
    app, project, run = workflow_lab
    use(app, project, [workflows.step("Bounded", "agent", max_rounds=1)])
    worker.tick(app)
    run([("text", "Not complete yet")])
    worker.tick(app)
    assert len(sprints(app, project["id"])) == 1
    assert state(app, project)["steps"][0]["status"] == "blocked"


def test_definition_snapshot_and_owner_isolation(env):
    app, a, b, settings = env
    from backend.tests.test_agents import configure

    _, model = configure(app, a, settings)
    body = {"name": "Private", "steps": [workflows.step("Read", "agent")]}
    response = a.post(BASE, json=body)
    assert response.status_code == 200, response.text
    saved = response.json()
    created = a.post(
        "/api/v1/research/projects",
        json={
            "message": "Review papers",
            "model_config_id": model,
            "workflow_id": saved["id"],
        },
    )
    assert created.status_code == 200, created.text
    pid = created.json()["id"]
    update = a.put(
        f"{BASE}/{saved['id']}", json={**body, "name": "Changed", "version": 1}
    )
    assert update.status_code == 200 and update.json()["version"] == 2
    assert (
        a.put(f"{BASE}/{saved['id']}", json={**body, "version": 1}).status_code == 409
    )
    assert all(row["id"] != saved["id"] for row in b.get(BASE).json())
    assert b.get(f"{BASE}/{saved['id']}").status_code == 404
    assert (
        b.put(f"{BASE}/{saved['id']}", json={**body, "version": 2}).status_code == 404
    )
    assert b.delete(f"{BASE}/{saved['id']}").status_code == 404
    assert b.get(f"/api/v1/research/projects/{pid}").status_code == 404
    assert a.delete(f"{BASE}/{saved['id']}").status_code == 200
    frozen = a.get(f"/api/v1/research/projects/{pid}").json()["project"]["workflow"]
    assert frozen["version"] == 1 and frozen["name"] == "Private"
    assert a.put(f"{BASE}/research", json={**body, "version": 1}).status_code == 409
    assert (
        a.post(
            BASE, json={"name": "Bad", "steps": [workflows.step("First", "review")]}
        ).status_code
        == 422
    )


def test_legacy_research_needs_no_migration_and_still_runs(workflow_lab, env):
    app, project, run = workflow_lab
    with app.state.maker() as d:
        p = d.get(ResearchProject, project["id"])
        p.workflow, p.workflow_state = {}, {}
        d.commit()
    response = env[1].get(f"/api/v1/research/projects/{project['id']}")
    assert response.status_code == 200
    assert response.json()["project"]["workflow"]["id"] == "research"
    assert response.json()["project"]["workflow"]["state"]["current"] == 1
    worker.tick(app)
    assert planned(app, project["id"])[0].role == "executor"
    run([("tool", "end_sprint", {"summary": "Legacy round"}), ("text", "done")])
    worker.tick(app)
    assert len(sprints(app, project["id"])) == 2


def test_schedules_snapshot_selected_workflow_and_reject_foreign_ids(env):
    from backend.models import ResearchWorkspace
    from backend.tests.test_agents import configure
    from backend.tests.test_research_schedules import create, setup  # noqa: F401

    app, a, b, settings = env
    owner, model = configure(app, a, settings)
    _, _other_model = configure(app, b, settings)
    with app.state.maker() as d:
        home = ResearchWorkspace(owner=owner, name="P", model_config_id=model)
        d.add(home)
        d.commit()
        wid = home.id
    private = b.post(
        BASE, json={"name": "Other", "steps": [workflows.step("Read", "agent")]}
    ).json()["id"]
    body = {
        "title": "Review",
        "prompt": "Review papers",
        "workspace_id": wid,
        "timezone": "UTC",
        "workflow_id": "literature-review",
    }
    assert (
        a.post(
            "/api/v1/research/schedules", json={**body, "workflow_id": private}
        ).status_code
        == 404
    )
    item = a.post("/api/v1/research/schedules", json=body).json()
    record = a.post(f"/api/v1/research/schedules/{item['id']}/run").json()
    assert record["status"] == "succeeded", record
    project = a.get(f"/api/v1/research/projects/{record['research_id']}").json()[
        "project"
    ]
    assert (
        project["workflow"]["id"] == "literature-review"
        and project["stage"] == "workflow"
    )


def test_migration_0042_roundtrip(env):
    app = env[0]
    migration = importlib.import_module(
        "backend.migrations.versions.0042_research_workflows"
    )
    with app.state.engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            migration.downgrade()
            assert "workflow" not in {
                c["name"] for c in inspect(conn).get_columns("research_projects")
            }
            migration.upgrade()
            migration.upgrade()
        assert "research_workflows" in inspect(conn).get_table_names()
        assert "workflow_id" in {
            c["name"] for c in inspect(conn).get_columns("research_schedules")
        }


def test_checkpoint_failure_and_missing_outputs_do_not_advance(
    workflow_lab, monkeypatch
):
    app, project, run = workflow_lab
    use(
        app,
        project,
        [
            workflows.step("Required", "agent", outputs=["required.md"]),
            workflows.step("Next", "agent"),
        ],
    )
    worker.tick(app)
    finish(run, "wrong.md")
    assert state(app, project)["current"] == 0
    assert sprints(app, project["id"])[0].status == "running"
    worker.tick(app)
    monkeypatch.setattr(worker, "capture_handoff", lambda *_: False)
    finish(run, "required.md")
    assert state(app, project)["current"] == 0
    assert not state(app, project)["steps"][0].get("commit_sha")


def test_workflow_file_tools_cannot_cross_owners(workflow_lab, env):
    app, project, _run = workflow_lab
    use(app, project, [workflows.step("Private", "agent")])
    worker.tick(app)
    _sprint, queued = planned(app, project["id"])
    from backend.models import User

    with app.state.maker() as d:
        other = d.scalar(select(User).where(User.username == "bob")).id
    with pytest.raises(ValueError, match="研究任务不存在"):
        asyncio.run(
            execute(
                app,
                other,
                queued.session_id,
                "write",
                {"path": "private.md", "content": "bad"},
                "x",
                True,
                research=queued.runtime["research"],
            )
        )


def test_read_to_write_choices_spawn_one_default_workflow_child(workflow_lab, env):
    app, project, run = workflow_lab
    use(
        app,
        project,
        [
            workflows.step("Ideas", "agent", confirmation=True),
            workflows.step("Research", "agent", action="child_research"),
            workflows.step("Write", "agent"),
        ],
    )
    worker.tick(app)
    run(
        [
            (
                "tool",
                "finish_step",
                {
                    "summary": "Two directions",
                    "outputs": [
                        {
                            "title": "Direction A",
                            "content": "Question A",
                            "kind": "idea",
                        },
                        {
                            "title": "Direction B",
                            "content": "Question B",
                            "kind": "idea",
                        },
                    ],
                },
            ),
            ("text", "done"),
        ]
    )
    a = env[1]
    request = next(
        r
        for r in a.get(f"/api/v1/research/projects/{project['id']}/decisions").json()
        if r["open"]
    )
    response = a.post(
        f"/api/v1/research/projects/{project['id']}/decisions/{request['id']}",
        json={"approve": True, "note": "Direction B"},
    )
    assert response.status_code == 200, response.text
    worker.tick(app)
    child_id = state(app, project)["steps"][1]["child_id"]
    worker.tick(app)
    assert state(app, project)["steps"][1]["child_id"] == child_id
    with app.state.maker() as d:
        child = d.get(ResearchProject, child_id)
        assert child.parent_id == project["id"] and child.question == "Direction B"
        assert child.workflow["id"] == "research" and child.stage == "scoping"
        child.status, child.stage, child.end_reason = "finished", "done", "concluded"
        child.conclusion = {"summary": "Child evidence"}
        for queued in d.scalars(
            select(AgentRun).where(AgentRun.session_id == child.session_id)
        ):
            queued.status = "cancelled"
        d.commit()
    worker.tick(app)
    worker.tick(app)
    assert state(app, project)["current"] == 2
    assert state(app, project)["steps"][1]["commit_sha"]
    assert "Child evidence" in planned(app, project["id"])[1].prompt


def test_builtin_copies_keep_native_research_actions(env):
    _app, a, _b, _settings = env
    original = a.get(f"{BASE}/research").json()
    steps = [
        {k: v for k, v in step.items() if k != "stage"} for step in original["steps"]
    ]
    saved = a.post(BASE, json={"name": "Copied research", "steps": steps})
    assert saved.status_code == 200, saved.text
    assert saved.json()["steps"][2]["action"] == "conclusion"
    assert saved.json()["steps"][3]["action"] == "retrospective"


def test_copied_research_conclusion_and_retrospective_keep_native_flow(
    workflow_lab, env
):
    app, project, _run = workflow_lab
    steps = [
        workflows.step("Plan", "plan"),
        workflows.step("Experiment", "experiment"),
        workflows.step("Conclusion", "agent", action="conclusion", confirmation=True),
        workflows.step("Retrospective", "agent", action="retrospective"),
    ]
    use(app, project, steps)
    with app.state.maker() as d:
        p = d.get(ResearchProject, project["id"])
        workflows.native_complete(d, p, "plan", "Approved plan")
        sprint = ResearchSprint(
            project_id=p.id, number=1, role="advisor", run_id="native", status="ended"
        )
        d.add(sprint)
        d.flush()
        research_stages.propose_conclusion(
            d, p, sprint, {"status": "concluded", "summary": "Measured result"}
        )
        assert p.workflow_state["current"] == 2 and p.status == "waiting"
        d.commit()
    a = env[1]
    request = next(
        r
        for r in a.get(f"/api/v1/research/projects/{project['id']}/decisions").json()
        if r["open"]
    )
    response = a.post(
        f"/api/v1/research/projects/{project['id']}/decisions/{request['id']}",
        json={"approve": True},
    )
    assert response.status_code == 200, response.text
    assert state(app, project)["current"] == 3
    worker.tick(app)
    with app.state.maker() as d:
        p = d.get(ResearchProject, project["id"])
        assert p.stage == "done" and p.status == "finished"
        assert p.workflow_state["current"] == 4


def test_stopping_custom_workflow_does_not_schedule_retrospective(workflow_lab, env):
    app, project, _run = workflow_lab
    use(app, project, [workflows.step("Write", "agent")])
    worker.tick(app)
    response = env[1].post(f"/api/v1/research/projects/{project['id']}/stop", json={})
    assert response.status_code == 200, response.text
    worker.tick(app)
    worker.tick(app)
    assert len(sprints(app, project["id"])) == 1
    with app.state.maker() as d:
        assert d.get(ResearchProject, project["id"]).end_reason == "stopped"
