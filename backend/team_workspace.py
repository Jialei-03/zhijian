"""The team's project tree, including its authoritative agent documents."""

import re

from . import research_repo as repo

DIFF_BYTES = 80_000


class RevertConflict(ValueError):
    def __init__(self, message, conflicts=()):
        super().__init__(message)
        self.conflicts = list(conflicts)


def changes(path, commit):
    """One sealed commit, with literal, NUL-delimited paths (including binaries)."""
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40,64}", commit):
        raise ValueError("提交无效 / Invalid commit")
    base = commit + "^"
    names = repo.git(
        path,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-status",
        "-z",
        base,
        commit,
        "--",
    ).stdout.split("\0")
    statuses = dict(zip(names[1::2], names[::2]))
    stats = repo.git(
        path,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--numstat",
        "-z",
        base,
        commit,
        "--",
    ).stdout
    files = []
    for row in filter(None, stats.split("\0")):
        added, removed, name = row.split("\t", 2)
        files.append(
            {
                "path": name,
                "added": int(added) if added != "-" else 0,
                "removed": int(removed) if removed != "-" else 0,
                "status": statuses[name],
            }
        )
    return {
        "commit": commit,
        "files": files,
        "added": sum(f["added"] for f in files),
        "removed": sum(f["removed"] for f in files),
    }


def file_diff(path, commit, name):
    if name not in {f["path"] for f in changes(path, commit)["files"]}:
        raise FileNotFoundError("文件不在本次改动中 / File not in changes")
    raw = repo.git(
        path,
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        commit + "^",
        commit,
        "--",
        name,
        text=False,
    ).stdout
    return {
        "path": name,
        "diff": raw[:DIFF_BYTES].decode("utf-8", errors="ignore"),
        "truncated": len(raw) > DIFF_BYTES,
    }


def revert(settings, d, workspace, message, user):
    from sqlalchemy import select

    from .models import AgentRun, AgentSession
    from .research_workspaces import lock_workspace

    lock_workspace(d, workspace)
    if workspace.archived:
        raise RevertConflict("团队已归档 / Team archived")
    path = repo.repo_dir(settings, workspace.id)
    with repo._locked(repo.home(settings, workspace.id)):
        d.refresh(message)
        if message.data.get("reverted_by"):
            return
        commit = message.data.get("commit")
        if not commit or not changes(path, commit)["files"]:
            raise RevertConflict("没有可撤销的改动 / No changes to revert")
        runs = d.scalars(
            select(AgentRun)
            .join(AgentSession, AgentSession.id == AgentRun.session_id)
            .where(
                AgentSession.workspace_id == workspace.id,
                AgentSession.kind == "team_member",
                AgentRun.status.in_(("queued", "running")),
            )
        )
        if any(
            not (r.runtime or {}).get("team", {}).get("research_round") for r in runs
        ):
            raise RevertConflict("成员仍在运行 / Member still running")
        if repo.git(path, "status", "--porcelain", "-z", "-uall").stdout:
            raise RevertConflict("仓库有未提交改动 / Uncommitted changes")
        if any(
            repo._git_path(path, name).exists()
            for name in ("REVERT_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "sequencer")
        ):
            raise RevertConflict("仓库有未完成操作 / Git operation in progress")
        if repo.git(
            path, "merge-base", "--is-ancestor", commit, "HEAD", check=False
        ).returncode:
            raise RevertConflict("提交不在当前历史中 / Commit not in current history")
        before = repo.head(path)
        try:
            repo.git(
                path,
                "-c",
                f"user.name={user.username}",
                "-c",
                f"user.email={user.email or user.id + '@ora.local'}",
                "revert",
                "--no-edit",
                "--no-rerere-autoupdate",
                commit,
            )
        except repo.GitError as error:
            conflicts = repo.git(
                path, "diff", "--name-only", "--diff-filter=U", "-z"
            ).stdout.split("\0")
            repo.git(path, "revert", "--abort", check=False)
            # Also covers a failed commit after a clean application.
            repo.git(path, "reset", "--merge", before)
            raise RevertConflict(
                "撤销冲突 / Revert conflict" if any(conflicts) else str(error),
                filter(None, conflicts),
            ) from None
        reverted_by = repo.head(path)
        try:
            message.data = {**message.data, "reverted_by": reverted_by}
            d.commit()
        except Exception:
            d.rollback()
            repo.git(path, "reset", "--merge", before)
            raise


def workdir(settings, workspace):
    # Member editors and external edits use this same tree. A second branch
    # would leave AGENTS.md and .ora/agents behind after definition edits.
    # Never fetch source code or open SSH just to run a channel/DM member.
    return repo.ensure_repo(settings, workspace, snapshot=False)


def seal(settings, workspace, run, message):
    info = (run.runtime or {}).get("team", {})
    if info.get("research_round") or "team_base" not in (run.runtime or {}):
        return
    path = workdir(settings, workspace)
    with repo._locked(repo.home(settings, workspace.id)):
        commit = repo.checkpoint(path, f"Team: {run.id}") or repo.head(path)
        if commit == run.runtime["team_base"]:
            message.data = {**message.data, "files": [], "commit": ""}
            return
        change = changes(path, commit)
    files = []
    for entry in change["files"]:
        rel = entry["path"]
        target = path / rel
        if rel and target.is_file() and not target.is_symlink():
            files.append({"path": rel, "name": target.name})
    message.data = {**message.data, "files": files, "commit": commit, "changes": change}
