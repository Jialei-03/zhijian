# ruff: noqa: B008
"""Local-only team messaging endpoints."""

from typing import Literal
from uuid import uuid4

from fastapi import Depends, HTTPException
from pydantic import Field
from sqlalchemy import func, select

from . import research_team as team
from . import team_members as members
from .models import AgentRun, TeamChannel, TeamDelivery, TeamMember, TeamMessage
from .schemas import Strict
from .team_budgets import TeamBudget
from .team_reminders import ReminderInput


class QuoteInput(Strict):
    message_id: str = Field(min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=12000)


class MessageInput(Strict):
    text: str = Field(default="", max_length=12000)
    thread_id: str | None = Field(default=None, max_length=80)
    mode: Literal["queue", "immediate", "record"] = "queue"
    done_when: str = ""
    model_config_id: str = Field(default="", max_length=64)
    client_id: str = Field(min_length=1, max_length=100)
    attachment_ids: list[str] = Field(default_factory=list, max_length=5)
    forward_message_id: str | None = Field(default=None, min_length=1, max_length=80)
    quote: QuoteInput | None = None
    also_channel: bool = False


class ChannelInput(Strict):
    name: str = Field(min_length=1, max_length=100)


class DecisionInput(Strict):
    status: Literal["accepted", "changes_requested"]
    feedback: str = ""


class DeliveryInput(Strict):
    text: str | None = Field(default=None, min_length=1, max_length=12000)
    mode: Literal["queue", "immediate"] | None = None
    cancel: bool = False


class ReadInput(Strict):
    through: str = Field(max_length=40)
    thread_id: str | None = Field(default=None, max_length=80)


class ActivityReadInput(Strict):
    through: str = Field(max_length=40)
    message_id: str | None = Field(default=None, max_length=80)


class AgentDocumentInput(Strict):
    source: str = Field(default="", max_length=150000)
    config: members.MemberConfig | None = None
    channels: list[str] | None = None
    filename: str = Field(default="agent.md", max_length=255)
    role: str = Field(default="custom", max_length=24)


def install_team_routes(app, settings, db, auth, workspace_of):
    base = "/api/v1/research/workspaces/{id}/team"
    from .team_message_marks import install_mark_routes

    install_mark_routes(app, base, db, auth, workspace_of)

    @app.put(base + "/budget")
    def save_budget(id: str, body: TeamBudget, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        team.ensure(d, workspace)
        workspace.workflow_state = {
            **workspace.workflow_state,
            "budget": body.model_dump(),
        }
        d.commit()
        return body.model_dump()

    def channel_of(d, workspace, identifier):
        try:
            return team.channel_of(d, workspace, identifier)
        except ValueError as error:
            raise HTTPException(404, str(error)) from None

    def thread_activity(d, workspace_id):
        root = func.coalesce(TeamMessage.thread_id, TeamMessage.id)
        activity = dict(
            d.execute(
                select(root, func.max(TeamMessage.created_at))
                .where(TeamMessage.workspace_id == workspace_id)
                .group_by(root)
            ).all()
        )
        # Legacy research replies live in events and sprints as well as team messages.
        for model, stamp in (
            (team.ResearchEvent, team.ResearchEvent.created_at),
            (team.ResearchSprint, team.ResearchSprint.updated_at),
        ):
            query = (
                select(model.project_id, func.max(stamp))
                .join(team.ResearchProject)
                .where(team.ResearchProject.workspace_id == workspace_id)
                .group_by(model.project_id)
            )
            if model is team.ResearchEvent:
                query = query.where(model.action == "message")
            for project_id, at in d.execute(query):
                root = f"research:{project_id}"
                activity[root] = max(activity.get(root, ""), at)
        return activity

    def delivery_out(d, row):
        message = d.get(TeamMessage, row.message_id)
        return dict(
            id=row.id,
            member_id=row.member_id,
            message_id=row.message_id,
            channel_id=message.channel_id,
            thread_id=message.thread_id,
            text=message.text,
            mode=row.mode,
            status=row.status,
            error=row.error,
            editable=(
                d.get(TeamMember, message.author_id).role == "human"
                if message.author_id
                else False
            ),
        )

    def editable_workspace(d, id, a):
        workspace = workspace_of(d, id, a)
        team.ensure(d, workspace)
        if workspace.archived:
            raise HTTPException(409, "团队已归档 / Team archived")
        return workspace

    @app.post(base + "/channels/{channel_id}/messages/{message_id}/reminders")
    def remind(
        id: str,
        channel_id: str,
        message_id: str,
        body: ReminderInput,
        a=Depends(auth),
        d=Depends(db),
    ):
        from .team_reminders import create

        workspace = editable_workspace(d, id, a)
        channel = channel_of(d, workspace, channel_id)
        try:
            result = create(d, workspace, channel, message_id, body.remind_at)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        d.commit()
        return result

    def validate_config(workspace, config):
        if config and config.model_config_id:
            from .agent_files import model_identifier
            from .research_chat import _model

            _model(
                settings,
                workspace.owner,
                workspace,
                model_identifier(settings, workspace.owner, config.model_config_id),
            )

    @app.post(base + "/agent-document")
    def agent_document(
        id: str, body: AgentDocumentInput, a=Depends(auth), d=Depends(db)
    ):
        from . import agent_files as files

        workspace = workspace_of(d, id, a)
        try:
            source = body.source
            if body.config:
                values = files.parse(source, body.role) if source else {}
                values.update(body.config.model_dump())
                if body.channels is not None:
                    known = {
                        value
                        for channel in d.scalars(
                            select(TeamChannel).where(
                                TeamChannel.workspace_id == workspace.id,
                                TeamChannel.member_id.is_(None),
                            )
                        )
                        for value in (channel.id, "#" + channel.name)
                    }
                    values["channels"] = list(
                        dict.fromkeys(
                            body.channels
                            + [c for c in values.get("channels", []) if c not in known]
                        )
                    )
                source = files.render(values, source, body.role)
            return {
                "source": source,
                "config": files.parse(source, body.role),
                "warnings": [
                    "未知工具 / Unknown tool: " + t
                    for t in files.parse(source, body.role)["tools"]
                    if t not in files.GROUPS
                ],
            }
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @app.post(base + "/import-agent")
    def import_agent(id: str, body: AgentDocumentInput, a=Depends(auth), d=Depends(db)):
        from .agent_files import import_agent

        workspace_of(d, id, a)
        try:
            return import_agent(body.source, body.filename)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @app.get(base + "/library")
    def member_library(id: str, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        from .agent_files import discover_library

        result = [
            members.library_out(d, row) for row in discover_library(d, workspace.owner)
        ]
        d.commit()
        return result

    @app.patch(base + "/library/{library_id}")
    def update_library(
        id: str,
        library_id: str,
        body: members.LibraryEdit,
        a=Depends(auth),
        d=Depends(db),
    ):
        workspace = editable_workspace(d, id, a)
        try:
            row = members.library_of(d, workspace.owner, library_id)
            validate_config(workspace, body.config)
            result = members.sync_library(d, row, body)
        except ValueError as error:
            raise HTTPException(409, str(error)) from None
        d.commit()
        return result

    @app.post(base + "/members")
    def add_member(id: str, body: members.MemberCreate, a=Depends(auth), d=Depends(db)):
        workspace = editable_workspace(d, id, a)
        try:
            validate_config(workspace, body.config)
            member = members.create(d, workspace, body)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        d.commit()
        return {"id": member.id}

    @app.patch(base + "/members/{member_id}")
    def update_member(
        id: str,
        member_id: str,
        body: members.MemberEdit,
        a=Depends(auth),
        d=Depends(db),
    ):
        workspace = editable_workspace(d, id, a)
        try:
            member = members.owned(d, workspace, member_id)
            validate_config(workspace, body.config)
            members.edit(d, workspace, member, body)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        d.commit()
        return {"ok": True}

    @app.delete(base + "/members/{member_id}")
    def delete_member(id: str, member_id: str, a=Depends(auth), d=Depends(db)):
        workspace = editable_workspace(d, id, a)
        try:
            member = members.owned(d, workspace, member_id)
            if member.role in team.ROLES:
                raise ValueError(
                    "内置成员不可删除 / Built-in members cannot be deleted"
                )
            members.edit(d, workspace, member, members.MemberEdit(enabled=False))
            member.deleted = True
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        d.commit()
        return {"ok": True}

    @app.get(base + "/members/{member_id}/avatar")
    def member_avatar(id: str, member_id: str, a=Depends(auth), d=Depends(db)):
        from fastapi.responses import FileResponse
        from . import agent_files as files

        workspace = workspace_of(d, id, a)
        try:
            member = members.owned(d, workspace, member_id)
            path = files.avatar_path(
                files.member_root(settings, member), members.config(member)["avatar"]
            )
            if path is None or not path.is_file():
                raise ValueError("头像不存在 / Avatar not found")
        except (OSError, ValueError) as error:
            raise HTTPException(404, str(error)) from None
        return FileResponse(
            path,
            media_type=files.AVATAR_TYPES[path.suffix.lower()],
            headers={
                "Cache-Control": "private, no-cache",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
            },
        )

    @app.get(base + "/members/{member_id}")
    def member_detail(id: str, member_id: str, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        try:
            member = members.owned(d, workspace, member_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from None
        out = next(
            m for m in team.overview(d, workspace)["members"] if m["id"] == member.id
        )
        rows = list(
            d.scalars(
                select(TeamMessage)
                .where(TeamMessage.author_id == member.id)
                .order_by(TeamMessage.created_at.desc())
            )
        )
        roots = set(
            d.scalars(
                select(TeamMessage.thread_id).where(
                    TeamMessage.workspace_id == id, TeamMessage.thread_id.is_not(None)
                )
            )
        )
        seen, threads = set(), []
        for message in rows:
            thread = message.thread_id or message.id
            if thread not in roots or (message.channel_id, thread) in seen:
                continue
            seen.add((message.channel_id, thread))
            # A thread is named by the message that started it.
            root = d.get(TeamMessage, thread) or message
            run = d.get(AgentRun, message.data.get("run_id") or "")
            channel = team.channel_of(d, workspace, message.channel_id)
            text = next(
                t.strip()
                for t in (
                    team.message_out(d, root)["text"],
                    team.message_out(d, message)["text"],
                    run.prompt if run else "",
                    f"#{channel.name}",
                )
                if t and t.strip()
            )
            threads.append(
                {
                    "id": thread,
                    "channel_id": message.channel_id,
                    "text": text[:200],
                    "last_message_at": root.created_at,
                }
            )
        from .models import ResearchProject, ResearchSprint
        from .research_team import research_context

        for sprint, run in d.execute(
            select(ResearchSprint, AgentRun)
            .join(AgentRun, ResearchSprint.run_id == AgentRun.id)
            .join(ResearchProject, ResearchSprint.project_id == ResearchProject.id)
            .where(ResearchProject.workspace_id == id)
            .order_by(ResearchSprint.created_at.desc())
        ):
            info = research_context(d, run.runtime.get("research", {}), workspace.owner)
            if (
                not info
                or info["member_id"] != member.id
                or (info["channel_id"], info["thread_id"]) in seen
            ):
                continue
            seen.add((info["channel_id"], info["thread_id"]))
            threads.append(
                {
                    "id": info["thread_id"],
                    "channel_id": info["channel_id"],
                    "text": sprint.summary[:200] or run.prompt[:200],
                    "last_message_at": sprint.created_at,
                }
            )
        activity = thread_activity(d, id)
        for thread in threads:
            thread["last_message_at"] = max(
                thread["last_message_at"], activity.get(thread["id"], "")
            )
        threads.sort(key=lambda t: (t["last_message_at"], t["id"]), reverse=True)
        out["threads"] = threads[:50]
        run = team.active_run(d, member)
        # What the member is working on now; nothing while idle.
        out["activity"] = run.prompt[:500] if run else ""
        from .team_presence import recent_files

        out["recent_files"] = recent_files(d, member)
        out["attention"] = team.work_overview(d, workspace)["attention"]["members"].get(
            member.id
        )
        d.commit()
        return out

    @app.get(base + "/workflows/{workflow_id}/{version}")
    def workflow_snapshot(
        id: str, workflow_id: str, version: int, a=Depends(auth), d=Depends(db)
    ):
        from .models import ResearchProject

        workspace = workspace_of(d, id, a)
        team.ensure(d, workspace)
        from .team_workflows import key

        stored = workspace.workflow_state.get("snapshots", {}).get(
            key({"id": workflow_id, "version": version})
        )
        result = (
            workspace.workflow
            if (workspace.workflow["id"], workspace.workflow["version"])
            == (workflow_id, version)
            else stored
            or next(
                (
                    p.workflow
                    for p in d.scalars(
                        select(ResearchProject).where(
                            ResearchProject.workspace_id == id,
                            ResearchProject.owner == workspace.owner,
                        )
                    )
                    if (p.workflow.get("id"), p.workflow.get("version"))
                    == (workflow_id, version)
                ),
                None,
            )
        )
        if not result:
            raise HTTPException(404, "工作流版本不存在 / Workflow version not found")
        d.commit()
        return result

    @app.get(base + "/workflow")
    def workflow(id: str, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        team.ensure(d, workspace)
        result = workspace.workflow
        d.commit()
        return result

    @app.put(base + "/workflow")
    def save_workflow(id: str, body: dict, a=Depends(auth), d=Depends(db)):
        from .team_workflows import save

        workspace = workspace_of(d, id, a)
        try:
            result = save(d, workspace, body)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        d.commit()
        return result

    @app.post(base + "/workflow")
    def select_workflow(id: str, body: dict, a=Depends(auth), d=Depends(db)):
        from .team_workflows import select_workflow as choose

        workspace = workspace_of(d, id, a)
        try:
            result = choose(d, workspace, body.get("workflow_id", "research"))
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        d.commit()
        return result

    @app.get(base)
    def overview(id: str, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        out = team.overview(d, workspace)
        d.commit()
        return out

    @app.get(base + "/work")
    def work_overview(id: str, a=Depends(auth), d=Depends(db)):
        return team.work_overview(d, workspace_of(d, id, a))

    @app.get(base + "/channels/{channel_id}/messages")
    def messages(
        id: str,
        channel_id: str,
        thread_id: str | None = None,
        a=Depends(auth),
        d=Depends(db),
    ):
        workspace = workspace_of(d, id, a)
        read_through = team.now()
        try:
            team.ensure(d, workspace)
            channel = channel_of(d, workspace, channel_id)
            out = team.history(d, workspace, channel, thread_id)
            out["read_through"] = read_through
        except ValueError as error:
            raise HTTPException(404, str(error)) from None
        d.commit()
        return out

    @app.get(base + "/channels/{channel_id}/summary")
    def channel_summary(
        id: str,
        channel_id: str,
        since: str | None = None,
        through: str | None = None,
        a=Depends(auth),
        d=Depends(db),
    ):
        from .team_catchup import summary

        workspace = workspace_of(d, id, a)
        channel = channel_of(d, workspace, channel_id)
        try:
            return summary(d, workspace, channel, since, through)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @app.post(base + "/channels/{channel_id}/messages")
    def send(
        id: str, channel_id: str, body: MessageInput, a=Depends(auth), d=Depends(db)
    ):
        workspace = workspace_of(d, id, a)
        try:
            team.ensure(d, workspace)
            channel = channel_of(d, workspace, channel_id)
            key = f"user:{id}:{body.client_id}"
            message = d.scalar(select(TeamMessage).where(TeamMessage.source_key == key))
            if message:
                if (message.channel_id, message.thread_id, message.text) != (
                    channel_id,
                    body.thread_id,
                    team.normalize(body.text).strip(),
                ):
                    raise ValueError("消息标识已用于其他内容 / Message ID already used")
                if (
                    (message.data.get("forward") or {}).get("message_id")
                    != body.forward_message_id
                    or (
                        {k: message.data["quote"][k] for k in ("message_id", "text")}
                        if message.data.get("quote")
                        else None
                    )
                    != (
                        {
                            **body.quote.model_dump(),
                            "text": team.normalize(body.quote.text).strip(),
                        }
                        if body.quote
                        else None
                    )
                    or bool(message.data.get("also_channel")) != body.also_channel
                    or message.data.get("mode", "queue") != body.mode
                    or message.data.get("done_when", "")
                    != team.normalize(body.done_when).strip()
                ):
                    raise ValueError("消息标识已用于其他内容 / Message ID already used")
            else:
                from .team_message_features import reference

                references = {}
                if body.forward_message_id:
                    references["forward"] = reference(
                        d, workspace, body.forward_message_id
                    )
                if body.quote:
                    references["quote"] = reference(
                        d, workspace, body.quote.message_id, body.quote.text
                    )
                if body.model_config_id:
                    if not channel.member_id:
                        raise ValueError("只能在私信选择模型 / Choose model in DM")
                    from .research_chat import _model

                    _model(settings, workspace.owner, workspace, body.model_config_id)
                    d.get(
                        TeamMember, channel.member_id
                    ).model_config_id = body.model_config_id
                from .agent_attachments import attachments

                attached = attachments(d, workspace.owner, body.attachment_ids)
                message = team.post(
                    d,
                    workspace,
                    channel,
                    body.text,
                    thread_id=body.thread_id,
                    mode=body.mode,
                    source_key=key,
                    data={
                        "attachments": attached,
                        "done_when": team.normalize(body.done_when).strip(),
                        **references,
                    },
                    also_channel=body.also_channel,
                )
                for row in d.scalars(
                    select(TeamDelivery)
                    .join(TeamMember)
                    .where(
                        TeamMember.workspace_id == workspace.id,
                        TeamDelivery.status == "queued",
                    )
                ):
                    if row.message_id == message.id or message.id in row.action.get(
                        "merged_messages", []
                    ):
                        team.dispatch(settings, d, workspace, row)
            out = team.message_out(d, message)
            d.commit()
            return out
        except ValueError as error:
            raise HTTPException(409, str(error)) from None

    def message_of(d, workspace, message_id):
        from .team_message_features import source_message

        try:
            return source_message(d, workspace, message_id)
        except ValueError as error:
            raise HTTPException(404, str(error)) from None

    @app.post(base + "/messages/{message_id}/decision")
    def decide_message(
        id: str, message_id: str, body: DecisionInput, a=Depends(auth), d=Depends(db)
    ):
        from .team_message_decisions import decide

        workspace = editable_workspace(d, id, a)
        message = message_of(d, workspace, message_id)
        try:
            result = decide(d, workspace, message, body.status, body.feedback)
            for row in d.scalars(
                select(TeamDelivery)
                .join(TeamMember)
                .where(
                    TeamMember.workspace_id == workspace.id,
                    TeamDelivery.status == "queued",
                )
            ):
                if row.message_id == result.id or result.id in row.action.get(
                    "merged_messages", []
                ):
                    team.dispatch(settings, d, workspace, row)
        except ValueError as error:
            raise HTTPException(409, str(error)) from None
        out = team.message_out(d, message)
        d.commit()
        return out

    @app.put(base + "/messages/{message_id}/reactions/{emoji}")
    def add_reaction(
        id: str, message_id: str, emoji: str, a=Depends(auth), d=Depends(db)
    ):
        return change_reaction(d, id, a, message_id, emoji)

    @app.delete(base + "/messages/{message_id}/reactions/{emoji}")
    def remove_reaction(
        id: str, message_id: str, emoji: str, a=Depends(auth), d=Depends(db)
    ):
        return change_reaction(d, id, a, message_id, emoji, remove=True)

    def change_reaction(d, id, a, message_id, emoji, *, remove=False):
        from .team_message_features import react

        workspace = workspace_of(d, id, a)
        team.ensure(d, workspace)
        message = message_of(d, workspace, message_id)
        try:
            out = react(d, workspace, message, emoji, remove=remove)
        except ValueError as error:
            raise HTTPException(409, str(error)) from None
        d.commit()
        return out

    @app.post(base + "/channels")
    def create_channel(id: str, body: ChannelInput, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        team.ensure(d, workspace)
        if workspace.archived or not body.name.strip():
            raise HTTPException(409, "频道不可用 / Channel unavailable")
        channel = TeamChannel(workspace_id=id, key=str(uuid4()), name=body.name.strip())
        d.add(channel)
        d.commit()
        return dict(id=channel.id, name=channel.name)

    @app.patch(base + "/channels/{channel_id}")
    def rename(
        id: str, channel_id: str, body: ChannelInput, a=Depends(auth), d=Depends(db)
    ):
        workspace = workspace_of(d, id, a)
        channel = channel_of(d, workspace, channel_id)
        if workspace.archived or channel.member_id or not body.name.strip():
            raise HTTPException(409, "频道不可用 / Channel unavailable")
        channel.name = body.name.strip()
        d.commit()
        return {"ok": True}

    @app.delete(base + "/channels/{channel_id}")
    def remove(id: str, channel_id: str, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        channel = channel_of(d, workspace, channel_id)
        if channel.member_id or channel.key == "experiments" or workspace.archived:
            raise HTTPException(409, "频道不可删除 / Channel cannot be deleted")
        active = d.scalar(
            select(TeamDelivery.id)
            .join(TeamMessage)
            .where(
                TeamMessage.channel_id == channel.id,
                TeamDelivery.status.in_(["queued", "running", "steering"]),
            )
        )
        if active:
            raise HTTPException(409, "频道有待处理消息 / Channel has pending messages")
        if any(
            channel.id in {r["when"].get("channel"), r["then"].get("channel")}
            for r in workspace.workflow.get("rules", [])
        ):
            raise HTTPException(
                409, "频道仍被规则引用 / Channel is referenced by rules"
            )
        channel.archived = True
        d.commit()
        return {"ok": True}

    @app.get(base + "/deliveries")
    def deliveries(id: str, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        return [
            delivery_out(d, row)
            for row in d.scalars(
                select(TeamDelivery)
                .join(TeamMember)
                .join(TeamMessage, TeamMessage.id == TeamDelivery.message_id)
                .where(
                    TeamMember.workspace_id == id,
                    TeamMessage.author_id == team.stable(workspace, "human"),
                    TeamDelivery.run_id.is_(None),
                    TeamDelivery.status.in_(
                        ["queued", "steering", "failed", "rejected"]
                    ),
                )
                .order_by(TeamDelivery.created_at)
            )
        ]

    @app.post(base + "/messages/{message_id}/continue")
    def continue_message(id: str, message_id: str, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        team.ensure(d, workspace)
        message = d.get(TeamMessage, message_id)
        if not message or message.workspace_id != workspace.id:
            raise HTTPException(404, "Not found")
        run = d.get(AgentRun, message.data.get("run_id"))
        if (
            not run
            or not (
                (run.runtime or {}).get("time_limit_reached")
                or (run.runtime or {}).get("budget_limit")
            )
            or run.status in team.ACTIVE
        ):
            raise HTTPException(409, "作业不可继续 / Run cannot be continued")
        key = f"continue:{run.id}"
        incoming = d.scalar(select(TeamMessage).where(TeamMessage.source_key == key))
        if not incoming:
            channel = team.channel_of(d, workspace, message.channel_id)
            from .research_map import researcher_language

            instruction = (
                "继续未完成的任务，先检查已保存的文件。"
                if researcher_language(team.language_part(d, workspace)) == "zh"
                else "Continue the unfinished task using the saved files."
            )
            incoming = team.post(
                d,
                workspace,
                channel,
                f"@{message.author_id} {instruction}",
                thread_id=message.thread_id,
                source_key=key,
            )
            for delivery in d.scalars(
                select(TeamDelivery).where(TeamDelivery.message_id == incoming.id)
            ):
                team.dispatch(settings, d, workspace, delivery)
        d.commit()
        return team.message_out(d, incoming)

    def changed_message(d, workspace, message_id):
        message = d.get(TeamMessage, message_id)
        if not message or message.workspace_id != workspace.id:
            raise HTTPException(404, "Not found")
        if not message.data.get("commit"):
            raise HTTPException(409, "没有可用提交 / No commit")
        run = (
            d.get(AgentRun, message.data["run_id"])
            if message.data.get("run_id")
            else None
        )
        if run and (run.runtime or {}).get("team_base") == message.data["commit"]:
            raise HTTPException(409, "没有可用提交 / No commit")
        return message

    @app.get(base + "/messages/{message_id}/diff")
    def message_diff(
        id: str, message_id: str, path: str, a=Depends(auth), d=Depends(db)
    ):
        from . import research_repo, team_workspace

        workspace = workspace_of(d, id, a)
        message = changed_message(d, workspace, message_id)
        try:
            return team_workspace.file_diff(
                research_repo.repo_dir(settings, workspace.id),
                message.data["commit"],
                path,
            )
        except FileNotFoundError as error:
            raise HTTPException(404, str(error)) from None
        except (ValueError, research_repo.GitError) as error:
            raise HTTPException(409, str(error)) from None

    @app.post(base + "/messages/{message_id}/revert")
    def revert_message(id: str, message_id: str, a=Depends(auth), d=Depends(db)):
        from . import research_repo, team_workspace
        from .models import User

        workspace = workspace_of(d, id, a)
        message = changed_message(d, workspace, message_id)
        try:
            team_workspace.revert(settings, d, workspace, message, d.get(User, a["id"]))
        except team_workspace.RevertConflict as error:
            raise HTTPException(
                409, {"message": str(error), "conflicts": error.conflicts}
            ) from None
        except (ValueError, research_repo.GitError) as error:
            raise HTTPException(409, str(error)) from None
        return team.message_out(d, message)

    @app.get(base + "/file")
    def read_team_file(
        id: str, path: str, raw: bool = False, a=Depends(auth), d=Depends(db)
    ):
        from fastapi.responses import FileResponse

        from .research_files import TEXT_BYTES, kind_of, resolve
        from .team_workspace import workdir

        workspace = workspace_of(d, id, a)
        target = resolve(workdir(settings, workspace), path)
        if (
            not target.is_file()
            or ".git" in target.relative_to(workdir(settings, workspace)).parts
        ):
            raise HTTPException(404, "文件不存在 / File not found")
        with target.open("rb") as handle:
            content = handle.read(TEXT_BYTES + 1)
        kind = kind_of(target, content[:8192])
        if raw and kind in {"image", "pdf"}:
            return FileResponse(
                target,
                headers={
                    "X-Content-Type-Options": "nosniff",
                    "Cache-Control": "private, no-cache",
                },
            )
        return dict(
            name=target.name,
            path=path,
            kind=kind,
            truncated=len(content) > TEXT_BYTES,
            content=content[:TEXT_BYTES].decode("utf-8", errors="replace")
            if kind in {"text", "markdown", "csv"}
            else "",
        )

    @app.patch(base + "/deliveries/{delivery_id}")
    def edit_delivery(
        id: str, delivery_id: str, body: DeliveryInput, a=Depends(auth), d=Depends(db)
    ):
        workspace = workspace_of(d, id, a)
        team.ensure(d, workspace)
        row = d.get(TeamDelivery, delivery_id)
        if row is None or d.get(TeamMember, row.member_id).workspace_id != id:
            raise HTTPException(404, "Not found")
        message = d.get(TeamMessage, row.message_id)
        if (
            workspace.archived
            or row.status not in {"queued", "failed", "rejected"}
            or message.author_id != team.stable(workspace, "human")
        ):
            raise HTTPException(409, "消息已投递 / Message already delivered")
        if body.cancel:
            row.status = "cancelled"
        else:
            if body.text is not None:
                text = team.normalize(body.text).strip()
                if not text:
                    raise HTTPException(422, "消息不能为空 / Empty message")
                if set(team.mentions(d, workspace, text)) != set(message.mentions):
                    raise HTTPException(409, "收件人已改变 / Recipients changed")
                message.text = text
            if body.mode:
                row.mode = body.mode
            row.status, row.error = "queued", ""
            team.dispatch(settings, d, workspace, row)
        d.commit()
        return delivery_out(d, row)

    @app.post(base + "/channels/{channel_id}/read")
    def read(id: str, channel_id: str, body: ReadInput, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        channel = channel_of(d, workspace, channel_id)
        team.root_of(d, workspace, channel, body.thread_id)
        from .team_catchup import timestamp

        try:
            through = min(timestamp(body.through), team.now())
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        for message in d.scalars(
            select(TeamMessage).where(
                TeamMessage.channel_id == channel.id,
                TeamMessage.thread_id == body.thread_id,
                TeamMessage.kind != "reminder",
            )
        ):
            # Compared as instants: stored and sent stamps may end in Z or +00:00.
            if timestamp(message.created_at) <= through:
                message.data = {**message.data, "read": True}
        if body.thread_id is None:
            channel.read_at = max(channel.read_at, through)
        d.commit()
        return {"ok": True}

    @app.get(base + "/activity")
    def activity(id: str, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        team.ensure(d, workspace)
        out = team.activity(d, workspace)
        d.commit()
        return out

    @app.post(base + "/activity/read")
    def read_activity(id: str, body: ActivityReadInput, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        team.ensure(d, workspace)
        through = min(body.through, team.now())
        for event in team.activity(d, workspace):
            if event["created_at"] <= through and (
                body.message_id is None or event["id"] == body.message_id
            ):
                message = d.get(TeamMessage, event["id"])
                message.data = {**message.data, "read": True}
        d.commit()
        return {"ok": True}

    @app.get(base + "/threads")
    def threads(id: str, mentions: bool = False, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        members = team.ensure(d, workspace)
        human = next(m.id for m in members if m.role == "human")
        rows = list(
            d.scalars(
                select(TeamMessage)
                .where(TeamMessage.workspace_id == id, TeamMessage.kind != "reminder")
                .order_by(TeamMessage.created_at)
            )
        )
        if mentions:
            out = [team.message_out(d, m) for m in rows if human in m.mentions]
            out = [m for m in out if team.has_message_content(m)]
        else:
            # A thread whose replies all said nothing is not listed.
            roots = {
                m.thread_id
                for m in rows
                if m.thread_id and team.has_message_content(team.message_out(d, m))
            }
            out = [
                team.message_out(d, m)
                for m in rows
                if m.id in roots and not m.thread_id
            ]
            channel = d.scalar(
                select(TeamChannel).where(
                    TeamChannel.workspace_id == id, TeamChannel.key == "experiments"
                )
            )
            out += [
                team.research_root(p, channel, d)
                for p in d.scalars(
                    select(team.ResearchProject).where(
                        team.ResearchProject.workspace_id == id
                    )
                )
            ]
        if not mentions:
            activity = thread_activity(d, id)
            channels = {
                c.id: c
                for c in d.scalars(
                    select(TeamChannel).where(TeamChannel.workspace_id == id)
                )
            }
            grouped = {}
            for row in rows:
                value = team.message_out(d, row)
                if row.data.get("research_forwarded") or not team.has_message_content(
                    value
                ):
                    continue
                grouped.setdefault(
                    (row.channel_id, row.thread_id or row.id), []
                ).append(value)
            legacy_participants = {}
            role_members = {m.role: m.id for m in members}
            for model, role in (
                (team.ResearchEvent, team.ResearchEvent.actor),
                (team.ResearchSprint, team.ResearchSprint.role),
            ):
                query = (
                    select(model.project_id, role)
                    .join(team.ResearchProject)
                    .where(team.ResearchProject.workspace_id == id)
                    .order_by(model.created_at.desc())
                )
                if model is team.ResearchEvent:
                    query = query.where(model.action == "message")
                for project_id, author_role in d.execute(query):
                    author_role = {
                        "scoping": "advisor",
                        "discussion": "advisor",
                        "workflow": "executor",
                        "review": "advisor",
                    }.get(author_role, author_role)
                    if author_role in role_members:
                        legacy_participants.setdefault(
                            f"research:{project_id}", []
                        ).append(role_members[author_role])
            for message in out:
                channel = channels[message["channel_id"]]
                messages = grouped.get((channel.id, message["id"]), [])
                message["channel"] = team.conversation_out(channel)
                message["preview"] = team.preview_text(
                    message["data"].get("title") or message["text"]
                )
                message["participant_ids"] = list(
                    dict.fromkeys(
                        m["author_id"] for m in reversed(messages) if m["author_id"]
                    )
                )
                message["unread"] = sum(
                    m["author_id"] != human and not m["data"].get("read")
                    for m in messages
                )
                if message["kind"] == "research":
                    message["author_id"] = human
                    message["participant_ids"] = list(
                        dict.fromkeys(
                            [
                                *message["participant_ids"],
                                *legacy_participants.get(message["id"], []),
                                human,
                            ]
                        )
                    )
                else:
                    message["replies"] = sum(m["id"] != message["id"] for m in messages)
                message["last_message_at"] = max(
                    message["created_at"], activity.get(message["id"], "")
                )
            out.sort(key=lambda m: (m["last_message_at"], m["id"]), reverse=True)
        d.commit()
        return out
