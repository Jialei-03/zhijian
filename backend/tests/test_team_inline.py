"""Conversation routing in memory; no runtime, Git, providers or network."""

import json
import socket
import subprocess

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend import research_chat, research_team_tools
from backend import research_team as team
from backend.models import (
    AgentControl,
    AgentRun,
    Base,
    ResearchProject,
    ResearchWorkspace,
    TeamDelivery,
    TeamMessage,
)
from backend.research_team_routes import install_team_routes


@pytest.fixture
def inline(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Subprocesses and network are forbidden in this test")

    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(research_chat, "_model", lambda *a: ("offline", "offline"))
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    maker = sessionmaker(engine, expire_on_commit=False)
    with maker() as d:
        workspace = ResearchWorkspace(id="team", owner="owner", name="Team")
        d.add(workspace)
        d.flush()
        team.ensure(d, workspace)
        workspace.workflow = {
            "id": "inline",
            "name": "Inline",
            "version": 1,
            "rules": [],
        }
        d.commit()
    app = FastAPI()
    app.state.maker = maker

    def db():
        with maker() as d:
            yield d

    def workspace_of(d, identifier, owner):
        workspace = d.get(ResearchWorkspace, identifier)
        assert workspace.owner == owner
        return workspace

    install_team_routes(app, None, db, lambda: "owner", workspace_of)
    with TestClient(app) as client:
        yield app, client
    engine.dispose()


BASE = "/api/v1/research/workspaces/team/team"


def send(inline, text, thread=None, channel="general", mode="queue"):
    app, client = inline
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, "team")
        cid = team.stable(workspace, channel)
    response = client.post(
        f"{BASE}/channels/{cid}/messages",
        json={"text": text, "thread_id": thread, "mode": mode, "client_id": text},
    )
    assert response.status_code == 200, response.text
    return response.json()


def runs(inline):
    with inline[0].state.maker() as d:
        return list(
            d.scalars(select(AgentRun).order_by(AgentRun.created_at, AgentRun.id))
        )


def finish(inline, run, text="Done"):
    with inline[0].state.maker() as d:
        row = d.get(AgentRun, run.id)
        row.status, row.response = "completed", text
        d.commit()
    team.settle(None, inline[0].state.maker)


@pytest.mark.parametrize("location", ["channel", "thread", "research"])
def test_inline_reply_and_tool_handoffs_follow_the_wake_location(inline, location):
    app, client = inline
    root = send(inline, "Start")
    thread = root["id"] if location == "thread" else None
    channel = "general"
    if location == "research":
        with app.state.maker() as d:
            workspace = d.get(ResearchWorkspace, "team")
            project = ResearchProject(
                id="project",
                owner="owner",
                workspace_id="team",
                question="Question",
                session_id=next(
                    m.session_id
                    for m in team.ensure(d, workspace)
                    if m.role == "librarian"
                ),
                model_config_id="offline",
                workflow=workspace.workflow,
            )
            d.add(project)
            d.commit()
        thread, channel = "research:project", "experiments"
    incoming = send(inline, "@librarian find papers", thread, channel)
    run = runs(inline)[0]
    assert run.runtime["team"]["thread_id"] == thread
    scope = ["team", incoming["channel_id"], thread]
    assert run.runtime["team"]["routing_scope"] == scope
    # Omitting thread_id uses the wake location and fills the existing placeholder.
    info = {**run.runtime["team"], "run_id": run.id}
    result = research_team_tools._call(
        app, "owner", info, "team_send_message", {"text": "Sources", "wake": ["writer"]}
    )
    finish(inline, run, "Sources")
    writer = runs(inline)[-1]
    assert writer.id != run.id
    assert writer.runtime["team"]["thread_id"] == thread
    assert writer.runtime["team"]["routing_scope"] == scope
    finish(inline, writer, "Draft")
    response = client.get(
        f"{BASE}/channels/{incoming['channel_id']}/messages",
        params={"thread_id": thread} if thread else {},
    ).json()
    replies = [m for m in response["messages"] if m.get("run")]
    assert [m["text"] for m in replies] == ["Sources", "Draft"]
    assert all(m["thread_id"] == thread for m in replies)
    assert replies[0]["id"] == result["message_id"]
    with app.state.maker() as d:
        state = d.get(ResearchWorkspace, "team").workflow_state["threads"]
        assert json.dumps(scope, separators=(",", ":")) in state


def test_inline_user_reply_opens_an_independent_scope_and_lists_participants(inline):
    app, client = inline
    root = send(inline, "@librarian find sources")
    finish(inline, runs(inline)[0])
    assert client.get(BASE + "/threads").json() == []
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, "team")
        librarian = team.stable(workspace, "librarian")
    assert client.get(f"{BASE}/members/{librarian}").json()["threads"] == []
    send(inline, "@writer draft here", root["id"])
    writer = runs(inline)[-1]
    assert writer.runtime["team"]["routing_scope"] == [
        "team",
        root["channel_id"],
        root["id"],
    ]
    finish(inline, writer)
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, "team")
        for identifier, role in [("a-older", "librarian"), ("z-newer", "writer")]:
            d.add(
                TeamMessage(
                    id=identifier,
                    workspace_id="team",
                    channel_id=root["channel_id"],
                    thread_id=root["id"],
                    author_id=team.stable(workspace, role),
                    text=identifier,
                    created_at="2099-01-01T00:00:00Z",
                )
            )
        d.add(
            TeamMessage(
                workspace_id="team",
                channel_id=root["channel_id"],
                thread_id=root["id"],
                text="System",
                created_at="2099-01-02T00:00:00Z",
            )
        )
        d.commit()
    threads = client.get(BASE + "/threads").json()
    assert [m["id"] for m in threads] == [root["id"]]
    assert threads[0]["replies"] == 5
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, "team")
        assert threads[0]["reply_authors"] == [
            team.stable(workspace, role) for role in ("writer", "librarian", "human")
        ]
    assert [
        t["id"] for t in client.get(f"{BASE}/members/{librarian}").json()["threads"]
    ] == [root["id"]]
    assert threads[0]["last_message_at"] == "2099-01-02T00:00:00Z"


def test_inline_wait_resumes_only_in_the_same_channel_scope(inline):
    app, _ = inline
    root = send(inline, "@librarian check")
    run = runs(inline)[0]
    research_team_tools._call(
        app,
        "owner",
        {**run.runtime["team"], "run_id": run.id},
        "team_wait_for_owner",
        {"text": "Proceed?"},
    )
    finish(inline, run, "Proceed?")
    send(inline, "@writer separate thread", root["id"])
    send(inline, "@writer another channel", channel="writing")
    with app.state.maker() as d:
        state = d.get(ResearchWorkspace, "team").workflow_state["threads"]
        assert state[
            json.dumps(["team", root["channel_id"], None], separators=(",", ":"))
        ]["waiting"]
    send(inline, "@librarian continue")
    assert len(runs(inline)) == 3
    with app.state.maker() as d:
        state = d.get(ResearchWorkspace, "team").workflow_state["threads"]
        assert not state[
            json.dumps(["team", root["channel_id"], None], separators=(",", ":"))
        ]["waiting"]


def test_inline_rule_counts_share_channel_scope_but_not_user_threads(inline):
    app, _ = inline
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, "team")
        workspace.workflow = {
            **workspace.workflow,
            "rules": [
                {
                    "id": "once",
                    "when": {"event": "message", "from_role": "owner"},
                    "then": {"action": "wake", "role": "librarian"},
                    "limit": {"per_thread": 1},
                }
            ],
        }
        d.commit()
    root = send(inline, "First")
    finish(inline, runs(inline)[0])
    send(inline, "Second")
    assert len(runs(inline)) == 1
    send(inline, "Thread", root["id"])
    assert len(runs(inline)) == 2
    send(inline, "Other channel", channel="writing")
    assert len(runs(inline)) == 2  # Same member is busy; the delivery stays queued.
    with app.state.maker() as d:
        assert len(list(d.scalars(select(TeamDelivery)))) == 3


def test_inline_unclaimed_wakes_merge_only_in_the_same_location(inline):
    app, _ = inline
    root = send(inline, "@writer first")
    send(inline, "@writer second")
    assert len(runs(inline)) == 1
    assert "second" in runs(inline)[0].prompt
    send(inline, "@writer in thread", root["id"])
    with app.state.maker() as d:
        assert len(list(d.scalars(select(TeamDelivery)))) == 2
    finish(inline, runs(inline)[0])
    assert runs(inline)[-1].runtime["team"]["thread_id"] == root["id"]


def test_inline_steering_receipt_returns_to_the_incoming_location(inline):
    app, _ = inline
    root = send(inline, "Start thread")
    send(inline, "@writer work", root["id"])
    run = runs(inline)[0]
    with app.state.maker() as d:
        d.get(AgentRun, run.id).status = "running"
        d.commit()
    send(inline, "@writer answer here", mode="immediate")
    with app.state.maker() as d:
        d.scalar(select(AgentControl)).status = "applied"
        d.commit()
    finish(inline, run)
    with app.state.maker() as d:
        receipt = d.scalar(
            select(TeamMessage).where(TeamMessage.source_key.like("steer:%"))
        )
        assert receipt and receipt.thread_id is None


def test_inline_unread_and_continuation_stay_in_the_channel(inline):
    app, client = inline
    root = send(inline, "@writer draft")
    run = runs(inline)[0]
    finish(inline, run)
    overview = client.get(BASE).json()
    channel = next(c for c in overview["channels"] if c["id"] == root["channel_id"])
    assert channel["unread"] == 1 and overview["threads_unread"] == 0
    assert (
        client.post(
            f"{BASE}/channels/{channel['id']}/read",
            json={"through": channel["last_at"]},
        ).status_code
        == 200
    )
    assert (
        next(
            c for c in client.get(BASE).json()["channels"] if c["id"] == channel["id"]
        )["unread"]
        == 0
    )
    with app.state.maker() as d:
        row = d.get(AgentRun, run.id)
        row.runtime = {**row.runtime, "time_limit_reached": True}
        response = d.scalar(
            select(TeamMessage).where(TeamMessage.source_key == f"run:{run.id}")
        )
        response_id = response.id
        d.commit()
    continued = client.post(f"{BASE}/messages/{response_id}/continue", json={})
    assert continued.status_code == 200, continued.text
    assert continued.json()["thread_id"] is None


def test_inline_cross_channel_wake_keeps_origin_scope_and_destination_location(inline):
    app, _ = inline
    root = send(inline, "@librarian find")
    run = runs(inline)[0]
    with app.state.maker() as d:
        destination = team.stable(d.get(ResearchWorkspace, "team"), "writing")
    result = research_team_tools._call(
        app,
        "owner",
        {**run.runtime["team"], "run_id": run.id},
        "team_send_message",
        {"channel_id": destination, "text": "Draft", "wake": ["writer"]},
    )
    finish(inline, run)
    writer = runs(inline)[-1]
    assert writer.runtime["team"]["channel_id"] == destination
    assert writer.runtime["team"]["thread_id"] is None
    assert writer.runtime["team"]["routing_scope"] == ["team", root["channel_id"], None]
    with app.state.maker() as d:
        assert d.get(TeamMessage, result["message_id"]).thread_id is None
