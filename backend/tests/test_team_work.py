"""Derived work and attention: SQLite only, no runtime, network or repository."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend import research_team as team
from backend import team_work
from backend.models import (
    AgentRun,
    AgentSession,
    Base,
    ResearchEvent,
    ResearchProject,
    ResearchSprint,
    ResearchWorkspace,
    TeamChannel,
    TeamDelivery,
    TeamMember,
    TeamMessage,
)
from backend.research_team_routes import install_team_routes


def at(minutes):
    return (datetime(2026, 10, 24, tzinfo=UTC) + timedelta(minutes=minutes)).isoformat()


@pytest.fixture
def work_db(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    monkeypatch.setattr(team_work, "now", lambda: at(120))
    # A projection must not adopt agent files, route messages, or start a worker.
    monkeypatch.setattr(
        team, "ensure", lambda *_: pytest.fail("projection wrote team state")
    )
    with Session(engine, expire_on_commit=False) as d:
        workspace = ResearchWorkspace(
            id="w", owner="owner", name="Team", created_at=at(0)
        )
        d.add(workspace)
        for role in ("human", "writer", "reviewer", "advisor"):
            d.add(AgentSession(id=f"s-{role}", owner="owner", kind="team_member"))
            d.add(
                TeamMember(
                    id=role,
                    workspace_id="w",
                    role=role,
                    name=role,
                    session_id=f"s-{role}",
                )
            )
        d.add_all(
            [
                TeamChannel(
                    id="c", workspace_id="w", key="experiments", name="Experiments"
                ),
                TeamChannel(
                    id="dm",
                    workspace_id="w",
                    key="dm:writer",
                    member_id="writer",
                    name="Writer",
                ),
            ]
        )
        d.commit()
        yield d, workspace
    engine.dispose()


def message(d, identifier, minute=0, **extra):
    row = TeamMessage(
        **(
            {
                "id": identifier,
                "workspace_id": "w",
                "channel_id": "c",
                "thread_id": "thread",
                "author_id": "writer",
                "text": identifier,
                "created_at": at(minute),
            }
            | extra
        )
    )
    d.add(row)
    d.flush()
    return row


def run(d, identifier, status="running", minute=0, **extra):
    row = AgentRun(
        **(
            {
                "id": identifier,
                "owner": "owner",
                "session_id": "s-writer",
                "model_config_id": "offline",
                "model": "Offline",
                "prompt": "Work",
                "status": status,
                "created_at": at(minute),
                "updated_at": at(minute + 5),
                "runtime": {
                    "team": {
                        "workspace_id": "w",
                        "channel_id": "c",
                        "thread_id": identifier,
                        "member_id": "writer",
                    }
                },
            }
            | extra
        )
    )
    d.add(row)
    d.flush()
    return row


def research(d, identifier="research", **extra):
    row = ResearchProject(
        **(
            {
                "id": identifier,
                "workspace_id": "w",
                "owner": "owner",
                "session_id": "s-advisor",
                "question": "Why?",
                "model_config_id": "offline",
                "status": "active",
                "created_at": at(0),
                "updated_at": at(110),
            }
            | extra
        )
    )
    d.add(row)
    d.flush()
    return row


def research_event(d, identifier, minute, action, **extra):
    row = ResearchEvent(
        **(
            {
                "id": identifier,
                "project_id": "research",
                "actor": "advisor",
                "action": action,
                "detail": {"member_id": "advisor"},
                "created_at": at(minute),
            }
            | extra
        )
    )
    d.add(row)
    d.flush()
    return row


def test_team_work_groups_scope_and_read_only(work_db):
    d, workspace = work_db
    message(d, "wait", 10, thread_id="waiting", data={"waiting": True})
    run(
        d,
        "working",
        steps=[
            {"name": "read", "arguments": {"path": "draft.md"}, "status": "running"}
        ],
    )
    run(d, "done", "completed")
    queued = message(d, "queue", 20, thread_id="queued")
    d.add(TeamDelivery(message_id=queued.id, member_id="writer", created_at=at(20)))
    workspace.workflow_state = {
        "threads": {
            json.dumps(["w", "c", "review"]): {
                "workflows": {
                    "flow": {
                        "reviews": {"r": {"pending": True, "reviewer": "reviewer"}}
                    }
                }
            },
            json.dumps(["w", "c", "waiting"]): {"waiting": True},
        }
    }
    # Another owner's runtime cannot leak through even with the same workspace id.
    run(d, "other-owner", owner="other")
    run(
        d,
        "other-workspace",
        runtime={"team": {"workspace_id": "elsewhere", "channel_id": "c"}},
    )
    d.commit()
    statements = []

    def capture(_, __, statement, *args):
        statements.append(statement)

    event.listen(d.bind, "before_cursor_execute", capture)
    try:
        value = team.work_overview(d, workspace)
    finally:
        event.remove(d.bind, "before_cursor_execute", capture)
    assert value["counts"] == {
        "waiting": 1,
        "review": 1,
        "working": 1,
        "queued": 1,
        "done": 1,
    }
    assert [i["group"] for i in value["items"]] == list(team_work.GROUPS)
    items = {i["thread_id"]: i for i in value["items"]}
    assert items["waiting"]["stuck"] == ["owner_wait"]
    assert items["review"]["stuck"] == ["reviewer_absent"]
    assert items["working"]["current_step"]["arguments"]["path"] == "draft.md"
    assert items["working"]["member_ids"] == ["writer"]
    assert items["working"]["elapsed_seconds"] == 7200
    assert items["done"]["elapsed_seconds"] == 300
    assert not d.new and not d.dirty and not d.deleted
    assert all(s.lstrip().upper().startswith("SELECT") for s in statements)


def test_team_work_attention_overlaps_replies_and_duplicate_notices(work_db):
    d, workspace = work_db
    run(
        d,
        "run",
        "completed",
        runtime={
            "team": {
                "workspace_id": "w",
                "channel_id": "c",
                "thread_id": "thread",
                "member_id": "writer",
            }
        },
        updated_at=at(60),
    )
    message(d, "ask-1", 10, data={"waiting": True})
    message(d, "notice", 11, author_id=None, kind="relay_limit", data={"waiting": True})
    message(d, "ask-2", 20, author_id="reviewer", data={"waiting": True})
    message(d, "wrong-thread", 25, author_id="human", thread_id="elsewhere")
    message(d, "answer", 40, author_id="human")
    message(d, "mention", 50, mentions=["human"])
    result = team_work.project(d, workspace)
    total = result["attention"]["total"]
    assert total["asks"] == 2 and total["pending"] == 0
    assert total["median_wait_seconds"] == 1500
    assert total["waiting_seconds"] == 1800  # Overlapping waits counted once.
    assert total["waiting_share"] == 0.5
    assert not total["partial"]
    assert result["items"][0]["group"] == "done"
    assert result["attention"]["members"]["writer"]["asks"] == 1


def test_team_work_research_decisions_plans_and_attribution(work_db):
    d, workspace = work_db
    research(d, stage="conclusion", plan={"approved_at": at(20)})
    research_event(d, "plan", 10, "plan_proposed")
    research_event(d, "question", 30, "decision_requested")
    research_event(
        d,
        "answer",
        50,
        "human_decision",
        actor="human",
        detail={"request_id": "question"},
    )
    research_event(
        d,
        "conclusion",
        60,
        "decision_requested",
        detail={"kind": "conclusion", "member_id": "advisor"},
    )
    result = team_work.project(d, workspace)
    total = result["attention"]["total"]
    assert total["asks"] == 3 and total["pending"] == 1
    assert total["median_wait_seconds"] == 900
    assert total["waiting_seconds"] == 5400
    assert total["waiting_share"] == 0.75
    assert not total["partial"]
    assert result["attention"]["researches"][0]["asks"] == 3
    assert result["attention"]["members"]["advisor"]["asks"] == 3
    assert result["items"][0]["thread_id"] == "research:research"
    assert result["items"][0]["group"] == "waiting"
    # Missing identity is reported rather than silently asserted from a role.
    research_event(d, "unknown", 70, "decision_requested", actor="system", detail={})
    partial = team_work.project(d, workspace)["attention"]
    assert partial["total"]["partial"]
    assert partial["researches"][0]["partial"]
    assert partial["members"]["advisor"]["partial"]


def test_team_work_sprint_identity_and_completed_research(work_db):
    d, workspace = work_db
    research(d, status="finished", updated_at=at(90))
    r = run(
        d,
        "native",
        "completed",
        runtime={"research": {"project_id": "research", "member_id": "advisor"}},
    )
    d.add(
        ResearchSprint(
            id="sprint", project_id="research", number=1, run_id=r.id, role="advisor"
        )
    )
    research_event(
        d,
        "asked",
        20,
        "decision_requested",
        actor="system",
        sprint_id="sprint",
        detail={"kind": "conclusion"},
    )
    result = team_work.project(d, workspace)
    stats = result["attention"]["members"]["advisor"]
    assert stats["asks"] == 1 and stats["pending"] == 0
    assert stats[
        "partial"
    ]  # Finish only gives an upper bound for an unrecorded answer.
    assert stats["median_wait_seconds"] is None
    assert result["items"][0]["group"] == "done"


def test_team_work_failed_retry_and_reviewer_presence(work_db):
    d, workspace = work_db
    run(d, "failure", "failed")
    workspace.workflow_state = {
        "threads": {
            json.dumps(["w", "c", "review"]): {
                "workflows": {
                    "flow": {
                        "reviews": {"r": {"pending": True, "reviewer": "reviewer"}}
                    }
                }
            }
        }
    }
    reviewer = run(
        d,
        "reviewer-run",
        session_id="s-reviewer",
        runtime={
            "team": {
                "workspace_id": "w",
                "channel_id": "c",
                "thread_id": "review",
                "member_id": "reviewer",
            }
        },
    )
    result = team_work.project(d, workspace)
    items = {i["thread_id"]: i for i in result["items"]}
    assert items["failure"]["stuck"] == ["failed"]
    assert items["review"]["group"] == "review" and not items["review"]["stuck"]
    run(
        d,
        "retry",
        "completed",
        minute=10,
        runtime={
            "team": {
                "workspace_id": "w",
                "channel_id": "c",
                "thread_id": "failure",
                "member_id": "writer",
            }
        },
    )
    reviewer.status = "queued"
    items = {i["thread_id"]: i for i in team_work.project(d, workspace)["items"]}
    assert items["failure"]["group"] == "done" and not items["failure"]["stuck"]
    assert items["review"]["stuck"] == ["reviewer_absent"]


def test_team_work_api_ownership_and_empty_projection(work_db):
    d, workspace = work_db
    app = FastAPI()

    def db():
        yield d

    def workspace_of(session, identifier, owner):
        if identifier != workspace.id or workspace.owner != owner:
            raise HTTPException(404)
        return workspace

    install_team_routes(app, None, db, lambda: "owner", workspace_of)
    with TestClient(app) as client:
        response = client.get("/api/v1/research/workspaces/w/team/work")
        assert response.status_code == 200
        assert response.json()["items"] == []
        assert response.json()["attention"]["total"]["asks"] == 0
        assert (
            client.get("/api/v1/research/workspaces/other/team/work").status_code == 404
        )


def test_team_work_cross_channel_handoff_keeps_wait_scope(work_db):
    d, workspace = work_db
    message(
        d,
        "ask",
        10,
        channel_id="dm",
        thread_id=None,
        data={"waiting": True, "routing_scope": ["w", "c", "thread"]},
    )
    message(d, "reply", 20, author_id="human")
    result = team_work.project(d, workspace)
    assert result["attention"]["total"]["asks"] == 1
    assert result["attention"]["total"]["pending"] == 0
    assert result["attention"]["total"]["median_wait_seconds"] == 600
    assert result["counts"]["waiting"] == 0


def test_team_work_unknown_wait_and_revised_plan_are_partial(work_db):
    d, workspace = work_db
    workspace.workflow_state = {
        "threads": {json.dumps(["w", "c", None]): {"waiting": True}}
    }
    result = team_work.project(d, workspace)
    assert result["counts"]["waiting"] == 1
    assert result["attention"]["total"]["partial"]
    research(d, stage="scoping", plan={})
    research_event(d, "plan-1", 10, "plan_proposed")
    research_event(d, "plan-2", 20, "plan_proposed")
    stats = team_work.project(d, workspace)["attention"]["researches"][0]
    assert stats["asks"] == 2 and stats["pending"] == 1
    assert stats["partial"]
    assert stats["median_wait_seconds"] is None


def test_team_work_independent_decisions_at_same_time_are_counted(work_db):
    d, workspace = work_db
    research(d)
    research_event(d, "question-a", 10, "decision_requested")
    research_event(d, "question-b", 10, "decision_requested")
    assert team_work.project(d, workspace)["attention"]["total"]["asks"] == 2


def test_team_work_legacy_session_and_completed_retry_delivery(work_db):
    d, workspace = work_db
    d.add(
        AgentSession(
            id="old-session", owner="owner", workspace_id="w", kind="project_chat"
        )
    )
    d.add(
        TeamChannel(
            id="advisor-dm",
            workspace_id="w",
            key="dm:advisor",
            member_id="advisor",
            name="Advisor",
        )
    )
    run(d, "old-run", session_id="old-session", runtime={})
    failed = message(d, "old-request", thread_id="retry")
    d.add(
        TeamDelivery(
            message_id=failed.id, member_id="writer", status="failed", created_at=at(0)
        )
    )
    run(
        d,
        "new-run",
        "completed",
        minute=10,
        runtime={
            "team": {
                "workspace_id": "w",
                "channel_id": "c",
                "thread_id": "retry",
                "member_id": "writer",
            }
        },
    )
    items = team_work.project(d, workspace)["items"]
    legacy = next(item for item in items if item["channel_id"] == "advisor-dm")
    assert legacy["group"] == "working" and legacy["member_ids"] == ["advisor"]
    retry = next(item for item in items if item["thread_id"] == "retry")
    assert retry["group"] == "done" and not retry["stuck"]


def test_team_work_research_approval_releases_message_wait(work_db):
    d, workspace = work_db
    project = research(d)
    message(d, "team-wait", 10, thread_id="research:research", data={"waiting": True})
    research_event(
        d,
        "approval",
        20,
        "stage_changed",
        actor="human",
        detail={"from": "scoping", "to": "experiments"},
    )
    stats = team_work.project(d, workspace)["attention"]["researches"][0]
    assert stats["asks"] == 1 and stats["pending"] == 0
    assert stats["median_wait_seconds"] == 600
    message(d, "unanswered", 30, thread_id="research:research", data={"waiting": True})
    project.status, project.updated_at = "finished", at(40)
    stats = team_work.project(d, workspace)["attention"]["researches"][0]
    assert stats["asks"] == 2 and stats["pending"] == 0
    assert stats["partial"]
    assert stats["median_wait_seconds"] == 600
