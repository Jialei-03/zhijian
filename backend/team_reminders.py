"""Researcher-only, one-shot reminders dispatched by the schedule worker."""

from datetime import UTC, datetime

from pydantic import AwareDatetime
from sqlalchemy import select, update

from .models import ResearchProject, TeamChannel, TeamMessage, TeamReminder
from .research_schedules import stamp
from .schemas import Strict


class ReminderInput(Strict):
    remind_at: AwareDatetime


def create(d, workspace, channel, message_id, remind_at):
    from . import research_team as team

    if channel.archived:
        raise ValueError("频道已归档 / Channel archived")
    if remind_at <= datetime.now(UTC):
        raise ValueError("提醒时间已过 / Reminder time has passed")
    message = d.get(TeamMessage, message_id)
    if message:
        if (
            message.workspace_id != workspace.id
            or message.channel_id != channel.id
            or message.kind == "reminder"
        ):
            raise ValueError("消息不存在 / Message not found")
        value = team.message_out(d, message)
    else:
        root = team.root_of(d, workspace, channel, message_id)
        value = (
            team.research_root(root, channel, d)
            if isinstance(root, ResearchProject)
            else team.message_out(d, root)
        )
    item = TeamReminder(
        owner=workspace.owner,
        workspace_id=workspace.id,
        channel_id=channel.id,
        message_id=message_id,
        thread_id=value["thread_id"],
        excerpt=team.preview_text(value["text"]),
        remind_at=stamp(remind_at),
    )
    d.add(item)
    d.flush()
    return {"id": item.id, "remind_at": item.remind_at}


def deliver_due(d, workspace, at):
    """Claim and append atomically; restart/catch-up cannot duplicate an event."""
    boundary = stamp(at)
    for item in d.scalars(
        select(TeamReminder).where(
            TeamReminder.workspace_id == workspace.id,
            TeamReminder.owner == workspace.owner,
            TeamReminder.delivered_at == "",
            TeamReminder.remind_at <= boundary,
        )
    ):
        channel = d.get(TeamChannel, item.channel_id)
        if not channel or channel.archived:
            continue
        claimed = d.execute(
            update(TeamReminder)
            .where(TeamReminder.id == item.id, TeamReminder.delivered_at == "")
            .values(delivered_at=boundary)
        )
        if not claimed.rowcount:
            continue
        d.add(
            TeamMessage(
                workspace_id=workspace.id,
                channel_id=item.channel_id,
                kind="reminder",
                text=item.excerpt,
                source_key=f"reminder:{item.id}",
                created_at=boundary,
                data={
                    "reminder": {
                        "message_id": item.message_id,
                        "channel_id": item.channel_id,
                        "thread_id": item.thread_id,
                    }
                },
            )
        )
    d.flush()
