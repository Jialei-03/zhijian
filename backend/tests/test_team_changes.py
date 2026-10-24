"""Local git and SQLite only; repositories live exclusively under tmp_path."""

import socket
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend import research_repo as repo
from backend import research_team as team
from backend import team_workspace
from backend.models import (
    AgentRun,
    AgentSession,
    Base,
    ResearchWorkspace,
    TeamChannel,
    TeamMember,
    TeamMessage,
    User,
)
from backend.research_team_routes import install_team_routes


@pytest.fixture
def world(tmp_path, monkeypatch):
    def offline(*args, **kwargs):
        raise AssertionError("Network is forbidden")

    monkeypatch.setattr(socket.socket, "connect", offline)
    original_git = repo.git

    def temporary_git(cwd, *args, **kwargs):
        assert Path(cwd).resolve().is_relative_to(tmp_path.resolve())
        assert not {"fetch", "pull", "push", "clone", "ls-remote"}.intersection(args)
        return original_git(cwd, *args, **kwargs)

    monkeypatch.setattr(repo, "git", temporary_git)
    settings = SimpleNamespace(storage=str(tmp_path / "files"), mode="local")
    engine = create_engine("sqlite:///" + str(tmp_path / "test.db"))
    Base.metadata.create_all(engine)
    maker = sessionmaker(engine, info={"settings": settings})
    with maker() as d:
        workspace = ResearchWorkspace(id="workspace", owner="owner", name="Changes")
        d.add_all(
            [
                workspace,
                User(
                    id="owner",
                    username="researcher",
                    email="researcher@example.test",
                    password="unused",
                ),
                TeamChannel(
                    id="channel", workspace_id=workspace.id, key="general", name="Chat"
                ),
                TeamMember(
                    id="member", workspace_id=workspace.id, role="writer", name="Writer"
                ),
            ]
        )
        d.commit()
        path = repo.ensure_repo(settings, workspace, snapshot=False)
    (path / "draft.md").write_text("original\n")
    (path / "deleted.md").write_text("delete me\n")
    base = repo.checkpoint(path, "Before run")
    app = FastAPI()

    def db():
        with maker() as d:
            yield d

    def auth(x_owner: str = Header(default="owner")):
        return {"id": x_owner}

    def workspace_of(d, id, a):
        row = d.get(ResearchWorkspace, id)
        if not row or row.owner != a["id"]:
            raise HTTPException(404, "Not found")
        return row

    install_team_routes(app, settings, db, auth, workspace_of)
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client,
            settings=settings,
            maker=maker,
            path=path,
            base=base,
            url="/api/v1/research/workspaces/workspace/team/messages/reply",
        )
    engine.dispose()


def seal(world, *, edit=True):
    if edit:
        (world.path / "draft.md").write_text("edited\nsecond\n")
    with world.maker() as d:
        run = AgentRun(
            id="run",
            owner="owner",
            session_id="session",
            model_config_id="offline",
            model="offline",
            prompt="Edit files",
            status="completed",
            runtime={"team_base": world.base, "team": {}},
        )
        message = TeamMessage(
            id="reply",
            workspace_id="workspace",
            channel_id="channel",
            author_id="member",
            data={"run_id": run.id},
            text="Saved",
        )
        d.add_all([run, message])
        d.flush()
        team_workspace.seal(
            world.settings, d.get(ResearchWorkspace, "workspace"), run, message
        )
        d.commit()
        return team.message_out(d, message)


def test_team_changes_numstat_status_binary_and_literal_paths(world):
    special = "文稿\t[1]\n.md"
    (world.path / special).write_text("one\ntwo\n")
    (world.path / "binary.bin").write_bytes(b"\0binary\xff")
    (world.path / "deleted.md").unlink()
    output = seal(world)
    changes = output["data"]["changes"]
    assert changes["commit"] == output["data"]["commit"]
    assert (changes["added"], changes["removed"]) == (4, 2)
    assert {
        f["path"]: (f["added"], f["removed"], f["status"]) for f in changes["files"]
    } == {
        "draft.md": (2, 1, "M"),
        "deleted.md": (0, 1, "D"),
        special: (2, 0, "A"),
        "binary.bin": (0, 0, "A"),
    }
    assert "deleted.md" not in {f["path"] for f in output["data"]["files"]}
    for name in (special, "deleted.md", "binary.bin"):
        response = world.client.get(world.url + "/diff", params={"path": name})
        assert response.status_code == 200, response.text
        assert response.json()["path"] == name
        assert response.json()["diff"]


def test_team_changes_diff_is_commit_scoped_readonly_and_bounded(world):
    output = seal(world)
    commit = output["data"]["commit"]
    (world.path / "draft.md").write_text("later\n")
    later = repo.checkpoint(world.path, "Later")
    before = repo.git(world.path, "status", "--porcelain").stdout
    patch = world.client.get(world.url + "/diff", params={"path": "draft.md"}).json()
    assert "-original\n+edited\n+second" in patch["diff"]
    assert "+later" not in patch["diff"]
    assert not patch["truncated"]
    assert repo.head(world.path) == later != commit
    assert repo.git(world.path, "status", "--porcelain").stdout == before
    for name in ("../draft.md", ":(glob)*", "AGENTS.md", "absent.md"):
        assert (
            world.client.get(world.url + "/diff", params={"path": name}).status_code
            == 404
        )
    assert (
        world.client.get(
            world.url + "/diff",
            params={"path": "draft.md"},
            headers={"X-Owner": "other"},
        ).status_code
        == 404
    )
    assert (
        world.client.get(
            world.url.replace("reply", "missing") + "/diff", params={"path": "draft.md"}
        ).status_code
        == 404
    )

    (world.path / "huge.md").write_text("文" * 40000 + "\n")
    huge = repo.checkpoint(world.path, "Large patch")
    with world.maker() as d:
        row = d.get(TeamMessage, "reply")
        row.data = {**row.data, "commit": huge}
        d.commit()
    response = world.client.get(world.url + "/diff", params={"path": "huge.md"}).json()
    assert response["truncated"]
    assert len(response["diff"].encode()) <= team_workspace.DIFF_BYTES


def test_team_changes_empty_run_and_historical_messages(world):
    empty = seal(world, edit=False)
    assert not empty["data"].get("changes")
    assert not empty["data"]["commit"]
    assert world.client.post(world.url + "/revert").status_code == 409
    with world.maker() as d:
        message = d.get(TeamMessage, "reply")
        message.data = {**message.data, "commit": world.base}
        assert "changes" not in team.message_out(d, message)["data"]
        d.commit()
    assert world.client.post(world.url + "/revert").status_code == 409
    (world.path / "draft.md").write_text("saved\n")
    commit = repo.checkpoint(world.path, "Historical run")
    with world.maker() as d:
        message = d.get(TeamMessage, "reply")
        message.data = {**message.data, "commit": commit}
        assert team.message_out(d, message)["data"][
            "changes"
        ] == team_workspace.changes(world.path, commit)


def test_team_changes_compare_with_parent_even_when_team_base_is_older(world):
    (world.path / "other-run.md").write_text("another run\n")
    parent = repo.checkpoint(world.path, "Another run finished first")
    output = seal(world)
    assert repo.git(world.path, "rev-parse", "HEAD^").stdout.strip() == parent
    changes = output["data"]["changes"]
    assert changes["files"] == [
        {"path": "draft.md", "added": 2, "removed": 1, "status": "M"}
    ]


def test_team_changes_revert_success_preserves_later_commits_and_is_idempotent(world):
    (world.path / "added.md").write_text("added\n")
    (world.path / "deleted.md").unlink()
    output = seal(world)
    commit = output["data"]["commit"]
    (world.path / "unrelated.md").write_text("keep this\n")
    later = repo.checkpoint(world.path, "Unrelated later change")
    response = world.client.post(world.url + "/revert")
    assert response.status_code == 200, response.text
    result = response.json()
    reverted = result["data"]["reverted_by"]
    assert reverted == repo.head(world.path)
    assert repo.git(world.path, "rev-parse", "HEAD^").stdout.strip() == later
    assert (
        repo.git(
            world.path, "show", "-s", "--format=%an <%ae>", reverted
        ).stdout.strip()
        == "researcher <researcher@example.test>"
    )
    assert commit in repo.git(world.path, "show", "-s", "--format=%B", reverted).stdout
    assert (world.path / "draft.md").read_text() == "original\n"
    assert (world.path / "deleted.md").read_text() == "delete me\n"
    assert not (world.path / "added.md").exists()
    assert (world.path / "unrelated.md").read_text() == "keep this\n"
    assert (
        world.client.post(world.url + "/revert").json()["data"]["reverted_by"]
        == reverted
    )
    assert repo.head(world.path) == reverted
    assert not repo.git(world.path, "status", "--porcelain").stdout
    assert (
        world.client.post(
            world.url + "/revert", headers={"X-Owner": "other"}
        ).status_code
        == 404
    )
    assert (
        world.client.get(world.url + "/diff", params={"path": "draft.md"}).status_code
        == 200
    )


def test_team_changes_revert_conflict_leaves_no_partial_state(world):
    (world.path / "added.md").write_text("must survive a conflict\n")
    seal(world)
    (world.path / "draft.md").write_text("later overlapping edit\n")
    later = repo.checkpoint(world.path, "Conflicting later change")
    response = world.client.post(world.url + "/revert")
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["conflicts"] == ["draft.md"]
    assert repo.head(world.path) == later
    assert (world.path / "draft.md").read_text() == "later overlapping edit\n"
    assert (world.path / "added.md").read_text() == "must survive a conflict\n"
    assert not repo.git(world.path, "status", "--porcelain").stdout
    for name in ("REVERT_HEAD", "sequencer", "MERGE_HEAD"):
        assert not repo._git_path(world.path, name).exists()
    with world.maker() as d:
        assert "reverted_by" not in d.get(TeamMessage, "reply").data


def test_team_changes_revert_rejects_dirty_active_or_archived_workspace(world):
    seal(world)
    before = repo.head(world.path)
    (world.path / "draft.md").write_text("unsaved\n")
    assert world.client.post(world.url + "/revert").status_code == 409
    assert (world.path / "draft.md").read_text() == "unsaved\n"
    (world.path / "draft.md").write_text("edited\nsecond\n")
    with world.maker() as d:
        d.add(
            AgentSession(
                id="session",
                owner="owner",
                workspace_id="workspace",
                kind="team_member",
            )
        )
        d.get(AgentRun, "run").status = "running"
        d.commit()
    assert world.client.post(world.url + "/revert").status_code == 409
    with world.maker() as d:
        d.get(AgentRun, "run").status = "completed"
        d.get(ResearchWorkspace, "workspace").archived = True
        d.commit()
    assert world.client.post(world.url + "/revert").status_code == 409
    assert repo.head(world.path) == before


@pytest.mark.parametrize("stage", ["git", "database"])
def test_team_changes_failed_revert_rolls_back_files_index_and_receipt(
    world, monkeypatch, stage
):
    seal(world)
    before = repo.head(world.path)
    if stage == "git":
        original_git = repo.git

        def fail_commit(path, *args, **kwargs):
            if "revert" in args and "--no-edit" in args:
                original_git(path, "revert", "--no-commit", args[-1])
                raise repo.GitError("Commit failed")
            return original_git(path, *args, **kwargs)

        monkeypatch.setattr(repo, "git", fail_commit)
        response = world.client.post(world.url + "/revert")
        assert response.status_code == 409, response.text
    else:

        def fail_save():
            raise OSError("Database unavailable")

        with world.maker() as d:
            monkeypatch.setattr(d, "commit", fail_save)
            with pytest.raises(OSError, match="Database unavailable"):
                team_workspace.revert(
                    world.settings,
                    d,
                    d.get(ResearchWorkspace, "workspace"),
                    d.get(TeamMessage, "reply"),
                    d.get(User, "owner"),
                )
    assert repo.head(world.path) == before
    assert (world.path / "draft.md").read_text() == "edited\nsecond\n"
    assert not repo.git(world.path, "status", "--porcelain").stdout
    assert not repo._git_path(world.path, "REVERT_HEAD").exists()
    with world.maker() as d:
        assert "reverted_by" not in d.get(TeamMessage, "reply").data
