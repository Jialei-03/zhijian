"""End-to-end wiring checks with the isolated Step 1 world and no provider calls."""

import asyncio
import importlib
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import UTC, datetime

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select

from backend import research_team as team
from backend import team_rules
from backend.agent_tools import execute
from backend.models import (
    AgentRun,
    ResearchWorkflow,
    ResearchWorkspace,
    TeamDelivery,
    TeamMember,
    TeamMessage,
)
from backend.tests.test_research_team import (  # noqa: F401
    cloud_env,
    deliveries,
    env,
    finish,
    send,
    world,
)


def flow(world, rules):
    _, a, _, _, _, _, _, base, overview = world
    current = a.get(base).json()["workflow"]
    result = a.put(base + "/workflow", json={**current, "rules": rules})
    assert result.status_code == 200, result.text
    return result.json()


def rule(identifier="auto", action="wake", **extra):
    return {
        "id": identifier,
        "enabled": True,
        "when": {"event": "message", "from_role": "owner"},
        "then": {
            "action": action,
            **(
                {"role": "librarian", "instruction": "Read sources"}
                if action == "wake"
                else {}
            ),
            **extra,
        },
        "limit": {"per_thread": 10},
    }


def test_team_save_conflict_references_provenance_and_history(world):
    app, a, b, settings, _, _, wid, base, overview = world
    saved = flow(world, [rule()])
    assert b.get(base + "/workflow").status_code == 404
    assert (
        a.put(
            base + "/workflow", json={**saved, "version": saved["version"] - 1}
        ).status_code
        == 409
    )
    invalid = deepcopy(saved)
    invalid["rules"][0]["then"] = {"action": "wake", "member": "foreign"}
    assert a.put(base + "/workflow", json=invalid).status_code == 422
    message = send(world, "Read this")
    delivery = deliveries(app)[0]
    with app.state.maker() as d:
        run_message = d.scalar(
            select(TeamMessage).where(
                TeamMessage.source_key == f"run:{delivery.run_id}"
            )
        )
        assert run_message.data["rule"] == "auto"
        from backend.models import AgentRun

        run = d.get(AgentRun, delivery.run_id)
        assert "Read sources" in run.prompt and run.runtime["team"]["rule"] == "auto"
    flow(world, [rule("changed")])
    historical = a.get(base + f"/workflows/{saved['id']}/{saved['version']}")
    assert (
        historical.status_code == 200 and historical.json()["rules"][0]["id"] == "auto"
    )
    assert a.get(base).json()["runtime"]["fired"][-1]["rule"] == "auto"


def test_rule_counts_and_inbox_are_atomic_under_concurrent_sends(world):
    app, a, _, settings, _, _, wid, base, overview = world
    bounded = rule()
    bounded["limit"]["per_thread"] = 1
    flow(world, [bounded])
    channel_id = next(c["id"] for c in overview["channels"] if c["key"] == "general")

    def post(index):
        with app.state.maker() as d:
            workspace = d.get(ResearchWorkspace, wid)
            message = team.post(
                d,
                workspace,
                team.channel_of(d, workspace, channel_id),
                f"message {index}",
            )
            d.commit()
            return message.id

    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(post, range(2)))
    assert len(ids) == 2
    assert len(deliveries(app)) == 1
    with app.state.maker() as d:
        state = d.get(ResearchWorkspace, wid).workflow_state
        assert (
            max(
                s["workflows"][
                    team_rules._workflow_key(a.get(base).json()["workflow"])
                ]["counts"].get("auto", 0)
                for s in state["threads"].values()
            )
            == 1
        )


def test_review_tool_correlates_one_result_per_run_and_returns_through_engine(world):
    app, a, _, settings, owner, _, wid, base, overview = world
    review = rule("peer", "review", role="reviewer", on_fail="writer", max_rounds=1)
    flow(world, [review])
    send(world, "Check evidence")
    delivery = deliveries(app)[0]
    from backend.models import AgentRun

    with app.state.maker() as d:
        d.get(AgentRun, delivery.run_id).status = "running"
        d.commit()
    args = {"pass": False, "notes": "Missing citations"}
    one = asyncio.run(
        execute(
            app,
            owner,
            "ignored",
            "team_review_result",
            args,
            "r1",
            sandbox_id=delivery.run_id,
        )
    )
    two = asyncio.run(
        execute(
            app,
            owner,
            "ignored",
            "team_review_result",
            args,
            "r2",
            sandbox_id=delivery.run_id,
        )
    )
    assert one == two
    with app.state.maker() as d:
        returns = list(
            d.scalars(
                select(TeamDelivery).where(TeamDelivery.message_id == one["message_id"])
            )
        )
        assert len(returns) == 1
        assert d.get(TeamMember, returns[0].member_id).role == "writer"
        assert returns[0].action["rule"] == "peer"


def test_schedule_center_and_canvas_share_pause_delete_and_dispatch(world):
    app, a, _, settings, _, _, wid, base, overview = world
    from backend import research_schedules

    channel = next(c["id"] for c in overview["channels"] if c["key"] == "general")
    timer = {
        "id": "daily-note",
        "enabled": True,
        "when": {"event": "schedule", "cron": "0 9 * * *", "timezone": "UTC"},
        "then": {"action": "post", "channel": channel, "text": "Daily"},
        "limit": {"per_thread": 10},
    }
    saved = flow(world, [timer])
    listed = a.get("/api/v1/research/schedules").json()
    assert any(r.get("rule") == "daily-note" and r["editor_url"] for r in listed)
    # A fixed persisted baseline stands in for last night's successful claim.
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, wid)
        state = deepcopy(workspace.workflow_state)
        state["last_runs"][team_rules._workflow_key(saved)]["daily-note"] = (
            "2026-10-22T09:00:00Z"
        )
        workspace.workflow_state = state
        d.commit()
    at = datetime(2026, 10, 23, 9, tzinfo=UTC)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(
            pool.map(
                lambda _: research_schedules.tick(settings, app.state.maker, at),
                range(2),
            )
        )
    with app.state.maker() as d:
        assert (
            len(list(d.scalars(select(TeamMessage).where(TeamMessage.text == "Daily"))))
            == 1
        )
    schedule = a.post(
        "/api/v1/research/schedules",
        json={
            "title": "Launch",
            "prompt": "Question",
            "workspace_id": wid,
            "timezone": "UTC",
        },
    ).json()
    current = a.get(base).json()["workflow"]
    rid = f"schedule:{schedule['id']}"
    entry = next(r for r in current["rules"] if r["id"] == rid)
    entry["enabled"] = False
    assert a.put(base + "/workflow", json=current).status_code == 200
    assert a.get(f"/api/v1/research/schedules/{schedule['id']}").json()["paused"]
    current = a.get(base).json()["workflow"]
    current["rules"] = [r for r in current["rules"] if r["id"] != rid]
    assert a.put(base + "/workflow", json=current).status_code == 200
    assert a.get(f"/api/v1/research/schedules/{schedule['id']}").status_code == 404


def test_migration_0045_preserves_linear_definition_and_execution_state(world):
    app, *_ = world
    migration = importlib.import_module(
        "backend.migrations.versions.0045_team_workflows"
    )
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, world[6])
        old = ResearchWorkflow(
            owner=workspace.owner,
            name="Old",
            definition={
                "steps": [
                    {
                        "name": "Read",
                        "type": "agent",
                        "instructions": "Keep sources",
                        "outputs": ["sources.md"],
                    }
                ]
            },
        )
        d.add(old)
        d.commit()
        identifier = old.id
    with app.state.engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            migration.upgrade()
            migration.upgrade()
    with app.state.maker() as d:
        definition = d.get(ResearchWorkflow, identifier).definition
        assert definition["rules"] and definition["initial_state"]["linear"]
        assert definition["execution"]["steps"][0]["outputs"] == ["sources.md"]


def test_adopting_an_inflight_review_preserves_its_retry_budget(world):
    from backend import research_map, research_workflows
    from backend.team_workflows import research_event

    app, _, _, _, owner, model, wid, *_ = world
    with app.state.maker() as d:
        project = research_map.create_project(d, owner, "Existing review", "", model)
        project.workspace_id = wid
        old = {
            "id": "old-review",
            "name": "Old",
            "version": 1,
            "builtin": False,
            "steps": [
                research_workflows.step("Draft", "agent"),
                research_workflows.step("Review", "review", max_retries=1),
            ],
        }
        project.workflow = old
        project.stage = "workflow"
        project.workflow_state = {
            "current": 1,
            "steps": [
                {"status": "completed", "rounds": 1},
                {"status": "running", "rounds": 1, "retries": 1},
            ],
        }
        actions = research_event(
            d, project, "review_failed", role="advisor", kind="review"
        )
        assert [a["action"] for a in actions] == ["limit"]


def test_rule_posts_reenter_channel_rules_once_without_recursive_dispatch(world):
    app, a, _, settings, _, _, wid, base, overview = world
    destination = next(c["id"] for c in overview["channels"] if c["key"] == "writing")
    post = rule("announce", "post", channel=destination, text="Sources ready")
    listen = rule("listen")
    listen["when"] = {"event": "message", "channel": destination}
    flow(world, [post, listen])
    root = send(world, "Start")
    send(world, "Publish in another channel", thread_id=root["id"])
    with app.state.maker() as d:
        posts = list(
            d.scalars(select(TeamMessage).where(TeamMessage.text == "Sources ready"))
        )
        assert len(posts) == 2 and all(p.thread_id is None for p in posts)
    team.settle(settings, app.state.maker)
    assert len(deliveries(app)) == 1
    team.settle(settings, app.state.maker)
    assert len(deliveries(app)) == 1


def test_switching_workflows_restores_the_teams_saved_rules_and_layout(world):
    _, a, _, _, _, _, _, base, overview = world
    saved = flow(world, [rule("saved-rule")])
    member = overview["members"][0]["id"]
    saved["layout"]["members"][member] = {"x": 100, "y": 200}
    saved = a.put(base + "/workflow", json=saved).json()
    assert (
        a.post(
            base + "/workflow", json={"workflow_id": "literature-review"}
        ).status_code
        == 200
    )
    restored = a.post(base + "/workflow", json={"workflow_id": "research"}).json()
    assert restored["rules"] == saved["rules"]
    assert restored["layout"] == saved["layout"]
    assert restored["version"] == saved["version"]


def test_runtime_marks_completion_time_instead_of_the_placeholder_message_time(world):
    app, a, _, settings, _, _, _, base, _ = world
    flow(world, [rule()])
    send(world, "Start")
    delivery = deliveries(app)[0]
    with app.state.maker() as d:
        response = d.scalar(
            select(TeamMessage).where(
                TeamMessage.source_key == f"run:{delivery.run_id}"
            )
        )
        response.created_at = "2000-01-01T00:00:00Z"
        d.commit()
    finish(app, delivery.run_id, "@writer Continue", ["writer"])
    team.settle(settings, app.state.maker)
    with app.state.maker() as d:
        response = d.scalar(
            select(TeamMessage).where(
                TeamMessage.source_key == f"run:{delivery.run_id}"
            )
        )
        assert response.created_at == d.get(AgentRun, delivery.run_id).updated_at
    fired = a.get(base).json()["runtime"]["fired"]
    assert fired[-1]["rule"] == "@mention"
    assert fired[-1]["at"] > "2000-01-02"


def test_conclusion_handoff_obeys_the_rule_instead_of_the_old_owner_wait(world):
    from backend import (
        research_map,
        research_stages,
        research_worker,
        research_workflows,
    )
    from backend.models import ResearchSprint

    app, _, _, _, owner, model, wid, _, _ = world
    with app.state.maker() as d:
        project = research_map.create_project(d, owner, "Conclusion handoff", "", model)
        project.workspace_id, project.compute_id, project.stage = (
            wid,
            "host",
            "experiments",
        )
        research_workflows.snapshot(d, project, "research")
        workflow = deepcopy(project.workflow)
        wait = next(
            r
            for r in workflow["rules"]
            if r["when"]["event"] == "conclusion_proposed"
            and r["when"].get("from_role") == "advisor"
        )
        wait["then"] = {
            "action": "wake",
            "role": "writer",
            "instruction": "Draft the finding",
        }
        project.workflow = workflow
        sprint = ResearchSprint(
            project_id=project.id,
            number=1,
            role="advisor",
            run_id="no-run",
            status="ended",
            summary="A finding",
        )
        d.add(sprint)
        d.flush()
        research_stages.propose_conclusion(
            d, project, sprint, {"status": "concluded", "summary": "A finding"}
        )
        assert project.status == "active"
        research_worker._plan(app, d, project)
        d.flush()
        queued = list(d.scalars(select(TeamDelivery)))
        assert (
            len(queued) == 1 and d.get(TeamMember, queued[0].member_id).role == "writer"
        )
        assert queued[0].action["rule"] == wait["id"]
        research_worker._plan(app, d, project)
        assert len(list(d.scalars(select(TeamDelivery)))) == 1
