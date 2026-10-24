"""Owned member templates and persistent team instances.

Files hold effective values; sync compares each team file with its last library baseline.
Deleted instances remain as historical message/rule references.
"""

from uuid import uuid4
from typing import Literal

from pydantic import ConfigDict, Field, field_validator
from sqlalchemy import select

from .models import (
    AgentSession,
    MemberLibrary,
    TeamChannel,
    TeamDelivery,
    TeamMember,
    TeamMessage,
)
from .schemas import Strict

COLORS = ("blue", "green", "amber", "red", "violet", "slate")


class Permissions(Strict):
    papers: bool = True
    files: bool = True
    commands: bool = False
    machines: list[str] = Field(
        default_factory=lambda: ["host", "local", "docker"], max_length=50
    )
    readonly: bool = False
    file_readonly: bool = False


class MemberConfig(Strict):
    description: str = Field(default="", max_length=5000)
    tools: list[str] | None = None
    wake_minutes: int = Field(default=0, ge=0, le=1440, strict=True)
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)
    name: str = Field(min_length=1, max_length=100)
    avatar_color: str = "blue"
    avatar: str | None = None
    role_description: str = Field(default="", max_length=50000)
    model_config_id: str = Field(default="", max_length=64)
    permissions: Permissions = Field(default_factory=Permissions)
    wake_turns: int = Field(default=0, ge=0, le=256, strict=True)
    wake_tokens: int = Field(default=0, ge=0, le=2000000, strict=True)

    @field_validator("name")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("名字不能为空 / Name is empty")
        return value.strip()

    @field_validator("avatar_color")
    @classmethod
    def color(cls, value):
        if value not in COLORS:
            raise ValueError("头像颜色无效 / Invalid avatar color")
        return value


class AvatarUpload(Strict):
    extension: Literal["png", "jpg", "jpeg", "webp", "svg"]
    content: str


class MemberCreate(Strict):
    avatar_upload: AvatarUpload | None = None
    source: str | None = Field(default=None, max_length=150000)
    config: MemberConfig | None = None
    library_id: str | None = None
    copy_from: str | None = None
    subscriptions: list[str] = Field(default_factory=list, max_length=100)


class MemberEdit(Strict):
    paused: bool | None = None
    avatar_upload: AvatarUpload | None = None
    source: str | None = Field(default=None, max_length=150000)
    revision: str | None = None
    restore_builtin: bool = False
    config: MemberConfig | None = None
    enabled: bool | None = None
    subscriptions: list[str] | None = Field(default=None, max_length=100)
    reset_overrides: bool = False


class LibraryEdit(Strict):
    config: MemberConfig | None = None
    source: str | None = Field(default=None, max_length=150000)
    revision: str | None = None
    version: int
    sync: bool  # The client must explicitly choose whether existing instances follow.


def permissions(member):
    if member.permissions:
        return Permissions.model_validate(member.permissions).model_dump()
    return Permissions(commands=member.role in {"executor", "writer"}).model_dump()


def description(member):
    from .agent_files import read_member, shared_instructions

    values = read_member(member)[1]
    # Name the member: threads hold other members' messages, and a model that
    # only sees a role brief can take on the author's identity.
    return (
        f"You are {values.get('name') or member.name}, a member of this team. "
        "Messages from other members are theirs, not yours.\n\n"
        + values["role_description"]
        + "\n\n"
        + shared_instructions(member)
    )


def config(member):
    from .agent_files import read_member

    values = read_member(member)[1]
    return {
        k: values.get(k, field.default)
        for k, field in MemberConfig.model_fields.items()
    }


def owned(d, workspace, identifier):
    member = d.get(TeamMember, identifier)
    if not member or member.workspace_id != workspace.id or member.deleted:
        raise ValueError("成员不存在 / Member not found")
    return member


def library_of(d, owner, identifier):
    row = d.get(MemberLibrary, identifier)
    if not row or row.owner != owner:
        raise ValueError("成员库条目不存在 / Library member not found")
    return row


def subscriptions(d, workspace, ids):
    available = set(
        d.scalars(
            select(TeamChannel.id).where(
                TeamChannel.workspace_id == workspace.id,
                TeamChannel.member_id.is_(None),
                TeamChannel.archived.is_(False),
            )
        )
    )
    if set(ids) - available:
        raise ValueError("订阅频道不存在 / Subscription channel not found")
    return list(dict.fromkeys(ids))


def revision(source):
    import hashlib

    return hashlib.sha256(source.encode()).hexdigest()


def file_out(member):
    from .agent_files import member_root, read_member, safe_path, settings_of

    source, _ = read_member(member)
    raw = source
    if member.file_path:
        try:
            raw = safe_path(
                member_root(settings_of(member), member), member.file_path
            ).read_text(encoding="utf-8")
        except (OSError, UnicodeError, ValueError):
            pass
    return {
        "source": raw,
        "revision": revision(raw),
        "file_path": member.file_path,
        "file_error": getattr(member, "_file_error", ""),
        "builtin_update_available": getattr(member, "_builtin_update_available", False),
    }


def avatar_out(member, owner):
    from pathlib import Path
    from . import agent_files as files
    from .research_team import ROLES

    avatar = config(member)["avatar"]
    url = None
    if member.role != "human" and files.settings_of(member):
        try:
            path = files.avatar_path(
                files.member_root(files.settings_of(member), member), avatar
            )
            if path:
                stamp = str(path.stat().st_mtime_ns) if path.is_file() else "missing"
                url = f"/api/v1/research/workspaces/{member.workspace_id}/team/members/{member.id}/avatar?v={stamp}"
        except (OSError, ValueError):
            pass
    return {
        "avatar_url": url,
        "avatar_seed": (
            owner
            if member.role == "human"
            else (
                member.role
                if member.role in ROLES
                else Path(member.file_path or member.name).stem
            )
        ),
    }


def check_revision(source, expected):
    if expected is not None and revision(source) != expected:
        raise ValueError("成员文件已更新 / Agent file changed")


def create(d, workspace, body):
    from . import agent_files as files

    channel_ids = subscriptions(d, workspace, body.subscriptions)
    library = None
    original = ""
    if body.library_id:
        if body.copy_from or body.config or body.source:
            raise ValueError("成员来源冲突 / Conflicting member sources")
        library = library_of(d, workspace.owner, body.library_id)
        original, values = files.read_library(library)
    else:
        source = owned(d, workspace, body.copy_from) if body.copy_from else None
        if source and source.role == "human":
            raise ValueError("不能复制研究者 / Cannot copy the researcher")
        if source:
            original, _ = files.read_member(source)
        if body.source is not None:
            original = body.source
            values = files.parse(original)
        else:
            values = (
                body.config.model_dump()
                if body.config
                else config(source)
                if source
                else None
            )
        if values is None:
            raise ValueError("缺少成员配置 / Member configuration required")
        if source and not body.config and body.source is None:
            names = {
                m.name
                for m in d.scalars(
                    select(TeamMember).where(TeamMember.workspace_id == workspace.id)
                )
            }
            base_name = source.name[:90] + " copy"
            values["name"] = base_name
            n = 2
            while values["name"] in names:
                values["name"], n = f"{base_name} {n}", n + 1
        original = files.render(values, original)
        library = MemberLibrary(owner=workspace.owner, config={})
        d.add(library)
        d.flush()
        files.save_library(library, original)
    session = AgentSession(
        owner=workspace.owner,
        workspace_id=workspace.id,
        kind="team_member",
        title=values["name"],
    )
    d.add(session)
    d.flush()
    member = TeamMember(
        workspace_id=workspace.id,
        role="custom_" + uuid4().hex[:16],
        library_id=library.id,
        session_id=session.id,
        name=values["name"],
    )
    d.add(member)
    d.flush()
    values = files.parse(original)
    if channel_ids and body.source is None:
        values["channels"] = files.channels_for(d, member, channel_ids)
        original = files.render(values, original)
    files.save_member(member, original, workspace.owner, upload=body.avatar_upload)
    files.atomic_write(
        files.state_path(files.settings_of(member), member.id, "base.md"),
        files.read_library(library)[0],
    )
    d.add(
        TeamChannel(
            workspace_id=workspace.id,
            key=f"dm:{member.id}",
            name=member.name,
            member_id=member.id,
        )
    )
    d.flush()
    return member


def edit(d, workspace, member, body):
    from . import agent_files as files

    if member.role == "human":
        raise ValueError("研究者不可编辑 / Researcher cannot be edited")
    if body.paused is not None:
        member.paused = body.paused
    if body.model_fields_set == {"paused"}:
        return
    current = file_out(member)
    check_revision(current["source"], body.revision)
    original, values = files.read_member(member)
    if body.reset_overrides and member.library_id:
        original, values = files.read_library(
            library_of(d, workspace.owner, member.library_id)
        )
        files.atomic_write(
            files.state_path(files.settings_of(member), member.id, "base.md"), original
        )
    restore = body.restore_builtin and files.builtin_file(member) is not None
    if restore:
        original = files.builtin_file(member).read_bytes().decode("utf-8")
        values = files.parse(original, member.role)
    if body.source is not None:
        original, values = body.source, files.parse(body.source, member.role)
    if body.config:
        values.update(body.config.model_dump())
    if body.subscriptions is not None and body.source is None:
        values["channels"] = files.channels_for(
            d, member, subscriptions(d, workspace, body.subscriptions)
        )
    if body.enabled is not None:
        values["enabled"] = body.enabled
    source = (
        original
        if (body.source is not None or restore)
        and not body.config
        and body.enabled is None
        and body.subscriptions is None
        else files.render(values, original, member.role)
    )
    files.save_member(
        member, source, workspace.owner, upload=body.avatar_upload, builtin=restore
    )
    for channel in d.scalars(
        select(TeamChannel).where(TeamChannel.member_id == member.id)
    ):
        channel.name = member.name
    if not member.enabled:
        for row in d.scalars(
            select(TeamDelivery).where(
                TeamDelivery.member_id == member.id, TeamDelivery.status == "queued"
            )
        ):
            row.status, row.error = "cancelled", "成员已停用 / Member disabled"


def sync_library(d, row, body):
    from . import agent_files as files
    from .models import ResearchWorkspace

    if row.version != body.version:
        raise ValueError("成员库已更新 / Library member changed")
    original, previous = files.read_library(row)
    from .agent_files import library_root, safe_path, settings_of

    raw = safe_path(library_root(settings_of(row), row.owner), row.file_path).read_text(
        encoding="utf-8"
    )
    check_revision(raw, body.revision)
    if body.source is not None:
        source = body.source
    elif body.config:
        source = files.render({**previous, **body.config.model_dump()}, original)
    else:
        raise ValueError("缺少成员配置 / Member configuration required")
    files.parse(source)
    files.save_library(row, source)
    row.version += 1
    if body.sync:
        for member in d.scalars(
            select(TeamMember).where(
                TeamMember.library_id == row.id, TeamMember.deleted.is_(False)
            )
        ):
            team_source, team_values = files.read_member(member)
            baseline_path = files.state_path(
                files.settings_of(member), member.id, "base.md"
            )
            baseline = (
                files.parse(baseline_path.read_text(encoding="utf-8"))
                if baseline_path.exists()
                else previous
            )
            new_values = files.parse(source)
            # Each team owns its subscriptions and explicit edits, including external edits.
            merged = {
                k: new_values[k] if k != "channels" and v == baseline.get(k) else v
                for k, v in team_values.items()
            }
            # Patch onto the team's document so its unknown fields survive sync.
            team_header, _ = files.split(team_source)
            old_header, _ = files.split(
                baseline_path.read_text(encoding="utf-8")
                if baseline_path.exists()
                else original
            )
            new_header, _ = files.split(source)
            known = {
                "name",
                "description",
                "model",
                "tools",
                "machines",
                "channels",
                "budget",
                "color",
                "avatar",
                "readonly",
                "file_readonly",
                "enabled",
            }
            for key in (set(old_header) | set(new_header)) - known:
                if team_header.get(key) == old_header.get(key):
                    if key in new_header:
                        team_header[key] = new_header[key]
                    else:
                        team_header.pop(key, None)
            import io

            out = io.StringIO()
            files.yaml().dump(team_header, out)
            team_source = (
                "---\n" + out.getvalue() + "---\n\n" + team_values["role_description"]
            )
            files.save_member(
                member,
                files.render(merged, team_source),
                d.get(ResearchWorkspace, member.workspace_id).owner,
            )
            files.atomic_write(baseline_path, source)
            for channel in d.scalars(
                select(TeamChannel).where(TeamChannel.member_id == member.id)
            ):
                channel.name = member.name
    return library_out(d, row)


def library_out(d, row):
    from .agent_files import read_library

    source, values = read_library(row)
    from .agent_files import library_root, safe_path, settings_of

    try:
        source = safe_path(
            library_root(settings_of(row), row.owner), row.file_path
        ).read_text(encoding="utf-8")
    except (OSError, UnicodeError, ValueError):
        pass
    return {
        "id": row.id,
        "version": row.version,
        "config": {k: values[k] for k in MemberConfig.model_fields},
        "source": source,
        "revision": revision(source),
        "file_path": row.file_path,
        "file_error": getattr(row, "_file_error", ""),
        "teams": list(
            dict.fromkeys(
                d.scalars(
                    select(TeamMember.workspace_id).where(
                        TeamMember.library_id == row.id, TeamMember.deleted.is_(False)
                    )
                )
            )
        ),
    }


def allowed(member, spec):
    p, name = permissions(member), spec["name"]
    from .agent_files import read_member

    groups = set(read_member(member)[1].get("tools") or [])
    if name == "web_read":
        return member.enabled and not member.deleted and "web" in groups
    if name in {"run_job", "stop_job"} and "experiments" not in groups:
        return False
    if name == "bash" and "shell" not in groups:
        return False
    if (
        name
        in {"project_overview", "research_read", "start_research", "message_research"}
        and "project" not in groups
    ):
        return False
    if not member.enabled or member.deleted:
        return False
    if name in {"bash", "run_job", "stop_job", "start_research", "message_research"}:
        return p["commands"] and not p["readonly"]
    if name in {"read", "ls", "find", "grep", "write", "edit"}:
        return p["files"] and (
            name not in {"write", "edit"} or not (p["readonly"] or p["file_readonly"])
        )
    from .agent_worker import RESEARCH_BASE

    if name in RESEARCH_BASE | {"team_search_papers", "team_import_paper"}:
        return p["papers"]
    # Team conversation and research handoff remain available in read-only mode.
    if (
        p["readonly"]
        and spec.get("write")
        and not (
            name.startswith("team_")
            or name
            in {
                "advise",
                "end_sprint",
                "review_step",
                "finish_step",
                "focus",
                "propose_plan",
                "propose_conclusion",
            }
        )
    ):
        return False
    return True


def check_machine(settings, d, member, info):
    from .models import ResearchProject, ResearchWorkspace

    workspace = d.get(ResearchWorkspace, member.workspace_id)
    project = (
        d.get(ResearchProject, info["thread_id"][9:])
        if (info.get("thread_id") or "").startswith("research:")
        else None
    )
    from .research_locations import compute_for

    machine = project.compute_id if project else compute_for(settings, workspace)
    if machine not in permissions(member)["machines"]:
        raise ValueError("成员无权使用这台机器 / Machine permission denied")


def audit_denial(d, run, member, name, reason):
    info = run.runtime["team"]
    d.add(
        TeamMessage(
            workspace_id=member.workspace_id,
            channel_id=info["channel_id"],
            thread_id=info.get("thread_id"),
            kind="permission_denied",
            text=reason,
            data={"run_id_denied": run.id, "member_id": member.id, "tool": name},
        )
    )
    d.commit()


def apply_runtime(d, run, payload, info, settings=None):
    """Apply the same capability boundary to ordinary wakes and research rounds."""
    member = d.get(TeamMember, info["member_id"])
    if not member or not member.enabled or member.deleted:
        raise ValueError("成员已停用 / Member disabled")
    payload["tools"] = [t for t in payload["tools"] if allowed(member, t)]
    if settings:
        try:
            check_machine(settings, d, member, info)
        except ValueError:
            from .agent_tools import PI_NAMES

            payload["tools"] = [
                t
                for t in payload["tools"]
                if t["name"] not in PI_NAMES | {"run_job", "stop_job"}
            ]

    from .models import ResearchWorkspace
    from .research_team import language_part

    language = language_part(d, d.get(ResearchWorkspace, member.workspace_id))
    role_text = description(member)
    payload["system_prompt"] = (
        language
        + role_text
        + "\n\n"
        + payload.get("system_prompt", "").removeprefix(language)
    )
    brief = payload["context"].removeprefix(language)
    if not brief.startswith(role_text):
        brief = role_text + "\n\n" + brief
    payload["context"] = language + brief
    from .team_message_features import refresh_feedback

    payload["context"] = refresh_feedback(d, member, payload["context"])
    from .team_budgets import snapshot

    run.runtime = {**run.runtime, **snapshot(member)}
    payload["limits"]["model_turns"] = member.wake_turns
    payload["limits"]["tool_calls"] = 0
    if member.wake_tokens:
        payload["limits"]["output_tokens"] = min(
            payload["limits"]["output_tokens"], member.wake_tokens
        )
    return member.wake_turns, member.wake_tokens
