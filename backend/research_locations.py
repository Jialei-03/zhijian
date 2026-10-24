"""Physical workspaces and non-interactive SSH connections.

Existing-folder binding never changes its Git repository. New folders are
created only when explicitly requested. Runtime
metadata stays under the application's data directory, away from user files.
"""

import json
import os
import posixpath
import shlex
import subprocess
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import Depends, HTTPException, Query
from pydantic import Field
from sqlalchemy import or_, select

from . import research_settings
from .schemas import Strict

SYSTEM_FOLDERS = (
    "/Users",
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/bin",
    "/etc",
    "/var",
    "/private",
)
HOME_FOLDERS = ("Library", "Desktop", "Documents", "Downloads")
FOLDER_ERRORS = {
    "root": "不能用根目录",
    "home": "不能用主目录",
    "system": "不能用系统目录",
    "personal": "不能用个人目录",
    "git": "不能用 Git 元数据目录",
}


def project_folder_error(path, home="~", *, resolve=False):
    """Exact protected roots, including aliases; their project subfolders are allowed."""

    def normalize(value):
        if resolve:
            return str(Path(value).expanduser().resolve())
        return posixpath.normpath(
            "/" + value.lstrip("/") if value.startswith("/") else value
        )

    path, home = normalize(path), normalize(home)
    if path == home:
        return "home"
    if path == normalize("/"):
        return "root"
    if path in {normalize(p) for p in SYSTEM_FOLDERS}:
        return "system"
    if path in {normalize(f"{home}/{p}") for p in HOME_FOLDERS}:
        return "personal"
    if ".git" in (part.lower() for part in path.split("/")):
        return "git"
    return ""


def check_folder_name(name):
    if (
        not name
        or name in {".", ".."}
        or any(char in name for char in ("/", "\\", "\0", "\n", "\r"))
    ):
        raise ValueError("文件夹名称不合法")


class ConnectionInput(Strict):
    id: str = Field(default="", max_length=41)
    kind: Literal["ssh"] = "ssh"
    name: str = Field(default="", max_length=80)
    displayname: str = Field(default="", max_length=80)
    host: str = Field(min_length=1, max_length=201)
    port: int = Field(default=22, ge=1, le=65535)
    identity_file: str = Field(default="", max_length=2000)


def ssh_args(item):
    """Validated argv options; no shell interpolation of host, port, or key path."""
    host = item if isinstance(item, str) else item.get("host", "")
    if not research_settings.HOST.fullmatch(host):
        raise ValueError("SSH 主机填配置名或 user@host")
    args = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]
    if isinstance(item, dict):
        try:
            port = int(item.get("port") or 22)
        except (ValueError, TypeError):
            raise ValueError("SSH 端口不合法") from None
        if not 1 <= port <= 65535:
            raise ValueError("SSH 端口须在 1 至 65535 之间")
        if port != 22:
            args += ["-p", str(port)]
        identity = item.get("identity_file") or ""
        if identity:
            if "\0" in identity or "\n" in identity or "\r" in identity:
                raise ValueError("SSH 密钥文件路径不合法")
            path = Path(identity).expanduser().resolve()
            if not path.is_file():
                raise ValueError("SSH 密钥文件不存在")
            args += ["-i", str(path)]
    return args


def connection(settings, connection_id):
    item = research_settings.compute(settings, connection_id)
    if item.get("kind") != "ssh":
        raise ValueError("请选择 SSH 连接")
    ssh_args(item)
    return item


def _remote_query(item, path, validate=False, create_folder=""):
    from . import research_sandbox

    script = """import json,os,sys
r=json.load(sys.stdin)
home=os.path.realpath(os.path.expanduser('~'))
p=os.path.realpath(os.path.expanduser(r['path'] or os.path.join(home,'ORA')))
if not r['path'] and p not in {home,'/'}:
    os.makedirs(os.path.join(home,'ORA'),exist_ok=True)
if not os.path.isdir(p): raise ValueError('目录不存在')
target=os.path.join(p,r['create_folder']) if r['create_folder'] else p
p=os.path.realpath(target)
blocked={os.path.realpath(v):'system' for v in r['system_folders']}
blocked.update({os.path.realpath(os.path.join(home,v)):'personal' for v in r['home_folders']})
blocked.update({'/':'root',home:'home'})
error=blocked.get(p,'')
if '.git' in (v.lower() for v in p.split('/')): error='git'
if (r['validate'] or r['create_folder'] or not r['path']) and error: raise ValueError(r['errors'][error])
if r['create_folder']:
    try: os.mkdir(target)
    except FileExistsError: raise ValueError('文件夹已存在') from None
if r.get('validate') and not os.access(p,os.W_OK|os.X_OK): raise ValueError('目录不可写')
out={'path':p,'parent':None if os.path.dirname(p)==p else os.path.dirname(p),'entries':[],'project_error':error}
if not r.get('validate'):
    out['entries']=sorted([{'name':e.name,'path':os.path.join(p,e.name)} for e in os.scandir(p) if e.is_dir()],key=lambda x:x['name'].lower())[:2000]
print(json.dumps(out,ensure_ascii=False))
"""
    if not isinstance(path, str) or "\0" in path or "\n" in path or "\r" in path:
        raise ValueError("远程目录不合法")
    try:
        done = research_sandbox.run(
            [*ssh_args(item), item["host"], "python3 -c " + shlex.quote(script)],
            input=json.dumps(
                {
                    "path": path,
                    "validate": validate,
                    "create_folder": create_folder,
                    "system_folders": SYSTEM_FOLDERS,
                    "home_folders": HOME_FOLDERS,
                    "errors": FOLDER_ERRORS,
                }
            )
            + "\n",
            capture_output=True,
            text=True,
            timeout=25,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError("SSH 连接暂时不可用：" + str(exc)[:200]) from None
    if done.returncode:
        raise ValueError("无法访问远程目录：" + (done.stderr or "SSH 连接失败")[-400:])
    try:
        return json.loads((done.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise ValueError("远程机器没有返回目录信息") from None


def folders(settings, kind, path="", connection_id=""):
    if kind == "ssh":
        return _remote_query(connection(settings, connection_id), path)
    if kind != "local":
        raise ValueError("请选择本机或 SSH")
    if not path:
        default = Path.home() / "ORA"
        error = project_folder_error(str(default), str(Path.home()), resolve=True)
        if error:
            raise ValueError(FOLDER_ERRORS[error])
        default.mkdir(exist_ok=True)
        path = str(default)
    folder = Path(path).expanduser().resolve()
    if not folder.is_dir():
        raise ValueError("目录不存在")
    entries = []
    for item in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
        try:
            if item.is_dir():
                entries.append({"name": item.name, "path": str(item)})
        except OSError:
            continue
    return {
        "path": str(folder),
        "parent": None if folder.parent == folder else str(folder.parent),
        "entries": entries[:2000],
        "project_error": project_folder_error(
            str(folder), str(Path.home()), resolve=True
        ),
    }


def validate_location(settings, location, *, create_folder=""):
    location = location or {"kind": "managed"}
    if not isinstance(location, dict):
        raise ValueError("工作区位置不合法")
    kind, path = location.get("kind", "managed"), location.get("path") or ""
    if create_folder:
        check_folder_name(create_folder)
    if kind == "managed":
        if create_folder:
            raise ValueError("请选择本机或 SSH 目录")
        return {"kind": "managed", "path": "", "connection_id": ""}
    if kind == "ssh":
        cid = location.get("connection_id") or ""
        if not isinstance(path, str) or not path or any(c in path for c in "\0\n\r"):
            raise ValueError("请选择已存在的 SSH 目录")
        target = posixpath.join(path, create_folder) if create_folder else path
        error = project_folder_error(target)
        if error:
            raise ValueError(FOLDER_ERRORS[error])
        found = _remote_query(
            connection(settings, cid),
            path,
            validate=True,
            create_folder=create_folder,
        )
        error = found.get("project_error") or project_folder_error(found["path"])
        if error:
            raise ValueError(FOLDER_ERRORS[error])
        return {"kind": "ssh", "path": found["path"], "connection_id": cid}
    if (
        kind != "local"
        or not isinstance(path, str)
        or not path
        or any(c in path for c in "\0\n\r")
    ):
        raise ValueError("请选择已存在的本机或 SSH 目录")
    parent = Path(path).expanduser().resolve()
    folder = parent
    if create_folder:
        folder = parent / create_folder
    error = project_folder_error(str(folder), str(Path.home()), resolve=True)
    if error:
        raise ValueError(FOLDER_ERRORS[error])
    if not parent.is_dir():
        raise ValueError("目录不存在")
    if create_folder:
        try:
            folder.mkdir()
        except FileExistsError:
            raise ValueError("文件夹已存在") from None
    if not os.access(folder, os.W_OK | os.X_OK):
        raise ValueError("目录不可写")
    return {"kind": "local", "path": str(folder), "connection_id": ""}


def location_for(settings, workspace):
    from . import research_repo

    location = dict(getattr(workspace, "location", None) or {})
    kind = location.get("kind") or "managed"
    if kind == "managed":
        return {
            "kind": kind,
            "path": str(research_repo.repo_dir(settings, workspace.id)),
            "connection_id": "",
        }
    return {
        "kind": kind,
        "path": location.get("path", ""),
        "connection_id": location.get("connection_id", ""),
    }


def compute_for(settings, workspace):
    location = location_for(settings, workspace)
    if location["kind"] == "local":
        return "host"
    if location["kind"] == "ssh":
        return connection(settings, location["connection_id"])["id"]
    return (
        getattr(workspace, "compute_id", "")
        or research_settings.load(settings)["default_compute"]
    )


def binding_path(settings, project_id):
    from .research_sandbox import _root

    return _root(settings, project_id) / "location.json"


def research_location(settings, workspace, project):
    """Actual execution cwd, including independent forks and legacy managed work."""
    from . import research_remote, research_repo

    origin = location_for(settings, workspace)
    if not getattr(project, "parent_id", None) and origin["kind"] != "managed":
        return origin
    item = research_settings.compute(settings, project.compute_id)
    if item["kind"] == "ssh":
        return {
            "kind": "ssh",
            "path": research_remote._base(item, project.id) + "/work",
            "connection_id": item["id"],
        }
    return {
        "kind": "local",
        "path": str(research_repo.thread_dir(settings, workspace.id, project.id)),
        "connection_id": "",
    }


def tool_cwd(settings, d, project):
    """Pi's tool directory, separate from its isolated local Node process cwd."""
    from .models import ResearchWorkspace

    if not project.workspace_id:
        return ""
    workspace = d.get(ResearchWorkspace, project.workspace_id)
    if workspace is None or workspace.owner != project.owner:
        raise ValueError("研究工作区不可用，无法确定工具工作目录")
    if (
        getattr(project, "parent_id", None)
        or location_for(settings, workspace)["kind"] == "managed"
    ) and research_settings.compute(settings, project.compute_id)["kind"] == "docker":
        return "/work"
    location = research_location(settings, workspace, project)
    path = location.get("path") or ""
    if location["kind"] != "ssh":
        if not Path(path).is_absolute():
            raise ValueError("研究工具工作目录不是绝对路径")
        return path
    if path.startswith("/"):
        return path
    # A new SSH fork may not have been seeded yet. Resolve its path on the
    # selected host without requiring that directory to exist or creating it.
    from . import research_sandbox

    item = connection(settings, location["connection_id"])
    script = (
        "import json,os,sys; "
        "p=json.load(sys.stdin)['path']; "
        "print(json.dumps({'path':os.path.realpath(os.path.expanduser(p))}))"
    )
    try:
        done = research_sandbox.run(
            [*ssh_args(item), item["host"], "python3 -c " + shlex.quote(script)],
            input=json.dumps({"path": path}) + "\n",
            capture_output=True,
            text=True,
            timeout=25,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError("SSH 工具工作目录解析失败，请检查所选连接后重试") from None
    if done.returncode:
        raise ValueError("SSH 工具工作目录解析失败，请检查所选连接后重试")
    try:
        resolved = json.loads((done.stdout or "").strip().splitlines()[-1])["path"]
        if (
            not isinstance(resolved, str)
            or not resolved.startswith("/")
            or any(char in resolved for char in ("\0", "\n", "\r"))
        ):
            raise ValueError()
        return resolved
    except (ValueError, KeyError, IndexError, TypeError):
        raise ValueError("SSH 没有返回有效的绝对工具工作目录，请重试") from None


def read_binding(settings, project_id):
    try:
        return json.loads(binding_path(settings, project_id).read_text())
    except (OSError, ValueError):
        return {}


def bind(settings, workspace, project):
    from . import research_repo

    location = location_for(settings, workspace)
    if getattr(project, "parent_id", None):
        location = {
            "kind": "managed",
            "path": str(research_repo.thread_dir(settings, workspace.id, project.id)),
            "connection_id": "",
        }
    path = binding_path(settings, project.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {**location, "workspace_id": workspace.id}
    if read_binding(settings, project.id) == data:
        return location
    temporary = path.with_name("location-" + uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(data))
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return location


def execution_compute(settings, d, project):
    from .models import ResearchWorkspace

    workspace = (
        d.get(ResearchWorkspace, project.workspace_id) if project.workspace_id else None
    )
    location = bind(settings, workspace, project) if workspace else {}
    if location.get("kind") == "ssh":
        item = {
            **connection(settings, location["connection_id"]),
            "workspace_path": location["path"],
        }
        project.compute_id = item["id"]
        return item
    if location.get("kind") == "local":
        project.compute_id = "host"
        return research_settings.compute(settings, "host")
    return research_settings.compute(settings, project.compute_id)


def busy_workspace(d, workspace, *, exclude_session_id=""):
    """Caller holds the workspace lock before admitting a writer in a user folder."""
    from .models import AgentRun, AgentSession, ResearchJob, ResearchProject

    if (getattr(workspace, "location", None) or {}).get("kind") not in {"local", "ssh"}:
        return False
    runs = (
        select(AgentRun.id)
        .join(AgentSession, AgentSession.id == AgentRun.session_id)
        .outerjoin(ResearchProject, ResearchProject.session_id == AgentSession.id)
        .where(
            or_(
                AgentSession.workspace_id == workspace.id,
                ResearchProject.workspace_id == workspace.id,
            ),
            AgentRun.status.in_(("queued", "running")),
            AgentRun.session_id != exclude_session_id,
            or_(ResearchProject.id.is_(None), ResearchProject.parent_id.is_(None)),
        )
        .limit(1)
    )
    jobs = (
        select(ResearchJob.id)
        .join(ResearchProject, ResearchProject.id == ResearchJob.project_id)
        .where(
            ResearchProject.workspace_id == workspace.id,
            ResearchProject.parent_id.is_(None),
            ResearchProject.session_id != exclude_session_id,
            ResearchJob.status.in_(("queued", "running")),
        )
        .limit(1)
    )
    return bool(d.scalar(runs) or d.scalar(jobs))


def install_location_routes(app, settings, db, auth, human, owned):
    def allowed(a):
        human(a)
        if settings.mode != "local":
            raise HTTPException(403, "工作区只在本机版提供")

    @app.get("/api/v1/research/folders")
    def browse(
        kind: Literal["local", "ssh"] = "local",
        path: str = Query(default="", max_length=4000),
        connection_id: str = Query(default="", max_length=41),
        a=Depends(auth),
    ):
        allowed(a)
        try:
            return folders(settings, kind, path, connection_id)
        except (ValueError, OSError) as exc:
            raise HTTPException(409, str(exc)) from None

    @app.get("/api/v1/research/connections")
    def connections(a=Depends(auth)):
        allowed(a)
        return [
            {
                key: item.get(key, 22 if key == "port" else "")
                for key in ("id", "name", "kind", "host", "port", "identity_file")
            }
            for item in research_settings.load(settings)["computes"]
            if item.get("kind") == "ssh"
        ]

    @app.post("/api/v1/research/connections")
    def add_connection(body: ConnectionInput, a=Depends(auth)):
        allowed(a)
        try:
            cid = body.id or "ssh-" + uuid4().hex[:12]
            item = research_settings.check_compute(
                {
                    "id": cid,
                    "kind": "ssh",
                    "name": body.name or body.displayname or body.host,
                    "host": body.host,
                    "port": body.port,
                    "identity_file": body.identity_file,
                }
            )
            ssh_args(item)
            _remote_query(item, "~", validate=False)
            data = research_settings.load(settings)
            previous = next((c for c in data["computes"] if c["id"] == cid), None)
            if previous and previous.get("kind") != "ssh":
                raise ValueError("连接编号已被本机环境使用")
            data["computes"] = [c for c in data["computes"] if c["id"] != cid] + [item]
            research_settings.save(settings, data)
            return {
                key: item.get(key, 22 if key == "port" else "")
                for key in ("id", "name", "kind", "host", "port", "identity_file")
            }
        except (ValueError, OSError) as exc:
            raise HTTPException(409, str(exc)) from None
