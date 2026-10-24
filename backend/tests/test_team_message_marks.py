"""Pins, private saved messages and broadcasts: SQLite/ASGI only, no Git or models."""

import asyncio
import importlib.util
import json
import socket
import subprocess
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, select

from backend import research_team as team
from backend.models import (
    AgentSession,
    ResearchProject,
    ResearchWorkspace,
    TeamChannel,
    TeamDelivery,
    TeamMessage,
    TeamMessageMark,
)
from backend.research_team_tools import TEAM_TOOLS, _call, execute
from backend.tests.test_team_activity import inbox  # noqa: F401
from backend.tests.test_team_empty_replies import empty_reply  # noqa: F401


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Network and subprocesses are forbidden")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)


def mark(client, base, message, kind="pin", method="put", **body):
    return client.request(
        method.upper(),
        base + f"/messages/{message.id}/marks/{kind}",
        json={"channel_id": message.channel_id, **body},
    )


def test_team_message_marks_pin_thread_files_counts_and_unpin(inbox):
    client, base, (d, workspace, channel, run, reply) = inbox
    run.response = "Pinned finding"
    reply.data = {**reply.data, "files": [{"path": "finding.md", "name": "finding.md"}]}
    d.commit()
    for _ in range(2):
        assert mark(client, base, reply).status_code == 200
    assert len(list(d.scalars(select(TeamMessageMark)))) == 1
    history = client.get(base + f"/channels/{channel.id}/messages").json()
    pin = next(m for m in history["activity"] if m["pinned"])
    assert pin["id"] == reply.id and pin["thread_id"] == "request"
    assert pin["text"] == "Pinned finding"
    assert pin["data"]["files"][0]["path"] == "finding.md"
    thread = client.get(
        base + f"/channels/{channel.id}/messages?thread_id=request"
    ).json()
    assert thread["messages"][0]["pinned"] is True
    overview = team.overview(d, workspace)
    assert next(c for c in overview["channels"] if c["id"] == channel.id)[
        "pinned_count"
    ] == 1
    for _ in range(2):
        assert mark(client, base, reply, method="delete").status_code == 200
    assert not list(d.scalars(select(TeamMessageMark)))


def test_team_message_marks_saved_private_complete_remove_and_isolation(
    inbox, monkeypatch
):
    from backend import research_chat

    client, base, (d, workspace, channel, _, reply) = inbox
    monkeypatch.setattr(research_chat, "context", lambda *_: "Project")
    before = team.context(d, workspace, reply)
    for _ in range(2):
        assert mark(client, base, reply, "later").status_code == 200
    rows = client.get(base + "/saved").json()
    assert len(rows) == 1 and not rows[0]["completed"]
    assert rows[0]["channel"]["id"] == channel.id
    assert team.context(d, workspace, reply) == before
    assert mark(client, base, reply, "later", completed=True).status_code == 200
    assert client.get(base + "/saved").json()[0]["completed"] is True
    assert mark(client, base, reply, "later").status_code == 200
    assert client.get(base + "/saved").json()[0]["completed"] is True
    assert mark(client, base, reply, "later", completed=False).status_code == 200
    assert client.get(base + "/saved").json()[0]["completed"] is False
    assert mark(client, base, reply, "later", owner="intruder").status_code == 422
    assert mark(client, base.replace(workspace.id, "other"), reply).status_code == 404
    other_workspace = ResearchWorkspace(id="other", owner="another-owner", name="Other")
    other_channel = TeamChannel(
        id="other-channel", workspace_id=other_workspace.id, key="general", name="Other"
    )
    foreign = TeamMessage(
        id="foreign", workspace_id=other_workspace.id, channel_id=other_channel.id,
        text="Other team's message",
    )
    d.add_all([other_workspace, other_channel, foreign])
    d.commit()
    assert mark(client, base, foreign).status_code == 404
    assert mark(
        client, base, foreign, channel_id=channel.id
    ).status_code == 404
    assert client.get(base.replace(workspace.id, "other") + "/saved").status_code == 404
    assert mark(
        client, base, reply, channel_id=team.stable(workspace, "writing")
    ).status_code == 404
    assert mark(client, base, reply, "unknown").status_code == 404
    assert mark(client, base, reply, "later", method="delete").status_code == 200
    assert client.get(base + "/saved").json() == []


def test_team_message_marks_context_only_ten_channel_pins_and_members_cannot_pin(
    inbox, monkeypatch
):
    from backend import research_chat

    client, base, (d, workspace, channel, run, reply) = inbox
    monkeypatch.setattr(research_chat, "context", lambda *_: "Project")
    for number in range(12):
        message = TeamMessage(
            workspace_id=workspace.id,
            channel_id=channel.id,
            text=f"Finding {number}",
            data={"files": [{"path": f"{number}.md", "name": f"{number}.md"}]},
        )
        d.add(message)
        d.commit()
        assert mark(client, base, message).status_code == 200
    other = TeamMessage(
        workspace_id=workspace.id,
        channel_id=team.stable(workspace, "writing"),
        text="Other channel",
    )
    d.add(other)
    d.commit()
    assert mark(client, base, other).status_code == 200
    context = team.context(d, workspace, reply)
    pins = json.loads(context.split("Channel pins:\n")[1].split("\n\nConversation")[0])
    assert len(pins) == 10 and all(p["files"] for p in pins)
    assert "Other channel" not in json.dumps(pins)
    assert sum(
        m["pinned"] for m in team.history(d, workspace, channel)["activity"]
    ) == 12
    assert all(
        "pin" not in spec["name"] and "saved" not in spec["name"] for spec in TEAM_TOOLS
    )
    run.runtime = {
        "team": {
            "workspace_id": workspace.id,
            "member_id": reply.author_id,
            "channel_id": channel.id,
        }
    }
    run.status = "running"
    d.commit()
    app = SimpleNamespace(
        state=SimpleNamespace(maker=lambda: nullcontext(d), settings=None)
    )
    with pytest.raises(ValueError, match="Tool unavailable"):
        asyncio.run(
            execute(
                app, workspace.owner, run.id, "team_pin_message", {"message_id": reply.id}
            )
        )


def test_team_message_marks_virtual_roots_and_direct_messages(inbox):
    client, base, (d, workspace, _, run, _) = inbox
    d.get(AgentSession, run.session_id).kind = "project_chat"
    channel = d.get(TeamChannel, team.stable(workspace, "experiments"))
    project = ResearchProject(
        id="native",
        owner=workspace.owner,
        workspace_id=workspace.id,
        session_id=run.session_id,
        model_config_id=run.model_config_id,
        question="Native question",
    )
    d.add(project)
    dm = d.get(TeamChannel, team.stable(workspace, "dm:advisor"))
    d.commit()
    for identifier, target in [("research:native", channel), (f"legacy:{run.id}", dm)]:
        message = SimpleNamespace(id=identifier, channel_id=target.id)
        assert mark(client, base, message, "later").status_code == 200
        assert mark(client, base, message).status_code == (
            409 if target.member_id else 200
        )
    assert {row["id"] for row in client.get(base + "/saved").json()} == {
        "research:native",
        f"legacy:{run.id}",
    }
    history = client.get(base + f"/channels/{channel.id}/messages").json()
    assert history["messages"][0]["pinned"] is True


def test_team_message_marks_native_research_payload_includes_channel_pins(
    inbox, monkeypatch
):
    from backend import agent_worker, research_locations, team_members

    client, base, (d, workspace, _, run, reply) = inbox
    channel = d.get(TeamChannel, team.stable(workspace, "experiments"))
    project = ResearchProject(
        id="native",
        owner=workspace.owner,
        workspace_id=workspace.id,
        session_id=run.session_id,
        model_config_id=run.model_config_id,
        question="Question",
    )
    pin = TeamMessage(
        workspace_id=workspace.id,
        channel_id=channel.id,
        text="Shared finding",
        data={"files": [{"path": "finding.md", "name": "finding.md"}]},
    )
    d.add_all([project, pin])
    run.status = "running"
    run.runtime = {"research": {"project_id": project.id, "role": "executor"}}
    d.commit()
    assert mark(client, base, pin).status_code == 200
    assert mark(client, base, reply, "later", completed=True).status_code == 200
    app = SimpleNamespace(
        state=SimpleNamespace(maker=lambda: nullcontext(d), settings=None)
    )
    monkeypatch.setattr(agent_worker, "validate_endpoint", lambda *_: None)
    monkeypatch.setattr(agent_worker, "selection_context", lambda *_: "")
    monkeypatch.setattr(research_locations, "tool_cwd", lambda *_: ".")

    class PayloadChecked(Exception):
        pass

    def check_payload(_d, _run, payload, *_args):
        pins = json.loads(payload["context"].split("Channel pins:\n")[1])
        assert [value["id"] for value in pins] == [pin.id]
        assert pins[0]["text"] == "Shared finding"
        assert pins[0]["files"][0]["path"] == "finding.md"
        assert "saved_at" not in payload["context"]
        assert "completed" not in pins[0]
        raise PayloadChecked

    monkeypatch.setattr(team_members, "apply_runtime", check_payload)
    with pytest.raises(PayloadChecked):
        agent_worker._process(
            app, run.id, {"model": run.model, "api_key": "offline-placeholder"}
        )


def test_team_broadcast_send_idempotent_and_references_live_files(inbox, monkeypatch):
    client, base, (d, workspace, channel, _, _) = inbox
    dispatched = []
    monkeypatch.setattr(team, "dispatch", lambda *args: dispatched.append(args[-1].id))
    body = {
        "text": "@writer Conclusion",
        "thread_id": "request",
        "client_id": "broadcast",
        "also_channel": True,
    }
    url = base + f"/channels/{channel.id}/messages"
    first = client.post(url, json=body)
    assert first.status_code == 200, first.text
    assert client.post(url, json=body).json()["id"] == first.json()["id"]
    assert client.post(url, json={**body, "also_channel": False}).status_code == 409
    source = d.get(TeamMessage, first.json()["id"])
    source.data = {
        **source.data,
        "files": [{"path": "result.md", "name": "result.md"}],
        "research_forwarded": True,
    }
    source.text = "Updated conclusion"
    d.commit()
    mirrors = list(
        d.scalars(select(TeamMessage).where(TeamMessage.kind == "thread_broadcast"))
    )
    assert len(mirrors) == 1 and mirrors[0].thread_id is None
    row = next(
        m for m in client.get(url).json()["messages"] if m["id"] == mirrors[0].id
    )
    assert row["text"] == "Updated conclusion"
    assert row["data"]["files"][0]["path"] == "result.md"
    assert not row["data"]["research_forwarded"]
    assert row["data"]["thread_origin"] == {
        "message_id": source.id,
        "thread_id": "request",
    }
    deliveries = list(d.scalars(select(TeamDelivery)))
    assert len(deliveries) == 1 and deliveries[0].message_id == source.id
    assert len(dispatched) == 1
    assert client.post(
        url, json={**body, "client_id": "no-thread", "thread_id": None}
    ).status_code == 409
    dm = team.stable(workspace, "dm:writer")
    assert client.post(
        base + f"/channels/{dm}/messages", json={**body, "client_id": "wrong-thread"}
    ).status_code == 409


@pytest.mark.parametrize("existing", [True, False])
def test_team_broadcast_member_tool_current_response_or_explicit_thread(
    inbox, existing
):
    _, _, (d, workspace, channel, run, reply) = inbox
    if existing:
        reply.source_key = f"run:{run.id}"
    d.commit()
    app = SimpleNamespace(state=SimpleNamespace(maker=lambda: nullcontext(d)))
    info = dict(
        workspace_id=workspace.id,
        channel_id=channel.id,
        member_id=reply.author_id,
        thread_id="request" if existing else None,
        run_id=run.id,
    )
    args = {
        "text": "Conclusion",
        "also_channel": True,
        "kind": "conclusion",
        "thread_id": "request",
    }
    result = _call(app, workspace.owner, info, "team_send_message", args)
    source = d.get(TeamMessage, result["message_id"])
    assert (source.id == reply.id) is existing
    mirror = d.scalar(select(TeamMessage).where(TeamMessage.kind == "thread_broadcast"))
    assert team.message_out(d, mirror)["text"] == "Conclusion"
    if existing:
        _call(
            app, workspace.owner, info, "team_send_message", {**args, "text": "Final"}
        )
        assert len(
            list(
                d.scalars(
                    select(TeamMessage).where(TeamMessage.kind == "thread_broadcast")
                )
            )
        ) == 1
        assert team.message_out(d, mirror)["text"] == "Final"
    with pytest.raises(ValueError, match="Only channel thread replies"):
        _call(
            app, workspace.owner, info, "team_send_message", {**args, "thread_id": None}
        )


def test_team_message_marks_migration_roundtrip():
    spec = importlib.util.spec_from_file_location(
        "marks_migration", "backend/migrations/versions/0051_team_message_marks.py"
    )
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.down_revision == "0050"
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            assert "team_message_marks" in inspect(connection).get_table_names()
            assert len(
                inspect(connection).get_unique_constraints("team_message_marks")
            ) == 1
            migration.downgrade()
            assert "team_message_marks" not in inspect(connection).get_table_names()
    engine.dispose()
