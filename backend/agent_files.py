"""Round-trip agent documents and the disk-backed definition boundary.

The old SQL definition columns are migration archives only. Valid snapshots and
library sync baselines live beside the data directory, never in model prompts.
"""

import base64
import binascii
import hashlib
import io
import os
import re
import tempfile
import tomllib
from pathlib import Path, PureWindowsPath
from xml.etree import ElementTree

from PIL import Image
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap
from ruamel.yaml.error import MarkedYAMLError
from sqlalchemy import select
from sqlalchemy.orm import object_session

from .builtin_agent_versions import BUILTIN_HASHES

GROUPS = ("literature", "files", "shell", "experiments", "web", "project")
COLORS = ("blue", "green", "amber", "red", "violet", "slate")
BUILTINS = Path(__file__).parent / "agents"
AVATAR_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}


class DefinitionError(ValueError):
    def __init__(self, line, reason):
        self.line = line
        super().__init__(f"第 {line} 行 / Line {line}: {reason}")


def yaml():
    parser = YAML(typ="rt")
    parser.preserve_quotes = True
    parser.allow_duplicate_keys = False
    parser.width = 1000
    return parser


def split(source):
    if len(source) > 150000 or "\0" in source:
        raise DefinitionError(1, "文件无效或过大 / Invalid or oversized file")
    lines = source.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise DefinitionError(1, "缺少 YAML 头 / Missing YAML header")
    end = next((n for n in range(1, len(lines)) if lines[n].strip() == "---"), None)
    if end is None:
        raise DefinitionError(len(lines), "YAML 头未结束 / Unterminated YAML header")
    try:
        header = yaml().load("".join(lines[1:end]))
    except MarkedYAMLError as exc:
        mark = exc.problem_mark or exc.context_mark
        raise DefinitionError(
            (mark.line + 2) if mark else 2, exc.problem or str(exc)
        ) from None
    if not isinstance(header, dict):
        raise DefinitionError(2, "YAML 头必须是映射 / Header must be a mapping")
    return header, "".join(lines[end + 1 :])


def parse(source, role="custom"):
    header, body = split(source)

    def line(key):
        return header.lc.key(key)[0] + 2 if key in header else 2

    def fail(key, reason):
        raise DefinitionError(line(key), reason)

    name = header.get("name")
    if (
        not isinstance(name, str)
        or not name.strip()
        or len(name) > 100
        or re.search(r'[<>:"/\\|?*\x00-\x1f]', name)
        or name in {".", ".."}
        or name.endswith((".", " "))
    ):
        fail("name", "名字无效 / Invalid name")
    for key in ("description", "model", "color", "avatar"):
        if key in header and not isinstance(header[key], str):
            fail(key, f"{key} 必须是文字 / Must be text")
    if header.get("color", "blue") not in COLORS:
        fail("color", "头像颜色无效 / Invalid avatar color")
    try:
        avatar_relative(header.get("avatar", ""))
    except ValueError as exc:
        fail("avatar", str(exc))
    for key in ("tools", "machines", "channels"):
        if key in header and (
            not isinstance(header[key], list)
            or len(header[key]) > 100
            or any(not isinstance(v, str) or not v for v in header[key])
        ):
            fail(key, f"{key} 必须是文字列表 / Must be a list of strings")
    for key in ("readonly", "file_readonly", "enabled"):
        if key in header and type(header[key]) is not bool:
            fail(key, f"{key} 必须是布尔值 / Must be boolean")
    budget = header.get("budget", {})
    if not isinstance(budget, dict):
        fail("budget", "budget 必须是映射 / Must be a mapping")
    for key, maximum in (
        ("turns", 256),
        ("tokens", 2000000),
        ("minutes", 1440),
        ("total_tokens", 10**12),
    ):
        # Members have no limits unless the file sets them; 0 means none.
        least = 0
        if key in budget and (
            type(budget[key]) is not int or not least <= budget[key] <= maximum
        ):
            budget_line = budget.lc.key(key)[0] + 2
            raise DefinitionError(
                budget_line, f"{key} 必须在 {least}–{maximum} 之间 / Out of range"
            )
    if len(body) > 50000:
        raise DefinitionError(source.count("\n") + 1, "正文过长 / Body too long")
    tools = list(header.get("tools", default_tools(role)))
    permissions = {
        "papers": "literature" in tools,
        "files": "files" in tools,
        "commands": bool({"shell", "experiments"} & set(tools)),
        "machines": list(header.get("machines", ["host", "local", "docker"])),
        "readonly": header.get("readonly", False),
        "file_readonly": header.get("file_readonly", False),
    }
    return {
        "name": name,
        "description": header.get("description", ""),
        "avatar_color": header.get("color", "blue"),
        "avatar": header.get("avatar", ""),
        "role_description": body.removeprefix("\n"),
        "model_config_id": header.get("model", ""),
        "permissions": permissions,
        "tools": tools,
        "wake_turns": budget.get("turns", 0),
        "wake_tokens": budget.get("tokens", 0),
        "wake_minutes": budget.get("minutes", 0),
        "max_tokens": budget.get("total_tokens", 0),
        "channels": list(header.get("channels", [])),
        "enabled": header.get("enabled", True),
    }


def default_tools(role):
    return [
        "literature",
        "files",
        "web",
        "project",
        *(["shell", "experiments"] if role in {"executor", "writer"} else []),
    ]


def render(config, source="", role="custom"):
    """Patch known values; round-trip unknown YAML, comments and nested keys."""
    header, _ = split(source) if source else (CommentedMap(), "")
    previous = parse(source, role) if source else {}
    values = {
        "name": config["name"],
        "description": config.get("description", ""),
        "model": config.get("model_config_id", ""),
        "color": config.get("avatar_color", "blue"),
        "channels": config.get("channels", []),
        "enabled": config.get("enabled", True),
    }
    if config.get("avatar") is not None:
        if config["avatar"]:
            values["avatar"] = config["avatar"]
        else:
            header.pop("avatar", None)
    p = config.get("permissions", {})
    tools = config.get("tools")
    if tools is None:
        tools = [
            g
            for g in default_tools(role)
            if g not in {"literature", "files", "shell", "experiments"}
        ]
        tools += (["literature"] if p.get("papers", True) else []) + (
            ["files"] if p.get("files", True) else []
        )
        if p.get("commands", False):
            tools += ["shell", "experiments"]
    # Existing API clients edit boolean permissions. Keep those edits meaningful
    # while leaving unknown tool names in the document for another runtime.
    if previous and p != previous["permissions"]:
        for flag, groups in (
            ("papers", ["literature"]),
            ("files", ["files"]),
            ("commands", ["shell", "experiments"]),
        ):
            if p.get(flag) != previous["permissions"][flag]:
                tools = [g for g in tools if g not in groups] + (
                    groups if p.get(flag) else []
                )
    values.update(
        tools=list(dict.fromkeys(tools)),
        machines=p.get("machines", ["host", "local", "docker"]),
        readonly=p.get("readonly", False),
        file_readonly=p.get("file_readonly", False),
    )
    for key, value in values.items():
        corresponding = {"model": "model_config_id", "color": "avatar_color"}.get(
            key, key
        )
        if not source or key in header or value != previous.get(corresponding):
            header[key] = value
    budget = header.setdefault("budget", CommentedMap())
    for key, field in (
        ("turns", "wake_turns"),
        ("tokens", "wake_tokens"),
        ("minutes", "wake_minutes"),
        ("total_tokens", "max_tokens"),
    ):
        # Limits are only written when set; none by default.
        if config.get(field):
            budget[key] = config[field]
        else:
            budget.pop(key, None)
    if not budget:
        header.pop("budget", None)
    out = io.StringIO()
    yaml().dump(header, out)
    result = "---\n" + out.getvalue() + "---\n\n" + config.get("role_description", "")
    parse(result, role)
    return result


def import_agent(source, filename="agent.md", name=""):
    warnings = []
    if filename.lower().endswith(".toml"):
        try:
            data = tomllib.loads(source)
        except tomllib.TOMLDecodeError as exc:
            match = re.search(r"line (\d+)", str(exc))
            raise DefinitionError(
                int(match[1]) if match else source.count("\n") + 1, str(exc)
            ) from None
        for key in ("description", "developer_instructions"):
            if key in data and not isinstance(data[key], str):
                raise DefinitionError(1, f"{key} 必须是文字 / Must be text")
        body = data.pop("developer_instructions", "")
        header = CommentedMap(data)
        header["name"] = name or Path(filename).stem
        out = io.StringIO()
        yaml().dump(header, out)
        result = "---\n" + out.getvalue() + "---\n\n" + body
    else:
        header, body = split(source)
        mapping = {
            "Read": "files",
            "Grep": "files",
            "Glob": "files",
            "Edit": "files",
            "Write": "files",
            "Bash": "shell",
            "WebFetch": "web",
            "WebSearch": "web",
        }
        tools = header.get("tools", [])
        if isinstance(tools, str):
            tools = [s.strip() for s in tools.split(",") if s.strip()]
        if not isinstance(tools, list) or any(not isinstance(t, str) for t in tools):
            raise DefinitionError(
                header.lc.key("tools")[0] + 2, "tools 必须是工具列表 / Invalid tools"
            )
        mapped = []
        for tool in tools:
            mapped.append(mapping.get(tool, tool))
            if tool not in mapping and tool not in GROUPS:
                warnings.append("未知工具 / Unknown tool: " + tool)
        if "tools" in header:
            header["tools"] = list(dict.fromkeys(mapped))
            if set(tools) & {"Read", "Grep", "Glob"} and not set(tools) & {
                "Edit",
                "Write",
            }:
                header["file_readonly"] = True
        if name:
            header["name"] = name
        out = io.StringIO()
        yaml().dump(header, out)
        result = "---\n" + out.getvalue() + "---\n" + body
    return {"source": result, "config": parse(result), "warnings": warnings}


def legacy_limit(value, old_default):
    """Old databases stored the former default limits; those mean no limit now."""
    return 0 if not value or value == old_default else value


def settings_of(row):
    session = object_session(row)
    return session.info.get("settings") if session else None


def data_root(settings):
    return Path(settings.storage).parent


def safe_path(root, relative):
    root = Path(root)
    path = root / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts or path == root:
        raise ValueError("成员路径无效 / Invalid agent path")
    for item in [root, *path.relative_to(root).parents, path]:
        candidate = item if item.is_absolute() else root / item
        if candidate.is_symlink():
            raise ValueError("成员路径不能是符号链接 / Agent path is a symlink")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("成员路径无效 / Invalid agent path")
    return path


def avatar_relative(value):
    """Unknown avatar formats round-trip; recognized images must be repo-relative."""
    if (
        not value
        or value.startswith("pixel:")
        or Path(value).suffix.lower() not in AVATAR_TYPES
    ):
        return None
    if (
        "\\" in value
        or ":" in value
        or "\0" in value
        or Path(value).is_absolute()
        or PureWindowsPath(value).drive
        or ".." in Path(value).parts
    ):
        raise ValueError("头像路径无效 / Invalid avatar path")
    return value


def avatar_path(root, value):
    relative = avatar_relative(value)
    return safe_path(root, relative) if relative else None


def avatar_upload(upload):
    """Decode and verify uploads before changing a member or its image."""
    try:
        raw = base64.b64decode(upload.content, validate=True)
        if upload.extension == "svg":
            if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
                raise ValueError()
            if ElementTree.fromstring(raw).tag != "{http://www.w3.org/2000/svg}svg":
                raise ValueError()
        else:
            with Image.open(io.BytesIO(raw)) as image:
                expected = {"png": "PNG", "jpg": "JPEG", "jpeg": "JPEG", "webp": "WEBP"}
                if image.format != expected[upload.extension]:
                    raise ValueError()
                image.verify()
        return raw
    except (
        ValueError,
        binascii.Error,
        OSError,
        ElementTree.ParseError,
        Image.DecompressionBombError,
    ) as exc:
        raise ValueError("头像图片无效 / Invalid avatar image") from exc


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".agent-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as output:
            output.write(text)
        os.replace(temp, path)
    finally:
        if Path(temp).exists():
            Path(temp).unlink()


def state_path(settings, identifier, suffix="valid.md"):
    return safe_path(data_root(settings), f"agent-state/{identifier}.{suffix}")


def library_root(settings, owner):
    # Hosted installations isolate owners; local installations have one library.
    relative = (
        "agents"
        if settings.mode == "local"
        else "agents/" + hashlib.sha256(owner.encode()).hexdigest()[:24]
    )
    return safe_path(data_root(settings), relative)


def member_root(settings, member):
    from . import research_repo
    from .models import ResearchWorkspace

    d = object_session(member)
    workspace = d.get(ResearchWorkspace, member.workspace_id)
    return research_repo.ensure_repo(settings, workspace, snapshot=False)


def legacy_config(member):
    from .team_members import MemberConfig, Permissions

    role = member.role
    text = member.legacy_role_description or ""
    if not text and not member.library_id and (BUILTINS / f"{role}.md").is_file():
        return parse((BUILTINS / f"{role}.md").read_text(encoding="utf-8"), role)
    return {
        **MemberConfig(name=member.legacy_name or role).model_dump(),
        "avatar_color": member.legacy_avatar_color or "blue",
        "avatar": "",
        "role_description": text,
        "model_config_id": member.legacy_model_config_id or "",
        "permissions": member.legacy_permissions
        or Permissions(commands=role in {"executor", "writer"}).model_dump(),
        "wake_turns": legacy_limit(member.legacy_wake_turns, 32),
        "wake_tokens": legacy_limit(member.legacy_wake_tokens, 200000),
        "max_tokens": legacy_limit(member.legacy_max_tokens, 2000000),
        "enabled": member.legacy_enabled is not False,
    }


def channels_for(d, member, ids):
    from .models import TeamChannel

    return [
        "#" + c.name
        for c in d.scalars(
            select(TeamChannel).where(
                TeamChannel.workspace_id == member.workspace_id,
                TeamChannel.id.in_(ids),
                TeamChannel.member_id.is_(None),
            )
        )
    ]


def ensure_member(member):
    settings = settings_of(member)
    if settings is None or member.role == "human" or member.file_path:
        return
    d = object_session(member)
    values = legacy_config(member)
    # Preserve all settings of built-ins while taking their initial body from the bundle.
    if not member.library_id:
        values.update(
            name=member.legacy_name,
            avatar_color=member.legacy_avatar_color or values["avatar_color"],
            model_config_id=member.legacy_model_config_id or "",
            enabled=member.legacy_enabled is not False,
        )
        if member.legacy_role_description:
            values["role_description"] = member.legacy_role_description
        if member.legacy_permissions:
            values["permissions"] = member.legacy_permissions
            values["tools"] = None
        values.update(
            wake_turns=legacy_limit(member.legacy_wake_turns, 32),
            wake_tokens=legacy_limit(member.legacy_wake_tokens, 200000),
        )
    values["max_tokens"] = legacy_limit(member.legacy_max_tokens, 2000000)
    values["channels"] = channels_for(d, member, member.legacy_subscriptions or [])
    source = render(values, role=member.role)
    builtin = builtin_file(member)
    if builtin:
        original = builtin.read_bytes().decode("utf-8")
        if parse(source, member.role) == parse(original, member.role):
            source = original
    save_member(
        member, source, actor="ORA migration", initialize=True, builtin=bool(builtin)
    )
    if member.library_id:
        from .models import MemberLibrary

        library = d.get(MemberLibrary, member.library_id)
        if library:
            base = read_library(library)[0]
            atomic_write(state_path(settings, member.id, "base.md"), base)


def read_valid(settings, row, path, role="custom"):
    try:
        if path.stat().st_size > 600000:
            raise DefinitionError(1, "文件过大 / File too large")
        raw = path.read_text(encoding="utf-8")
        if getattr(row, "_definition_source", None) == raw:
            config = row._definition_values
        else:
            config = parse(raw, role)
            row._definition_source, row._definition_values = raw, config
        row._file_error = ""
        snapshot = state_path(settings, row.id)
        if getattr(row, "_snapshot_source", None) != raw and (
            not snapshot.exists() or snapshot.read_text(encoding="utf-8") != raw
        ):
            atomic_write(snapshot, raw)
        row._snapshot_source = raw
        return raw, config
    except (OSError, UnicodeError, ValueError) as exc:
        row._file_error = (
            str(exc) if isinstance(exc, DefinitionError) else f"第 1 行 / Line 1: {exc}"
        )
        snapshot = state_path(settings, row.id)
        if snapshot.exists():
            raw = snapshot.read_text(encoding="utf-8")
            return raw, parse(raw, role)
        raise DefinitionError(1, str(exc)) from None


def builtin_file(member):
    if not member.library_id and member.role in BUILTIN_HASHES:
        return BUILTINS / f"{member.role}.md"
    return None


def builtin_record(member):
    return f".ora/builtin-agents/{member.role}.sha256"


def update_builtin(member, root, path):
    """Only an exact bundled copy may follow an updated built-in automatically."""
    member._builtin_update_available = False
    builtin = builtin_file(member)
    if not builtin:
        return
    current = builtin.read_bytes()
    current_hash = hashlib.sha256(current).hexdigest()
    raw_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    record = safe_path(root, builtin_record(member))
    baseline = record.read_text(encoding="utf-8").strip() if record.exists() else None
    member._builtin_update_available = (baseline or raw_hash) != current_hash
    if raw_hash == current_hash:
        member._builtin_update_available = False
        return
    unchanged = (
        raw_hash == baseline if baseline else raw_hash in BUILTIN_HASHES[member.role]
    )
    if unchanged:
        saved = save_member(
            member,
            current.decode("utf-8"),
            actor="ORA",
            builtin=True,
            expected_hash=raw_hash,
        )
        member._builtin_update_available = saved is None


def read_member(member):
    ensure_member(member)
    settings = settings_of(member)
    if settings is None or member.role == "human":
        return "", legacy_config(member)
    root = member_root(settings, member)
    try:
        path = safe_path(root, member.file_path)
        try:
            update_builtin(member, root, path)
        except OSError:
            # Missing definitions still use the valid snapshot and expose its error.
            pass
        return read_valid(
            settings, member, safe_path(root, member.file_path), member.role
        )
    except ValueError as exc:
        member._file_error = str(exc)
        snapshot = state_path(settings, member.id)
        if snapshot.exists():
            raw = snapshot.read_text(encoding="utf-8")
            return raw, parse(raw, member.role)
        raise


def member_value(member, key):
    if not settings_of(member) or member.role == "human":
        value = getattr(member, "legacy_" + key, None)
        if value is None:
            defaults = {"overrides": [], "subscriptions": [], "enabled": True}
            return defaults.get(key, legacy_config(member).get(key))
        return value
    _, values = read_member(member)
    if key == "subscriptions":
        from .models import TeamChannel

        d = object_session(member)
        return [
            c.id
            for c in d.scalars(
                select(TeamChannel).where(
                    TeamChannel.workspace_id == member.workspace_id,
                    TeamChannel.member_id.is_(None),
                    TeamChannel.archived.is_(False),
                )
            )
            if "#" + c.name in values["channels"] or c.id in values["channels"]
        ]
    if key == "overrides":
        base = state_path(settings_of(member), member.id, "base.md")
        if not base.exists():
            return []
        baseline = parse(base.read_text(encoding="utf-8"))
        return sorted(k for k in values if values[k] != baseline.get(k))
    if key == "model_config_id" and values[key]:
        from .models import ResearchWorkspace

        settings = settings_of(member)
        workspace = object_session(member).get(ResearchWorkspace, member.workspace_id)
        return model_identifier(settings, workspace.owner, values[key])
    return values[key]


def model_identifier(settings, owner, model):
    from .translation_settings import read_store, shared_configs

    candidates = shared_configs(settings) + read_store(settings, owner)["models"]
    match = next(
        (
            row
            for row in candidates
            if model in {row["id"], row.get("model"), row.get("name")}
        ),
        None,
    )
    return match["id"] if match else model


def save_member(
    member,
    source,
    actor,
    initialize=False,
    upload=None,
    builtin=False,
    expected_hash=None,
):
    from . import research_repo

    values = parse(source, member.role)
    settings = settings_of(member)
    from .models import User

    person = object_session(member).get(User, actor)
    if person:
        actor = f"{person.username} ({actor})"
    repo = member_root(settings, member)
    image = avatar_upload(upload) if upload else None
    if upload:
        values["avatar"] = f".ora/avatars/{values['name']}.{upload.extension}"
        source = render(values, source, member.role)
    image_path = avatar_path(repo, values["avatar"])
    relative = f".ora/agents/{values['name']}.md"
    if initialize:
        from .models import TeamMember

        d = object_session(member)
        used = set(
            d.scalars(
                select(TeamMember.file_path).where(
                    TeamMember.workspace_id == member.workspace_id,
                    TeamMember.id != member.id,
                )
            )
        )
        path = safe_path(repo, relative)
        if relative in used or (
            path.exists() and path.read_text(encoding="utf-8") != source
        ):
            relative = f".ora/agents/{values['name']}-{member.id[:8]}.md"
    with research_repo._locked(research_repo.home(settings, member.workspace_id)):
        path = safe_path(repo, relative)
        old = safe_path(repo, member.file_path) if member.file_path else None
        if expected_hash is not None and (
            old is None or hashlib.sha256(old.read_bytes()).hexdigest() != expected_hash
        ):
            return None
        if (old is None or path != old) and path.exists():
            # An interrupted SQL transaction may have already exported this exact file.
            if not initialize or path.read_text(encoding="utf-8") != source:
                raise ValueError("同名成员文件已存在 / Agent file already exists")
        atomic_write(path, source)
        paths = [relative]
        if builtin:
            record = builtin_record(member)
            atomic_write(
                safe_path(repo, record),
                hashlib.sha256(builtin_file(member).read_bytes()).hexdigest() + "\n",
            )
            paths.append(record)
        if image is not None:
            # Commit the image and definition together, only when the member is saved.
            image_path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=".avatar-", dir=image_path.parent)
            try:
                with os.fdopen(fd, "wb") as output:
                    output.write(image)
                os.replace(temporary, image_path)
            finally:
                Path(temporary).unlink(missing_ok=True)
            paths.append(values["avatar"])
        if old and old != path and old.exists():
            old.unlink()
            old_relative = str(old.relative_to(repo))
            if (
                research_repo.git(
                    repo, "ls-files", "--error-unmatch", "--", old_relative, check=False
                ).returncode
                == 0
            ):
                paths.append(old_relative)
        research_repo.git(repo, "add", "--", *paths)
        if research_repo.git(
            repo, "diff", "--cached", "--quiet", "--", *paths, check=False
        ).returncode:
            research_repo.git(
                repo,
                "commit",
                "-q",
                "-m",
                f"更新内置成员 {values['name']}"
                if expected_hash is not None
                else f"{actor} 修改成员 {values['name']}",
                "--",
                *paths,
            )
        member.file_path = relative
        atomic_write(state_path(settings, member.id), source)
    return values


def read_library(row):
    settings = settings_of(row)
    root = library_root(settings, row.owner)
    if not row.file_path:
        values = row.legacy_config
        relative = values["name"] + ".md"
        path = safe_path(root, relative)
        source = render(values)
        from .models import MemberLibrary

        used = set(
            object_session(row).scalars(
                select(MemberLibrary.file_path).where(
                    MemberLibrary.owner == row.owner, MemberLibrary.id != row.id
                )
            )
        )
        if relative in used or (
            path.exists() and path.read_text(encoding="utf-8") != source
        ):
            relative = values["name"] + "-" + row.id[:8] + ".md"
        row.file_path = relative
        atomic_write(safe_path(root, relative), source)
    return read_valid(settings, row, safe_path(root, row.file_path))


def library_config(row):
    return read_library(row)[1] if settings_of(row) else row.legacy_config


def save_library(row, source):
    values = parse(source)
    root = library_root(settings_of(row), row.owner)
    relative = values["name"] + ".md"
    path = safe_path(root, relative)
    old = safe_path(root, row.file_path) if row.file_path else None
    if path != old and path.exists():
        raise ValueError("同名成员文件已存在 / Agent file already exists")
    atomic_write(path, source)
    if old and old != path and old.exists():
        old.unlink()
    row.file_path = relative
    atomic_write(state_path(settings_of(row), row.id), source)


def shared_instructions(member):
    from .models import ResearchWorkspace

    d = object_session(member)
    return (
        workspace_instructions(d.get(ResearchWorkspace, member.workspace_id))
        if d
        else ""
    )


def workspace_instructions(workspace):
    settings = settings_of(workspace)
    if not settings:
        return workspace.instructions or ""
    from . import research_repo

    root = research_repo.ensure_repo(settings, workspace, snapshot=False)
    path = safe_path(root, "AGENTS.md")
    if path.exists():
        return path.read_text(encoding="utf-8")
    return ""


def save_instructions(workspace, text):
    from . import research_repo

    settings = settings_of(workspace)
    if not settings:
        return
    root = research_repo.ensure_repo(settings, workspace, snapshot=False)
    with research_repo._locked(research_repo.home(settings, workspace.id)):
        atomic_write(safe_path(root, "AGENTS.md"), text)
        research_repo.git(root, "add", "--", "AGENTS.md")
        if research_repo.git(
            root, "diff", "--cached", "--quiet", "--", "AGENTS.md", check=False
        ).returncode:
            research_repo.git(
                root,
                "commit",
                "-q",
                "-m",
                f"{workspace.owner} 修改团队说明 AGENTS.md",
                "--",
                "AGENTS.md",
            )


def export_all(d):
    from .models import MemberLibrary, TeamMember, ResearchWorkspace
    from . import research_repo

    settings = d.info.get("settings")
    if settings:
        for workspace in d.scalars(select(ResearchWorkspace)):
            if (research_repo.repo_dir(settings, workspace.id) / ".git").exists():
                research_repo.ensure_repo(settings, workspace, snapshot=False)

    for row in d.scalars(select(MemberLibrary)):
        read_library(row)
    for member in d.scalars(select(TeamMember).where(TeamMember.role != "human")):
        ensure_member(member)
    d.flush()


def discover_team(d, workspace, members):
    """Register runtime identities for files added by an editor or Git checkout."""
    from . import research_repo
    from .models import AgentSession, TeamChannel, TeamMember

    settings = d.info.get("settings")
    if not settings:
        return
    repo = research_repo.ensure_repo(settings, workspace, snapshot=False)
    folder = safe_path(repo, ".ora/agents")
    known = {m.file_path for m in members}
    for path in sorted(folder.glob("*.md")):
        relative = str(path.relative_to(repo))
        if relative in known:
            continue
        try:
            safe_path(repo, relative)
            values = parse(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError):
            continue
        from uuid import uuid4

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
            name=values["name"],
            session_id=session.id,
            file_path=relative,
        )
        d.add(member)
        d.flush()
        read_member(member)
        d.add(
            TeamChannel(
                workspace_id=workspace.id,
                key="dm:" + member.id,
                name=values["name"],
                member_id=member.id,
            )
        )
        members.append(member)
    d.flush()


def discover_library(d, owner):
    from .models import MemberLibrary

    settings = d.info.get("settings")
    rows = list(d.scalars(select(MemberLibrary).where(MemberLibrary.owner == owner)))
    for row in rows:
        read_library(row)
    known = {r.file_path for r in rows}
    root = library_root(settings, owner)
    for path in sorted(root.glob("*.md")):
        if path.name in known:
            continue
        try:
            safe_path(root, path.name)
            parse(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError):
            continue
        row = MemberLibrary(owner=owner, file_path=path.name, config={})
        d.add(row)
        d.flush()
        read_library(row)
        rows.append(row)
    return rows
