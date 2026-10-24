# ruff: noqa: F811
"""File definitions: all tests use temporary app data and no model/network calls."""

import base64
import hashlib
import importlib
import io
import shutil
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import select

from backend import agent_files as files, research_repo as repo
from backend.models import MemberLibrary, ResearchWorkspace, TeamMember
from backend.team_members import MemberConfig, config, description
from backend.tests.test_research_team import world, send, deliveries  # noqa: F401
from backend.tests.test_acceptance import env as cloud_env  # noqa: F401
from backend.tests.test_research_routes import env  # noqa: F401

SOURCE = """---
name: Ada
description: Verify evidence
tools: [files, web]
channels: ["#闲聊"]
budget: {turns: 3, tokens: 5000, minutes: 8, future: 42}
future: # keep this comment
  nested: [one, "two"]
---

# Evidence
Keep every citation.
"""


def add(world, source=SOURCE):
    result = world[1].post(world[7] + "/members", json={"source": source})
    assert result.status_code == 200, result.text
    return result.json()["id"]


def path_of(world, mid):
    app, _, _, settings, *_ = world
    with app.state.maker() as d:
        member = d.get(TeamMember, mid)
        return repo.repo_dir(settings, member.workspace_id) / member.file_path


def test_roundtrip_preserves_unknown_fields_comments_and_body():
    values = files.parse(SOURCE)
    values.update(
        name="Ada II", description="New description", role_description="# Revised\n"
    )
    updated = files.render(values, SOURCE)
    assert 'future: # keep this comment\n  nested: [one, "two"]' in updated
    assert files.split(updated)[0]["budget"]["future"] == 42
    assert files.parse(updated)["role_description"] == "# Revised\n"
    assert files.parse(updated)["wake_minutes"] == 8
    assert files.parse(updated)["tools"] == ["files", "web"]


@pytest.mark.parametrize(
    "avatar", ["pixel:中文-seed", ".ora/avatars/ada.png", "future:animal"]
)
def test_avatar_roundtrip_preserves_original_and_legacy_color(avatar):
    source = SOURCE.replace(
        "name: Ada", f'name: Ada\navatar: "{avatar}" # keep avatar\ncolor: amber'
    )
    values = files.parse(source)
    assert values["avatar"] == avatar
    assert (
        files.render(values, source).split("avatar:")[1].splitlines()[0]
        == f' "{avatar}" # keep avatar'
    )
    # Older clients do not know this optional field.
    legacy = MemberConfig(name="Ada").model_dump()
    assert files.parse(files.render(legacy, source))["avatar"] == avatar
    values["avatar"] = "pixel:another"
    updated = files.parse(files.render(values, source))
    assert updated["avatar"] == "pixel:another"
    assert updated["avatar_color"] == "amber"
    values["avatar"] = ""
    assert "avatar:" not in files.render(values, source)
    assert files.parse(SOURCE)["avatar"] == ""


@pytest.mark.parametrize(
    "relative",
    [
        "../outside.png",
        "/tmp/outside.png",
        "a/../../outside.svg",
        r"..\outside.jpg",
        "C:/outside.webp",
        "https://example.com/a.png",
    ],
)
def test_avatar_rejects_non_repository_paths(tmp_path, relative):
    with pytest.raises(ValueError):
        files.avatar_path(tmp_path, relative)
    with pytest.raises(files.DefinitionError) as error:
        files.parse(SOURCE.replace("name: Ada", "name: Ada\navatar: " + relative))
    assert error.value.line == 3


def test_avatar_rejects_symlink_files_and_directories(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "image.png").write_bytes(b"outside")
    (root / "linked").symlink_to(outside, target_is_directory=True)
    (root / "linked.png").symlink_to(outside / "image.png")
    for relative in ("linked/image.png", "linked.png"):
        with pytest.raises(ValueError):
            files.avatar_path(root, relative)
    assert (
        files.avatar_path(root, ".ora/avatars/Ada.PNG") == root / ".ora/avatars/Ada.PNG"
    )


@pytest.mark.parametrize(
    "extension,raw",
    [
        ("png", b"not an image"),
        ("svg", b"not xml"),
        ("svg", b'<html xmlns="http://www.w3.org/1999/xhtml"/>'),
        (
            "svg",
            b'<!DOCTYPE svg [<!ENTITY x "x">]><svg xmlns="http://www.w3.org/2000/svg"/>',
        ),
    ],
)
def test_avatar_rejects_invalid_image_contents(extension, raw):
    from backend.team_members import AvatarUpload

    with pytest.raises(ValueError, match="Invalid avatar image"):
        files.avatar_upload(
            AvatarUpload(extension=extension, content=base64.b64encode(raw).decode())
        )


@pytest.fixture
def avatar_app(tmp_path, monkeypatch):
    """Exercise real team/file routes without models, credentials, sockets or git writes."""
    from fastapi import Depends, FastAPI, Header, HTTPException
    from fastapi.testclient import TestClient
    from backend.config import Settings, database
    from backend.models import Base, User
    from backend import research_team as team
    from backend.research_team_routes import install_team_routes

    settings = Settings(
        database_url="sqlite:///" + str(tmp_path / "avatar.db"),
        storage=str(tmp_path / "files"),
        testing=True,
        mode="local",
    )
    engine, maker = database(settings)
    Base.metadata.create_all(engine)

    def ensure_repo(settings, workspace, **_):
        root = repo.repo_dir(settings, workspace.id)
        (root / ".ora/agents").mkdir(parents=True, exist_ok=True)
        return root

    git = Mock(
        side_effect=lambda _root, *args, **_: SimpleNamespace(
            returncode=1 if args[0] == "diff" else 0, stdout=""
        )
    )
    monkeypatch.setattr(repo, "ensure_repo", ensure_repo)
    monkeypatch.setattr(repo, "git", git)
    monkeypatch.setattr(repo, "available", lambda: False)
    with maker() as d:
        d.add(User(id="owner", username="avatar-owner", password="unused"))
        d.flush()
        d.add(ResearchWorkspace(id="project", owner="owner", name="Avatars"))
        d.commit()

    def db():
        with maker() as d:
            yield d

    def auth(x_owner: str = Header(default="owner")):
        return {"id": x_owner}

    def workspace_of(d, identifier, a):
        workspace = d.get(ResearchWorkspace, identifier)
        if not workspace or workspace.owner != a["id"]:
            raise HTTPException(404)
        return workspace

    app = FastAPI()
    install_team_routes(app, settings, db, auth, workspace_of)
    base = "/api/v1/research/workspaces/project/team"

    @app.get(base)
    def overview(d=Depends(db), a=Depends(auth)):
        result = team.overview(d, workspace_of(d, "project", a))
        d.commit()
        return result

    with TestClient(app) as client:
        yield client, base, repo.repo_dir(settings, "project"), git
    engine.dispose()


@pytest.mark.parametrize("extension", ["png", "jpg", "jpeg", "webp", "svg"])
def test_avatar_save_upload_overview_read_and_isolation(avatar_app, extension):
    from PIL import Image

    client, base, root, git = avatar_app
    if extension == "svg":
        raw = b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>'
    else:
        output = io.BytesIO()
        Image.new("RGB", (2, 2)).save(
            output,
            format={"png": "PNG", "jpg": "JPEG", "jpeg": "JPEG", "webp": "WEBP"}[
                extension
            ],
        )
        raw = output.getvalue()
    result = client.post(
        base + "/members",
        json={
            "source": SOURCE,
            "avatar_upload": {
                "extension": extension,
                "content": base64.b64encode(raw).decode(),
            },
        },
    )
    assert result.status_code == 200, result.text
    member_id = result.json()["id"]
    detail = client.get(base + f"/members/{member_id}").json()
    relative = f".ora/avatars/Ada.{extension}"
    assert detail["avatar"] == relative
    assert detail["avatar_seed"] == "Ada"
    assert (root / relative).read_bytes() == raw
    assert files.parse((root / detail["file_path"]).read_text())["avatar"] == relative
    commit = next(
        call for call in reversed(git.call_args_list) if call.args[1] == "commit"
    )
    assert commit.args[-2:] == (detail["file_path"], relative)
    image = client.get(detail["avatar_url"])
    assert image.status_code == 200 and image.content == raw
    assert image.headers["content-type"] == files.AVATAR_TYPES["." + extension]
    assert "sandbox" in image.headers["content-security-policy"]
    assert (
        client.get(detail["avatar_url"], headers={"X-Owner": "other"}).status_code
        == 404
    )
    overview = client.get(base).json()
    assert (
        next(m for m in overview["members"] if m["id"] == member_id)["avatar"]
        == relative
    )
    assert (
        next(m for m in overview["members"] if m["role"] == "human")["avatar_seed"]
        == "owner"
    )
    assert (
        next(m for m in overview["members"] if m["role"] == "advisor")["avatar_seed"]
        == "advisor"
    )
    # The image endpoint rechecks symlinks even after a valid avatar was saved.
    (root / relative).unlink()
    (root / relative).symlink_to(root / detail["file_path"])
    assert client.get(detail["avatar_url"]).status_code == 404


def test_avatar_edit_upload_and_invalid_upload_leave_current_files(avatar_app):
    client, base, root, _ = avatar_app
    member_id = client.post(base + "/members", json={"source": SOURCE}).json()["id"]
    url = base + f"/members/{member_id}"
    detail = client.get(url).json()
    assert detail["avatar"] == "" and detail["avatar_url"] is None
    raw = b'<svg xmlns="http://www.w3.org/2000/svg"/>'
    upload = {"extension": "svg", "content": base64.b64encode(raw).decode()}
    assert (
        client.patch(
            url,
            json={
                "source": detail["source"].replace("name: Ada", "name: Ada II"),
                "revision": detail["revision"],
                "avatar_upload": upload,
            },
        ).status_code
        == 200
    )
    saved = client.get(url).json()
    assert saved["avatar"] == ".ora/avatars/Ada II.svg"
    assert (root / saved["avatar"]).read_bytes() == raw
    assert (
        client.patch(
            url, json={"avatar_upload": {"extension": "svg", "content": "broken"}}
        ).status_code
        == 422
    )
    assert client.get(url).json()["source"] == saved["source"]
    assert (root / saved["avatar"]).read_bytes() == raw
    assert (
        client.patch(
            url, json={"source": saved["source"].replace(saved["avatar"], "pixel:new")}
        ).status_code
        == 200
    )
    changed = client.get(url).json()
    assert changed["avatar"] == "pixel:new" and changed["avatar_url"] is None
    assert client.get(url + "/avatar").status_code == 404


def test_avatar_upload_uses_the_configured_upload_request_limit(cloud_env):
    _, client, _, settings = cloud_env
    settings.upload_limit = 3 * 1024 * 1024
    path = "/api/v1/research/workspaces/project/team/members"
    body = {"source": "x" * (2 * 1024 * 1024)}
    assert client.post(path, json=body).status_code == 413
    # Validation or authorization may fail, but an image-sized save reaches the route.
    assert (
        client.post(path, json=body, headers={"X-Avatar-Upload": "1"}).status_code
        != 413
    )
    assert (
        client.post(
            path + "/agent/avatar", json=body, headers={"X-Avatar-Upload": "1"}
        ).status_code
        == 413
    )
    body["source"] = "x" * (7 * 1024 * 1024)
    assert (
        client.post(path, json=body, headers={"X-Avatar-Upload": "1"}).status_code
        == 413
    )


def test_avatar_sandbox_policy_survives_application_middleware(cloud_env):
    from fastapi.responses import Response

    app, client, _, _ = cloud_env

    @app.get("/test-avatar-policy")
    def image():
        return Response(
            headers={"Content-Security-Policy": "sandbox; default-src 'none'"}
        )

    # Ahead of the frontend's catch-all route, as the real avatar route is.
    app.router.routes.insert(0, app.router.routes.pop())

    assert (
        client.get("/test-avatar-policy").headers["content-security-policy"]
        == "sandbox; default-src 'none'"
    )


@pytest.mark.parametrize(
    "source,line",
    [
        ("name: Ada\n", 1),
        ("---\nname: Ada\n", 2),
        ("---\nname: [\n---\n", 3),
        ("---\nname: Ada\ntools: Bash\n---\n", 3),
        ("---\nname: Ada\nname: Bob\n---\n", 3),
        ("---\nname: Ada\nbudget: {turns: true}\n---\n", 3),
        ("---\nname: ../Ada\n---\n", 2),
        ("---\nname: Ada\nenabled: no\n---\n", 3),
    ],
)
def test_format_errors_have_lines(source, line):
    with pytest.raises(files.DefinitionError) as error:
        files.parse(source)
    assert error.value.line == line


def test_external_dirty_and_committed_edits_refresh_pages_wakes_and_permissions(world):
    app, a, _, settings, _, _, wid, base, _ = world
    mid = add(world)
    path = path_of(world, mid)
    source = (
        path.read_text()
        .replace("Verify evidence", "External description")
        .replace("# Evidence", "# External body")
    )
    path.write_text(source)
    detail = a.get(base + f"/members/{mid}").json()
    assert (
        detail["description"] == "External description"
        and "# External body" in detail["role_description"]
    )
    assert detail["source"] == source
    assert detail["subscriptions"]
    # SQL fields are an archive, never a second definition source.
    with app.state.maker() as d:
        member = d.get(TeamMember, mid)
        member.legacy_role_description = "Wrong SQL definition"
        member.legacy_permissions = {
            "papers": True,
            "files": False,
            "commands": True,
            "machines": [],
            "readonly": False,
        }
        d.commit()
    repo.git(path.parents[2], "add", "--", str(path.relative_to(path.parents[2])))
    repo.git(path.parents[2], "commit", "-qm", "external edit")
    (repo.repo_dir(settings, wid) / "AGENTS.md").write_text(
        "# Shared\nEvery member reads this."
    )
    send(world, "@Ada check")
    with app.state.maker() as d:
        from backend.models import AgentRun

        run = d.get(AgentRun, deliveries(app)[0].run_id)
        assert (
            "# External body" in run.context
            and "Every member reads this." in run.context
        )
        member = d.get(TeamMember, mid)
        from backend.team_members import allowed

        assert allowed(member, {"name": "read"})
        assert not allowed(member, {"name": "bash"})
        assert member.wake_turns == 3 and member.wake_tokens == 5000


def test_invalid_external_file_keeps_last_valid_across_sessions_and_repair(world):
    _, a, _, _, _, _, _, base, _ = world
    mid = add(world)
    path = path_of(world, mid)
    path.write_text("---\nname: Ada\ntools: broken\n---\nBAD")
    for _ in range(2):
        detail = a.get(base + f"/members/{mid}").json()
        assert "Line 3" in detail["file_error"]
        assert detail["role_description"].startswith("# Evidence")
        assert "tools: broken" in detail["source"]
    result = a.patch(
        base + f"/members/{mid}",
        json={"source": SOURCE, "revision": detail["revision"]},
    )
    assert result.status_code == 200, result.text
    assert not a.get(base + f"/members/{mid}").json()["file_error"]


def test_save_renames_and_commits_only_agent_with_actor_and_checks_revision(world):
    _, a, _, settings, owner, _, wid, base, _ = world
    mid = add(world)
    detail = a.get(base + f"/members/{mid}").json()
    root = repo.repo_dir(settings, wid)
    (root / "unrelated.txt").write_text("do not commit")
    repo.git(root, "add", "unrelated.txt")
    source = detail["source"].replace("name: Ada", "name: New Ada")
    result = a.patch(
        base + f"/members/{mid}",
        json={"source": source, "revision": detail["revision"]},
    )
    assert result.status_code == 200, result.text
    assert not (root / ".ora/agents/Ada.md").exists()
    assert (root / ".ora/agents/New Ada.md").read_text() == source
    log = repo.git(root, "log", "-1", "--format=%s").stdout
    assert owner in log and "New Ada" in log
    assert (
        "unrelated.txt"
        not in repo.git(root, "show", "--format=", "--name-only", "HEAD").stdout
    )
    assert (
        a.patch(
            base + f"/members/{mid}",
            json={"source": source, "revision": detail["revision"]},
        ).status_code
        == 422
    )


def test_builtin_files_are_copied_and_can_restore(world):
    _, a, _, settings, _, _, wid, base, overview = world
    for member in overview["members"]:
        if member["role"] == "human":
            continue
        path = path_of(world, member["id"])
        assert path.is_file()
        original = (files.BUILTINS / (member["role"] + ".md")).read_bytes()
        assert path.read_bytes() == original
        record = repo.repo_dir(settings, wid) / files.builtin_record(
            SimpleNamespace(role=member["role"])
        )
        assert record.read_text().strip() == hashlib.sha256(original).hexdigest()
    builtin = next(m for m in overview["members"] if m["role"] == "librarian")
    mid = builtin["id"]
    assert a.patch(base + f"/members/{mid}", json={"source": SOURCE}).status_code == 200
    assert (
        a.patch(base + f"/members/{mid}", json={"restore_builtin": True}).status_code
        == 200
    )
    assert a.get(base + f"/members/{mid}").json()["name"] == "文献员"
    assert (
        path_of(world, mid).read_bytes()
        == (files.BUILTINS / "librarian.md").read_bytes()
    )


def historical_builtin(role, with_length_rule=False):
    source = (files.BUILTINS / f"{role}.md").read_text()
    source = source.replace("`wake`", "`to`")
    if not with_length_rule:
        source = source.replace(
            "Match the requested response length (one sentence when asked for one), "
            "adding brief verification details only when requested or necessary.\n\n",
            "",
        )
    return source


def test_builtin_hashes_cover_all_shipped_versions_and_generated_copies():
    for role, hashes in files.BUILTIN_HASHES.items():
        current = (files.BUILTINS / f"{role}.md").read_text()
        for source in (
            current,
            historical_builtin(role),
            historical_builtin(role, True),
        ):
            values = files.parse(source, role)
            for copy in (
                source,
                files.render(values, role=role),
                files.render(values, source, role),
            ):
                assert hashlib.sha256(copy.encode()).hexdigest() in hashes


@pytest.mark.parametrize("renamed", [False, True])
def test_builtin_record_auto_updates_and_commits_only_its_files(
    world, tmp_path, monkeypatch, renamed
):
    app, a, _, settings, _, _, wid, base, overview = world
    member = next(m for m in overview["members"] if m["role"] == "librarian")
    path = path_of(world, member["id"])
    bundled = tmp_path / "bundled"
    shutil.copytree(files.BUILTINS, bundled)
    monkeypatch.setattr(files, "BUILTINS", bundled)
    root = repo.repo_dir(settings, wid)
    (root / "unrelated.txt").write_text("leave staged")
    repo.git(root, "add", "--", "unrelated.txt")
    with app.state.maker() as d:
        row = d.get(TeamMember, member["id"])
        original = files.read_member(row)[0]
        # Neither new bundle is in the historical list: the recorded hash is enough.
        for rule in ("First new rule.", "Second new rule."):
            updated = original + "\n" + rule + "\n"
            if renamed:
                updated = updated.replace("name: 文献员", "name: 新文献员")
            (bundled / "librarian.md").write_text(updated)
            assert files.read_member(row)[0] == updated
            old_path, path = path, root / row.file_path
            if old_path != path:
                assert not old_path.exists()
            assert path.read_bytes() == updated.encode()
            record = root / files.builtin_record(row)
            assert (
                record.read_text().strip()
                == hashlib.sha256(updated.encode()).hexdigest()
            )
            assert (
                repo.git(root, "log", "-1", "--format=%s").stdout.strip()
                == f"更新内置成员 {files.parse(updated)['name']}"
            )
            changed = repo.git(
                root, "show", "--format=", "--no-renames", "--name-only", "HEAD"
            ).stdout.splitlines()
            expected = {row.file_path, files.builtin_record(row)}
            if old_path != path:
                expected.add(str(old_path.relative_to(root)))
            assert set(changed) == expected
            assert not getattr(row, "_file_error", "")
            assert files.state_path(settings, row.id).read_text() == updated
            head = repo.git(root, "rev-parse", "HEAD").stdout
            assert files.read_member(row)[0] == updated
            assert repo.git(root, "rev-parse", "HEAD").stdout == head
        d.commit()
        assert not a.get(base + f"/members/{row.id}").json()["builtin_update_available"]
    assert (
        repo.git(root, "diff", "--cached", "--name-only").stdout.strip()
        == "unrelated.txt"
    )


@pytest.mark.parametrize("copy_style", ["original", "initialized", "restored"])
def test_builtin_legacy_copies_without_record_auto_update(world, copy_style):
    _, a, _, settings, _, _, wid, base, overview = world
    root = repo.repo_dir(settings, wid)
    for member in overview["members"]:
        role = member["role"]
        if role == "human":
            continue
        source = historical_builtin(role)
        if copy_style != "original":
            source = files.render(
                files.parse(source, role),
                source if copy_style == "restored" else "",
                role,
            )
        path = path_of(world, member["id"])
        path.write_bytes(source.encode())
        record = files.builtin_record(SimpleNamespace(role=role))
        (root / record).unlink()
        repo.git(root, "add", "--", member["file_path"], record)
        repo.git(root, "commit", "-q", "-m", "Old built-in fixture")
        result = a.get(base + f"/members/{member['id']}")
        assert result.status_code == 200, result.text
        assert path.read_bytes() == (files.BUILTINS / f"{role}.md").read_bytes()
        assert not result.json()["builtin_update_available"]
        assert (
            repo.git(root, "log", "-1", "--format=%s").stdout.strip()
            == f"更新内置成员 {member['name']}"
        )


@pytest.mark.parametrize("recorded", [False, True])
@pytest.mark.parametrize("change", ["body", "name", "avatar", "newline"])
def test_builtin_user_edits_are_preserved_until_explicit_restore(
    world, tmp_path, monkeypatch, recorded, change
):
    _, a, _, settings, _, _, wid, base, overview = world
    member = next(m for m in overview["members"] if m["role"] == "librarian")
    mid = member["id"]
    path = path_of(world, mid)
    if change == "newline":
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
    else:
        body = (
            {"source": path.read_text() + "\nMy instructions.\n"}
            if change == "body"
            else {
                "config": {
                    **{key: member[key] for key in MemberConfig.model_fields},
                    change: "Ada" if change == "name" else "pixel:custom",
                }
            }
        )
        result = a.patch(base + f"/members/{mid}", json=body)
        assert result.status_code == 200, result.text
        path = path_of(world, mid)
    customized = path.read_bytes()
    assert not a.get(base + f"/members/{mid}").json()["builtin_update_available"]
    root = repo.repo_dir(settings, wid)
    record = root / files.builtin_record(SimpleNamespace(role="librarian"))
    if not recorded:
        record.unlink()
    bundled = tmp_path / "bundled"
    shutil.copytree(files.BUILTINS, bundled)
    new_source = (bundled / "librarian.md").read_bytes() + b"\nNew bundled rule.\n"
    (bundled / "librarian.md").write_bytes(new_source)
    monkeypatch.setattr(files, "BUILTINS", bundled)
    head = repo.git(root, "rev-parse", "HEAD").stdout
    result = a.get(base + f"/members/{mid}")
    assert result.status_code == 200, result.text
    assert result.json()["builtin_update_available"]
    assert path.read_bytes() == customized
    assert repo.git(root, "rev-parse", "HEAD").stdout == head
    result = a.patch(
        base + f"/members/{mid}",
        json={"restore_builtin": True, "revision": result.json()["revision"]},
    )
    assert result.status_code == 200, result.text
    assert path_of(world, mid).read_bytes() == new_source
    assert record.read_text().strip() == hashlib.sha256(new_source).hexdigest()
    assert not a.get(base + f"/members/{mid}").json()["builtin_update_available"]


def test_builtin_auto_update_rechecks_file_under_repo_lock(
    world, tmp_path, monkeypatch
):
    app, _, _, settings, _, _, wid, _, overview = world
    member = next(m for m in overview["members"] if m["role"] == "librarian")
    path = path_of(world, member["id"])
    customized = path.read_text() + "\nConcurrent edit.\n"
    bundled = tmp_path / "bundled"
    shutil.copytree(files.BUILTINS, bundled)
    (bundled / "librarian.md").write_text(path.read_text() + "\nNew bundled rule.\n")
    monkeypatch.setattr(files, "BUILTINS", bundled)
    locked = repo._locked

    @contextmanager
    def edit_before_lock(*args, **kwargs):
        path.write_text(customized)
        with locked(*args, **kwargs):
            yield

    monkeypatch.setattr(repo, "_locked", edit_before_lock)
    root = repo.repo_dir(settings, wid)
    head = repo.git(root, "rev-parse", "HEAD").stdout
    with app.state.maker() as d:
        row = d.get(TeamMember, member["id"])
        assert files.read_member(row)[0] == customized
    assert path.read_text() == customized
    assert repo.git(root, "rev-parse", "HEAD").stdout == head


def test_external_library_and_team_files_are_discovered(world):
    app, a, _, settings, owner, _, wid, base, _ = world
    library = files.library_root(settings, owner)
    library.mkdir(parents=True, exist_ok=True)
    (library / "Ada.md").write_text(SOURCE)
    rows = a.get(base + "/library").json()
    assert len(rows) == 1 and rows[0]["config"]["name"] == "Ada"
    result = a.post(base + "/members", json={"library_id": rows[0]["id"]})
    assert result.status_code == 200, result.text
    path = repo.repo_dir(settings, wid) / ".ora/agents/Bob.md"
    path.write_text(SOURCE.replace("name: Ada", "name: Bob"))
    members = a.get(base).json()["members"]
    bob = next(m for m in members if m["name"] == "Bob")
    assert not bob["builtin"]
    assert a.delete(base + f"/members/{bob['id']}").status_code == 200
    assert not any(
        m["id"] == bob["id"] and not m["deleted"] for m in a.get(base).json()["members"]
    )


def test_library_sync_keeps_external_team_overrides_and_unknown_fields(world):
    _, a, _, settings, owner, _, _, base, _ = world
    mid = add(world)
    row = a.get(base + "/library").json()[0]
    path = path_of(world, mid)
    path.write_text(
        path.read_text()
        .replace("Keep every citation.", "Team owns this body.")
        .replace("[one,", "[team,")
    )
    source = (
        row["source"]
        .replace("Verify evidence", "From library")
        .replace("turns: 3", "turns: 7")
    )
    result = a.patch(
        base + f"/library/{row['id']}",
        json={
            "source": source,
            "version": row["version"],
            "revision": row["revision"],
            "sync": True,
        },
    )
    assert result.status_code == 200, result.text
    detail = a.get(base + f"/members/{mid}").json()
    assert detail["description"] == "From library" and detail["wake_turns"] == 7
    assert (
        "Team owns this body." in detail["role_description"]
        and "[team," in detail["source"]
    )
    assert (
        files.parse((files.library_root(settings, owner) / "Ada.md").read_text())[
            "description"
        ]
        == "From library"
    )


@pytest.mark.parametrize(
    "filename,source",
    [
        (
            "checker.md",
            "---\nname: Checker\ndescription: Check\ntools: Read, Grep, Glob, Bash, WebFetch, FutureTool\nfuture: true\n---\n\nCheck it.",
        ),
        (
            "checker.toml",
            'description = "Check"\ndeveloper_instructions = "Check it."\nfuture = { value = 42 }\n',
        ),
    ],
)
def test_import_both_formats_and_api(world, filename, source):
    _, a, _, _, _, _, _, base, _ = world
    result = a.post(
        base + "/import-agent", json={"source": source, "filename": filename}
    )
    assert result.status_code == 200, result.text
    document = result.json()
    assert document["config"]["role_description"] == "Check it."
    assert "future" in document["source"]
    if filename.endswith(".md"):
        assert document["config"]["tools"] == ["files", "shell", "web", "FutureTool"]
        assert document["config"]["permissions"]["file_readonly"]
        assert not document["config"]["permissions"]["readonly"]
        assert document["warnings"] == ["未知工具 / Unknown tool: FutureTool"]
    mid = add(world, document["source"])
    assert a.get(base + f"/members/{mid}").json()["role_description"] == "Check it."


def test_form_source_conversion_retains_unknown_fields(world):
    _, a, _, _, _, _, _, base, _ = world
    parsed = a.post(base + "/agent-document", json={"source": SOURCE}).json()
    values = {k: parsed["config"][k] for k in MemberConfig.model_fields}
    values.update(description="Form edit", role_description="# New body")
    result = a.post(
        base + "/agent-document",
        json={"source": SOURCE, "config": values, "channels": ["#综述"]},
    )
    assert result.status_code == 200, result.text
    updated = result.json()
    assert "# keep this comment" in updated["source"]
    assert updated["config"]["channels"] == ["#综述"]
    assert updated["config"]["description"] == "Form edit"
    assert a.post(base + "/agent-document", json={"source": "bad"}).status_code == 422


def test_project_md_is_renamed_unchanged_once_and_shared_by_all_members(world):
    app, _, _, settings, _, _, wid, _, overview = world
    root = repo.repo_dir(settings, wid)
    (root / "AGENTS.md").unlink()
    content = b"# Legacy\r\nExact legacy instructions.\r\n"
    (root / "PROJECT.md").write_bytes(content)
    repo.git(root, "add", "-A")
    repo.git(root, "commit", "-qm", "legacy instructions")
    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, wid)
        repo.ensure_repo(settings, workspace)
        once = repo.head(root)
        repo.ensure_repo(settings, workspace)
        assert repo.head(root) == once
        assert not (root / "PROJECT.md").exists()
        assert (root / "AGENTS.md").read_bytes() == content
        for member in d.scalars(
            select(TeamMember).where(
                TeamMember.workspace_id == wid, TeamMember.role != "human"
            )
        ):
            assert "Exact legacy instructions." in description(member)


def test_migration_exports_legacy_library_team_overrides_and_is_idempotent(world):
    app, _, _, settings, owner, _, wid, _, _ = world
    with app.state.maker() as d:
        library = MemberLibrary(
            owner=owner,
            config=MemberConfig(
                name="Legacy", role_description="Original body"
            ).model_dump(),
        )
        d.add(library)
        d.flush()
        member = TeamMember(
            workspace_id=wid,
            role="custom_legacy",
            name="Legacy",
            role_description="Team body",
            library_id=library.id,
            permissions={
                "papers": False,
                "files": True,
                "commands": False,
                "machines": ["host"],
                "readonly": True,
            },
            wake_turns=4,
            wake_tokens=6000,
            enabled=False,
        )
        d.add(member)
        d.flush()
        files.export_all(d)
        path = repo.repo_dir(settings, wid) / member.file_path
        assert files.parse(path.read_text())["role_description"] == "Team body"
        assert not member.enabled and member.wake_tokens == 6000
        assert config(member)["permissions"]["readonly"]
        assert "role_description" in member.overrides
        assert files.read_library(library)[1]["role_description"] == "Original body"
        before = repo.head(path.parents[2])
        files.export_all(d)
        assert repo.head(path.parents[2]) == before
        assert member.legacy_role_description == "Team body"
        d.commit()
    migration = importlib.import_module("backend.migrations.versions.0047_agent_files")
    assert migration.down_revision == "0046"


def test_symlinks_cannot_read_or_write_outside_agent_roots(world, tmp_path):
    _, a, _, _, _, _, _, base, _ = world
    mid = add(world)
    path = path_of(world, mid)
    external = tmp_path / "private.md"
    external.write_text(SOURCE.replace("# Evidence", "# Private"))
    path.unlink()
    path.symlink_to(external)
    detail = a.get(base + f"/members/{mid}").json()
    assert "# Private" not in detail["role_description"]
    assert detail["file_error"]
    assert a.patch(base + f"/members/{mid}", json={"source": SOURCE}).status_code == 422
    assert "# Private" in external.read_text()


def test_0047_schema_upgrade_exports_on_selected_data_directory_and_downgrades(
    tmp_path,
):
    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from backend.config import Settings, database
    from backend.models import Base, User

    settings = Settings(
        storage=str(tmp_path / "files"),
        database_url="sqlite:///" + str(tmp_path / "migration.db"),
        mode="local",
    )
    engine, maker = database(settings)
    Base.metadata.create_all(engine)
    with maker(info={}) as d:
        owner = User(username="migration", password="unused")
        d.add(owner)
        d.flush()
        workspace = ResearchWorkspace(owner=owner.id, name="Legacy project")
        d.add(workspace)
        d.flush()
        library = MemberLibrary(
            owner=owner.id,
            config=MemberConfig(
                name="Imported", role_description="Library archive"
            ).model_dump(),
        )
        d.add(library)
        d.flush()
        member = TeamMember(
            workspace_id=workspace.id,
            role="custom_old",
            name="Imported",
            role_description="Team archive",
            library_id=library.id,
        )
        d.add(member)
        d.flush()
        mid, lid, wid = member.id, library.id, workspace.id
        d.commit()
    migration = importlib.import_module("backend.migrations.versions.0047_agent_files")
    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.commit()
        with connection.begin():
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
        connection.info["ora_settings"] = settings
        with connection.begin():
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
                migration.upgrade()
            team_path = connection.execute(
                sa.text("SELECT file_path FROM team_members WHERE id=:id"), {"id": mid}
            ).scalar_one()
            library_path = connection.execute(
                sa.text("SELECT file_path FROM member_library WHERE id=:id"),
                {"id": lid},
            ).scalar_one()
            assert team_path and library_path
        assert (
            files.parse((repo.repo_dir(settings, wid) / team_path).read_text())[
                "role_description"
            ]
            == "Team archive"
        )
        assert (
            files.parse((tmp_path / "agents" / library_path).read_text())[
                "role_description"
            ]
            == "Library archive"
        )
        with connection.begin():
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
        assert "file_path" not in {
            c["name"] for c in sa.inspect(connection).get_columns("team_members")
        }
        assert (repo.repo_dir(settings, wid) / team_path).exists()
    engine.dispose()


def test_shared_instruction_editor_writes_file_and_external_changes_reach_briefs(world):
    app, a, _, settings, _, _, wid, base, overview = world
    result = a.patch(
        f"/api/v1/research/workspaces/{wid}",
        json={"instructions": "Team instructions from editor"},
    )
    assert result.status_code == 200, result.text
    root = repo.repo_dir(settings, wid)
    assert (root / "AGENTS.md").read_text() == "Team instructions from editor"
    (root / "AGENTS.md").write_text("External team instructions")
    assert (
        a.get(f"/api/v1/research/workspaces/{wid}").json()["instructions"]
        == "External team instructions"
    )
    from backend.research_chat import overview as brief

    with app.state.maker() as d:
        workspace = d.get(ResearchWorkspace, wid)
        text = brief(d, workspace)
        assert "External team instructions" in text
        assert "Team instructions from editor" not in text
        for member in d.scalars(
            select(TeamMember).where(
                TeamMember.workspace_id == wid, TeamMember.role != "human"
            )
        ):
            assert "External team instructions" in description(member)


def test_source_is_authoritative_even_when_legacy_client_sends_subscription_ids(world):
    _, a, _, _, _, _, _, base, _ = world
    source = SOURCE.replace('["#闲聊"]', '["#Future channel"]')
    mid = add(world, source)
    result = a.patch(
        base + f"/members/{mid}", json={"source": source, "subscriptions": []}
    )
    assert result.status_code == 200, result.text
    assert "#Future channel" in a.get(base + f"/members/{mid}").json()["source"]


def test_cumulative_budget_is_read_from_file_and_legacy_budget_is_archived(world):
    app, a, _, _, _, _, _, base, _ = world
    mid = add(world)
    path = path_of(world, mid)
    values = files.parse(path.read_text())
    values["max_tokens"] = 12345
    path.write_text(files.render(values, path.read_text()))
    with app.state.maker() as d:
        member = d.get(TeamMember, mid)
        member.legacy_max_tokens = 99999
        d.commit()
        assert member.max_tokens == 12345
        assert member.wake_minutes == 8
    assert a.get(base + f"/members/{mid}").json()["max_tokens"] == 12345


def test_file_model_name_resolves_to_configured_model_without_model_call(world):
    app, a, _, settings, owner, model_id, _, base, _ = world
    from backend.translation_settings import read_store
    from backend.models import AgentRun

    model = next(
        row for row in read_store(settings, owner)["models"] if row["id"] == model_id
    )["model"]
    mid = add(world, SOURCE.replace("name: Ada", f"name: Ada\nmodel: {model}"))
    send(world, "@Ada use configured model")
    with app.state.maker() as d:
        member = d.get(TeamMember, mid)
        assert member.model_config_id == model_id
        assert d.get(AgentRun, deliveries(app)[0].run_id).model_config_id == model_id


def test_new_definitions_are_not_copied_back_into_legacy_database_fields(world):
    app, _, _, _, _, _, _, _, _ = world
    mid = add(world)
    with app.state.maker() as d:
        member = d.get(TeamMember, mid)
        library = d.get(MemberLibrary, member.library_id)
        assert library.legacy_config == {}
        assert member.legacy_role_description == ""
        assert member.legacy_permissions == {}
        assert files.read_member(member)[1]["role_description"].startswith("# Evidence")


def test_editor_can_rename_an_external_untracked_member_file(world):
    _, a, _, settings, _, _, wid, base, _ = world
    root = repo.repo_dir(settings, wid)
    path = root / ".ora/agents/External.md"
    path.write_text(SOURCE.replace("name: Ada", "name: External"))
    member = next(m for m in a.get(base).json()["members"] if m["name"] == "External")
    result = a.patch(
        base + f"/members/{member['id']}",
        json={"source": path.read_text().replace("name: External", "name: Renamed")},
    )
    assert result.status_code == 200, result.text
    assert not path.exists()
    assert (root / ".ora/agents/Renamed.md").exists()
    assert (
        ".ora/agents/Renamed.md"
        in repo.git(root, "show", "--format=", "--name-only", "HEAD").stdout
    )


def test_source_editor_uses_the_members_role_when_tools_are_omitted(world):
    _, a, _, _, _, _, _, base, _ = world
    source = "---\nname: Executor\n---\n\nRun experiments."
    result = a.post(
        base + "/agent-document", json={"source": source, "role": "executor"}
    )
    assert result.status_code == 200, result.text
    assert "shell" in result.json()["config"]["tools"]
    assert result.json()["config"]["permissions"]["commands"]
    fields = {k: result.json()["config"][k] for k in MemberConfig.model_fields}
    converted = a.post(
        base + "/agent-document",
        json={"source": source, "role": "executor", "config": fields},
    )
    assert converted.status_code == 200, converted.text
    assert "shell" in converted.json()["config"]["tools"]


def test_wake_token_cap_is_optional():
    plain = files.parse("---\nname: Ada\n---\n\nHi")
    assert plain["wake_tokens"] == 0
    source = files.render({**plain, "wake_tokens": 50000}, "---\nname: Ada\n---\n\nHi")
    assert files.parse(source)["wake_tokens"] == 50000
    cleared = files.render({**plain, "wake_tokens": 0}, source)
    assert "tokens:" not in cleared.replace("total_tokens:", "")
    assert files.parse(cleared)["wake_tokens"] == 0
