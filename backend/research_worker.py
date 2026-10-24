"""Plans research sprints: one at a time per project, from its map, within budget.

Each sprint is an ordinary agent run in the "research" lane, executed by the
agent worker. This worker only decides when the next one starts, closes the
ones that ended without a handoff, and collects finished experiments.
"""

import json
import signal
import threading
import time
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import select

from . import (
    research_datasets,
    research_dialogue,
    research_map,
    research_repo,
    research_sandbox,
    research_stages,
    research_tracker,
    research_workflows,
)
from .config import Settings, database
from .filelock import lock_nowait
from .models import (
    AgentRun,
    AgentSession,
    ResearchEvent,
    ResearchJob,
    ResearchProject,
    ResearchSprint,
    ResearchWorkspace,
    TeamMember,
    now,
)
from .parent_watch import watch_parent
from .research_brief import (
    advisor_brief,
    distiller_brief,
    executor_brief,
    scoping_brief,
    workflow_brief,
    workflow_context,
)
from .research_map import event
from .translation_settings import read_config

INTERVAL = 2
DONE = {"completed", "failed", "cancelled"}


def fallback_summary(run):
    """What a sprint did, in a few plain lines, when it ended without a handoff:
    read by the researcher in the thread and by the next round's brief."""
    steps = run.steps or []
    failed = [s for s in steps if s.get("status") == "failed"]
    said = [str(s.get("said") or "").strip() for s in steps if s.get("said")]
    names = []
    for step in steps:
        if step.get("name") and step["name"] not in names:
            names.append(step["name"])
    lines = [
        f"本轮在没有交接的情况下结束（{run.error or run.status}）："
        f"共 {len(steps)} 步，{len(failed)} 步失败。"
    ]
    if said:
        lines.append("最后说的：" + said[-1][:300])
    if names:
        lines.append("用过的工具：" + "、".join(names[:12]))
    for step in failed[-3:]:
        reason = str(step.get("error") or "").strip().splitlines()
        lines.append(
            f"- {step.get('name')} 失败：{(reason[0] if reason else '')[:160]}"
        )
    return "\n".join(lines)


def charge(maker, research, tokens):
    """Model tokens, to the sprint, the node in focus at the time, and the project."""
    if tokens <= 0 or not research.get("sprint_id"):
        # Preparing an environment belongs to no project's budget.
        return
    from .models import ResearchNode

    with maker() as d:
        sprint = d.get(ResearchSprint, research["sprint_id"])
        project = d.get(ResearchProject, research["project_id"])
        if sprint is None or project is None:
            return
        sprint.tokens += tokens
        if sprint.focus_node_id:
            node = d.get(ResearchNode, sprint.focus_node_id)
            if node is not None:
                node.spent_tokens += tokens
        project.spent = {
            **project.spent,
            "tokens": project.spent.get("tokens", 0) + tokens,
        }
        if project.workspace_id:
            from .research_team import ensure

            members = ensure(d, d.get(ResearchWorkspace, project.workspace_id))
            role = {
                "scoping": "advisor",
                "discussion": "advisor",
                "workflow": "executor",
                "review": "advisor",
            }.get(sprint.role, sprint.role)
            member = next(
                (m for m in members if m.id == research.get("member_id")), None
            ) or next((m for m in members if m.role == role), None)
            if member:
                member.tokens += tokens
        d.commit()


LIMITS = (
    ("sprints", "max_sprints"),
    ("tokens", "max_tokens"),
    ("job_seconds", "max_job_seconds"),
)


def _over_budget(project):
    """Whether a limit the project has is reached; a limit left empty never is."""
    budget, spent = project.budget, project.spent
    return any(
        budget.get(limit) is not None and spent.get(used, 0) >= budget[limit]
        for used, limit in LIMITS
    )


def _share(spent, limit):
    return spent / limit if limit else 0.0


def _settle(d, project, sprint):
    """A sprint whose run is over but which never handed over is closed by the system."""
    run = d.get(AgentRun, sprint.run_id)
    if run is not None:
        from .research_team import normalize

        run.response = normalize(run.response)
    if run is None or run.status not in DONE:
        return False
    if sprint.role in {"scoping", "discussion"}:
        # A turn of the conversation: its reply is what the advisor said.
        reply = (run.response or "").strip()
        proposed = any(e.action == "plan_proposed" for e in _events(d, sprint))
        sprint.status = "ended" if run.status == "completed" else "abnormal"
        sprint.summary = reply[:4000]
        sprint.updated_at = now()
        if run.status != "completed":
            event(
                d,
                project,
                None,
                "system",
                "sprint_abnormal",
                {"run_status": run.status, "reason": (run.error or run.status)[:500]},
                sprint.id,
            )
        if reply:
            research_stages.say(d, project, "advisor", reply, sprint.id)
        elif proposed:
            research_stages.say(
                d, project, "advisor", "计划卡片已更新，你看看。", sprint.id
            )
        else:
            research_stages.say(
                d,
                project,
                "system",
                "导师这次没能回复（"
                + (run.error or run.status)[:200]
                + "）。可以再说一次。",
                sprint.id,
            )
        return True
    if (
        sprint.role in {"executor", "workflow", "review"}
        and run.status == "completed"
        and (run.response or "").strip()
    ):
        # A reply hands over the round; a workflow still needs its completion tool.
        sprint.status = "ended"
        sprint.summary = run.response.strip()[:4000]
        sprint.updated_at = now()
        event(d, project, None, "system", "handoff_from_reply", {}, sprint.id)
        return True
    sprint.status = "abnormal"
    sprint.summary = fallback_summary(run)
    sprint.updated_at = now()
    event(
        d,
        project,
        None,
        "system",
        "sprint_abnormal",
        {
            "run_status": run.status,
            "reason": (run.error or sprint.summary or run.status)[:500],
        },
        sprint.id,
    )
    if sprint.role == "advisor":
        # An advisor that said nothing changes nothing; the executor carries on.
        event(d, project, None, "system", "advisor_silent", {}, sprint.id)
    if (run.runtime or {}).get("interrupted"):
        # Cut short by a restart of this service, not by the research: given back.
        project.spent = {
            **project.spent,
            "sprints": max(0, project.spent.get("sprints", 0) - 1),
        }
        event(d, project, None, "system", "sprint_refunded", {}, sprint.id)
    elif _outage(run):
        # The model service failed before anything was done: the sprint is given back.
        project.spent = {
            **project.spent,
            "sprints": max(0, project.spent.get("sprints", 0) - 1),
        }
        event(
            d,
            project,
            None,
            "system",
            "model_outage",
            {"error": run.error[:300], "at": _now()},
            sprint.id,
        )
    return True


OUTAGE_LIMIT = 5
OUTAGE_BACKOFF = 60
OUTAGE_BACKOFF_MAX = 1800


def _now_real():
    return time.time()


# Through one name, so tests can move the clock.
_now = _now_real


def _outage(run):
    """The run failed without doing anything: the model service, not the research."""
    return run is not None and run.status == "failed" and not run.steps


def _outages(d, project, history):
    """How many of the last sprints in a row failed on the model service.

    Counting starts again when a person resumes the project.
    """
    resumed = d.scalars(
        select(ResearchEvent.created_at)
        .where(
            ResearchEvent.project_id == project.id,
            ResearchEvent.actor.in_(["human", "lead"]),
            ResearchEvent.action == "active",
        )
        .order_by(ResearchEvent.created_at.desc())
    ).first()
    count = 0
    for sprint in reversed(history):
        if resumed and sprint.created_at <= resumed:
            break
        if not _outage(d.get(AgentRun, sprint.run_id)):
            break
        count += 1
    return count


def _waiting_out(d, project, count):
    """Whether the pause after `count` outages in a row is still running."""
    last = d.scalars(
        select(ResearchEvent)
        .where(
            ResearchEvent.project_id == project.id,
            ResearchEvent.action == "model_outage",
        )
        .order_by(ResearchEvent.created_at.desc())
    ).first()
    if last is None:
        return False
    delay = min(OUTAGE_BACKOFF * 2 ** (count - 1), OUTAGE_BACKOFF_MAX)
    return _now() < float(last.detail.get("at", 0)) + delay


def _last_human_message(d, project):
    return d.scalars(
        select(ResearchEvent.created_at)
        .where(
            ResearchEvent.project_id == project.id,
            ResearchEvent.actor.in_(["human", "lead"]),
            ResearchEvent.action == "message",
        )
        .order_by(ResearchEvent.created_at.desc())
    ).first()


ADVISOR_EVERY = 3
PROGRESS = {"add_node", "update_node", "record_result"}
MARKS = (0.5, 0.8)


def _events(d, sprint):
    return list(
        d.scalars(select(ResearchEvent).where(ResearchEvent.sprint_id == sprint.id))
    )


def _progressed(d, sprint):
    return any(row.action in PROGRESS for row in _events(d, sprint))


def next_role(d, project, history):
    """Who works next: the advisor when a judgment is due, else the executor.

    A judgment is due every few executor sprints, after a result that may
    meet a kill condition, after a claimed finding, when the executor says it
    needs something only a person can provide, when the budget crosses
    half and four fifths, and when two sprints in a row moved nothing on the
    map. Never two advisor sprints in a row.
    """
    if project.budget.get("advisor") is False:
        # An ablation run: the executor works alone.
        return "executor"
    # Talking the plan through is not research work to be reviewed.
    history = [s for s in history if s.role != "scoping"]
    said = _last_human_message(d, project)
    if (
        said is not None
        and research_stages.unanswered(d, project)
        and (not history or history[-1].created_at < said)
    ):
        # The person spoke: the advisor answers before anything else moves.
        return "advisor"
    if not history or history[-1].role == "advisor":
        return "executor"
    since = []
    for sprint in reversed(history):
        if sprint.role == "advisor":
            break
        since.append(sprint)
    if len(since) >= ADVISOR_EVERY:
        return "advisor"
    for row in _events(d, history[-1]):
        if row.action == "record_result" and row.detail.get("kill_triggered") in {
            "yes",
            "unsure",
        }:
            return "advisor"
        if row.action == "add_node" and row.detail.get("kind") == "finding":
            return "advisor"
        if row.action == "end_sprint" and row.detail.get("needs_input"):
            # Only a person can unblock it: the advisor decides now whether to stop and ask.
            return "advisor"
    budget, spent = project.budget, project.spent
    ratio = max(
        _share(spent.get("sprints", 0), budget.get("max_sprints")),
        _share(spent.get("tokens", 0), budget.get("max_tokens")),
    )
    marked = {
        row.detail.get("mark")
        for row in d.scalars(
            select(ResearchEvent).where(
                ResearchEvent.project_id == project.id,
                ResearchEvent.action == "budget_mark",
            )
        )
    }
    for mark in MARKS:
        if ratio >= mark and mark not in marked:
            event(d, project, None, "system", "budget_mark", {"mark": mark})
            return "advisor"
    if len(since) >= 2 and all(
        not s.waiting_on and not _progressed(d, s) for s in since[:2]
    ):
        return "advisor"
    return "executor"


def _plan(app, d, project):
    if not _schedulable(d, project, "active"):
        return
    research_workflows.adopt_project(d, project)
    latest = d.scalars(
        select(ResearchSprint)
        .where(ResearchSprint.project_id == project.id)
        .order_by(ResearchSprint.number.desc())
    ).first()
    if latest is not None and latest.status == "running":
        if not _settle(d, project, latest):
            return
        if latest.role != "discussion":
            capture_handoff(app.state.settings, d, project, latest)
        if latest.role in {"workflow", "review"}:
            research_workflows.round_ended(d, project, latest)
    if not research_workflows.checkpoints(app.state.settings, d, project):
        return
    if project.status != "active":
        return
    spec = research_workflows.current(project)
    if spec and _over_budget(project):
        research_stages.request_budget(d, project)
        return
    if (
        spec
        and spec.get("max_rounds")
        and project.workflow_state["steps"][project.workflow_state["current"]]["rounds"]
        >= spec["max_rounds"]
    ):
        research_workflows.block(d, project, "步骤轮数已用完")
        return
    if spec and spec.get("action") == "child_research":
        research_workflows.child_tick(app.state.settings, d, project)
        return
    if spec and spec["type"] in {"agent", "review"}:
        config = read_config(app.state.settings, project.owner, project.model_config_id)
        if not config.get("model"):
            project.status = "paused"
            event(d, project, None, "system", "paused", {"reason": "模型配置不可用"})
            return
        from .team_workflows import next_research_action, action_role

        history = list(
            d.scalars(
                select(ResearchSprint)
                .where(ResearchSprint.project_id == project.id)
                .order_by(ResearchSprint.number)
            )
        )
        action = next_research_action(d, project, history, "executor")
        role = action_role(d, project, action, "workflow")
        if role:
            _start(app, d, project, latest, role, config, action=action)
        return
    if latest is not None and latest.waiting_on:
        waiting = d.scalars(
            select(ResearchJob).where(
                ResearchJob.id.in_(latest.waiting_on),
                ResearchJob.status.in_(research_sandbox.ACTIVE),
            )
        ).first()
        if waiting is not None:
            return
    if project.stage == "scoping":
        _converse(app, d, project, latest)
        return
    if research_datasets.pending(d, project) is not None:
        return
    failed = next(
        (r for r in research_datasets.of(d, project.id) if r.status == "failed"), None
    )
    if failed is not None:
        project.status = "paused"
        event(
            d,
            project,
            None,
            "system",
            "paused",
            {"reason": f"数据集 {failed.name} 下载失败：{failed.note[:200]}"},
        )
        return
    if _over_budget(project):
        if project.budget.get("auto_decide"):
            research_stages.end_on_budget(d, project)
        else:
            # The one in charge decides whether the question is worth more.
            research_stages.request_budget(d, project)
        return
    config = read_config(app.state.settings, project.owner, project.model_config_id)
    if not config.get("model"):
        project.status = "paused"
        event(d, project, None, "system", "paused", {"reason": "模型配置不可用"})
        return
    history = list(
        d.scalars(
            select(ResearchSprint)
            .where(ResearchSprint.project_id == project.id)
            .order_by(ResearchSprint.number)
        )
    )
    outages = _outages(d, project, history)
    if outages >= OUTAGE_LIMIT:
        last = d.get(AgentRun, history[-1].run_id)
        project.status = "paused"
        project.updated_at = now()
        event(
            d,
            project,
            None,
            "system",
            "paused",
            {
                "reason": "模型服务连续出错，研究已暂停："
                + (last.error if last else "")[:200]
            },
        )
        return
    if outages and _waiting_out(d, project, outages):
        return
    from .team_workflows import next_research_action, action_role

    action = next_research_action(d, project, history, next_role(d, project, history))
    role = action_role(d, project, action, "executor")
    if role is None:
        return
    if role not in BRIEFS:
        _deliver_rule_action(d, project, action)
        return
    if (
        role == "executor"
        and _local(app, project, d)
        and not research_sandbox.docker_status()["available"]
    ):
        # The executor's work is experiments: without Docker a sprint only spends tokens.
        reason = research_sandbox.docker_status()["reason"]
        said = d.scalars(
            select(ResearchEvent)
            .where(
                ResearchEvent.project_id == project.id,
                ResearchEvent.action == "docker_unavailable",
            )
            .order_by(ResearchEvent.created_at.desc())
        ).first()
        if said is None or (history and said.created_at < history[-1].created_at):
            event(d, project, None, "system", "docker_unavailable", {"reason": reason})
        return
    _start(app, d, project, latest, role, config, action=action)


def _deliver_rule_action(d, project, action):
    from .models import TeamMessage
    from .research_team import stable
    from .team_workflows import apply, consumed

    workspace = d.get(ResearchWorkspace, project.workspace_id)
    if workspace:
        message = TeamMessage(
            workspace_id=workspace.id,
            channel_id=stable(workspace, "experiments"),
            thread_id=f"research:{project.id}",
            text=action.get("instruction") or project.question,
            data={"research_forwarded": True},
        )
        d.add(message)
        d.flush()
        apply(d, workspace, message, project.workflow, [action])
        consumed(project)


def _local(app, project, d=None):
    """Whether the project's experiments run in this machine's Docker."""
    from . import research_settings

    try:
        if d is not None:
            from .research_locations import execution_compute

            item = execution_compute(app.state.settings, d, project)
        else:
            item = research_settings.compute(app.state.settings, project.compute_id)
    except ValueError:
        return True
    return item["kind"] == "docker"


def _auto_focus(d, project, sprint):
    from .research_tools import _focus

    if sprint.focus_node_id:
        return
    nodes = research_map.nodes(d, project)
    candidates = [n for n in nodes if n.parent_id is not None]
    if not candidates:
        candidates = nodes
    order = {
        h["title"]: i for i, h in enumerate((project.plan or {}).get("hypotheses", []))
    }
    candidates.sort(key=lambda n: order.get(n.title, len(order)))
    node = next(
        (
            n
            for n in candidates
            if n.status in {"open", "active"} and research_map.is_live(d, n)
        ),
        None,
    )
    if node is not None:
        _focus(
            d,
            project,
            sprint,
            {"node_id": node.id, "intent": "自动聚焦本轮首个未完成节点"},
        )


BRIEFS = {
    "advisor": advisor_brief,
    "executor": executor_brief,
    "scoping": scoping_brief,
}


def _converse(app, d, project, latest):
    """While scoping, the advisor answers each thing the person says."""
    spec = research_workflows.current(project)
    first_step_round = bool(
        spec
        and project.workflow_state["steps"][project.workflow_state["current"]]["rounds"]
        == 0
    )
    from .team_workflows import pending

    if (
        not research_stages.unanswered(d, project)
        and not first_step_round
        and not pending(project)
    ):
        return
    config = read_config(app.state.settings, project.owner, project.model_config_id)
    if not config.get("model"):
        project.status = "paused"
        event(d, project, None, "system", "paused", {"reason": "模型配置不可用"})
        research_stages.say(
            d, project, "system", "模型配置不可用，先在设置里选一个模型。"
        )
        return
    from .team_workflows import next_research_action, action_role

    history = list(
        d.scalars(
            select(ResearchSprint)
            .where(ResearchSprint.project_id == project.id)
            .order_by(ResearchSprint.number)
        )
    )
    action = next_research_action(d, project, history, "advisor", scoping=True)
    role = action_role(d, project, action, "scoping")
    if role:
        # A plan action uses the existing conversational planning runner.
        _start(
            app,
            d,
            project,
            latest,
            "scoping" if role == "executor" else role,
            config,
            action=action,
        )


def _start(app, d, project, latest, role, config, *, action=None):
    from .research_team import available

    target = d.get(TeamMember, action["member"]) if action else None
    if not available(d, project, target.role if target else role):
        return
    number = (latest.number if latest else 0) + 1
    sprint = ResearchSprint(project_id=project.id, number=number, role=role, run_id="")
    d.add(sprint)
    d.flush()
    if role == "executor":
        _auto_focus(d, project, sprint)
    spec = research_workflows.current(project)
    brief = (workflow_brief if role in {"workflow", "review"} else BRIEFS[role])(
        d, project, number, app.state.settings
    )
    if spec and role not in {"workflow", "review"}:
        brief += "\n\n" + workflow_context(project)
    if action and action.get("instruction"):
        brief += "\n\n" + action["instruction"]
    chosen = project.model_config_id
    if target and target.model_config_id:
        chosen = target.model_config_id
        config = read_config(app.state.settings, project.owner, chosen)
    research_workflows.round_started(project)
    run = AgentRun(
        owner=project.owner,
        session_id=project.session_id,
        model_config_id=chosen,
        model=config["model"],
        prompt=(
            ("\n\n".join(research_stages.unanswered(d, project)) or "继续讨论这项研究")
            if role == "scoping"
            else brief
        ),
        context=(brief if role == "scoping" else "research/" + project.id),
        writable=True,
        lane="research",
        runtime={
            **(
                {
                    "rule": {
                        k: action[k]
                        for k in ("rule", "workflow", "workflow_version")
                        if k in action
                    }
                }
                if action
                else {}
            ),
            "research": {
                "project_id": project.id,
                "sprint_id": sprint.id,
                "role": role,
                **(
                    {"member_id": action["member"]}
                    if action and target and (spec or target.library_id)
                    else {}
                ),
                **(
                    {
                        "workflow_index": project.workflow_state["current"],
                        "workflow_attempt": project.workflow_state["steps"][
                            project.workflow_state["current"]
                        ]["attempt"],
                    }
                    if spec
                    else {}
                ),
                # Before experiments the advisor reads the project like a chat.
                **(
                    {"workspace_id": project.workspace_id}
                    if role in {"scoping", "workflow", "review"}
                    and project.workspace_id
                    else {}
                ),
            },
        },
    )
    d.add(run)
    d.flush()
    sprint.run_id = run.id
    from .team_workflows import consumed

    consumed(project)
    if role != "scoping":
        # Talking the plan through is not a research sprint of the budget.
        project.spent = {
            **project.spent,
            "sprints": project.spent.get("sprints", 0) + 1,
        }
    if role == "executor" and not any(
        e.action == "playbook_version"
        for e in d.scalars(
            select(ResearchEvent).where(ResearchEvent.project_id == project.id)
        )
    ):
        # Which playbook this project ran with, for comparing runs later.
        from . import research_playbook

        book = research_playbook.load(app.state.settings)
        event(
            d,
            project,
            None,
            "system",
            "playbook_version",
            {
                "version": book["version"],
                "active": [r["id"] for r in research_playbook.active(book)],
            },
            sprint.id,
        )
    project.updated_at = now()
    event(
        d,
        project,
        None,
        "system",
        "sprint_planned",
        {"number": number, "role": role, **(run.runtime.get("rule") or {})},
        sprint.id,
    )


def _distill(app, d, project):
    """Once a project is over, one distiller sprint turns it into playbook rules."""
    research_workflows.adopt_project(d, project)
    if not research_workflows.is_native(project):
        spec = research_workflows.current(project)
        if not spec or spec.get("action") != "retrospective":
            return
    if project.stage == "done" or not _schedulable(d, project, "finished"):
        return
    if not research_workflows.checkpoints(app.state.settings, d, project):
        return
    if d.scalar(
        select(AgentRun.id)
        .where(
            AgentRun.session_id == project.session_id,
            AgentRun.status.in_(("queued", "running")),
        )
        .limit(1)
    ):
        return
    history = list(
        d.scalars(
            select(ResearchSprint)
            .where(ResearchSprint.project_id == project.id)
            .order_by(ResearchSprint.number)
        )
    )
    if project.status != "finished":
        # Reopened meanwhile (its limits lifted): nothing to look back on yet.
        return
    if project.budget.get("distill") is False:
        research_stages.set_stage(d, project, "done")
        return
    mine = [s for s in history if s.role == "distiller"]
    if mine:
        sprint = mine[-1]
        if sprint.status == "running" and _settle(d, project, sprint):
            event(d, project, None, "system", "distiller_silent", {}, sprint.id)
            capture_handoff(app.state.settings, d, project, sprint)
        if sprint.status != "running":
            research_stages.set_stage(d, project, "done")
        return
    if not any(s.role == "executor" for s in history):
        research_stages.set_stage(d, project, "done")
        return
    config = read_config(app.state.settings, project.owner, project.model_config_id)
    if not config.get("model"):
        return
    from .research_team import available

    if not available(d, project, "distiller"):
        return
    from .team_workflows import pending, research_event, consumed

    action = pending(project)
    if not action:
        # Old finished projects and automatic budget stops enter the same rule.
        research_event(
            d, project, "conclusion_proposed", role="executor", kind="conclusion"
        )
        action = pending(project)
    if not action:
        return
    member = d.get(TeamMember, action["member"])
    if (member.role if member else action["member"]) != "distiller":
        _deliver_rule_action(d, project, action)
        return
    chosen = (
        member.model_config_id
        if member and member.model_config_id
        else project.model_config_id
    )
    config = read_config(app.state.settings, project.owner, chosen)
    number = history[-1].number + 1
    sprint = ResearchSprint(
        project_id=project.id, number=number, role="distiller", run_id=""
    )
    d.add(sprint)
    d.flush()
    run = AgentRun(
        owner=project.owner,
        session_id=project.session_id,
        model_config_id=chosen,
        model=config["model"],
        prompt=distiller_brief(d, project, number, app.state.settings),
        context="research/" + project.id,
        writable=True,
        lane="research",
        runtime={
            "rule": {
                k: action[k]
                for k in ("rule", "workflow", "workflow_version")
                if k in action
            },
            "research": {
                "project_id": project.id,
                "sprint_id": sprint.id,
                "role": "distiller",
            },
        },
    )
    d.add(run)
    d.flush()
    sprint.run_id = run.id
    consumed(project)
    event(
        d,
        project,
        None,
        "system",
        "sprint_planned",
        {"number": number, "role": "distiller"},
        sprint.id,
    )


def capture_handoff(settings, d, project, sprint):
    """A failed Git checkpoint must not discard an otherwise valid handoff."""
    from .research_branches import capture_round

    try:
        return capture_round(settings, d, project, sprint, allow_capture=True)
    except (OSError, ValueError, RuntimeError) as exc:
        event(
            d,
            project,
            None,
            "system",
            "checkpoint_unavailable",
            {"reason": str(exc)[:500]},
            sprint.id,
        )
        return False


def _schedulable(d, project, status):
    from .research_chat import lock_session
    from .research_workspaces import lock_workspace

    session = d.get(AgentSession, project.session_id)
    if session is None or session.owner != project.owner:
        return False
    lock_session(d, session)
    d.refresh(project)
    if project.workspace_id:
        workspace = d.get(ResearchWorkspace, project.workspace_id)
        if workspace is None or workspace.owner != project.owner:
            return False
        # Use the same session -> workspace order as archival, then discard the
        # worker's earlier project snapshot before admitting another model run.
        lock_workspace(d, workspace)
        d.refresh(project)
        if workspace.archived:
            return False
        from .research_locations import busy_workspace

        if not project.parent_id and busy_workspace(
            d, workspace, exclude_session_id=project.session_id
        ):
            return False
    return project.status == status and (
        status != "finished" or project.stage != "done"
    )


def tick(app):
    """One round of planning over every active project."""
    from . import research_schedules, research_team

    for name, step in (
        ("team", research_team.settle),
        ("schedules", research_schedules.tick),
        ("conversations", research_dialogue.settle),
        ("sweep", research_sandbox.sweep),
        ("datasets", research_datasets.start_fetching),
        ("tracker", research_tracker.sync_pending),
        ("repositories", research_repo.settle),
        ("checkpoints", research_repo.checkpoints),
        ("workflow_checkpoints", research_workflows.seal_pending),
    ):
        try:
            step(app.state.settings, app.state.maker)
        except Exception as e:  # noqa: BLE001 — housekeeping must not stop planning
            print(
                json.dumps({"research_worker": name, "error": str(e)[:300]}),
                flush=True,
            )
    with app.state.maker() as d:
        ids = list(
            d.scalars(
                select(ResearchProject.id).where(ResearchProject.status == "active")
            )
        )
    with app.state.maker() as d:
        done = list(
            d.scalars(
                select(ResearchProject.id).where(ResearchProject.status == "finished")
            )
        )
    for id in done:
        with app.state.maker() as d:
            project = d.get(ResearchProject, id)
            try:
                _distill(app, d, project)
                d.commit()
            except (ValueError, OSError) as e:
                d.rollback()
                print(
                    json.dumps({"research_worker": id, "error": str(e)[:300]}),
                    flush=True,
                )
    for id in ids:
        with app.state.maker() as d:
            project = d.get(ResearchProject, id)
            if project is None or project.status != "active":
                continue
            try:
                _plan(app, d, project)
                d.commit()
            except (ValueError, OSError) as e:
                d.rollback()
                print(
                    json.dumps({"research_worker": id, "error": str(e)[:300]}),
                    flush=True,
                )


def main():
    watch_parent()
    settings = Settings.env()
    _, maker = database(settings)
    app = SimpleNamespace(state=SimpleNamespace(settings=settings, maker=maker))
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    path = Path(settings.storage).parent / "research-worker.lock"
    with path.open("a") as lock:
        lock_nowait(lock)
        while not stopping.is_set():
            try:
                tick(app)
            except (
                Exception
            ) as e:  # noqa: BLE001 — the scheduler outlives one bad round
                print(
                    json.dumps({"research_worker": "tick", "error": str(e)[:300]}),
                    flush=True,
                )
            stopping.wait(INTERVAL)


if __name__ == "__main__":
    main()
