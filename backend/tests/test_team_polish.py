"""Real team regressions, using fake providers and local temporary repositories."""

import asyncio
import math
import importlib
from datetime import UTC, datetime, timedelta

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select, text

from backend import academic_search, team_rules
from backend import research_team as team
from backend.agent_tools import execute
from backend.models import (
    AgentControl,
    AgentRun,
    ModelUsage,
    ResearchWorkspace,
    TeamMember,
    TeamMessage,
)
from backend.tests.test_acceptance import env as cloud_env  # noqa: F401
from backend.tests.test_research_routes import env  # noqa: F401
from backend.tests.test_research_team import deliveries, finish, send, world  # noqa: F401
from backend.tests.test_team_rules import event, members, scope, workflow  # noqa: F401


def call(world, run_id, name, args):
    app, _, _, _, owner, *_ = world
    with app.state.maker() as d:
        run = d.get(AgentRun, run_id)
        run.status = "running"
        session = run.session_id
        d.commit()
    return asyncio.run(
        execute(app, owner, session, name, args, "polish", sandbox_id=run_id)
    )


def test_all_mentions_and_language_at_front(world):
    app, _, _, _, _, _, wid, *_ = world
    send(world, "@writer 写引言，做完交给 @文献员，然后 @评审")
    rows = deliveries(app)
    assert len(rows) == 3
    with app.state.maker() as d:
        assert d.get(TeamMember, rows[0].member_id).role == "writer"
        run = d.get(AgentRun, rows[0].run_id)
        assert "做完交给 @文献员" in run.prompt
        assert run.context.startswith("## 语言\n用中文")
        assert run.runtime["team"]["thread_id"] is None
    send(world, "Please continue in English.")
    with app.state.maker() as d:
        assert team.language_part(d, d.get(ResearchWorkspace, wid)).startswith(
            "## Language"
        )


def test_agent_wakes_everyone_named_without_a_cap(members):
    flow, state = workflow(), {}
    actions, state = team_rules.match(
        flow,
        event(
            members,
            "executor",
            mentions=["m-writer", "m-librarian", "m-reviewer", "m-advisor"],
        ),
        state,
        members=members,
    )
    assert [a["member"] for a in actions] == [
        "m-writer",
        "m-librarian",
        "m-reviewer",
        "m-advisor",
    ]
    for _ in range(30):
        actions, state = team_rules.match(
            flow,
            event(members, "writer", mentions=["m-reviewer", "m-executor"]),
            state,
            members=members,
        )
        assert len(actions) == 2
    assert not scope(state)["waiting"]


def test_merge_unstarted_wakes_in_thread_and_keep_all_requests(world):
    app, _, _, settings, *_ = world
    send(world, "@writer busy elsewhere")
    root = send(world, "Thread")
    send(world, "@writer first queued task", thread_id=root["id"])
    send(world, "@writer add references", thread_id=root["id"])
    rows = deliveries(app)
    assert len(rows) == 2 and rows[-1].status == "queued"
    finish(app, rows[0].run_id, "done")
    team.settle(settings, app.state.maker)
    with app.state.maker() as d:
        run = d.get(AgentRun, deliveries(app)[-1].run_id)
        assert "first queued task" in run.prompt and "add references" in run.prompt
        state = d.get(ResearchWorkspace, world[6]).workflow_state
        matching = [s for k, s in state["threads"].items() if root["id"] in k]
        assert matching[0]["relay"] == 0 or matching[0]["relay"] == 1


def test_merge_a_run_created_but_not_claimed_by_worker(world):
    app, *_ = world
    send(world, "@writer first request")
    send(world, "@writer add citations")
    assert len(deliveries(app)) == 1
    with app.state.maker() as d:
        run = d.get(AgentRun, deliveries(app)[0].run_id)
        assert run.status == "queued"
        assert "first request" in run.prompt and "add citations" in run.prompt


def test_merged_wake_retains_attachments_and_rule_instructions(world):
    from backend.models import TeamChannel

    app, _, _, settings, *_ = world
    send(world, "@writer busy elsewhere")
    with app.state.maker() as d:
        d.get(AgentRun, deliveries(app)[0].run_id).status = "running"
        d.commit()
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, world[6])
        channel = d.get(
            TeamChannel,
            next(c["id"] for c in world[8]["channels"] if c["key"] == "general"),
        )
        root = team.post(
            d,
            workspace,
            channel,
            "@writer first requirement",
            data={"attachments": [{"id": "first-file"}]},
        )
        pending = d.scalar(
            select(team.TeamDelivery).where(team.TeamDelivery.message_id == root.id)
        )
        pending.action = {**pending.action, "instruction": "Keep the evidence"}
        team.post(
            d,
            workspace,
            channel,
            "@writer second requirement",
            data={"attachments": [{"id": "second-file"}]},
        )
        d.commit()
    finish(app, deliveries(app)[0].run_id, "done")
    team.settle(settings, app.state.maker)
    assert len(deliveries(app)) == 2
    with app.state.maker() as d:
        run = d.get(AgentRun, deliveries(app)[-1].run_id)
        assert set(run.attachment_ids) == {"first-file", "second-file"}
        assert all(
            text in run.prompt
            for text in ["first requirement", "second requirement", "Keep the evidence"]
        )


def test_agent_handoff_merges_into_members_unclaimed_run(world):
    app, _, _, settings, *_ = world
    send(world, "@librarian @writer find and write")
    with app.state.maker() as d:
        rows = {d.get(TeamMember, r.member_id).role: r for r in deliveries(app)}
    call(
        world,
        rows["librarian"].run_id,
        "team_send_message",
        {"text": "@writer use these references", "to": ["writer"]},
    )
    finish(app, rows["librarian"].run_id, "@writer use these references")
    team.settle(settings, app.state.maker)
    assert len(deliveries(app)) == 2
    with app.state.maker() as d:
        writer = d.get(AgentRun, rows["writer"].run_id)
        assert "use these references" in writer.prompt


def test_placeholder_filled_and_routed_once(world):
    app, a, _, settings, *_ = world
    send(world, "@librarian find papers")
    row = deliveries(app)[0]
    result = call(
        world,
        row.run_id,
        "team_send_message",
        {"text": "找到了论文，@writer 请写引言", "to": ["@writer"]},
    )
    finish(app, row.run_id, "找到了论文，@writer 请写引言")
    team.settle(settings, app.state.maker)
    team.settle(settings, app.state.maker)
    with app.state.maker() as d:
        replies = list(
            d.scalars(select(TeamMessage).where(TeamMessage.author_id == row.member_id))
        )
        assert len(replies) == 1 and replies[0].id == result["message_id"]
        assert replies[0].thread_id is None and replies[0].text
    assert len(deliveries(app)) == 2
    queued = a.get(world[7] + "/deliveries").json()
    assert not queued  # Agent deliveries never appear above the human composer.


def test_cross_channel_post_links_back_and_uses_origin_relay(world):
    app, a, _, settings, *_ = world
    root = send(world, "@librarian find papers")
    row = deliveries(app)[0]
    writing = next(c for c in world[8]["channels"] if c["key"] == "writing")
    result = call(
        world,
        row.run_id,
        "team_send_message",
        {"channel_id": writing["id"], "text": "@writer draft"},
    )
    finish(app, row.run_id, "已发到写作频道")
    team.settle(settings, app.state.maker)
    with app.state.maker() as d:
        response = d.scalar(
            select(TeamMessage).where(TeamMessage.source_key == f"run:{row.run_id}")
        )
        assert response.thread_id is None
        assert response.data["links"][0]["thread_id"] == result["message_id"]
        next_run = d.get(AgentRun, deliveries(app)[-1].run_id)
        assert next_run.runtime["team"]["routing_scope"] == [
            world[6],
            root["channel_id"],
            None,
        ]


def test_advisor_direction_does_not_implicitly_wait(world):
    app, _, _, settings, *_ = world
    root = send(world, "@advisor review")
    row = deliveries(app)[0]
    finish(
        app,
        row.run_id,
        "决定转向另一套方法。@writer @executor 重新开始",
        ["writer", "executor"],
    )
    team.settle(settings, app.state.maker)
    assert len(deliveries(app)) == 3
    with app.state.maker() as d:
        assert not any(
            s["waiting"]
            for s in d.get(ResearchWorkspace, world[6])
            .workflow_state["threads"]
            .values()
        )
        waits = list(
            d.scalars(select(TeamMessage).where(TeamMessage.kind == "relay_limit"))
        )
        assert not waits


def test_explicit_question_pauses_and_notifies_owner(world):
    app, a, _, settings, *_ = world
    send(world, "@advisor review")
    row = deliveries(app)[0]
    call(world, row.run_id, "team_wait_for_owner", {"text": "改用另一套方法吗？"})
    finish(app, row.run_id, "改用另一套方法吗？")
    team.settle(settings, app.state.maker)
    assert len(deliveries(app)) == 1
    assert any(
        m["kind"] == "relay_limit" and m["data"]["waiting"]
        for m in a.get(world[7]).json()["notifications"]
    )
    assert next(
        m for m in a.get(world[7]).json()["members"] if m["role"] == "human"
    )["status"] == "waiting"
    send(world, "@writer 按这个方向写")
    assert len(deliveries(app)) == 2
    assert next(
        m for m in a.get(world[7]).json()["members"] if m["role"] == "human"
    )["status"] == "idle"


def test_failed_empty_and_time_limited_output(world, monkeypatch):
    from backend import agent_worker, research_repo
    from backend.team_workspace import workdir

    app, a, b, settings, _, _, wid, base, _ = world
    root = send(world, "@writer 写引言")
    row = deliveries(app)[0]
    monkeypatch.setenv("AGENT_NODE", "/usr/bin/false")
    with app.state.maker() as d:
        d.get(AgentRun, row.run_id).status = "running"
        d.commit()
    agent_worker.process(app, row.run_id)  # Fails locally before any provider call.
    call(
        world,
        row.run_id,
        "write",
        {"path": "drafts/intro.md", "content": "# 引言\n\n已经写好的内容"},
    )
    with app.state.maker() as d:
        run = d.get(AgentRun, row.run_id)
        assert agent_worker.execution_seconds(run) == math.inf
        run.status, run.error = "failed", "timeout"
        run.runtime = {**run.runtime, "time_limit_reached": True}
        d.commit()
    team.settle(settings, app.state.maker)
    with app.state.maker() as d:
        response = d.scalar(
            select(TeamMessage).where(TeamMessage.source_key == f"run:{row.run_id}")
        )
        assert response.data["files"] == [
            {"path": "drafts/intro.md", "name": "intro.md"}
        ]
        assert response.data["commit"]
        path = workdir(settings, d.get(ResearchWorkspace, wid))
        assert research_repo.git(path, "status", "--porcelain").stdout == ""
        response_id = response.id
    assert (
        a.get(base + "/file", params={"path": "drafts/intro.md"})
        .json()["content"]
        .startswith("# 引言")
    )
    assert (
        a.get(base + "/file", params={"path": "../repo/PROJECT.md"}).status_code == 400
    )
    assert a.get(base + "/file", params={"path": ".git"}).status_code == 404
    assert b.get(base + "/file", params={"path": "drafts/intro.md"}).status_code == 404
    assert a.get(base + "/deliveries").json() == []
    endpoint = base + f"/messages/{response_id}/continue"
    assert a.post(endpoint, json={}).status_code == 200
    assert a.post(endpoint, json={}).status_code == 200
    assert len(deliveries(app)) == 2
    assert deliveries(app)[-1].status == "running"


def test_academic_search_fake_responses_and_clear_errors(monkeypatch):
    monkeypatch.setattr(
        academic_search.discovery,
        "fetch_arxiv",
        lambda terms: [
            {
                "external_id": "arxiv:2301.12345",
                "title": "Arxiv result",
                "authors": "A; B",
                "abstract": "Summary",
                "published": "2023-01-01",
                "url": "https://arxiv.org/abs/2301.12345",
            }
        ],
    )

    def fake(url, params):
        assert params.get("query", params.get("search")) == "optimization"
        if "openalex" in url:
            return {
                "results": [
                    {
                        "title": "OpenAlex result",
                        "publication_year": 2024,
                        "cited_by_count": 17,
                        "authorships": [{"author": {"display_name": "C"}}],
                        "abstract_inverted_index": {"Abstract": [0]},
                        "doi": "https://doi.org/10.1000/example",
                    }
                ]
            }
        return {
            "data": [
                {
                    "title": "Scholar result",
                    "year": 2025,
                    "authors": [{"name": "D"}],
                    "abstract": "S2 abstract",
                    "citationCount": 42,
                    "url": "https://www.semanticscholar.org/paper/example",
                }
            ]
        }

    monkeypatch.setattr(academic_search.scholar, "_json", fake)
    result = academic_search.search("optimization")
    assert len(result["papers"]) == 3 and not result["errors"]
    assert result["papers"][0]["authors"] == ["A", "B"]
    assert [p["citation_count"] for p in result["papers"]] == [None, 17, 42]

    def offline(*args):
        raise academic_search.scholar.ScholarUnavailable("offline")

    monkeypatch.setattr(academic_search.scholar, "_json", offline)
    assert academic_search.search("optimization")["errors"]
    monkeypatch.setattr(academic_search.discovery, "fetch_arxiv", offline)
    with pytest.raises(ValueError, match="Academic search failed.*offline"):
        academic_search.search("optimization")


def test_search_import_is_owned_idempotent_and_offline(world, monkeypatch):
    app, a, b, *_ = world
    send(world, "@librarian 找论文")
    run_id = deliveries(app)[0].run_id
    monkeypatch.setattr(
        academic_search,
        "search",
        lambda *args: {
            "papers": [
                {
                    "title": "Optimization paper",
                    "authors": ["Alice"],
                    "abstract": "Summary",
                    "year": 2025,
                    "citation_count": 6,
                    "doi": "10.1000/example",
                    "arxiv": "",
                    "url": "https://doi.org/10.1000/example",
                }
            ],
            "errors": [],
        },
    )
    found = call(world, run_id, "team_search_papers", {"query": "optimization"})
    imported = call(
        world, run_id, "team_import_paper", {"id": found["papers"][0]["id"]}
    )
    again = call(world, run_id, "team_import_paper", {"id": found["papers"][0]["id"]})
    assert imported["id"] == again["id"]
    assert a.get("/api/v1/papers/" + imported["id"]).json()["authors"] == "Alice"
    assert b.get("/api/v1/papers/" + imported["id"]).status_code == 404


def test_migration_boundary_and_file_definitions_unchanged(world):
    app, _, _, _, _, _, wid, *_ = world
    migration = importlib.import_module("backend.migrations.versions.0048_team_polish")
    with app.state.engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            migration.downgrade()
            before = datetime.now(UTC).isoformat()
            migration.upgrade()
        import json

        boundary = json.loads(
            conn.execute(
                text("SELECT workflow_state FROM research_workspaces WHERE id=:id"),
                {"id": wid},
            ).scalar_one()
        )["job_notifications_after"]
        assert boundary >= before
        from sqlalchemy import inspect

        columns = {c["name"] for c in inspect(conn).get_columns("team_members")}
        assert not {"max_execution_seconds", "max_model_turns"} & columns
        assert (
            "relay_limit"
            not in json.loads(
                conn.execute(
                    text("SELECT workflow_state FROM research_workspaces WHERE id=:id"),
                    {"id": wid},
                ).scalar_one()
            )["budget"]
        )
        # Repeating the upgrade must retain the original boundary and user settings.
        with Operations.context(MigrationContext.configure(conn)):
            migration.upgrade()
        assert (
            json.loads(
                conn.execute(
                    text("SELECT workflow_state FROM research_workspaces WHERE id=:id"),
                    {"id": wid},
                ).scalar_one()
            )["job_notifications_after"]
            == boundary
        )


def test_team_limits_queue_notify_once_resume_and_isolate(world):
    app, a, b, settings, *_ = world
    base = world[7]
    budget = {
        "max_tokens": 100,
        "period_hours": 24,
        "max_concurrent": 1,
    }
    assert b.put(base + "/budget", json=budget).status_code == 404
    assert (
        a.put(base + "/budget", json={**budget, "max_concurrent": -1}).status_code
        == 422
    )
    assert a.put(base + "/budget", json=budget).status_code == 200
    send(world, "@writer @librarian find and write")
    assert sorted(r.status for r in deliveries(app)) == ["queued", "running"]
    team.settle(settings, app.state.maker)
    team.settle(settings, app.state.maker)
    with app.state.maker() as d:
        notes = list(d.scalars(select(TeamMessage).where(TeamMessage.kind == "budget")))
        assert len(notes) == 1 and notes[0].thread_id is None
    assert any(
        m["data"].get("reason") == "concurrent"
        for m in a.get(base).json()["notifications"]
    )
    first = next(r for r in deliveries(app) if r.status == "running")
    pending = next(r for r in deliveries(app) if r.status == "queued")
    with app.state.maker() as d:
        d.add(
            ModelUsage(
                owner=world[4],
                source="agent",
                task_id=first.run_id,
                model="fake",
                total_tokens=101,
                status="completed",
            )
        )
        d.commit()
    finish(app, first.run_id, "done")
    team.settle(settings, app.state.maker)
    assert next(r for r in deliveries(app) if r.id == pending.id).status == "queued"
    assert a.get(base).json()["tokens"] == 101
    with app.state.maker() as d:
        usage = d.scalar(select(ModelUsage).where(ModelUsage.task_id == first.run_id))
        usage.created_at = (datetime.now(UTC) - timedelta(hours=25)).isoformat()
        d.commit()
    team.settle(settings, app.state.maker)
    assert next(r for r in deliveries(app) if r.id == pending.id).status == "running"


def test_member_budget_enforcement_uses_run_receipts_and_continue(world):
    from backend.team_budgets import run_limit

    app, a, b, _, *_ = world
    member = next(m for m in world[8]["members"] if m["role"] == "writer")
    url = world[7] + "/members/" + member["id"]
    from backend.agent_files import parse, render

    source = render(
        {
            **parse(member["source"]),
            "wake_turns": 7,
            "wake_tokens": 50,
            "wake_minutes": 30,
        },
        member["source"],
    )
    assert b.patch(url, json={"source": source}).status_code == 404
    assert a.patch(url, json={"source": source}).status_code == 200
    send(world, "@writer draft")
    row = deliveries(app)[0]
    with app.state.maker() as d:
        run = d.get(AgentRun, row.run_id)
        assert run.runtime["max_execution_seconds"] == 1800
        assert run.runtime["max_model_turns"] == 7
        assert run_limit(d, run) is None
        d.add(
            ModelUsage(
                owner=world[4],
                source="agent",
                task_id=run.id,
                model="fake",
                total_tokens=51,
                status="completed",
            )
        )
        d.flush()
        assert run_limit(d, run) == "member_tokens"


def test_merged_wake_can_be_sent_immediately(world):
    app, *_ = world
    send(world, "@writer busy")
    with app.state.maker() as d:
        d.get(AgentRun, deliveries(app)[0].run_id).status = "running"
        d.commit()
    send(world, "@writer queued")
    send(world, "@writer urgent clarification", mode="immediate")
    rows = deliveries(app)
    assert len(rows) == 2 and rows[1].status == "steering"
    with app.state.maker() as d:
        control = d.get(AgentControl, rows[1].control_id)
        assert "queued" in control.text and "urgent clarification" in control.text


def test_literature_tools_follow_permission_group(world, monkeypatch):
    from backend.research_team_tools import TEAM_TOOLS, definitions
    from backend.tests.test_agent_files import SOURCE, add, path_of

    mid = add(world)
    send(world, "@Ada find papers")
    run_id = deliveries(world[0])[0].run_id
    with pytest.raises(ValueError, match="permission denied"):
        call(world, run_id, "team_search_papers", {"query": "optimization"})
    with world[0].state.maker() as d:
        member = d.get(TeamMember, mid)
        assert "team_search_papers" not in {
            t["name"] for t in definitions(member.role, TEAM_TOOLS, member)
        }
    path_of(world, mid).write_text(
        SOURCE.replace("[files, web]", "[files, web, literature]")
    )
    monkeypatch.setattr(
        academic_search, "search", lambda *args: {"papers": [], "errors": []}
    )
    assert call(world, run_id, "team_search_papers", {"query": "optimization"}) == {
        "papers": [],
        "errors": [],
    }
    with world[0].state.maker() as d:
        member = d.get(TeamMember, mid)
        assert {"team_search_papers", "team_import_paper"} <= {
            t["name"] for t in definitions(member.role, TEAM_TOOLS, member)
        }


def test_old_jobs_stay_silent_and_running_jobs_notify_when_finished(world):
    from backend import research_map
    from backend.models import ResearchJob, ResearchSprint

    app, _, _, settings, owner, model, wid, *_ = world
    boundary = datetime.now(UTC)
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, wid)
        workspace.workflow_state = {
            **workspace.workflow_state,
            "job_notifications_after": boundary.isoformat(),
        }
        project = research_map.create_project(d, owner, "Question", "", model)
        project.workspace_id = wid
        sprint = ResearchSprint(project_id=project.id, number=1, run_id="old")
        d.add(sprint)
        d.flush()
        for identifier, status, finished in [
            ("historical", "succeeded", (boundary - timedelta(days=1)).isoformat()),
            ("in-flight", "running", None),
        ]:
            d.add(
                ResearchJob(
                    id=identifier,
                    project_id=project.id,
                    sprint_id=sprint.id,
                    node_id=research_map.root(d, project).id,
                    command="fake",
                    status=status,
                    finished_at=finished,
                )
            )
        d.commit()
    team.settle(settings, app.state.maker)
    with app.state.maker() as d:
        assert not list(d.scalars(select(TeamMessage).where(TeamMessage.kind == "job")))
        job = d.get(ResearchJob, "in-flight")
        job.status, job.finished_at = "succeeded", team.now()
        d.commit()
    team.settle(settings, app.state.maker)
    team.settle(settings, app.state.maker)
    with app.state.maker() as d:
        notes = list(d.scalars(select(TeamMessage).where(TeamMessage.kind == "job")))
        assert len(notes) == 1 and notes[0].data["job_id"] == "in-flight"


def test_finished_empty_placeholder_stays_completed(world):
    app, a, _, settings, *_ = world
    root = send(world, "@writer draft")
    finish(app, deliveries(app)[0].run_id, "")
    team.settle(settings, app.state.maker)
    rows = a.get(
        world[7] + f"/channels/{root['channel_id']}/messages",
    ).json()["messages"]
    rows = [m for m in rows if m.get("run")]
    assert len(rows) == 1
    assert rows[0]["text"] == ""
    assert rows[0]["run"]["status"] == "completed"
    assert not rows[0]["run"]["error"]
    assert not rows[0]["run"]["runtime"].get("no_answer")


def test_queued_run_reads_external_file_budget_at_start(world, tmp_path, monkeypatch):
    import json
    from pathlib import Path

    from backend import agent_files, agent_worker, research_repo
    from backend.team_workspace import workdir

    app, _, _, settings, _, _, wid, *_ = world
    send(world, "@writer draft")
    row = deliveries(app)[0]
    with app.state.maker() as d:
        member = d.get(TeamMember, row.member_id)
        source, values = agent_files.read_member(member)
        path = research_repo.repo_dir(settings, wid) / member.file_path
        path.write_text(
            agent_files.render(
                {
                    **values,
                    "wake_turns": 55,
                    "wake_tokens": 7000,
                    "wake_minutes": 33,
                    "role_description": "# Fresh role",
                },
                source,
            )
        )
        run = d.get(AgentRun, row.run_id)
        assert agent_worker.execution_seconds(run) == 1980
        run.status = "running"
        d.commit()
    captured = tmp_path / "payload.json"
    node = tmp_path / "fake-node"
    node.write_text(f"""#!{Path(".venv/bin/python").resolve()}
import json, sys
payload = json.loads(sys.stdin.readline())
open({str(captured)!r}, 'w').write(json.dumps(payload))
print(json.dumps({{"type":"done"}}), flush=True)
""")
    node.chmod(0o755)
    monkeypatch.setenv("AGENT_NODE", str(node))
    agent_worker.process(app, row.run_id)
    payload = json.loads(captured.read_text())
    assert payload["limits"]["model_turns"] == 55
    assert payload["limits"]["tool_calls"] == 0
    assert (
        "# Fresh role" in payload["system_prompt"]
        and "# Fresh role" in payload["context"]
    )
    assert "# Research writer" not in payload["context"]
    with app.state.maker() as d:
        run = d.get(AgentRun, row.run_id)
        assert run.runtime["max_execution_seconds"] == 1980
        assert run.runtime["max_tokens"] == 7000
        assert payload["tool_cwd"] == str(
            workdir(settings, d.get(ResearchWorkspace, wid)).resolve()
        )


def test_time_guard_preserves_partial_answer_and_notifies_owner(
    world, tmp_path, monkeypatch
):
    from pathlib import Path

    from backend import agent_worker

    app, a, _, settings, *_ = world
    send(world, "@writer draft")
    row = deliveries(app)[0]
    with app.state.maker() as d:
        d.get(AgentRun, row.run_id).status = "running"
        d.commit()
    received = []
    original = agent_worker.RunBudget

    def short_budget(execution, waiting):
        received.append(execution)
        return original(1, waiting)

    monkeypatch.setattr(agent_worker, "RunBudget", short_budget)
    node = tmp_path / "fake-node"
    node.write_text(f"""#!{Path(".venv/bin/python").resolve()}
import json, sys, time
sys.stdin.readline()
print(json.dumps({{"type":"delta", "text":"Saved partial draft"}}), flush=True)
time.sleep(3)
""")
    node.chmod(0o755)
    monkeypatch.setenv("AGENT_NODE", str(node))
    agent_worker.process(app, row.run_id)
    assert received == [math.inf]
    team.settle(settings, app.state.maker)
    notifications = a.get(world[7]).json()["notifications"]
    reply = next(m for m in notifications if m["data"].get("run_id") == row.run_id)
    assert reply["text"] == "Saved partial draft"
    assert reply["run"]["status"] == "failed"
    assert reply["run"]["runtime"]["time_limit_reached"]
    assert (
        a.post(world[7] + f"/messages/{reply['id']}/continue", json={}).status_code
        == 200
    )


def test_native_research_counts_before_worker_and_reads_file_duration(world):
    from backend import agent_worker, research_map
    from backend.models import AgentSession
    from backend.team_budgets import tokens, working

    app, _, _, _, owner, model, wid, *_ = world
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, wid)
        workspace.workflow_state = {
            **workspace.workflow_state,
            "budget": {"max_tokens": 100, "max_concurrent": 1},
        }
        project = research_map.create_project(d, owner, "Question", "", model)
        project.workspace_id = wid
        d.get(AgentSession, project.session_id).workspace_id = None
        run = AgentRun(
            owner=owner,
            session_id=project.session_id,
            model_config_id=model,
            model="fake",
            prompt="work",
            runtime={"research": {"project_id": project.id, "role": "executor"}},
        )
        d.add(run)
        d.flush()
        assert working(d, workspace) == 1
        assert agent_worker.execution_seconds(run) == math.inf
        assert not team.available(d, project, "writer")
        d.add(
            ModelUsage(
                owner=owner,
                source="agent",
                task_id=run.id,
                model="fake",
                total_tokens=101,
                status="completed",
            )
        )
        d.flush()
        assert tokens(d, workspace=workspace) == 101
        assert not team.available(d, project, "writer")
        assert {
            m.data["reason"]
            for m in d.scalars(select(TeamMessage).where(TeamMessage.kind == "budget"))
        } == {"concurrent", "team_tokens"}


def test_agent_mentions_only_refer_and_to_wakes(world):
    app, _, _, settings, *_ = world
    send(world, "@writer who found the papers?")
    row = deliveries(app)[0]
    call(
        world,
        row.run_id,
        "team_send_message",
        {"text": "@librarian found them; ask @reviewer?", "to": ["writer"]},
    )
    finish(app, row.run_id, "@librarian found them; ask @reviewer?")
    team.settle(settings, app.state.maker)
    assert len(deliveries(app)) == 1


def test_wake_names_who_works_next_and_never_the_researcher(world):
    app, _, _, settings, *_ = world
    send(world, "@librarian find a paper")
    row = deliveries(app)[0]
    call(
        world,
        row.run_id,
        "team_send_message",
        {"text": "Found it", "wake": ["writer", "研究者", "human", "librarian"]},
    )
    finish(app, row.run_id, "Found it")
    team.settle(settings, app.state.maker)
    with app.state.maker() as d:
        woken = [d.get(TeamMember, r.member_id).role for r in deliveries(app)[1:]]
    assert woken == ["writer"]
