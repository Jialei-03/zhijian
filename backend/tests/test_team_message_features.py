"""Message feedback/reference checks using only an isolated SQLite database."""

import importlib
import json
import socket
import subprocess
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import sessionmaker

from backend import research_chat, research_team as team
from backend.models import (
    AgentRun,
    AgentSession,
    Base,
    ResearchProject,
    ResearchWorkspace,
    TeamChannel,
    TeamDelivery,
    TeamMember,
    TeamMessage,
    TeamMessageReaction,
    User,
)
from backend.research_team_routes import install_team_routes
from backend.team_members import apply_runtime
from backend.team_message_features import feedback_part


@pytest.fixture
def features(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("No network, model calls or subprocesses in these tests")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(
        research_chat, "_model", lambda *a, **kw: ("offline", "offline")
    )
    monkeypatch.setattr(research_chat, "context", lambda *a, **kw: "Project context")
    engine = create_engine(f"sqlite:///{tmp_path / 'messages.db'}")
    Base.metadata.create_all(engine)
    maker = sessionmaker(engine, expire_on_commit=False)
    with maker() as d:
        d.add(User(id="owner", username="researcher", password="unused"))
        workspace = ResearchWorkspace(id="workspace", owner="owner", name="团队")
        other = ResearchWorkspace(id="other", owner="someone-else", name="Other")
        d.add_all([workspace, other])
        d.flush()
        members = team.ensure(d, workspace)
        team.ensure(d, other)
        overview = team.overview(d, workspace)
        d.commit()

    def database():
        with maker() as d:
            yield d

    def auth():
        return "owner"

    def workspace_of(d, identifier, owner):
        row = d.get(ResearchWorkspace, identifier)
        if not row or row.owner != owner:
            raise HTTPException(404, "Not found")
        return row

    app = FastAPI()
    install_team_routes(app, SimpleNamespace(), database, auth, workspace_of)
    with TestClient(app) as client:
        yield SimpleNamespace(
            engine=engine,
            client=client,
            maker=maker,
            base="/api/v1/research/workspaces/workspace/team",
            members={m.role: m.id for m in members},
            channels={c["key"]: c["id"] for c in overview["channels"]},
        )
    engine.dispose()


def post(features, channel="general", **body):
    return features.client.post(
        f"{features.base}/channels/{features.channels[channel]}/messages",
        json={"client_id": str(uuid4()), **body},
    )


def member_message(features, text="A **useful** finding", role="librarian", **extra):
    with features.maker() as d:
        row = TeamMessage(
            workspace_id="workspace",
            channel_id=extra.pop("channel_id", features.channels["general"]),
            author_id=features.members[role],
            text=text,
            **extra,
        )
        d.add(row)
        d.commit()
        return row.id


def reaction(features, message, emoji="👍", method="PUT"):
    return features.client.request(
        method, f"{features.base}/messages/{message}/reactions/{emoji}"
    )


def test_team_message_features_reactions_are_idempotent_and_do_not_make_activity(
    features,
):
    mid = member_message(features)
    before = features.client.get(features.base + "/activity").json()
    for _ in range(2):
        response = reaction(features, mid)
        assert response.status_code == 200, response.text
        assert response.json() == [{"emoji": "👍", "count": 1, "mine": True}]
    assert reaction(features, mid, "✅").status_code == 200
    history = features.client.get(
        f"{features.base}/channels/{features.channels['general']}/messages"
    ).json()
    assert [r["emoji"] for r in history["messages"][0]["reactions"]] == ["👍", "✅"]
    assert features.client.get(features.base + "/activity").json() == before
    for _ in range(2):
        assert reaction(features, mid, method="DELETE").json() == [
            {"emoji": "✅", "count": 1, "mine": True}
        ]
    assert reaction(features, mid, "🔥").status_code == 409
    assert reaction(features, "missing").status_code == 404
    with features.maker() as d:
        other_message = TeamMessage(
            workspace_id="other", channel_id="other-channel", text="private"
        )
        d.add(other_message)
        d.commit()
        assert reaction(features, other_message.id).status_code == 404
        d.get(ResearchWorkspace, "workspace").archived = True
        d.commit()
    assert reaction(features, mid).status_code == 409


def test_team_message_features_only_latest_ten_researcher_votes_reach_next_work(
    features,
):
    for index in range(12):
        mid = member_message(features, f"Finding {index}")
        assert reaction(features, mid, "👍" if index % 2 else "👎").status_code == 200
        with features.maker() as d:
            row = d.scalar(
                select(TeamMessageReaction).where(
                    TeamMessageReaction.message_id == mid
                )
            )
            row.created_at = f"2026-10-24T10:{index:02}:00Z"
            d.commit()
    checked = member_message(features, "Read receipt")
    reaction(features, checked, "✅")
    other = member_message(features, "Writer feedback", role="writer")
    reaction(features, other, "👍")
    with features.maker() as d:
        member = d.get(TeamMember, features.members["librarian"])
        part = feedback_part(d, member)
        rows = json.loads(part.split("\n")[-1])
        assert len(rows) == 10
        assert [row["text"] for row in rows] == [
            f"Finding {i}" for i in range(11, 1, -1)
        ]
        assert "✅" not in part and "Writer" not in part and "Read receipt" not in part
    sent = post(features, "dm:librarian", text="Next task")
    assert sent.status_code == 200, sent.text
    with features.maker() as d:
        run = d.scalar(select(AgentRun).where(AgentRun.session_id == member.session_id))
        assert part in run.context
        payload = {
            "context": "Research round",
            "system_prompt": "System",
            "tools": [],
            "limits": {"output_tokens": 1024},
        }
        apply_runtime(d, run, payload, {"member_id": member.id})
        assert part in payload["context"]
        assert payload["limits"]["tool_calls"] == 0
        assert member.file_path == ""  # Feedback never creates an agent file.


def test_team_message_features_forward_and_quote_snapshots_wake_and_retry(features):
    source = member_message(features)
    client_id = str(uuid4())
    body = dict(text="@writer FYI", forward_message_id=source, client_id=client_id)
    sent = post(features, "dm:librarian", **body)
    assert sent.status_code == 200, sent.text
    value = sent.json()
    assert value["data"]["forward"]["text"] == "A useful finding"
    assert value["data"]["forward"]["author_id"] == features.members["librarian"]
    assert value["data"]["forward"]["created_at"]
    assert post(features, "dm:librarian", **body).json()["id"] == value["id"]
    assert post(
        features, "dm:librarian", **{**body, "forward_message_id": "missing"}
    ).status_code == 409
    with features.maker() as d:
        deliveries = list(
            d.scalars(
                select(TeamDelivery).where(TeamDelivery.message_id == value["id"])
            )
        )
        assert features.members["librarian"] in [row.member_id for row in deliveries]
        run = d.get(
            AgentRun,
            next(
                row.run_id
                for row in deliveries
                if row.member_id == features.members["librarian"]
            ),
        )
        assert "A useful finding" in run.prompt and source in run.prompt
    empty_forward = post(features, forward_message_id=source)
    assert empty_forward.status_code == 200, empty_forward.text
    quote = {"message_id": source, "text": "useful finding"}
    quoted = post(features, text="@librarian Check", thread_id=source, quote=quote)
    assert quoted.status_code == 200, quoted.text
    assert quoted.json()["data"]["quote"]["text"] == quote["text"]
    with features.maker() as d:
        # Immediate steering must carry the original quote to the working member.
        pending = d.scalar(
            select(TeamDelivery).where(
                TeamDelivery.message_id == quoted.json()["id"]
            )
        )
        pending.mode = "immediate"
        team.dispatch(
            SimpleNamespace(), d, d.get(ResearchWorkspace, "workspace"), pending
        )
        from backend.models import AgentControl

        assert quote["text"] in d.get(AgentControl, pending.control_id).text
    assert post(features, text="", thread_id=source, quote=quote).status_code == 200
    assert post(
        features, text="plain", quote={**quote, "text": "fabricated"}
    ).status_code == 409
    assert post(features, text="plain", forward_message_id="missing").status_code == 409
    assert post(features, text="").status_code == 409


def test_team_message_features_agents_have_no_reaction_tool(features):
    from backend.research_team_tools import TEAM_TOOLS

    assert not any("react" in spec["name"] for spec in TEAM_TOOLS)


def test_team_message_features_merged_inbox_preserves_quotes_and_file_only_forwards(
    features,
):
    source = member_message(
        features, "", data={"files": [{"name": "draft.md", "path": "draft.md"}]}
    )
    forwarded = post(features, forward_message_id=source).json()
    assert forwarded["data"]["forward"]["text"] == "draft.md"
    quote_source = member_message(features, "A quoted result")
    quoted = post(
        features,
        text="Comment",
        quote={"message_id": quote_source, "text": "quoted result"},
    ).json()
    incoming = post(features, text="Batch").json()
    with features.maker() as d:
        delivery = TeamDelivery(
            member_id=features.members["librarian"],
            message_id=incoming["id"],
            action={"merged_messages": [forwarded["id"], quoted["id"]]},
        )
        d.add(delivery)
        d.flush()
        team.dispatch(
            SimpleNamespace(), d, d.get(ResearchWorkspace, "workspace"), delivery
        )
        run = d.get(AgentRun, delivery.run_id)
        assert "draft.md" in run.prompt and "quoted result" in run.prompt


def test_team_message_features_virtual_messages_keep_reactions_and_sources(features):
    with features.maker() as d:
        session = AgentSession(
            owner="owner", workspace_id="workspace", kind="project_chat"
        )
        d.add(session)
        d.flush()
        run = AgentRun(
            owner="owner",
            session_id=session.id,
            model_config_id="offline",
            model="offline",
            prompt="Legacy request",
            response="Legacy answer",
            status="completed",
        )
        d.add(run)
        project = ResearchProject(
            owner="owner",
            workspace_id="workspace",
            session_id=session.id,
            model_config_id="offline",
            question="Research question",
        )
        d.add(project)
        d.commit()
        identifiers = (
            f"legacy:{run.id}", f"legacy-user:{run.id}", f"research:{project.id}"
        )
    for identifier in identifiers:
        assert reaction(features, identifier).status_code == 200
        forwarded = post(features, forward_message_id=identifier)
        assert forwarded.status_code == 200, forwarded.text
        assert forwarded.json()["data"]["forward"]["message_id"] == identifier
    history = features.client.get(
        f"{features.base}/channels/{features.channels['dm:advisor']}/messages"
    ).json()["messages"]
    assert all(
        row["reactions"] == [{"emoji": "👍", "count": 1, "mine": True}]
        for row in history
    )
    roots = features.client.get(
        f"{features.base}/channels/{features.channels['experiments']}/messages"
    ).json()["messages"]
    assert roots[0]["reactions"][0]["emoji"] == "👍"
    with features.maker() as d:
        advisor = d.get(TeamMember, features.members["advisor"])
        feedback = feedback_part(d, advisor)
        assert "Legacy answer" in feedback and "Legacy request" not in feedback


def test_team_message_features_feedback_refreshes_at_start_and_checkmarks_stay_out(
    features,
):
    mid = member_message(
        features, "Read this", channel_id=features.channels["dm:librarian"]
    )
    reaction(features, mid, "✅")
    reaction(features, mid, "👍")
    sent = post(features, "dm:librarian", text="Next task")
    assert sent.status_code == 200, sent.text
    with features.maker() as d:
        run = d.scalar(select(AgentRun))
        assert "✅" not in run.context and '"reactions"' not in run.context
        payload = {
            "context": run.context + "\nSelection context",
            "system_prompt": "System",
            "tools": [],
            "limits": {"output_tokens": 1024},
        }
        old = run.context
    reaction(features, mid, "👍", method="DELETE")
    reaction(features, mid, "👎")
    with features.maker() as d:
        run = d.scalar(select(AgentRun))
        apply_runtime(d, run, payload, {"member_id": features.members["librarian"]})
        apply_runtime(d, run, payload, {"member_id": features.members["librarian"]})
        assert "👍" in old and "👍" not in payload["context"]
        assert payload["context"].count("Recent feedback") == 1
        assert "👎" in payload["context"] and "Selection context" in payload["context"]


def test_team_message_features_references_are_scoped_and_snapshots_survive_source_edits(
    features,
):
    with features.maker() as d:
        other = d.get(ResearchWorkspace, "other")
        channel_id = team.stable(other, "general")
        source = TeamMessage(
            workspace_id=other.id, channel_id=channel_id, text="Private"
        )
        d.add(source)
        d.commit()
    assert post(features, forward_message_id=source.id).status_code == 409
    assert post(
        features, quote={"message_id": source.id, "text": "Private"}
    ).status_code == 409
    mid = member_message(features)
    response = post(features, forward_message_id=mid)
    assert response.status_code == 200, response.text
    with features.maker() as d:
        d.get(TeamMessage, mid).text = "Edited after forwarding"
        d.commit()
        forwarded = d.get(TeamMessage, response.json()["id"])
        assert forwarded.data["forward"]["text"] == "A useful finding"
        d.get(TeamChannel, features.channels["general"]).archived = True
        d.commit()
    assert reaction(features, mid).status_code == 409


def test_team_message_features_migration_roundtrip(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    from backend.config import Settings

    settings = Settings(
        database_url=f"sqlite:///{tmp_path / 'migration.db'}",
        storage=str(tmp_path / "files"),
        testing=True,
    )
    monkeypatch.setattr(Settings, "env", classmethod(lambda cls: settings))
    command.upgrade(Config(toml_file="pyproject.toml"), "0049")
    engine = create_engine(settings.database_url)
    migration = importlib.import_module(
        "backend.migrations.versions.0050_message_feedback"
    )
    assert migration.down_revision == "0049"
    table = TeamMessageReaction.__tablename__
    with engine.begin() as connection:
        assert table not in inspect(connection).get_table_names()
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            assert {
                column["name"] for column in inspect(connection).get_columns(table)
            } == set(TeamMessageReaction.__table__.columns.keys())
            migration.upgrade()
            assert connection.execute(select(TeamMessageReaction)).all() == []
            migration.downgrade()
            assert table not in inspect(connection).get_table_names()
            migration.upgrade()
            assert connection.execute(select(TeamMessageReaction)).all() == []
    engine.dispose()
