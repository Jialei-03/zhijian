"""Researcher decisions on member deliverables, separate from research approvals."""

from sqlalchemy import select

from .models import TeamMember, TeamMessage, now


def can_decide(value, author):
    return bool(
        author
        and author.role != "human"
        and value["kind"]
        not in {
            "plan",
            "conclusion",
            "thread_broadcast",
            "event_reference",
            "sprint_reference",
        }
        and (
            not value.get("run") or value["run"]["status"] not in {"queued", "running"}
        )
        and (
            value["kind"] in {"result", "draft", "review"}
            or value["data"].get("files")
            or value["data"].get("attachments")
            or (value["data"].get("changes") or {}).get("files")
        )
    )


def decide(d, workspace, message, status, feedback):
    from . import research_team as team
    from . import team_workflows as workflows
    from .team_message_features import reference

    channel = team.channel_of(d, workspace, message.channel_id)
    author = d.get(TeamMember, message.author_id) if message.author_id else None
    if (
        workspace.archived
        or channel.archived
        or not can_decide(team.message_out(d, message), author)
    ):
        raise ValueError("消息不可裁决 / Message cannot be decided")
    feedback = team.normalize(feedback).strip()
    if status not in {"accepted", "changes_requested"}:
        raise ValueError("裁决不可用 / Decision unavailable")
    if status == "changes_requested" and not feedback:
        raise ValueError("修改意见为空 / Revision feedback is empty")
    previous = message.data.get("decision") or {}
    if (previous.get("status"), previous.get("feedback")) == (status, feedback):
        return d.get(TeamMessage, previous["event_id"])
    human = d.scalar(
        select(TeamMember).where(
            TeamMember.workspace_id == workspace.id, TeamMember.role == "human"
        )
    )
    event = TeamMessage(
        workspace_id=workspace.id,
        channel_id=message.channel_id,
        thread_id=message.thread_id,
        author_id=human.id,
        kind=status,
        text=feedback,
        data={
            "decision_message_id": message.id,
            "decision_author_id": author.id,
            "done_when": message.data.get("done_when", ""),
            "quote": reference(d, workspace, message.id),
            "routing_scope": message.data.get("routing_scope"),
        },
    )
    d.add(event)
    d.flush()
    message.data = {
        **message.data,
        "decision": {
            "status": status,
            "feedback": feedback,
            "event_id": event.id,
            "created_at": now(),
        },
    }
    flow = workflows.adopt(d, workspace)
    # Acceptance must not reserve a review or advance a wake that never runs.
    rules = [
        rule["id"]
        for rule in flow["rules"]
        if status != "accepted" or rule["then"]["action"] not in {"wake", "review"}
    ]
    actions = workflows.event(
        d,
        workspace,
        event,
        trigger=status,
        kind=message.kind if message.kind in {"result", "draft", "review"} else "text",
        rules=rules,
        enqueue=False,
    )
    if status == "changes_requested" and not any(
        a.get("member") == author.id and a["action"] in {"wake", "review"}
        for a in actions
    ):
        actions.append(
            {
                "rule": "@decision",
                "action": "wake",
                "member": author.id,
                "channel": message.channel_id,
                "thread": message.thread_id,
            }
        )
    workflows.apply(d, workspace, event, flow, actions)
    workspace.updated_at = now()
    return event
