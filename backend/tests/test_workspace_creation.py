"""Project admission and folder creation, without Git, models, network or SSH."""

import asyncio
import io
import json
import shlex
import socket
import subprocess
from contextlib import redirect_stdout
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from backend import agent_files, research_repo, research_sandbox, research_team
from backend import research_locations as loc
from backend.config import Settings, database
from backend.models import Base, User
from backend.research_routes import install_research_routes


@pytest.fixture
def project_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))

    def forbidden(*args, **kwargs):
        pytest.fail("This test must not execute subprocesses or Git")

    monkeypatch.setattr(subprocess, "run", forbidden)
    monkeypatch.setattr(research_repo, "git", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    return home


@pytest.mark.parametrize(
    "path,reason",
    [
        ("/", "root"),
        ("//", "root"),
        ("/usr/..", "root"),
        *((path, "system") for path in loc.SYSTEM_FOLDERS),
        ("~", "home"),
        ("~/", "home"),
        ("~/ORA/..", "home"),
        *((f"~/{name}", "personal") for name in loc.HOME_FOLDERS),
        ("~/ORA/.git/objects", "git"),
    ],
)
def test_workspace_creation_rejects_protected_local_and_ssh_paths(
    project_home, path, reason
):
    assert loc.project_folder_error(path) == reason
    with pytest.raises(ValueError, match=loc.FOLDER_ERRORS[reason]):
        loc.validate_location(None, {"kind": "local", "path": path})
    # Known remote roots are rejected before looking up a connection or executing SSH.
    with pytest.raises(ValueError, match=loc.FOLDER_ERRORS[reason]):
        loc.validate_location(
            None, {"kind": "ssh", "path": path, "connection_id": "unused"}
        )


def test_workspace_creation_default_parent_and_new_folder(project_home):
    listing = loc.folders(None, "local")
    parent = project_home / "ORA"
    assert parent.is_dir() and listing["path"] == str(parent)
    assert listing["project_error"] == ""
    assert list(parent.iterdir()) == []
    location = loc.validate_location(
        None, {"kind": "local", "path": str(parent)}, create_folder="未命名项目"
    )
    assert location["path"] == str(parent / "未命名项目")
    assert list((parent / "未命名项目").iterdir()) == []
    with pytest.raises(ValueError, match="已存在"):
        loc.validate_location(
            None, {"kind": "local", "path": str(parent)}, create_folder="未命名项目"
        )
    assert loc.folders(None, "local")["entries"] == [
        {"name": "未命名项目", "path": location["path"]}
    ]


@pytest.mark.parametrize(
    "name", [".", "..", "../Desktop", "a/b", "a\\b", "a\0b", "a\nb"]
)
def test_workspace_creation_rejects_folder_name_traversal(project_home, name):
    for kind in ("local", "ssh"):
        with pytest.raises(ValueError, match="名称不合法"):
            loc.validate_location(
                None, {"kind": kind, "path": str(project_home)}, create_folder=name
            )
    assert list(project_home.iterdir()) == []


def test_workspace_creation_resolves_aliases_and_allows_project_subfolders(
    project_home,
):
    desktop = project_home / "Desktop"
    desktop.mkdir()
    alias = project_home / "alias"
    alias.symlink_to(desktop, target_is_directory=True)
    with pytest.raises(ValueError, match="个人目录"):
        loc.validate_location(None, {"kind": "local", "path": str(alias)})
    assert loc.folders(None, "local", str(alias))["project_error"] == "personal"
    assert loc.folders(None, "local", str(project_home))["project_error"] == "home"
    child = loc.validate_location(
        None, {"kind": "local", "path": str(desktop)}, create_folder="My project"
    )
    assert loc.validate_location(None, child) == child
    # A dangling link must not cause mkdir to follow it outside the selected parent.
    outside = project_home / "outside"
    (desktop / "linked").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="已存在"):
        loc.validate_location(
            None, {"kind": "local", "path": str(desktop)}, create_folder="linked"
        )
    assert not outside.exists()
    for name in loc.HOME_FOLDERS:
        with pytest.raises(ValueError, match="个人目录"):
            loc.validate_location(
                None, {"kind": "local", "path": str(project_home)}, create_folder=name
            )


@pytest.fixture
def remote_machine(project_home, monkeypatch):
    """Execute only the remote Python script in-process, against a temporary HOME."""
    item = {"kind": "ssh", "id": "lab", "host": "unused"}
    monkeypatch.setattr(loc, "connection", lambda *args: item)

    def run_script(args, **kwargs):
        assert args[0] == "ssh"  # The argv is inspected, never launched.
        script = shlex.split(args[-1])[-1]
        output = io.StringIO()
        monkeypatch.setattr("sys.stdin", io.StringIO(kwargs["input"]))
        try:
            with redirect_stdout(output):
                exec(compile(script, "<remote-folder-script>", "exec"), {})
        except (ValueError, OSError) as exc:
            return subprocess.CompletedProcess(args, 1, "", str(exc))
        return subprocess.CompletedProcess(args, 0, output.getvalue(), "")

    monkeypatch.setattr(research_sandbox, "run", run_script)
    return item


def test_workspace_creation_remote_home_alias_and_default_parent(
    project_home, remote_machine
):
    listing = loc.folders(None, "ssh", connection_id="lab")
    assert listing["path"] == str(project_home / "ORA")
    assert listing["project_error"] == ""
    for path in (str(project_home), str(project_home / "ORA/..")):
        with pytest.raises(ValueError, match="主目录"):
            loc.validate_location(
                None, {"kind": "ssh", "path": path, "connection_id": "lab"}
            )
        assert loc.folders(None, "ssh", path, "lab")["project_error"] == "home"
    for protected in loc.SYSTEM_FOLDERS:
        alias = project_home / "system-alias"
        alias.symlink_to(protected, target_is_directory=True)
        with pytest.raises(ValueError, match="系统目录|不存在"):
            loc.validate_location(
                None, {"kind": "ssh", "path": str(alias), "connection_id": "lab"}
            )
        alias.unlink()
    location = loc.validate_location(
        None,
        {"kind": "ssh", "path": listing["path"], "connection_id": "lab"},
        create_folder="remote project",
    )
    assert location == {
        "kind": "ssh",
        "path": str(project_home / "ORA/remote project"),
        "connection_id": "lab",
    }
    with pytest.raises(ValueError, match="已存在"):
        loc.validate_location(
            None,
            {"kind": "ssh", "path": listing["path"], "connection_id": "lab"},
            create_folder="remote project",
        )


@pytest.mark.parametrize("kind", ["local", "ssh"])
def test_workspace_creation_default_parent_cannot_alias_home(
    project_home, remote_machine, kind
):
    (project_home / "ORA").symlink_to(project_home, target_is_directory=True)
    with pytest.raises(ValueError, match="主目录"):
        loc.folders(None, kind, connection_id="lab")


def test_workspace_creation_api(project_home, tmp_path, monkeypatch):
    settings = Settings(
        database_url="sqlite:///" + str(tmp_path / "db.sqlite"),
        storage=str(tmp_path / "files"),
        testing=True,
        mode="local",
    )
    engine, maker = database(settings)
    Base.metadata.create_all(engine)
    with maker() as d:
        user = User(username="user", password="unused")
        d.add(user)
        d.commit()
        uid = user.id

    def db():
        with maker() as d:
            yield d

    # Team initialization is outside this test; it writes private Git history.
    monkeypatch.setattr(research_team, "ensure", lambda *args: None)
    monkeypatch.setattr(agent_files, "workspace_instructions", lambda *args: "")
    app = FastAPI()
    install_research_routes(
        app, settings, db, lambda: {"id": uid}, lambda a: None, None
    )

    async def requests():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            parent = (await client.get("/api/v1/research/folders")).json()["path"]
            for path in ("/", str(project_home), str(project_home / "Desktop")):
                result = await client.post(
                    "/api/v1/research/workspaces",
                    json={
                        "name": "Unsafe",
                        "location": {"kind": "local", "path": path},
                    },
                )
                assert result.status_code == 422 and "不能用" in result.json()["detail"]
            body = {
                "name": "New project",
                "location": {"kind": "local", "path": parent},
                "create_folder": True,
            }
            result = await client.post("/api/v1/research/workspaces", json=body)
            assert result.status_code == 200, result.text
            assert result.json()["location"]["path"] == str(Path(parent) / body["name"])
            assert (
                await client.post("/api/v1/research/workspaces", json=body)
            ).status_code == 422
            body["name"] = "   "
            assert (
                await client.post("/api/v1/research/workspaces", json=body)
            ).status_code == 422

    try:
        asyncio.run(requests())
    finally:
        engine.dispose()
