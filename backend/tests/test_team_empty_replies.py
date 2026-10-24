"""Empty replies: in-memory data and ASGI only, without runtime or Git calls."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend import research_team as team
from backend.models import AgentRun, Base, ResearchWorkspace, TeamChannel, TeamMessage
from backend.research_team_routes import install_team_routes


@pytest.fixture
def empty_reply():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as d:
        workspace = ResearchWorkspace(id="workspace", owner="owner", name="Team")
        d.add(workspace)
        d.flush()
        members = team.ensure(d, workspace)
        writer = next(m for m in members if m.role == "writer")
        channel = d.get(TeamChannel, team.stable(workspace, "general"))
        human = team.stable(workspace, "human")
        root = TeamMessage(
            id="request",
            workspace_id=workspace.id,
            channel_id=channel.id,
            author_id=human,
            text="Previous message",
            created_at="2026-10-23T10:00:00Z",
        )
        run = AgentRun(
            id="run",
            owner=workspace.owner,
            session_id=writer.session_id,
            model_config_id="offline-model",
            model="offline-model",
            status="completed",
            prompt="Request",
            response="",
            steps=[{"name": "read", "status": "completed"}],
        )
        reply = TeamMessage(
            id="reply",
            workspace_id=workspace.id,
            channel_id=channel.id,
            thread_id=root.id,
            author_id=team.stable(workspace, "writer"),
            mentions=[human],
            data={"run_id": run.id},
            created_at="2026-10-23T11:00:00Z",
        )
        d.add_all([root, run, reply])
        d.commit()
        yield d, workspace, channel, run, reply
    engine.dispose()


@pytest.mark.parametrize("text", ["", " \n\t"])
@pytest.mark.parametrize(
    "data",
    [
        {},
        {"files": [], "attachments": [], "links": []},
        {"changes": {"files": [], "added": 0, "removed": 0}},
        {"commit": "a" * 40},
        {"files": [{"path": "draft.md", "name": "draft.md"}]},
        {"attachments": [{"id": "file", "name": "draft.md", "url": "/file"}]},
        {"changes": {"files": [{"path": "deleted.md", "status": "D"}]}},
        {"links": [{"channel_id": "other", "thread_id": "post", "name": "Other"}]},
    ],
)
def test_team_empty_message_out_preserves_completed_run_and_outputs(
    empty_reply, text, data
):
    d, _, _, run, reply = empty_reply
    run.response = text
    reply.data = {**reply.data, **data}
    d.flush()
    value = team.message_out(d, reply)
    assert value["text"] == text
    assert value["run"]["status"] == "completed"
    assert not value["run"]["error"]
    assert not value["run"]["runtime"].get("no_answer")
    assert value["data"] == reply.data
    assert run.status == "completed" and not run.error


@pytest.mark.parametrize(
    "status,error",
    [("failed", ""), ("failed", "Test error"), ("completed", "Test error")],
)
def test_team_empty_message_out_preserves_failures(empty_reply, status, error):
    d, _, _, run, reply = empty_reply
    run.status, run.error = status, error
    d.flush()
    value = team.message_out(d, reply)
    assert value["run"]["status"] == status
    assert value["run"]["error"] == error or value["run"]["runtime"]["no_answer"]
    assert team.has_message_content(value)


@pytest.mark.parametrize("channel_key", ["general", "dm:writer"])
def test_team_empty_last_message_and_unread_skip_empty_replies(
    empty_reply, channel_key
):
    d, workspace, _, run, reply = empty_reply
    channel = d.get(TeamChannel, team.stable(workspace, channel_key))
    root = d.get(TeamMessage, reply.thread_id)
    root.channel_id = reply.channel_id = channel.id
    run.response = " \n\t"
    d.flush()
    result = team.overview(d, workspace)
    preview = next(c for c in result["channels"] if c["id"] == channel.id)
    assert preview["last_message"]["text"] == root.text
    assert preview["last_at"] == root.created_at
    assert preview["unread"] == 0
    assert result["notifications"] == []
    assert result["mentions_unread"] == result["threads_unread"] == 0
    history = team.history(d, workspace, channel, root.id)
    assert [m["id"] for m in history["messages"]] == [reply.id]


@pytest.mark.parametrize(
    "data",
    [
        {"files": [{"path": "draft.md", "name": "draft.md"}]},
        {"attachments": [{"id": "file", "name": "draft.md", "url": "/file"}]},
        {"changes": {"files": [{"path": "deleted.md", "status": "D"}]}},
        {"links": [{"channel_id": "other", "thread_id": "post", "name": "Other"}]},
    ],
)
def test_team_empty_last_message_keeps_file_only_outputs(empty_reply, data):
    d, workspace, channel, _, reply = empty_reply
    reply.data = {**reply.data, **data}
    d.flush()
    result = team.overview(d, workspace)
    preview = next(c for c in result["channels"] if c["id"] == channel.id)
    assert preview["last_at"] == reply.created_at
    assert preview["unread"] == 1
    assert [m["id"] for m in result["notifications"]] == [reply.id]
    assert result["mentions_unread"] == result["threads_unread"] == 1


def test_team_empty_last_message_is_none_without_content(empty_reply):
    d, workspace, channel, _, reply = empty_reply
    d.delete(d.get(TeamMessage, reply.thread_id))
    reply.thread_id = None
    d.flush()
    preview = next(
        c for c in team.overview(d, workspace)["channels"] if c["id"] == channel.id
    )
    assert preview["last_message"] is None
    assert preview["last_at"] == channel.created_at


def test_team_empty_mentions_skip_empty_replies_and_keep_files_and_errors(empty_reply):
    d, workspace, _, run, reply = empty_reply
    app = FastAPI()

    def db():
        yield d

    def auth():
        return workspace.owner

    def workspace_of(session, identifier, owner):
        assert identifier == workspace.id and owner == workspace.owner
        return session.get(ResearchWorkspace, identifier)

    install_team_routes(app, None, db, auth, workspace_of)
    path = f"/api/v1/research/workspaces/{workspace.id}/team/threads?mentions=true"
    with TestClient(app) as client:
        assert client.get(path).json() == []
        reply.data = {
            **reply.data,
            "files": [{"path": "draft.md", "name": "draft.md"}],
        }
        d.commit()
        assert [m["id"] for m in client.get(path).json()] == [reply.id]
        reply.data = {"run_id": run.id}
        run.status, run.error = "failed", "Test error"
        d.commit()
        assert [m["id"] for m in client.get(path).json()] == [reply.id]
