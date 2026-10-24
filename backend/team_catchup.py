"""Deterministic catch-up receipts. Reading a summary never advances read state."""

import json
from datetime import UTC, datetime

from sqlalchemy import select

from . import research_team as team
from .models import (
    AgentRun,
    AgentSession,
    ResearchProject,
    ResearchSprint,
    TeamDelivery,
    TeamMember,
    TeamMessage,
)
from .team_presence import output_files


def timestamp(value):
    try:
        stamp = datetime.fromisoformat(value)
        if stamp.tzinfo is None:
            raise ValueError
        return stamp.astimezone(UTC).isoformat()
    except (TypeError, ValueError):
        raise ValueError("时间无效 / Invalid timestamp") from None


def summary(d, workspace, channel, since=None, through=None):
    through = min(timestamp(through or team.now()), team.now())
    since = timestamp(since or channel.read_at or channel.created_at)
    if since > through:
        raise ValueError("时间范围无效 / Invalid time range")
    human = team.stable(workspace, "human")
    messages = list(
        d.scalars(
            select(TeamMessage)
            .where(
                TeamMessage.workspace_id == workspace.id,
                TeamMessage.channel_id == channel.id,
            )
            .order_by(TeamMessage.created_at, TeamMessage.id)
        )
    )
    # Native research and legacy advisor work can finish without a team message.
    represented = {message.data.get("run_id") for message in messages}
    for run, session in d.execute(
        select(AgentRun, AgentSession)
        .join(AgentSession, AgentSession.id == AgentRun.session_id)
        .where(
            AgentRun.owner == workspace.owner,
            AgentRun.status.in_(["completed", "failed"]),
            AgentRun.updated_at > since,
            AgentRun.updated_at <= through,
        )
    ):
        if run.id in represented:
            continue
        origin = (run.runtime or {}).get("team") or {}
        member_id, thread_id = origin.get("member_id"), origin.get("thread_id")
        matches = (
            origin.get("workspace_id") == workspace.id
            and origin.get("channel_id") == channel.id
        )
        identifier = f"run:{run.id}"
        if (
            not origin
            and channel.key == "dm:advisor"
            and session.workspace_id == workspace.id
            and session.kind in {"project_lead", "project_chat"}
        ):
            matches, member_id = True, team.stable(workspace, "advisor")
            identifier = f"legacy:{run.id}"
        if not origin and channel.key == "experiments":
            sprint = d.scalar(
                select(ResearchSprint)
                .join(ResearchProject)
                .where(
                    ResearchSprint.run_id == run.id,
                    ResearchProject.workspace_id == workspace.id,
                )
            )
            if sprint:
                role = {
                    "scoping": "advisor",
                    "discussion": "advisor",
                    "workflow": "executor",
                    "review": "advisor",
                }.get(sprint.role, sprint.role)
                assigned = (run.runtime or {}).get("research", {}).get("member_id")
                member = d.scalar(
                    select(TeamMember).where(
                        TeamMember.workspace_id == workspace.id,
                        TeamMember.id == assigned
                        if assigned
                        else TeamMember.role == role,
                    )
                )
                if member:
                    matches, member_id, thread_id = (
                        True,
                        member.id,
                        f"research:{sprint.project_id}",
                    )
        if matches:
            messages.append(
                TeamMessage(
                    id=identifier,
                    workspace_id=workspace.id,
                    channel_id=channel.id,
                    thread_id=thread_id,
                    author_id=member_id,
                    text=run.response,
                    kind="run",
                    data={"run_id": run.id},
                    mentions=[],
                    created_at=run.updated_at,
                )
            )
    messages.sort(key=lambda message: (message.created_at, message.id))
    owner_replies = {
        json.dumps(
            message.data.get("routing_scope")
            or [workspace.id, channel.id, message.thread_id],
            separators=(",", ":"),
        ): message.created_at
        for message in messages
        if message.author_id == human and message.created_at <= through
    }
    values = {message.id: team.message_out(d, message) for message in messages}
    new_messages = [
        message
        for message in messages
        if since < message.created_at <= through
        and message.author_id != human
        and team.has_message_content(values[message.id])
    ]
    unread = [message for message in new_messages if not message.data.get("read")]
    completed, files, handoffs, waiting, failed = {}, {}, [], [], []
    seen_runs = set()
    for message in messages:
        value = values[message.id]
        run = value.get("run") or {}
        # A run may finish while its already-read placeholder keeps its old timestamp.
        run_at = run.get("updated_at", message.created_at)
        fresh = since < message.created_at <= through
        settled = (
            run.get("status") in {"completed", "failed", "cancelled"}
            and since < run_at <= through
        )
        if message.author_id == human or not (fresh or settled):
            continue
        if run and run["id"] not in seen_runs and settled:
            seen_runs.add(run["id"])
            if run["status"] == "completed":
                completed[message.author_id] = completed.get(message.author_id, 0) + 1
            elif run["status"] == "failed":
                failed.append(
                    {
                        "message_id": message.id,
                        "member_id": message.author_id,
                        "text": run.get("error") or team.preview_text(value["text"]),
                    }
                )
        # Output and notification receipts share the same event window.
        if fresh or settled:
            for file in output_files(value["data"]):
                files[file["path"]] = {**file, "member_id": message.author_id}
            targets = [
                identifier
                for identifier in message.data.get("to", [])
                if identifier != human
            ]
            if targets:
                handoffs.append(
                    {
                        "message_id": message.id,
                        "member_id": message.author_id,
                        "to": targets,
                    }
                )
            scope = message.data.get("routing_scope") or [
                workspace.id,
                channel.id,
                message.thread_id,
            ]
            scope_key = json.dumps(scope, separators=(",", ":"))
            answered = owner_replies.get(scope_key, "") > message.created_at
            partition = workspace.workflow_state.get("threads", {}).get(scope_key)
            if (
                message.data.get("waiting")
                and not answered
                and (partition is None or partition.get("waiting"))
            ):
                waiting.append(
                    {
                        "message_id": message.id,
                        "member_id": message.author_id,
                        "text": team.preview_text(value["text"]),
                    }
                )
            if (
                message.kind in {"budget", "relay_limit"}
                or message.data.get("status") == "failed"
                or message.data.get("file_error")
            ):
                failed.append(
                    {
                        "message_id": message.id,
                        "member_id": message.author_id,
                        "text": message.data.get("file_error")
                        or team.preview_text(value["text"]),
                    }
                )
    # Failed admission has no run, so it only appears on its delivery receipt.
    for delivery, message in d.execute(
        select(TeamDelivery, TeamMessage)
        .join(TeamMessage, TeamMessage.id == TeamDelivery.message_id)
        .where(
            TeamMessage.workspace_id == workspace.id,
            TeamMessage.channel_id == channel.id,
            TeamDelivery.status == "failed",
            TeamDelivery.run_id.is_(None),
            TeamDelivery.created_at > since,
            TeamDelivery.created_at <= through,
        )
    ):
        failed.append(
            {
                "message_id": message.id,
                "member_id": delivery.member_id,
                "text": delivery.error,
            }
        )
    first = (
        unread[0]
        if unread
        else next(
            (
                message
                for message in messages
                if (values[message.id].get("run") or {}).get("id") in seen_runs
            ),
            None,
        )
    )
    return {
        "since": since,
        "through": through,
        "show": len(new_messages) >= 5 or bool(completed),
        "new_messages": len(new_messages),
        "first_unread": {"id": first.id, "thread_id": first.thread_id}
        if first
        else None,
        "completed": [
            {"member_id": member, "count": count} for member, count in completed.items()
        ],
        "files": list(files.values()),
        "handoffs": handoffs,
        "waiting": waiting,
        "failed": list({item["message_id"]: item for item in failed}.values()),
    }
