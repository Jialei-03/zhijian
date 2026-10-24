"""Leave and reminders: in-memory SQLite only, no models/network/SSH/Git."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from backend import research_team as team, team_workflows as flows
from backend.agent_worker import ready_job
from backend.models import (
    AgentRun,
    ResearchWorkspace,
    TeamDelivery,
    TeamMember,
    TeamMessage,
    TeamReminder,
)
from backend.research_schedules import tick
from backend.research_team_routes import install_team_routes
from backend.research_team_tools import _call
from backend.tests.test_team_empty_replies import empty_reply  # noqa: F401


@pytest.fixture
def local_team(empty_reply):  # noqa: F811
    d, workspace, channel, run, reply = empty_reply
    app = FastAPI()

    def db():
        yield d

    def workspace_of(session, identifier, owner):
        value = session.get(ResearchWorkspace, identifier)
        if not value or value.owner != owner:
            raise HTTPException(404)
        return value

    install_team_routes(app, None, db, lambda: workspace.owner, workspace_of)
    maker = sessionmaker(bind=d.bind, expire_on_commit=False)
    app.state.maker = maker
    with TestClient(app) as client:
        yield (
            client,
            f"/api/v1/research/workspaces/{workspace.id}/team",
            empty_reply,
            app,
        )


def test_team_pause_preserves_running_work_and_human_mentions(local_team):
    client, base, (d, workspace, channel, run, reply), _ = local_team
    run.status = "running"
    d.commit()
    path = base + f"/members/{reply.author_id}"
    assert client.patch(path, json={"paused": True}).status_code == 200
    member = d.get(TeamMember, reply.author_id)
    assert member.paused and member.enabled
    message = team.post(d, workspace, channel, "@writer hello")
    assert message.mentions == [member.id]
    assert not list(d.scalars(select(TeamDelivery)))
    value = client.get(path).json()
    assert value["paused"] and value["status"] == "working"
    assert value["active_run_id"] == run.id
    assert run.status == "running"
    assert client.patch(path, json={"paused": False}).status_code == 200
    message = team.post(d, workspace, channel, "@writer welcome back")
    assert d.scalar(select(TeamDelivery).where(TeamDelivery.message_id == message.id))
    assert (
        client.patch(
            base + f"/members/{team.stable(workspace, 'human')}", json={"paused": True}
        ).status_code
        == 422
    )
    assert (
        client.patch(
            base.replace(workspace.id, "other") + "/members/any", json={"paused": True}
        ).status_code
        == 404
    )


def test_team_pause_blocks_tools_dispatch_and_worker_claim(local_team):
    _, _, (d, workspace, channel, run, reply), app = local_team
    writer = d.get(TeamMember, reply.author_id)
    writer.paused = True
    run.status = "queued"
    run.runtime = {"team": {"member_id": writer.id}}
    d.commit()
    # No model config is even read for a paused member.
    assert ready_job(d, SimpleNamespace()) is None
    delivery = TeamDelivery(message_id="request", member_id=writer.id)
    d.add(delivery)
    d.flush()
    team.dispatch(None, d, workspace, delivery)
    assert delivery.status == "queued" and delivery.run_id is None
    info = {
        "workspace_id": workspace.id,
        "member_id": team.stable(workspace, "librarian"),
        "channel_id": channel.id,
        "run_id": run.id,
    }
    d.commit()
    for field in ("wake", "to"):
        with pytest.raises(ValueError, match="暂停中"):
            _call(
                app,
                workspace.owner,
                info,
                "team_send_message",
                {"text": "Help", field: ["writer"]},
            )
    d.expire_all()
    assert d.get(AgentRun, run.id).status == "queued"


@pytest.mark.parametrize("subscribers", [False, True])
def test_team_pause_workflow_skip_is_activity_and_keeps_other_targets(
    local_team, subscribers
):
    client, base, (d, workspace, channel, _, reply), _ = local_team
    writer = d.get(TeamMember, reply.author_id)
    writer.paused = True
    if subscribers:
        writer.subscriptions = [channel.id]
        d.get(TeamMember, team.stable(workspace, "reviewer")).subscriptions = [
            channel.id
        ]
    flows.save(
        d,
        workspace,
        {
            **workspace.workflow,
            "builtin": False,
            "rules": [
                {
                    "id": "delegate",
                    "enabled": True,
                    "when": {"event": "message"},
                    "then": {
                        "action": "wake",
                        **(
                            {"subscribers": True}
                            if subscribers
                            else {"member": writer.id}
                        ),
                    },
                }
            ],
        },
    )
    message = team.post(d, workspace, channel, "Check this")
    d.commit()
    deliveries = list(d.scalars(select(TeamDelivery)))
    assert all(row.member_id != writer.id for row in deliveries)
    assert len(deliveries) == int(subscribers)
    event = next(
        row
        for row in client.get(base + "/activity").json()
        if row["activity_type"] == "paused"
    )
    assert event["data"]["paused_member"] == writer.id
    assert event["data"]["rule"] == "delegate"
    assert not event["data"]["waiting"]
    assert event["unread"]
    assert message.text == "Check this"


def test_team_pause_multiple_mentions_still_wake_available_members(local_team):
    _, _, (d, workspace, channel, _, reply), _ = local_team
    d.get(TeamMember, reply.author_id).paused = True
    team.post(d, workspace, channel, "@writer @reviewer please check")
    assert [row.member_id for row in d.scalars(select(TeamDelivery))] == [
        team.stable(workspace, "reviewer")
    ]


def test_team_reminder_schedule_tick_is_private_durable_and_one_shot(local_team):
    client, base, (d, workspace, channel, _, _), app = local_team
    at = datetime.now(UTC) + timedelta(hours=1)
    path = base + f"/channels/{channel.id}/messages/request/reminders"
    result = client.post(path, json={"remind_at": at.isoformat()})
    assert result.status_code == 200, result.text
    assert not list(d.scalars(select(TeamDelivery)))
    assert not any(
        event["activity_type"] == "reminder" for event in team.activity(d, workspace)
    )
    settings = SimpleNamespace(mode="local")
    tick(settings, app.state.maker, at - timedelta(seconds=1))
    assert not d.scalar(select(TeamMessage).where(TeamMessage.kind == "reminder"))
    tick(settings, app.state.maker, at + timedelta(days=2))  # Catch up after restart.
    tick(settings, app.state.maker, at + timedelta(days=2))
    d.expire_all()
    reminders = list(
        d.scalars(select(TeamMessage).where(TeamMessage.kind == "reminder"))
    )
    assert len(reminders) == 1
    reminder = reminders[0]
    assert reminder.text == "Previous message"
    assert reminder.data["reminder"] == {
        "message_id": "request",
        "channel_id": channel.id,
        "thread_id": None,
    }
    assert d.get(TeamReminder, result.json()["id"]).delivered_at
    assert len(list(d.scalars(select(AgentRun)))) == 1
    assert not list(d.scalars(select(TeamDelivery)))
    assert not any(
        row["kind"] == "reminder"
        for row in team.history(d, workspace, channel)["messages"]
    )
    with pytest.raises(ValueError, match="Thread not found"):
        team.history(d, workspace, channel, reminder.id)
    assert not any(
        row["kind"] == "reminder"
        for row in team.overview(d, workspace, include_reminders=False)["notifications"]
    )
    overview = team.overview(d, workspace)
    assert overview["activity_unread"] == 1
    assert next(c for c in overview["channels"] if c["id"] == channel.id)["unread"] == 0
    # Reading the conversation cannot consume a private reminder.
    client.post(
        base + f"/channels/{channel.id}/read", json={"through": reminder.created_at}
    )
    assert not reminder.data.get("read")
    # Set a present timestamp so the read boundary is valid (delivery above used a future clock).
    reminder.created_at = team.now()
    d.commit()
    assert (
        client.post(
            base + "/activity/read",
            json={"through": reminder.created_at, "message_id": reminder.id},
        ).status_code
        == 200
    )
    assert team.overview(d, workspace)["activity_unread"] == 0


@pytest.mark.parametrize(
    "value", ["yesterday", "2020-01-01T00:00:00Z", "2030-01-01T09:00:00"]
)
def test_team_reminder_rejects_invalid_or_past_time(local_team, value):
    client, base, (d, _, channel, _, _), _ = local_team
    assert (
        client.post(
            base + f"/channels/{channel.id}/messages/request/reminders",
            json={"remind_at": value},
        ).status_code
        == 422
    )
    assert not list(d.scalars(select(TeamReminder)))


def test_team_reminder_checks_message_scope_and_keeps_thread_target(local_team):
    client, base, (d, workspace, channel, run, reply), _ = local_team
    at = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    other = team.stable(workspace, "review")
    assert (
        client.post(
            base + f"/channels/{other}/messages/request/reminders",
            json={"remind_at": at},
        ).status_code
        == 422
    )
    assert (
        client.post(
            base + f"/channels/{channel.id}/messages/missing/reminders",
            json={"remind_at": at},
        ).status_code
        == 422
    )
    run.response = "**Evidence** with [source](https://example.invalid)"
    d.commit()
    response = client.post(
        base + f"/channels/{channel.id}/messages/{reply.id}/reminders",
        json={"remind_at": at},
    )
    assert response.status_code == 200
    item = d.get(TeamReminder, response.json()["id"])
    assert item.thread_id == "request" and item.message_id == reply.id
    assert item.excerpt == "Evidence with source"


def test_team_pause_legacy_schedule_records_skip_without_launch(local_team):
    from backend.models import ResearchProject, ResearchSchedule
    from backend.team_timers import run_legacy, sync

    client, _, (d, workspace, channel, _, _), _ = local_team
    advisor = d.get(TeamMember, team.stable(workspace, "advisor"))
    advisor.paused = True
    at = datetime.now(UTC)
    item = ResearchSchedule(
        owner=workspace.owner,
        workspace_id=workspace.id,
        title="Review",
        prompt="Review",
        timezone="UTC",
        next_run_at=at.isoformat(),
    )
    d.add(item)
    d.flush()
    sync(d, item)
    record = run_legacy(None, d, item, at, manual=True)
    d.commit()
    assert record.status == "failed" and "暂停" in record.error
    assert not list(d.scalars(select(ResearchProject)))
    assert not list(d.scalars(select(TeamDelivery)))
    notice = next(
        event
        for event in team.activity(d, workspace)
        if event["activity_type"] == "paused"
    )
    assert notice["data"]["paused_member"] == advisor.id


def test_team_pause_legacy_queued_advisor_cannot_be_claimed(local_team):
    from backend.models import AgentSession

    _, _, (d, workspace, _, run, _), _ = local_team
    session = AgentSession(
        owner=workspace.owner,
        workspace_id=workspace.id,
        kind="project_chat",
        title="Legacy",
    )
    d.add(session)
    d.flush()
    run.session_id = session.id
    run.runtime = {"research": {"role": "chat", "workspace_id": workspace.id}}
    run.status = "queued"
    d.get(TeamMember, team.stable(workspace, "advisor")).paused = True
    d.commit()
    assert ready_job(d, SimpleNamespace()) is None


def test_team_reminder_is_absent_from_schedule_center(local_team):
    from backend.research_schedules import install_schedule_routes

    client, base, (d, workspace, channel, _, _), app = local_team
    at = datetime.now(UTC) + timedelta(hours=1)
    assert (
        client.post(
            base + f"/channels/{channel.id}/messages/request/reminders",
            json={"remind_at": at.isoformat()},
        ).status_code
        == 200
    )

    def db():
        yield d

    install_schedule_routes(
        app,
        None,
        db,
        lambda: {"id": workspace.owner},
        lambda a, d: None,
        None,
        None,
        None,
    )
    assert client.get("/api/v1/research/schedules").json() == []


def test_team_pause_reminder_migration_is_additive_and_reversible():
    import importlib.util
    from pathlib import Path

    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = (
        Path(__file__).parents[1] / "migrations/versions/0052_team_pause_reminders.py"
    )
    spec = importlib.util.spec_from_file_location("pause_reminder_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.down_revision == "0051"
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        for table in ("users", "research_workspaces", "team_channels", "team_members"):
            connection.exec_driver_sql(
                f"CREATE TABLE {table} (id VARCHAR(36) PRIMARY KEY)"
            )
        connection.exec_driver_sql("INSERT INTO team_members VALUES ('existing')")
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert (
            connection.exec_driver_sql(
                "SELECT paused FROM team_members WHERE id='existing'"
            ).scalar()
            == 0
        )
        assert {
            column["name"]
            for column in sa.inspect(connection).get_columns("team_reminders")
        } >= {"owner", "remind_at", "delivered_at", "message_id"}
        migration.downgrade()
        assert "team_reminders" not in sa.inspect(connection).get_table_names()
        assert (
            connection.exec_driver_sql("SELECT id FROM team_members").scalar()
            == "existing"
        )
    engine.dispose()


def test_team_reminder_concurrent_scheduler_ticks_deliver_once(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    from sqlalchemy import create_engine
    from backend.models import Base, TeamChannel

    engine = create_engine(f"sqlite:///{tmp_path / 'reminders.db'}")
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, expire_on_commit=False)
    at = datetime.now(UTC)
    with maker() as d:
        workspace = ResearchWorkspace(owner="owner", name="Offline")
        d.add(workspace)
        d.flush()
        team.ensure(d, workspace)
        channel = d.get(TeamChannel, team.stable(workspace, "general"))
        d.add(
            TeamReminder(
                owner=workspace.owner,
                workspace_id=workspace.id,
                channel_id=channel.id,
                message_id="original",
                excerpt="Reminder",
                remind_at=(at - timedelta(minutes=1)).isoformat(),
            )
        )
        d.commit()
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(
            pool.map(lambda _: tick(SimpleNamespace(mode="local"), maker, at), range(2))
        )
    with maker() as d:
        assert (
            len(
                list(
                    d.scalars(select(TeamMessage).where(TeamMessage.kind == "reminder"))
                )
            )
            == 1
        )
    engine.dispose()
