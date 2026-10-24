# ruff: noqa: B008
"""Shared channel pins and researcher-only saved messages."""

from fastapi import Depends, HTTPException, Request
from pydantic import Field
from sqlalchemy import select

from .models import TeamMessage, TeamMessageMark
from .schemas import Strict


class MarkInput(Strict):
    channel_id: str = Field(max_length=80)
    completed: bool | None = None


def marks(d, workspace_id, *, channel_id=None, kind="pin", owner=""):
    query = select(TeamMessageMark).where(
        TeamMessageMark.workspace_id == workspace_id,
        TeamMessageMark.kind == kind,
        TeamMessageMark.owner == owner,
    )
    if channel_id:
        query = query.where(TeamMessageMark.channel_id == channel_id)
    return list(
        d.scalars(
            query.order_by(TeamMessageMark.created_at.desc(), TeamMessageMark.id.desc())
        )
    )


def resolve(d, workspace, channel_id, message_id):
    from . import research_team as team

    channel = team.channel_of(d, workspace, channel_id)
    message = d.get(TeamMessage, message_id)
    if message:
        if message.workspace_id == workspace.id and message.channel_id == channel.id:
            return team.message_out(d, message)
    elif message_id.startswith(("research:", "legacy:", "legacy-user:")):
        result = team.history(d, workspace, channel, message_id)
        if result["root"]:
            return result["root"]
    raise ValueError("消息不存在 / Message not found")


def context_pins(d, workspace, channel_id):
    from .research_team import preview_text

    out = []
    for mark in marks(d, workspace.id, channel_id=channel_id):
        try:
            value = resolve(d, workspace, channel_id, mark.message_id)
        except ValueError:
            continue  # Deleted native research must not hide the other pins.
        out.append(
            {
                "id": value["id"],
                "thread_id": value["thread_id"],
                "text": preview_text(value["text"]),
                "files": value["data"].get("files", []),
                "attachments": value["data"].get("attachments", []),
            }
        )
        # Only the briefing is capped; the channel keeps all of its pins.
        if len(out) == 10:
            break
    return out


def install_mark_routes(app, base, db, auth, workspace_of):
    # These authenticated researcher routes are deliberately absent from member tools.
    @app.get(base + "/saved")
    def saved(id: str, a=Depends(auth), d=Depends(db)):
        from . import research_team as team

        workspace = workspace_of(d, id, a)
        out = []
        for mark in marks(d, id, kind="later", owner=workspace.owner):
            try:
                value = resolve(d, workspace, mark.channel_id, mark.message_id)
                out.append(
                    {
                        **value,
                        "completed": mark.completed,
                        "saved_at": mark.created_at,
                        "channel": team.conversation_out(
                            team.channel_of(d, workspace, mark.channel_id)
                        ),
                    }
                )
            except ValueError:
                continue
        return out

    @app.put(base + "/messages/{message_id}/marks/{kind}")
    @app.delete(base + "/messages/{message_id}/marks/{kind}")
    def mark_message(
        id: str,
        message_id: str,
        kind: str,
        body: MarkInput,
        request: Request,
        a=Depends(auth),
        d=Depends(db),
    ):
        from . import research_team as team

        workspace = workspace_of(d, id, a)
        if kind not in {"pin", "later"}:
            raise HTTPException(404, "Not found")
        try:
            channel = team.channel_of(d, workspace, body.channel_id)
            resolve(d, workspace, channel.id, message_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from None
        if kind == "pin" and channel.member_id:
            raise HTTPException(409, "只能置顶到频道 / Pins require a channel")
        owner = workspace.owner if kind == "later" else ""
        # Serialize duplicate clicks on the same workspace, as message sends do.
        team.ensure(d, workspace)
        prior = d.scalar(
            select(TeamMessageMark).where(
                TeamMessageMark.workspace_id == id,
                TeamMessageMark.message_id == message_id,
                TeamMessageMark.kind == kind,
                TeamMessageMark.owner == owner,
            )
        )
        if request.method == "DELETE":
            if prior:
                d.delete(prior)
        elif prior:
            if body.completed is not None:
                prior.completed = body.completed
        else:
            d.add(
                TeamMessageMark(
                    workspace_id=id,
                    channel_id=channel.id,
                    message_id=message_id,
                    kind=kind,
                    owner=owner,
                    completed=body.completed or False,
                )
            )
        d.commit()
        return {"ok": True}
