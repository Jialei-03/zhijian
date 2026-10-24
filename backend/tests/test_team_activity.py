"""Activity aggregation and read receipts: SQLite and in-process ASGI only."""

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend import research_team as team
from backend.models import (
    ResearchEvent,
    ResearchProject,
    ResearchSprint,
    ResearchWorkspace,
    TeamChannel,
    TeamDelivery,
    TeamMessage,
)
from backend.research_team_routes import install_team_routes
from backend.tests.test_team_empty_replies import empty_reply  # noqa: F401


@pytest.fixture
def inbox(empty_reply):  # noqa: F811
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
    with TestClient(app) as client:
        yield client, f"/api/v1/research/workspaces/{workspace.id}/team", empty_reply


def test_team_activity_types_and_context(inbox):
    client, base, (d, workspace, channel, run, reply) = inbox
    human = team.stable(workspace, "human")
    run.response = "**Done**\nwith evidence"
    run.runtime = {"team": {"message_id": "request"}}
    # A completed run can also mention the researcher and reply to their thread.
    reply.mentions = [human]
    events = {
        "mention": dict(mentions=[human]),
        "called": dict(data={"to": [human]}),
        "waiting": dict(data={"waiting": True}),
        "budget": dict(kind="budget", text="", data={"reason": "team_tokens"}),
        "limit": dict(kind="relay_limit", text="", data={"reason": "review"}),
        "reply-only": dict(thread_id="request"),
        "unrelated": {},
    }
    for index, (identifier, changes) in enumerate(events.items()):
        d.add(
            TeamMessage(
                **(
                    dict(
                        id=identifier,
                        workspace_id=workspace.id,
                        channel_id=channel.id,
                        author_id=reply.author_id,
                        text=identifier,
                        created_at=f"2026-10-23T12:{index:02d}:00Z",
                    )
                    | changes
                )
            )
        )
    d.commit()
    result = client.get(base + "/activity")
    assert result.status_code == 200
    rows = result.json()
    assert [row["id"] for row in rows] == [
        "reply-only",
        "limit",
        "budget",
        "waiting",
        "called",
        "mention",
        "reply",
    ]
    by_id = {row["id"]: row for row in rows}
    assert by_id["reply"]["activity_types"] == ["mention", "completed", "reply"]
    assert by_id["reply"]["preview"] == "Done with evidence"
    assert by_id["reply"]["actor_id"] == reply.author_id
    assert by_id["reply"]["channel"] == team.conversation_out(channel)
    assert all(row["unread"] for row in rows)
    for identifier, kind in [
        ("waiting", "waiting"),
        ("budget", "budget"),
        ("limit", "limit"),
        ("called", "mention"),
        ("reply-only", "reply"),
    ]:
        assert by_id[identifier]["activity_type"] == kind
    overview = team.overview(d, workspace)
    assert overview["activity_unread"] == len(rows)
    assert {row["id"] for row in overview["notifications"]} == set(by_id)


def test_team_activity_completion_uses_delivery_even_without_a_thread(inbox):
    client, base, (d, workspace, _, run, reply) = inbox
    run.response = "Completed the task"
    reply.thread_id, reply.mentions = None, []
    d.add(
        TeamDelivery(
            message_id="request",
            member_id=reply.author_id,
            run_id=run.id,
            status="applied",
        )
    )
    d.commit()
    assert client.get(base + "/activity").json()[0]["activity_types"] == ["completed"]
    run.status = "running"
    d.commit()
    assert client.get(base + "/activity").json() == []


@pytest.mark.parametrize(
    "flag,kind", [("time_limit_reached", "limit"), ("budget_limit", "budget")]
)
def test_team_activity_keeps_empty_run_limits(inbox, flag, kind):
    client, base, (d, workspace, _, run, reply) = inbox
    run.runtime = {flag: True, "team": {"member_id": reply.author_id}}
    reply.author_id, reply.mentions = None, []
    d.commit()
    event = client.get(base + "/activity").json()[0]
    assert event["activity_type"] == kind
    assert event["actor_id"] == run.runtime["team"]["member_id"]
    assert team.overview(d, workspace)["activity_unread"] == 1
    assert team.overview(d, workspace)["threads_unread"] == 1
    assert client.get(base + "/threads").json()[0]["unread"] == 1


def test_team_activity_read_one_all_and_channel_share_receipts(inbox):
    client, base, (d, workspace, channel, run, reply) = inbox
    run.response = "Reply"
    human = team.stable(workspace, "human")
    for identifier, stamp in [("later", "12:00"), ("new-arrival", "13:00")]:
        d.add(
            TeamMessage(
                id=identifier,
                workspace_id=workspace.id,
                channel_id=channel.id,
                author_id=reply.author_id,
                text=identifier,
                mentions=[human],
                created_at=f"2026-10-23T{stamp}:00Z",
            )
        )
    d.commit()
    assert (
        client.post(
            base + "/activity/read",
            json={
                "through": reply.created_at,
                "message_id": reply.id,
            },
        ).status_code
        == 200
    )
    assert team.overview(d, workspace)["activity_unread"] == 2
    assert (
        client.post(
            base + "/activity/read",
            json={
                "through": "2026-10-23T12:00:00Z",
            },
        ).status_code
        == 200
    )
    rows = client.get(base + "/activity").json()
    assert {r["id"]: r["unread"] for r in rows} == {
        "reply": False,
        "later": False,
        "new-arrival": True,
    }
    # A conversation read updates the same activity receipt.
    assert (
        client.post(
            base + f"/channels/{channel.id}/read",
            json={
                "through": "2026-10-23T13:00:00Z",
            },
        ).status_code
        == 200
    )
    assert team.overview(d, workspace)["activity_unread"] == 0
    assert (
        client.get(base.replace(workspace.id, "missing") + "/activity").status_code
        == 404
    )
    assert (
        client.post(
            base.replace(workspace.id, "missing") + "/activity/read",
            json={"through": team.now()},
        ).status_code
        == 404
    )


def test_team_activity_requires_prior_participation_and_skips_archived(inbox):
    client, base, (d, workspace, channel, run, reply) = inbox
    reply.mentions = []
    run.response = "Before joining"
    reply.created_at = "2026-10-23T09:00:00Z"
    d.commit()
    assert client.get(base + "/activity").json() == []
    reply.mentions = [team.stable(workspace, "human")]
    channel.archived = True
    d.commit()
    assert client.get(base + "/activity").json() == []


def test_team_threads_include_source_participants_unread_and_last_activity(inbox):
    client, base, (d, workspace, channel, run, reply) = inbox
    run.response = "Thread reply"
    human = team.stable(workspace, "human")
    dm = d.get(TeamChannel, team.stable(workspace, "dm:writer"))
    d.add_all(
        [
            TeamMessage(
                id="dm-request",
                workspace_id=workspace.id,
                channel_id=dm.id,
                author_id=human,
                text="Direct request",
                created_at="2026-10-23T10:30:00Z",
            ),
            TeamMessage(
                id="dm-reply",
                workspace_id=workspace.id,
                channel_id=dm.id,
                thread_id="dm-request",
                author_id=reply.author_id,
                text="Direct reply",
                data={"read": True},
                created_at="2026-10-23T12:00:00Z",
            ),
        ]
    )
    d.commit()
    rows = client.get(base + "/threads").json()
    assert [row["id"] for row in rows] == ["dm-request", "request"]
    assert rows[0]["channel"]["member_id"] == reply.author_id
    assert rows[0]["unread"] == 0
    assert rows[1]["channel"] == team.conversation_out(channel)
    assert rows[1]["author_id"] == human
    assert rows[1]["participant_ids"] == [reply.author_id, human]
    assert rows[1]["replies"] == rows[1]["unread"] == 1
    assert rows[1]["last_message_at"] == reply.created_at


def test_team_activity_badge_counts_beyond_notification_preview(inbox):
    _, _, (d, workspace, channel, _, reply) = inbox
    for index in range(105):
        d.add(
            TeamMessage(
                workspace_id=workspace.id,
                channel_id=channel.id,
                author_id=reply.author_id,
                text=str(index),
                data={"waiting": True},
            )
        )
    d.commit()
    overview = team.overview(d, workspace)
    assert overview["activity_unread"] == 105
    assert len(team.activity(d, workspace)) == 105
    assert len(overview["notifications"]) == 100


def test_team_activity_and_threads_keep_native_research_context(inbox):
    client, base, (d, workspace, _, run, reply) = inbox
    channel = d.get(TeamChannel, team.stable(workspace, "experiments"))
    project = ResearchProject(
        id="native",
        owner=workspace.owner,
        workspace_id=workspace.id,
        question="Native research",
        session_id=run.session_id,
        model_config_id=run.model_config_id,
    )
    d.add(project)
    d.flush()
    d.add_all(
        [
            ResearchEvent(
                project_id=project.id,
                actor="advisor",
                action="message",
                detail={"text": "Evidence"},
            ),
            ResearchSprint(
                project_id=project.id,
                number=1,
                role="workflow",
                run_id=run.id,
                summary="Experiment",
            ),
        ]
    )
    run.response = "Native reply"
    reply.channel_id, reply.thread_id, reply.mentions = (
        channel.id,
        "research:native",
        [],
    )
    d.commit()
    event = client.get(base + "/activity").json()[0]
    assert event["activity_types"] == ["reply"]
    assert event["thread_id"] == "research:native"
    native = next(
        row
        for row in client.get(base + "/threads").json()
        if row["id"] == "research:native"
    )
    assert native["channel"] == team.conversation_out(channel)
    assert native["author_id"] == team.stable(workspace, "human")
    assert set(native["participant_ids"]) == {
        team.stable(workspace, role)
        for role in ["human", "advisor", "executor", "writer"]
    }
