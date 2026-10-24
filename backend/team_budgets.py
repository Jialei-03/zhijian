"""User-controlled team limits; usage comes from the existing model receipts."""

from datetime import UTC, datetime, timedelta

from pydantic import Field, StrictInt
from sqlalchemy import func, or_, select

from .models import (
    AgentRun,
    AgentSession,
    ModelUsage,
    ResearchProject,
    TeamMember,
    TeamMessage,
)
from .schemas import Strict


class TeamBudget(Strict):
    # No limit until the researcher sets one (0 means none).
    max_tokens: StrictInt = Field(default=0, ge=0)
    period_hours: StrictInt = Field(default=24, ge=1, le=8760)
    max_concurrent: StrictInt = Field(default=0, ge=0)


def snapshot(member):
    # Execution receipts record the effective file budget for this wake only.
    return {
        "max_execution_seconds": member.wake_minutes * 60,  # 0: none
        "max_model_turns": member.wake_turns,
        "max_tokens": member.wake_tokens,
    }


def limits(workspace):
    stored = dict(workspace.workflow_state.get("budget", {}))
    stored.pop("relay_limit", None)  # Removed: agents hand off without a cap.
    return TeamBudget.model_validate(stored).model_dump()


def _in_workspace(workspace):
    # Native research runs are queued before the child adds its team context.
    return or_(
        AgentSession.workspace_id == workspace.id,
        AgentRun.runtime["team"]["workspace_id"].as_string() == workspace.id,
        AgentRun.runtime["research"]["project_id"]
        .as_string()
        .in_(
            select(ResearchProject.id).where(
                ResearchProject.workspace_id == workspace.id
            )
        ),
    )


def tokens(d, *, workspace=None, run=None):
    query = select(
        func.coalesce(
            func.sum(
                func.coalesce(
                    ModelUsage.total_tokens,
                    func.nullif(ModelUsage.reserved_tokens, 0),
                    0,
                )
            ),
            0,
        )
    ).where(ModelUsage.source == "agent")
    if run:
        query = query.where(ModelUsage.task_id == run.id)
    else:
        since = (
            datetime.now(UTC) - timedelta(hours=limits(workspace)["period_hours"])
        ).isoformat()
        query = (
            query.join(AgentRun, AgentRun.id == ModelUsage.task_id)
            .join(
                AgentSession,
                AgentSession.id == AgentRun.session_id,
            )
            .where(
                ModelUsage.owner == workspace.owner,
                ModelUsage.created_at >= since,
                _in_workspace(workspace),
            )
        )
    return int(d.scalar(query))


def working(d, workspace):
    return d.scalar(
        select(func.count())
        .select_from(AgentRun)
        .join(
            AgentSession,
            AgentSession.id == AgentRun.session_id,
        )
        .where(
            AgentRun.status.in_(["queued", "running"]),
            AgentRun.owner == workspace.owner,
            _in_workspace(workspace),
        )
    )


def run_limit(d, run):
    from .models import ResearchWorkspace

    info = (run.runtime or {}).get("team")
    if not info:
        return None
    maximum = run.runtime.get("max_tokens", 0)
    if maximum and tokens(d, run=run) >= maximum:
        return "member_tokens"
    workspace = d.get(ResearchWorkspace, info["workspace_id"])
    member = d.get(TeamMember, info["member_id"])
    if member and member.max_tokens and member.tokens >= member.max_tokens:
        return "member_total_tokens"
    budget = limits(workspace)
    if budget["max_tokens"] and tokens(d, workspace=workspace) >= budget["max_tokens"]:
        return "team_tokens"
    return None


def notice(d, workspace, message, reason, *, source_key):
    if d.scalar(select(TeamMessage.id).where(TeamMessage.source_key == source_key)):
        return
    human = d.scalar(
        select(TeamMember.id).where(
            TeamMember.workspace_id == workspace.id,
            TeamMember.role == "human",
        )
    )
    d.add(
        TeamMessage(
            workspace_id=workspace.id,
            channel_id=message.channel_id,
            thread_id=message.thread_id,
            kind="budget",
            data={"reason": reason},
            mentions=[human] if human else [],
            source_key=source_key,
        )
    )
