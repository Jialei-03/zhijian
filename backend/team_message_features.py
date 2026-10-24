"""Researcher-only reactions and source snapshots for message references."""

import json
import re

from sqlalchemy import select

from .models import TeamChannel, TeamMember, TeamMessage, TeamMessageReaction

REACTIONS = ("👍", "👎", "✅")
FEEDBACK_HEADING = "\n\n## 近期反馈 / Recent feedback\n"


def source_message(d, workspace, identifier):
    from . import research_team as team

    message = d.get(TeamMessage, identifier)
    if message and message.workspace_id == workspace.id:
        return message
    # These older conversation entries are virtual roots, rather than SQL messages.
    key = "experiments" if identifier.startswith("research:") else "dm:advisor"
    if identifier.startswith(("research:", "legacy:", "legacy-user:")):
        channel = d.scalar(
            select(TeamChannel).where(
                TeamChannel.workspace_id == workspace.id, TeamChannel.key == key
            )
        )
        if channel:
            root = team.root_of(d, workspace, channel, identifier)
            if isinstance(root, TeamMessage):
                root.workspace_id = workspace.id
                return root
            return TeamMessage(
                id=identifier,
                workspace_id=workspace.id,
                channel_id=channel.id,
                author_id=team.stable(workspace, "human"),
                text=root.question,
                kind="research",
                data={},
                mentions=[],
                created_at=root.created_at,
            )
    raise ValueError("消息不存在 / Message not found")


def source_text(d, message):
    from .research_team import message_out

    text = message_out(d, message)["text"]
    text += "\n" + "\n".join(
        message.data[key]["text"]
        for key in ("forward", "quote")
        if message.data.get(key)
    )
    return text.strip() or "\n".join(
        file["name"]
        for file in [
            *message.data.get("files", []), *message.data.get("attachments", [])
        ]
    )


def reference(d, workspace, identifier, selected=None):
    from . import research_team as team

    message = source_message(d, workspace, identifier)
    text = source_text(d, message)
    if selected is not None:
        selected = team.normalize(selected).strip()
        needle = " ".join(selected.split())
        if not needle or not (
            needle in " ".join(text.split()) or needle in team.plain_text(text)
        ):
            raise ValueError("引用与原文不符 / Quote does not match source")
        excerpt = selected
    else:
        excerpt = team.plain_text(text)[:1200]
    author = d.get(TeamMember, message.author_id) if message.author_id else None
    return dict(
        message_id=message.id,
        channel_id=message.channel_id,
        thread_id=message.thread_id,
        author_id=message.author_id,
        author_name=author.name if author else "",
        created_at=message.created_at,
        text=excerpt,
    )


def message_text(d, message):
    """Include reference text in wakes, merged inbox entries and immediate steering."""
    from .research_team import message_out

    text = message_out(d, message)["text"]
    for key in ("forward", "quote"):
        ref = message.data.get(key)
        if ref:
            text += f"\n\n{key}:\n" + json.dumps(ref, ensure_ascii=False)
    if message.data.get("done_when"):
        text += "\n\n完成标准 / Done when: " + message.data["done_when"]
    return text.strip()


def reactions(d, workspace_id, message_id):
    if not workspace_id:
        return []
    rows = list(
        d.scalars(
            select(TeamMessageReaction).where(
                TeamMessageReaction.message_id == message_id,
                TeamMessageReaction.workspace_id == workspace_id,
            )
        )
    )
    human = (
        d.scalar(
            select(TeamMember.id).where(
                TeamMember.workspace_id == workspace_id, TeamMember.role == "human"
            )
        )
        if rows
        else None
    )
    return [
        dict(
            emoji=emoji,
            count=sum(row.emoji == emoji for row in rows),
            mine=any(row.emoji == emoji and row.member_id == human for row in rows),
        )
        for emoji in REACTIONS
        if any(row.emoji == emoji for row in rows)
    ]


def react(d, workspace, message, emoji, *, remove=False):
    if emoji not in REACTIONS:
        raise ValueError("反应不可用 / Reaction unavailable")
    channel = d.get(TeamChannel, message.channel_id)
    if workspace.archived or channel.archived:
        raise ValueError("团队或频道已归档 / Team or channel archived")
    human = d.scalar(
        select(TeamMember).where(
            TeamMember.workspace_id == workspace.id, TeamMember.role == "human"
        )
    )
    key = (message.id, human.id, emoji)
    prior = d.get(TeamMessageReaction, key)
    if prior and remove:
        d.delete(prior)
    elif not prior and not remove:
        from .research_team import plain_text

        d.add(
            TeamMessageReaction(
                workspace_id=workspace.id,
                message_id=message.id,
                member_id=human.id,
                author_id=message.author_id,
                excerpt=plain_text(source_text(d, message))[:300],
                emoji=emoji,
            )
        )
    d.flush()
    return reactions(d, workspace.id, message.id)


def feedback_part(d, member):
    rows = list(
        d.scalars(
            select(TeamMessageReaction)
            .join(TeamMember, TeamMember.id == TeamMessageReaction.member_id)
            .where(
                TeamMessageReaction.workspace_id == member.workspace_id,
                TeamMessageReaction.author_id == member.id,
                TeamMember.workspace_id == member.workspace_id,
                TeamMember.role == "human",
                TeamMessageReaction.emoji.in_(("👍", "👎")),
            )
            .order_by(
                TeamMessageReaction.created_at.desc(),
                TeamMessageReaction.message_id.desc(),
                TeamMessageReaction.emoji,
            )
            .limit(10)
        )
    )
    if not rows:
        return ""
    feedback = [
        dict(
            message_id=row.message_id,
            text=row.excerpt,
            reaction=row.emoji,
        )
        for row in rows
    ]
    return FEEDBACK_HEADING + json.dumps(feedback, ensure_ascii=False)


def refresh_feedback(d, member, context):
    # A queued run can start after votes changed; replace its old single-line JSON.
    context = re.sub(re.escape(FEEDBACK_HEADING) + r"[^\n]*", "", context)
    return context + feedback_part(d, member)
