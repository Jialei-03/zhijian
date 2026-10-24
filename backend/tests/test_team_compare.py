"""Comparison projections, ownership and independent workflow evaluation groups."""

from copy import deepcopy
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from backend import research_branches as branches
from backend import research_map as rm
from backend import research_repo
from backend import research_workspaces as rw
from backend.models import (
    AgentRun,
    AgentSession,
    ResearchEvaluationBatch,
    ResearchEvent,
    ResearchJob,
    ResearchProject,
    ResearchSprint,
    ResearchWorkflow,
    ResearchWorkspace,
    TeamMessage,
)
from backend.team_compare import comparison
from backend.tests.test_acceptance import bearer
from backend.tests.test_acceptance import env as cloud_env  # noqa: F401
from backend.tests.test_agents import configure

API = "/api/v1/research"
AT = "2026-10-23T01:00:00Z"


@pytest.fixture
def env(cloud_env, monkeypatch):  # noqa: F811
    cloud_env[3].mode = "local"
    # All API tests use isolated storage and never create a Git repository.
    monkeypatch.setattr(research_repo, "available", lambda: False)
    return cloud_env


def project(env, *, kind="research", owner=None, question="Does L2 help?"):
    app, a, _, settings = env
    configured_owner, model = configure(app, a, settings)
    owner = owner or configured_owner
    with app.state.maker() as d:
        w = rw.create(
            d, owner, "Evaluation" if kind == "eval" else "Research", kind=kind
        )
        p = rm.create_project(d, owner, question, "", model)
        p.workspace_id = w.id
        d.get(AgentSession, p.session_id).workspace_id = w.id
        p.status = "paused"
        d.commit()
        return p.id, w.id, model


def test_comparison_uses_own_costs_relevant_finite_numbers_and_role_participation(env):
    app, a, _, _ = env
    pid, _, _ = project(env)
    with app.state.maker() as d:
        p = d.get(ResearchProject, pid)
        p.created_at, p.updated_at = "2026-10-23T00:00:00Z", AT
        p.status = "finished"
        p.workflow = {"id": "test", "name": "Peer review"}
        p.conclusion = {"summary": "Accuracy improves to 0.91. Another sentence."}
        p.spent = {"tokens": 1000, "job_seconds": 80}
        p.inherited_history = {"sprints": [{"tokens": 99999}]}
        root = rm.root(d, p)
        root.status = "supported"
        root.evidence_for = [
            {"summary": "accuracy=0.91 loss=0.2", "evidence": [{"job_id": "j1"}]}
        ]
        for i, (role, tokens) in enumerate(
            [("executor", 600), ("advisor", 300), ("executor", 100)]
        ):
            d.add(
                ResearchSprint(
                    project_id=pid,
                    number=i + 1,
                    role=role,
                    tokens=tokens,
                    run_id=f"r{i}",
                    status="ended",
                )
            )
        d.add(
            ResearchJob(
                id="j1",
                project_id=pid,
                node_id=root.id,
                sprint_id="r",
                command="test",
                status="succeeded",
                started_at="2026-10-23T00:00:00Z",
                finished_at="2026-10-23T00:01:00Z",
                metrics={"accuracy": 0.91, "enabled": True, "loss": 0.2, "seed": 42},
            )
        )
        d.add(
            ResearchJob(
                project_id=pid,
                node_id=root.id,
                sprint_id="r",
                command="test",
                status="failed",
                metrics={"accuracy": 1},
                started_at="2026-10-23T00:01:00Z",
                finished_at="2026-10-23T00:01:20Z",
            )
        )
        rm.event(d, p, root, "human", "message", {"text": "Question"})
        d.commit()
    response = a.get(f"{API}/compare", params=[("ids", pid)])
    assert response.status_code == 200, response.text
    got = response.json()["threads"][0]
    assert got["workflow"] == "Peer review"
    assert got["conclusion"] == "Accuracy improves to 0.91."
    assert got["numbers"][:2] == [
        {"name": "accuracy", "value": 0.91},
        {"name": "loss", "value": 0.2},
    ]
    assert "enabled" not in {n["name"] for n in got["numbers"]}
    assert (
        got["tokens"],
        got["job_seconds"],
        got["elapsed_seconds"],
        got["rounds"],
    ) == (1000, 80, 3600, 3)
    from backend.research_team import stable

    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, d.get(ResearchProject, pid).workspace_id)
        assert {m["id"]: (m["messages"], m["tokens"]) for m in got["members"]} == {
            stable(workspace, "human"): (1, 0),
            stable(workspace, "advisor"): (1, 300),
            stable(workspace, "executor"): (2, 700),
        }

    with app.state.maker() as d:
        p = d.get(ResearchProject, pid)
        fake = [{"id": "m1", "name": "Ada", "messages": 7, "tokens": 800}]
        assert (
            comparison(d, [p], members_by_thread={pid: fake})["threads"][0]["members"]
            == fake
        )


def test_comparison_empty_legacy_running_jobs_and_no_inherited_cost(env):
    app, _, _, _ = env
    pid, _, _ = project(env)
    with app.state.maker() as d:
        p = d.get(ResearchProject, pid)
        p.created_at = "2026-10-23T00:59:00+00:00"
        p.status = "active"
        root = rm.root(d, p)
        p.inherited_history = {"sprints": [{"tokens": 1000}]}
        p.spent = {}
        d.add(
            ResearchJob(
                project_id=pid,
                node_id=root.id,
                sprint_id="r",
                command="test",
                started_at="2026-10-23T00:59:30Z",
            )
        )
        d.add(
            ResearchJob(
                project_id=pid,
                node_id=root.id,
                sprint_id="r",
                command="test",
                status="queued",
                started_at="2026-10-23T00:00:00Z",
            )
        )
        d.flush()
        result = comparison(d, [p], at=AT)["threads"][0]
        assert (
            result["tokens"],
            result["rounds"],
            result["job_seconds"],
            result["elapsed_seconds"],
        ) == (0, 0, 30, 60)
        assert result["members"] == result["numbers"] == []
        assert result["conclusion"] == ""
        rm.event(
            d, p, root, "advisor", "concluded", {"summary": "没有提升。后续工作。"}
        )
        d.flush()
        assert comparison(d, [p])["threads"][0]["conclusion"] == "没有提升。"


def test_comparison_workflow_names_cover_legacy_ids_and_preserve_snapshots(env):
    app, _, _, _ = env
    pid, _, _ = project(env)
    with app.state.maker() as d:
        p = d.get(ResearchProject, pid)
        custom = ResearchWorkflow(owner=p.owner, name="Custom review")
        d.add(custom)
        d.flush()
        for workflow, name in [
            ({}, "研究"),
            ({"id": "research"}, "研究"),
            ({"id": "research", "name": "research"}, "研究"),
            ({"id": "research", "name": "研究"}, "研究"),
            ({"id": "literature-review"}, "文献综述"),
            ({"id": custom.id}, "Custom review"),
            ({"id": custom.id, "name": "Snapshot review"}, "Snapshot review"),
        ]:
            p.workflow = workflow
            assert comparison(d, [p])["threads"][0]["workflow"] == name


def test_comparison_team_threads_use_last_message_without_changing_root_time(env):
    from backend import research_team as team

    app, a, b, _ = env
    pid, wid, _ = project(env)
    base = f"{API}/workspaces/{wid}/team"
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, wid)
        members = team.ensure(d, workspace)
        human = next(m for m in members if m.role == "human")
        advisor = next(m for m in members if m.role == "advisor")
        channel = team.channel_of(d, workspace, team.stable(workspace, "general"))
        old = team.post(d, workspace, channel, "Old thread", author=human)
        old.created_at = "2026-10-01T00:00:00Z"
        newer = team.post(d, workspace, channel, "Newer thread", author=human)
        newer.created_at = "2026-10-02T00:00:00Z"
        reply = team.post(
            d, workspace, channel, "Latest reply", author=advisor, thread_id=old.id
        )
        reply.created_at = "2026-10-04T00:00:00Z"
        reply.mentions = [human.id]
        p = d.get(ResearchProject, pid)
        p.created_at = "2026-09-01T00:00:00Z"
        # A metadata update must not count as a message.
        p.updated_at = "2026-10-10T00:00:00Z"
        d.add(
            ResearchEvent(
                project_id=pid,
                actor="advisor",
                action="message",
                detail={"text": "Legacy reply"},
                created_at="2026-10-03T00:00:00Z",
            )
        )
        old_id, newer_id, reply_id = old.id, newer.id, reply.id
        d.commit()
    response = a.get(base + "/threads")
    assert response.status_code == 200, response.text
    rows = response.json()
    assert [r["id"] for r in rows] == [old_id, f"research:{pid}"]
    assert newer_id not in {r["id"] for r in rows}
    assert rows[0]["created_at"] == "2026-10-01T00:00:00Z"
    assert [r["last_message_at"] for r in rows] == [
        "2026-10-04T00:00:00Z",
        "2026-10-03T00:00:00Z",
    ]
    assert [r["id"] for r in a.get(base + "/threads?mentions=true").json()] == [
        reply_id
    ]
    assert b.get(base + "/threads").status_code == 404
    with app.state.maker() as d:
        d.get(TeamMessage, reply_id).created_at = "2026-10-01T01:00:00Z"
        d.add(
            ResearchSprint(
                project_id=pid,
                number=1,
                run_id="fake",
                summary="Legacy turn",
                updated_at="2026-10-05T00:00:00Z",
            )
        )
        d.commit()
    assert [r["id"] for r in a.get(base + "/threads").json()] == [
        f"research:{pid}",
        old_id,
    ]


def test_member_threads_use_latest_activity_from_all_authors_and_legacy_research(env):
    from backend import research_team as team

    app, a, b, _ = env
    pid, wid, model = project(env)
    base = f"{API}/workspaces/{wid}/team"
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, wid)
        roster = team.ensure(d, workspace)
        human = next(m for m in roster if m.role == "human")
        advisor = next(m for m in roster if m.role == "advisor")
        channel = team.channel_of(d, workspace, team.stable(workspace, "general"))
        old = team.post(d, workspace, channel, "Earlier root", author=advisor)
        old.created_at = "2026-10-01T00:00:00Z"
        own_reply = team.post(
            d, workspace, channel, "Own reply", author=advisor, thread_id=old.id
        )
        own_reply.created_at = "2026-10-02T00:00:00Z"
        newer = team.post(d, workspace, channel, "Newer root", author=advisor)
        newer.created_at = "2026-10-03T00:00:00Z"
        reply = team.post(
            d, workspace, channel, "Later reply", author=human, thread_id=old.id
        )
        reply.created_at = "2026-10-06T00:00:00Z"
        p = d.get(ResearchProject, pid)
        p.created_at = "2026-09-01T00:00:00Z"
        p.updated_at = "2026-10-30T00:00:00Z"
        run = AgentRun(
            owner=workspace.owner,
            session_id=p.session_id,
            model_config_id=model,
            model="Offline",
            prompt="Legacy research",
            status="completed",
            runtime={"research": {"project_id": pid, "role": "advisor"}},
        )
        d.add(run)
        d.flush()
        sprint = ResearchSprint(
            project_id=pid,
            number=1,
            run_id=run.id,
            summary="Legacy summary",
            created_at="2026-09-30T00:00:00Z",
            updated_at="2026-10-04T00:00:00Z",
        )
        d.add(sprint)
        for action, at in (
            ("message", "2026-10-05T00:00:00Z"),
            ("metadata", "2026-10-31T00:00:00Z"),
        ):
            d.add(
                ResearchEvent(
                    project_id=pid, actor="human", action=action, created_at=at
                )
            )
        old_id, newer_id, advisor_id = old.id, newer.id, advisor.id
        d.commit()
    detail = a.get(base + f"/members/{advisor_id}")
    assert detail.status_code == 200, detail.text
    assert [
        (t["id"], t["text"], t["last_message_at"]) for t in detail.json()["threads"]
    ] == [
        (old_id, "Earlier root", "2026-10-06T00:00:00Z"),
        (f"research:{pid}", "Legacy summary", "2026-10-05T00:00:00Z"),
    ]
    assert newer_id not in {t["id"] for t in detail.json()["threads"]}
    assert b.get(base + f"/members/{advisor_id}").status_code == 404
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, wid)
        channel = team.channel_of(d, workspace, team.stable(workspace, "experiments"))
        reply = team.post(
            d,
            workspace,
            channel,
            "Research reply",
            author=d.get(team.TeamMember, advisor_id),
            thread_id=f"research:{pid}",
        )
        reply.created_at = "2026-10-07T00:00:00Z"
        d.commit()
    threads = a.get(base + f"/members/{advisor_id}").json()["threads"]
    assert len(threads) == 2
    assert (threads[0]["id"], threads[0]["last_message_at"]) == (
        f"research:{pid}",
        "2026-10-07T00:00:00Z",
    )


def test_comparison_is_local_human_only_atomic_and_preserves_order(env):
    app, a, b, settings = env
    first, _, _ = project(env)
    second, _, _ = project(env, question="Another question")
    assert [
        p["id"]
        for p in a.get(
            f"{API}/compare", params=[("ids", second), ("ids", first), ("ids", second)]
        ).json()["threads"]
    ] == [second, first]
    assert b.get(f"{API}/compare", params={"ids": first}).status_code == 404
    assert (
        a.get(f"{API}/compare", params=[("ids", first), ("ids", "missing")]).status_code
        == 404
    )
    assert a.get(f"{API}/compare").status_code == 422
    assert a.get(f"{API}/compare", params=[("ids", first)] * 13).status_code == 422
    agent, _ = bearer(app, a)
    assert agent.get(f"{API}/compare", params={"ids": first}).status_code == 403
    agent.close()
    settings.mode = "cloud"
    assert a.get(f"{API}/compare", params={"ids": first}).status_code == 403


def sealed_without_git(env, monkeypatch):
    app, _, _, _ = env
    pid, _, model = project(env)
    sha = "a" * 40
    with app.state.maker() as d:
        p = d.get(ResearchProject, pid)
        run = AgentRun(
            owner=p.owner,
            session_id=p.session_id,
            model_config_id=model,
            model="test",
            prompt="test",
            status="completed",
        )
        d.add(run)
        d.flush()
        sprint = ResearchSprint(
            project_id=pid, number=1, run_id=run.id, status="ended", commit_sha=sha
        )
        d.add(sprint)
        d.flush()
        sprint.snapshot = {
            "version": 1,
            "commit": sha,
            "sprint_id": sprint.id,
            "project": {
                key: deepcopy(getattr(p, key)) for key in branches.PROJECT_STATE
            },
            "nodes": [branches._row(rm.root(d, p))],
            "events": [],
            "sprints": [],
        }
        sid = sprint.id
        d.commit()
    monkeypatch.setattr(research_repo, "validate_checkpoint", lambda *args: sha)
    monkeypatch.setattr(research_repo, "fork_thread", lambda *args: None)
    return pid, {
        "sprint_id": sid,
        "expected_commit": sha,
        "change": "Same question",
        "client_id": str(uuid4()),
        "workflow_id": "literature-review",
    }


def test_fork_records_workflow_is_paused_and_retry_checks_workflow(env, monkeypatch):
    app, a, b, settings = env
    pid, body = sealed_without_git(env, monkeypatch)
    response = a.post(f"{API}/projects/{pid}/forks", json=body)
    assert response.status_code == 200, response.text
    child = response.json()
    assert child["workflow"]["id"] == "literature-review"
    assert child["status"] == "paused"
    assert child["forked_from"]["workflow_id"] == "literature-review"
    assert child["forked_from"]["workflow"] == child["workflow"]["name"]
    assert a.post(f"{API}/projects/{pid}/forks", json=body).json()["id"] == child["id"]
    assert (
        a.post(
            f"{API}/projects/{pid}/forks", json={**body, "workflow_id": "research"}
        ).status_code
        == 409
    )
    assert b.post(f"{API}/projects/{pid}/forks", json=body).status_code == 404
    assert (
        a.post(
            f"{API}/projects/{pid}/forks",
            json={**body, "client_id": str(uuid4()), "workflow_id": "missing"},
        ).status_code
        == 404
    )
    settings.mode = "cloud"
    assert a.post(f"{API}/projects/{pid}/forks", json=body).status_code == 403
    with app.state.maker() as d:
        assert d.scalar(select(func.count(ResearchProject.id))) == 2


def test_batch_cartesian_grouping_results_and_permissions(env):
    app, a, b, settings = env
    _, wid, model = project(env, kind="eval")
    body = {
        "name": "Matrix",
        "questions": ["Q1?", "Q2?"],
        "workflow_ids": ["research", "literature-review"],
        "model_config_id": model,
    }
    response = a.post(f"{API}/workspaces/{wid}/evaluations", json=body)
    assert response.status_code == 200, response.text
    batch = response.json()
    assert [(cell["question"], cell["workflow_id"]) for cell in batch["cells"]] == [
        (0, "research"),
        (0, "literature-review"),
        (1, "research"),
        (1, "literature-review"),
    ]
    ids = [c["research_id"] for c in batch["cells"]]
    assert len(set(ids)) == 4
    results = a.get(f"{API}/evaluations/{batch['id']}")
    assert results.status_code == 200, results.text
    assert [p["id"] for p in results.json()["threads"]] == ids
    assert len(a.get(f"{API}/workspaces/{wid}/evaluations").json()) == 1
    with app.state.maker() as d:
        for cell in batch["cells"]:
            p = d.get(ResearchProject, cell["research_id"])
            assert p.question == body["questions"][cell["question"]]
            assert p.workspace_id == wid and p.workflow["id"] == cell["workflow_id"]
            assert p.status == "active" and p.budget["auto_decide"]
        assert d.scalar(select(func.count(AgentRun.id))) == 0
    assert b.get(f"{API}/evaluations/{batch['id']}").status_code == 404
    assert b.get(f"{API}/workspaces/{wid}/evaluations").status_code == 404
    assert b.post(f"{API}/workspaces/{wid}/evaluations", json=body).status_code == 404
    settings.mode = "cloud"
    assert a.get(f"{API}/evaluations/{batch['id']}").status_code == 403
    assert a.post(f"{API}/workspaces/{wid}/evaluations", json=body).status_code == 403


def test_batch_validation_and_failure_leave_no_partial_group(env):
    app, a, _, _ = env
    _, wid, model = project(env, kind="eval")
    body = {
        "name": "Matrix",
        "questions": ["Q?"],
        "workflow_ids": ["research"],
        "model_config_id": model,
    }
    for patch in [
        {"questions": [" "]},
        {"workflow_ids": ["research", "research"]},
        {"questions": ["x"] * 51},
        {"model_config_id": "missing"},
        {"workflow_ids": ["research", "missing"]},
    ]:
        assert a.post(
            f"{API}/workspaces/{wid}/evaluations", json={**body, **patch}
        ).status_code in {404, 409, 422}
    _, ordinary, _ = project(env)
    assert (
        a.post(f"{API}/workspaces/{ordinary}/evaluations", json=body).status_code == 409
    )
    with app.state.maker() as d:
        assert d.scalar(select(func.count(ResearchEvaluationBatch.id))) == 0
        assert d.scalar(select(func.count(ResearchProject.id))) == 2


def test_batch_rolls_back_when_a_later_research_fails(env, monkeypatch):
    app, a, _, _ = env
    _, wid, model = project(env, kind="eval")
    original = rm.create_project
    calls = 0

    def fail_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ValueError("second research failed")
        return original(*args, **kwargs)

    monkeypatch.setattr(rm, "create_project", fail_second)
    response = a.post(
        f"{API}/workspaces/{wid}/evaluations",
        json={
            "name": "Atomic",
            "questions": ["Q1", "Q2"],
            "workflow_ids": ["research"],
            "model_config_id": model,
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "second research failed"
    with app.state.maker() as d:
        assert d.scalar(select(func.count(ResearchProject.id))) == 1
        assert d.scalar(select(func.count(ResearchEvaluationBatch.id))) == 0


def test_batch_migration_is_repeatable_and_preserves_research(env):
    import importlib

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import inspect

    app, _, _, _ = env
    pid, _, _ = project(env)
    migration = importlib.import_module(
        "backend.migrations.versions.0044_team_comparison"
    )
    with app.state.engine.begin() as connection:
        ResearchEvaluationBatch.__table__.drop(connection)
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            migration.upgrade()
        indexes = inspect(connection).get_indexes("research_evaluation_batches")
        assert {i["name"] for i in indexes} == {
            "ix_research_evaluation_batches_owner",
            "ix_research_evaluation_batches_workspace_id",
        }
    with app.state.maker() as d:
        assert d.get(ResearchProject, pid).question == "Does L2 help?"


def test_private_workflow_is_not_usable_by_another_owner(env, monkeypatch):
    app, a, b, _ = env
    pid, body = sealed_without_git(env, monkeypatch)
    private = b.post(
        f"{API}/workflows", json={"name": "Private", "steps": [{"name": "Only mine"}]}
    ).json()
    assert (
        a.post(
            f"{API}/projects/{pid}/forks", json={**body, "workflow_id": private["id"]}
        ).status_code
        == 404
    )
    _, wid, model = project(env, kind="eval")
    assert (
        a.post(
            f"{API}/workspaces/{wid}/evaluations",
            json={
                "name": "Private",
                "questions": ["Q"],
                "workflow_ids": [private["id"]],
                "model_config_id": model,
            },
        ).status_code
        == 404
    )
