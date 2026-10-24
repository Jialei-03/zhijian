"""Presence and catch-up: isolated SQLite, no worker, models, network or Git."""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from backend import agent_state
from backend import research_team as team
from backend.models import (
    AgentRun,
    AgentSession,
    Base,
    ResearchProject,
    ResearchSprint,
    ResearchWorkspace,
    TeamChannel,
    TeamDelivery,
    TeamMember,
    TeamMessage,
)
from backend.research_team_routes import install_team_routes
from backend.team_catchup import summary
from backend.team_presence import presence, recent_files


def at(minute):
    return f"2026-10-24T10:{minute:02d}:00+00:00"


@pytest.fixture
def colleagues(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'colleagues.db'}")
    Base.metadata.create_all(engine)
    maker = sessionmaker(engine)
    monkeypatch.setattr(team, "now", lambda: at(30))
    monkeypatch.setattr(agent_state, "now", lambda: at(30))
    # Definitions are irrelevant here; prevent repository adoption even by accident.
    monkeypatch.setattr(
        team,
        "ensure",
        lambda d, w: list(
            d.scalars(select(TeamMember).where(TeamMember.workspace_id == w.id))
        ),
    )
    with maker() as d:
        workspace = ResearchWorkspace(
            id="workspace",
            owner="owner",
            name="Team",
            model_config_id="default",
            created_at=at(0),
        )
        d.add(workspace)
        d.add(
            AgentSession(
                id="session",
                owner="owner",
                workspace_id=workspace.id,
                kind="team_member",
            )
        )
        d.add_all(
            [
                TeamMember(
                    id="member",
                    workspace_id=workspace.id,
                    role="writer",
                    name="Ada",
                    session_id="session",
                    max_tokens=0,
                ),
                TeamMember(
                    id=team.stable(workspace, "human"),
                    workspace_id=workspace.id,
                    role="human",
                    name="Owner",
                    max_tokens=0,
                ),
                TeamChannel(
                    id="channel",
                    workspace_id=workspace.id,
                    key="general",
                    name="General",
                    read_at=at(10),
                    created_at=at(0),
                ),
                TeamChannel(
                    id="dm",
                    workspace_id=workspace.id,
                    key="dm:writer",
                    name="Ada",
                    member_id="member",
                    read_at=at(10),
                    created_at=at(0),
                ),
            ]
        )
        d.commit()

    def db():
        with maker() as d:
            yield d

    def workspace_of(d, identifier, owner):
        workspace = d.get(ResearchWorkspace, identifier)
        if not workspace or workspace.owner != owner:
            raise HTTPException(404)
        return workspace

    app = FastAPI()
    install_team_routes(app, SimpleNamespace(), db, lambda: "owner", workspace_of)
    with TestClient(app) as client:
        yield maker, client
    engine.dispose()


def message(d, identifier, minute, **extra):
    row = TeamMessage(
        id=identifier,
        workspace_id="workspace",
        channel_id=extra.pop("channel_id", "channel"),
        author_id=extra.pop("author_id", "member"),
        text=extra.pop("text", identifier),
        created_at=at(minute),
        **extra,
    )
    d.add(row)
    d.flush()
    return row


def run(d, identifier, status="completed", **extra):
    row = AgentRun(
        id=identifier,
        owner="owner",
        session_id="session",
        model_config_id="model",
        model="Offline model",
        prompt="Work",
        status=status,
        created_at=at(9),
        updated_at=at(20),
        **extra,
    )
    d.add(row)
    d.flush()
    return row


def test_team_colleagues_presence_uses_latest_step_and_live_clock(colleagues):
    maker, _ = colleagues
    with maker() as d:
        workspace, member = (
            d.get(ResearchWorkspace, "workspace"),
            d.get(TeamMember, "member"),
        )
        active = run(
            d,
            "active",
            "running",
            steps=[
                {
                    "name": "read",
                    "status": "completed",
                    "arguments": {"path": "shared/plan.md"},
                },
                {
                    "name": "bash",
                    "status": "running",
                    "arguments": {"command": "python train.py"},
                    "result": "private output",
                },
            ],
            runtime={
                "phase": "tool",
                "since": at(29),
                "execution_seconds": 5,
                "waiting_seconds": 7,
            },
        )
        value = presence(d, workspace, member, active)
        assert value["current_step"]["arguments"] == {"command": "python train.py"}
        assert "result" not in value["current_step"]
        assert value["elapsed_seconds"] == 72
        assert active.runtime["execution_seconds"] == 5  # Reads never mutate the clock.
        active.steps = []
        assert presence(d, workspace, member, active)["current_step"] is None
        d.commit()
    response = colleagues[1].get("/api/v1/research/workspaces/workspace/team").json()
    assert (
        next(member for member in response["members"] if member["id"] == "member")[
            "status"
        ]
        == "working"
    )


def test_team_colleagues_queue_positions_and_recent_files(colleagues):
    maker, _ = colleagues
    with maker() as d:
        workspace, member = (
            d.get(ResearchWorkspace, "workspace"),
            d.get(TeamMember, "member"),
        )
        run(d, "a", "queued")
        current = run(d, "b", "queued")
        assert presence(d, workspace, member, current)["queue_ahead"] == 1
        root = message(d, "request", 11)
        d.add_all(
            [
                TeamDelivery(
                    id="first",
                    message_id=root.id,
                    member_id="other",
                    status="queued",
                    created_at=at(11),
                ),
                TeamDelivery(
                    id="second",
                    message_id=root.id,
                    member_id="member",
                    status="queued",
                    created_at=at(12),
                ),
            ]
        )
        d.flush()
        assert presence(d, workspace, member, None)["queue_ahead"] == 1
        message(
            d,
            "old-output",
            12,
            data={"files": [{"path": f"{i}.md", "name": f"{i}.md"} for i in range(5)]},
        )
        message(
            d,
            "new-output",
            13,
            data={
                "files": [{"path": "latest.md", "name": "latest.md"}],
                "changes": {"files": [{"path": "0.md", "status": "D"}]},
            },
        )
        assert [file["path"] for file in recent_files(d, member)] == [
            "latest.md",
            "1.md",
            "2.md",
        ]
        message(
            d,
            "removed-by-owner",
            14,
            author_id=team.stable(workspace, "human"),
            data={"changes": {"files": [{"path": "latest.md", "status": "D"}]}},
        )
        assert [file["path"] for file in recent_files(d, member)] == [
            "1.md",
            "2.md",
            "3.md",
        ]
        d.commit()
    detail = colleagues[1].get(
        "/api/v1/research/workspaces/workspace/team/members/member"
    )
    assert detail.status_code == 200, detail.text
    assert [file["path"] for file in detail.json()["recent_files"]] == [
        "1.md",
        "2.md",
        "3.md",
    ]


def test_team_colleagues_catchup_threshold_range_and_read_state(colleagues):
    maker, client = colleagues
    url = "/api/v1/research/workspaces/workspace/team/channels/channel"
    with maker() as d:
        message(d, "old", 9)
        for i in range(4):
            message(d, f"new-{i}", 11 + i)
        d.commit()
    assert client.get(url + "/summary").json()["show"] is False
    with maker() as d:
        message(d, "new-4", 15)
        message(d, "other-channel", 16, channel_id="dm")
        message(
            d,
            "own",
            17,
            author_id=team.stable(d.get(ResearchWorkspace, "workspace"), "human"),
        )
        message(d, "future", 40)
        d.commit()
    result = client.get(url + "/summary").json()
    assert result["show"] and result["new_messages"] == 5
    assert result["first_unread"] == {"id": "new-0", "thread_id": None}
    assert client.get(url + "/summary").json() == result
    assert (
        client.get(
            url + "/summary", params={"since": at(12), "through": at(14)}
        ).json()["new_messages"]
        == 2
    )
    assert client.get(url + "/summary", params={"since": "bad"}).status_code == 422
    assert (
        client.get(
            url + "/summary", params={"since": at(15), "through": at(14)}
        ).status_code
        == 422
    )
    assert (
        client.get(
            url.replace("workspaces/workspace", "workspaces/unowned") + "/summary"
        ).status_code
        == 404
    )
    with maker() as d:
        d.add(ResearchWorkspace(id="other", owner="owner", name="Other"))
        d.add(
            TeamChannel(
                id="foreign", workspace_id="other", key="general", name="Foreign"
            )
        )
        d.commit()
    assert (
        client.get(
            url.replace("channels/channel", "channels/foreign") + "/summary"
        ).status_code
        == 404
    )
    assert client.post(url + "/read", json={"through": at(30)}).status_code == 200
    assert client.get(url + "/summary").json()["show"] is False


def test_team_colleagues_catchup_completed_runs_files_handoffs_waits_failures(
    colleagues,
):
    maker, client = colleagues
    with maker() as d:
        run(d, "done")
        run(d, "failed", "failed", error="Training failed")
        message(
            d,
            "done-message",
            9,
            data={
                "run_id": "done",
                "read": True,
                "files": [{"path": "conclusion.md", "name": "conclusion.md"}],
                "changes": {"files": [{"path": "deleted.md", "status": "D"}]},
                "to": ["reviewer"],
            },
        )
        message(
            d, "duplicate-run", 20, thread_id="done-message", data={"run_id": "done"}
        )
        message(d, "failed-message", 20, data={"run_id": "failed"})
        message(d, "decision", 19, text="Approve training?", data={"waiting": True})
        message(d, "mention", 19, text="@Owner FYI")
        message(d, "notice", 21, kind="budget", text="Budget reached")
        root = message(d, "admission", 22)
        d.add(
            TeamDelivery(
                message_id=root.id,
                member_id="member",
                status="failed",
                error="Model missing",
                created_at=at(22),
            )
        )
        d.commit()
    result = client.get(
        "/api/v1/research/workspaces/workspace/team/channels/channel/summary"
    ).json()
    assert result["completed"] == [{"member_id": "member", "count": 1}]
    assert result["show"]
    assert result["handoffs"] == [
        {"message_id": "done-message", "member_id": "member", "to": ["reviewer"]}
    ]
    assert result["waiting"] == [
        {"message_id": "decision", "member_id": "member", "text": "Approve training?"}
    ]
    assert {file["path"] for file in result["files"]} == {"conclusion.md", "deleted.md"}
    assert {item["text"] for item in result["failed"]} == {
        "Training failed",
        "Budget reached",
        "Model missing",
    }
    with maker() as d:
        workspace, channel = (
            d.get(ResearchWorkspace, "workspace"),
            d.get(TeamChannel, "channel"),
        )
        message(d, "owner-reply", 23, author_id=team.stable(workspace, "human"))
        assert not summary(d, workspace, channel)["waiting"]


def test_team_colleagues_completion_alone_triggers_summary_and_thread_read_keeps_channel_cursor(
    colleagues,
):
    maker, client = colleagues
    with maker() as d:
        run(d, "only-completion")
        message(d, "root", 9, data={"run_id": "only-completion", "read": True})
        message(d, "reply", 12, thread_id="root")
        d.commit()
    url = "/api/v1/research/workspaces/workspace/team/channels/channel"
    assert client.get(url + "/summary").json()["show"]
    assert (
        client.post(
            url + "/read", json={"through": at(25), "thread_id": "root"}
        ).status_code
        == 200
    )
    with maker() as d:
        assert d.get(TeamChannel, "channel").read_at == at(10)
    assert client.get(url + "/messages").json()["read_through"] == at(30)
    assert client.post(url + "/read", json={"through": "invalid"}).status_code == 422


def test_team_colleagues_native_and_legacy_runs_without_messages(colleagues):
    maker, client = colleagues
    with maker() as d:
        workspace = d.get(ResearchWorkspace, "workspace")
        d.get(TeamChannel, "channel").key = "experiments"
        d.add(
            ResearchProject(
                id="project",
                workspace_id=workspace.id,
                owner=workspace.owner,
                question="Research",
                session_id="session",
                model_config_id="model",
            )
        )
        native = run(d, "native", response="Native result")
        d.add(
            ResearchSprint(
                project_id="project",
                run_id=native.id,
                number=1,
                role="writer",
                status="completed",
            )
        )
        run(
            d,
            "unrelated",
            response="Private result",
            runtime={
                "team": {
                    "workspace_id": "other",
                    "channel_id": "channel",
                    "member_id": "other",
                }
            },
        )
        d.add(
            AgentSession(
                id="legacy-session",
                owner=workspace.owner,
                workspace_id=workspace.id,
                kind="project_lead",
            )
        )
        advisor_id = team.stable(workspace, "advisor")
        d.add(
            TeamMember(
                id=advisor_id,
                workspace_id=workspace.id,
                role="advisor",
                name="Advisor",
                max_tokens=0,
            )
        )
        direct = d.get(TeamChannel, "dm")
        direct.key, direct.member_id = "dm:advisor", advisor_id
        legacy = run(d, "legacy", response="Legacy result")
        legacy.session_id = "legacy-session"
        d.commit()
    root = "/api/v1/research/workspaces/workspace/team/channels"
    native_summary = client.get(root + "/channel/summary").json()
    assert native_summary["completed"] == [{"member_id": "member", "count": 1}]
    assert native_summary["first_unread"]["thread_id"] == "research:project"
    legacy_summary = client.get(root + "/dm/summary").json()
    assert legacy_summary["completed"] == [{"member_id": advisor_id, "count": 1}]
    assert legacy_summary["first_unread"]["id"] == "legacy:legacy"
