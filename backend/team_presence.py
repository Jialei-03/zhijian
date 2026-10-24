"""Read-only colleague status and recent outputs from existing run receipts."""

from sqlalchemy import select

from .agent_state import presentation
from .models import AgentRun, TeamDelivery, TeamMessage


def presence(d, workspace, member, run):
    elapsed = 0
    if run and run.status == "running":
        clock = presentation(run)
        elapsed = clock.get("execution_seconds", 0) + clock.get("waiting_seconds", 0)
    queue_ahead = 0
    if run and run.status == "queued":
        queue_ahead = sum(
            (other.created_at, other.id) < (run.created_at, run.id)
            for other in d.scalars(
                select(AgentRun).where(
                    AgentRun.owner == workspace.owner, AgentRun.status == "queued"
                )
            )
        )
    elif not run:
        pending = list(
            d.scalars(
                select(TeamDelivery)
                .join(TeamMessage, TeamMessage.id == TeamDelivery.message_id)
                .where(
                    TeamMessage.workspace_id == workspace.id,
                    TeamDelivery.status == "queued",
                    TeamDelivery.run_id.is_(None),
                )
                .order_by(TeamDelivery.created_at, TeamDelivery.id)
            )
        )
        queue_ahead = next(
            (
                index
                for index, item in enumerate(pending)
                if item.member_id == member.id
            ),
            0,
        )
    step = (
        (run.steps or [])[-1] if run and run.status == "running" and run.steps else None
    )
    return {
        "status_text": (
            (run.runtime or {}).get("team_status", "")
            if run and run.status == "running"
            else ""
        ),
        "current_step": {
            key: step[key]
            for key in ("name", "label", "arguments", "status")
            if key in step
        }
        if step
        else None,
        "elapsed_seconds": elapsed,
        "queue_ahead": queue_ahead,
        "active_model": run.model if run else "",
        "effective_model_config_id": (
            run.model_config_id
            if run
            else member.model_config_id or workspace.model_config_id
        ),
    }


def output_files(data):
    """Changed paths include removals; callers decide whether a file can open."""
    files = {file["path"]: dict(file) for file in data.get("files", [])}
    for file in (data.get("changes") or {}).get("files", []):
        files[file["path"]] = {**files.get(file["path"], {}), **file}
    return [
        {
            "path": path,
            "name": file.get("name") or path,
            "deleted": file.get("status") == "D",
        }
        for path, file in files.items()
    ]


def recent_files(d, member):
    from .research_team import message_out

    latest, files = {}, {}
    for message in d.scalars(
        select(TeamMessage)
        .where(TeamMessage.workspace_id == member.workspace_id)
        .order_by(TeamMessage.created_at.desc(), TeamMessage.id.desc())
    ):
        for file in output_files(message_out(d, message)["data"]):
            latest.setdefault(file["path"], file)
            if message.author_id == member.id and not latest[file["path"]]["deleted"]:
                files.setdefault(file["path"], file)
        if len(files) >= 3:
            break
    return list(files.values())[:3]
