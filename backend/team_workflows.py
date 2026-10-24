"""Transactional adapter between contract rules and the existing team inbox.

The workspace row is the lock for routing, timers and delivery admission. No
model runs or external effects happen until the transaction has been committed.
"""

import json
from copy import deepcopy

from fastapi import HTTPException
from sqlalchemy import and_, delete, or_, select, update

from . import team_rules
from .models import (
    AgentRun,
    ResearchProject,
    ResearchWorkflow,
    ResearchWorkspace,
    TeamChannel,
    TeamDelivery,
    TeamMember,
    TeamMessage,
    now,
)


def references(d, workspace):
    members = [
        {
            "id": m.id,
            "name": m.name,
            "kind": "human" if m.role == "human" else "agent",
            "role": "owner" if m.role == "human" else m.role,
            "enabled": m.enabled and not m.deleted,
            "paused": m.paused,
            "subscriptions": m.subscriptions,
        }
        for m in d.scalars(
            select(TeamMember).where(TeamMember.workspace_id == workspace.id)
        )
    ]
    channels = [
        {"id": c.id, "name": c.name, "kind": "dm" if c.member_id else "channel"}
        for c in d.scalars(
            select(TeamChannel).where(
                TeamChannel.workspace_id == workspace.id,
                TeamChannel.archived.is_(False),
            )
        )
    ]
    return members, channels


def pack(source):
    """Upgrade old definitions in place without losing their execution boundary data."""
    if "rules" in source:
        flow, state = team_rules.deduplicate_workflow(
            source, source.get("initial_state")
        )
        if "initial_state" in source:
            flow["initial_state"] = state
        return flow
    flow, state = team_rules.convert_linear_workflow(source)
    return {**flow, "initial_state": state, "execution": deepcopy(source)}


def definition(d, owner, identifier="research", *, workspace=None):
    if workspace and workspace.workflow and workspace.workflow["id"] == identifier:
        return deepcopy(adopt(d, workspace))
    if workspace:
        saved = workspace.workflow_state.get("definitions", {}).get(identifier)
        if saved:
            flow, state = team_rules.deduplicate_workflow(
                saved, workspace.workflow_state
            )
            state["definitions"][identifier] = deepcopy(flow)
            workspace.workflow_state = state
            return flow
    builtins = team_rules.builtin_workflows()
    if identifier in builtins:
        return builtins[identifier]
    row = d.get(ResearchWorkflow, identifier)
    if not row or row.owner != owner:
        raise HTTPException(404, "工作流不存在 / Workflow not found")
    source = pack(
        {
            **row.definition,
            "id": row.id,
            "name": row.name,
            "version": row.version,
            "builtin": False,
        }
    )
    if source != row.definition:
        row.definition = source
    return team_rules.validate_workflow(
        {
            k: source[k]
            for k in ("id", "name", "version", "builtin", "rules", "layout")
            if k in source
        }
    )


def seed(d, workflow):
    if workflow.get("builtin"):
        return team_rules.initial_state(workflow)
    row = d.get(ResearchWorkflow, workflow["id"])
    state = deepcopy((row.definition if row else {}).get("initial_state", {}))
    routing = state.get("linear", {})
    if routing and key(workflow) not in routing:
        state["linear"][key(workflow)] = deepcopy(next(iter(routing.values())))
    return state


def adopt(d, workspace):
    if workspace.workflow:
        flow, state = team_rules.deduplicate_workflow(
            workspace.workflow, workspace.workflow_state
        )
        if flow != workspace.workflow:
            state.setdefault("definitions", {})[flow["id"]] = deepcopy(flow)
            workspace.workflow, workspace.workflow_state = flow, state
        return flow
    flow = definition(d, workspace.owner)
    # The native research template listens in the research channel. Other channels
    # stay available for explicit mentions and rules the owner adds.
    channel = d.scalar(
        select(TeamChannel).where(
            TeamChannel.workspace_id == workspace.id, TeamChannel.key == "experiments"
        )
    )
    if channel:
        for rule in flow["rules"]:
            if rule["when"]["event"] != "schedule":
                rule["when"]["channel"] = channel.id
    workspace.workflow = flow
    workspace.workflow_state = {
        **seed(d, flow),
        **workspace.workflow_state,
        "definitions": {flow["id"]: deepcopy(flow)},
    }
    return flow


def select_workflow(d, workspace, identifier):
    from .research_team import ensure

    ensure(d, workspace)
    if workspace.archived:
        raise HTTPException(409, "团队已归档 / Team archived")
    flow = definition(d, workspace.owner, identifier, workspace=workspace)
    from .models import ResearchSchedule

    launches = {
        f"schedule:{identifier}"
        for identifier in d.scalars(
            select(ResearchSchedule.id).where(
                ResearchSchedule.workspace_id == workspace.id
            )
        )
    }
    flow["rules"] = [
        r
        for r in flow["rules"]
        if not r["id"].startswith("schedule:") or r["id"] in launches
    ]
    members, channels = references(d, workspace)
    flow = team_rules.validate_workflow(flow, members=members, channels=channels)
    state = deepcopy(workspace.workflow_state)
    state.setdefault("linear", {}).update(seed(d, flow).get("linear", {}))
    # A fresh baseline prevents a newly selected timer from replaying old time.
    state.setdefault("last_runs", {}).setdefault(key(flow), {}).update(
        {r["id"]: now() for r in flow["rules"] if r["when"]["event"] == "schedule"}
    )
    # Scheduled launch descriptors follow their rule when the current workflow
    # changes; there is still only one timer and one delivery receipt.
    flow["rules"].extend(
        deepcopy(r)
        for r in workspace.workflow.get("rules", [])
        if r["id"].startswith("schedule:")
        and r["id"] in launches
        and r["id"] not in {x["id"] for x in flow["rules"]}
    )
    definitions = state.setdefault("definitions", {})
    definitions[workspace.workflow["id"]] = deepcopy(workspace.workflow)
    definitions[flow["id"]] = deepcopy(flow)
    workspace.workflow, workspace.workflow_state = flow, state
    return flow


def key(workflow):
    return json.dumps([workflow["id"], workflow["version"]], separators=(",", ":"))


def save(d, workspace, body, *, sync_launches=True):
    from .research_team import ensure

    ensure(d, workspace)
    old = workspace.workflow
    if workspace.archived and sync_launches:
        raise HTTPException(409, "团队已归档 / Team archived")
    members, channels = references(d, workspace)
    flow = team_rules.validate_workflow(body, members=members, channels=channels)
    if (old["id"], old["version"]) != (flow["id"], flow["version"]):
        raise HTTPException(409, "工作流已经更新 / Workflow changed")
    flow["version"] += 1
    state = deepcopy(workspace.workflow_state)
    # Editing a layout or instruction must not reset the linear cursor or a review.
    for scope in state.get("threads", {}).values():
        if key(old) in scope["workflows"]:
            scope["workflows"][key(flow)] = deepcopy(scope["workflows"][key(old)])
    if key(old) in state.get("linear", {}):
        state["linear"][key(flow)] = deepcopy(state["linear"][key(old)])
    prior = state.get("last_runs", {}).get(key(old), {})
    old_rules = {r["id"]: r for r in old["rules"]}
    state.setdefault("last_runs", {})[key(flow)] = {
        r["id"]: prior.get(r["id"], now()) if old_rules.get(r["id"]) == r else now()
        for r in flow["rules"]
        if r["when"]["event"] == "schedule"
    }
    from .models import ResearchSchedule, ResearchScheduleRun

    new_rules = {r["id"]: r for r in flow["rules"]}
    for rid, previous in old_rules.items():
        if not sync_launches or not rid.startswith("schedule:"):
            continue
        item = d.get(ResearchSchedule, rid[9:])
        if not item or item.workspace_id != workspace.id:
            continue
        if rid not in new_rules or new_rules[rid]["when"]["event"] != "schedule":
            d.execute(
                delete(ResearchScheduleRun).where(
                    ResearchScheduleRun.schedule_id == item.id
                )
            )
            d.delete(item)
        elif new_rules[rid] != previous:
            rule = new_rules[rid]
            item.paused = not rule["enabled"]
            item.prompt = rule["then"].get("instruction", item.prompt)
            if rule["when"]["event"] == "schedule":
                item.timezone = rule["when"]["timezone"]
                if rule["when"] != previous["when"]:
                    item.next_run_at = team_rules.next_cron(
                        rule["when"]["cron"], item.timezone, now()
                    ).isoformat()
    state.setdefault("definitions", {})[flow["id"]] = deepcopy(flow)
    workspace.workflow, workspace.workflow_state = flow, state
    return flow


def event(
    d,
    workspace,
    message,
    *,
    trigger="message",
    author=None,
    kind=None,
    workflow=None,
    rules=None,
    enqueue=True,
):
    """Must be called under ensure()/lock_workspace; state and inbox commit together."""
    members, _ = references(d, workspace)
    flow = deepcopy(workflow or adopt(d, workspace))
    if rules is not None:
        flow["rules"] = [r for r in flow["rules"] if r["id"] in rules]
    author = (
        author
        if author is not None
        else next((m for m in members if m["id"] == message.author_id), None)
    )
    data = getattr(message, "data", {})
    incoming = dict(
        type=trigger,
        team=workspace.id,
        channel=message.channel_id,
        thread=message.thread_id,
        author=author,
        kind=kind
        or (message.kind if message.kind in team_rules.KINDS.__args__ else "text"),
        mentions=message.mentions or [],
        at=message.created_at or now(),
        scope=data.get("routing_scope"),
        pending_members=[row.member_id for row in unstarted(d, message)],
        original_author=next(
            (m for m in members if m["id"] == data.get("decision_author_id")),
            None,
        ),
    )
    state = deepcopy(workspace.workflow_state)
    state.setdefault("snapshots", {}).setdefault(
        key(flow),
        deepcopy(
            workspace.workflow
            if key(flow) == key(workspace.workflow)
            else workflow or flow
        ),
    )
    state.setdefault("linear", {}).update(
        {
            k: v
            for k, v in seed(d, flow).get("linear", {}).items()
            if k not in state.get("linear", {})
        }
    )
    actions, state = team_rules.match(flow, incoming, state, members=members)
    fired = state.setdefault("fired", [])
    fired.extend(
        {
            "rule": a["rule"],
            "at": now(),
            "workflow": flow["id"],
            "version": flow["version"],
        }
        for a in actions
    )
    state["fired"] = fired[-100:]
    workspace.workflow_state = state
    if enqueue:
        apply(d, workspace, message, flow, actions)
    return actions


def provenance(flow, action):
    return {
        "rule": action["rule"],
        "workflow": flow["id"],
        "workflow_version": flow["version"],
    }


def unstarted(d, message):
    if message.thread_id is None and getattr(message, "id", None) is None:
        return []  # Timer events have no message or thread to merge.
    return list(
        d.scalars(
            select(TeamDelivery)
            .join(TeamMessage)
            .outerjoin(
                AgentRun,
                AgentRun.id == TeamDelivery.run_id,
            )
            .where(
                TeamMessage.channel_id == message.channel_id,
                TeamMessage.thread_id == message.thread_id,
                or_(
                    and_(
                        TeamDelivery.status == "queued", TeamDelivery.run_id.is_(None)
                    ),
                    and_(TeamDelivery.status == "running", AgentRun.status == "queued"),
                ),
            )
            .order_by(TeamDelivery.created_at, TeamDelivery.id)
        )
    )


def apply(d, workspace, message, flow, actions):
    for action in actions:
        metadata = provenance(flow, action)
        if action["action"] in {"wake", "review"}:
            existing = d.scalar(
                select(TeamDelivery).where(
                    TeamDelivery.message_id == message.id,
                    TeamDelivery.member_id == action["member"],
                )
            )
            if not existing:
                existing = next(
                    (
                        row
                        for row in unstarted(d, message)
                        if row.member_id == action["member"]
                    ),
                    None,
                )
                if existing:
                    merged = list(existing.action.get("merged_messages", []))
                    if message.id in merged:
                        continue
                    merged_action = {
                        **existing.action,
                        "merged_messages": [*merged, message.id],
                    }
                    if action["action"] == "review":
                        merged_action.update(action, **metadata)
                    merged_action["instruction"] = "\n\n".join(
                        dict.fromkeys(
                            text
                            for text in (
                                existing.action.get("instruction"),
                                action.get("instruction"),
                            )
                            if text
                        )
                    )
                    if existing.run_id:
                        from .team_member_context import trigger_text

                        run = d.get(AgentRun, existing.run_id)
                        extra = trigger_text(d, d.get(TeamMessage, message.id))
                        if action.get("instruction"):
                            extra += "\n\nRule instruction:\n" + action["instruction"]
                        changed = d.execute(
                            update(AgentRun)
                            .where(
                                AgentRun.id == run.id,
                                AgentRun.status == "queued",
                            )
                            .values(
                                prompt=run.prompt + "\n\n" + extra,
                                attachment_ids=list(
                                    dict.fromkeys(
                                        [
                                            *run.attachment_ids,
                                            *(
                                                a["id"]
                                                for a in message.data.get(
                                                    "attachments", []
                                                )
                                            ),
                                        ]
                                    )
                                ),
                                runtime={
                                    **run.runtime,
                                    "team": {**run.runtime["team"], **merged_action},
                                },
                            )
                        )
                        if not changed.rowcount:
                            existing = None
                    if existing:
                        existing.action = merged_action
                        if message.data.get("mode") == "immediate":
                            existing.mode = "immediate"
                        continue
            if not existing:
                d.add(
                    TeamDelivery(
                        message_id=message.id,
                        member_id=action["member"],
                        mode=message.data.get("mode", "queue"),
                        action={**action, **metadata},
                    )
                )
        else:
            d.add(
                TeamMessage(
                    workspace_id=workspace.id,
                    channel_id=action.get("channel", message.channel_id),
                    thread_id=(
                        action.get("thread")
                        if action.get("channel", message.channel_id)
                        == message.channel_id
                        else None
                    ),
                    kind=(
                        "member_paused"
                        if action["action"] == "skip"
                        else "relay_limit"
                        if action["action"] in {"wait_for_owner", "limit"}
                        else "text"
                    ),
                    text=action.get("text") or "",
                    data={
                        **metadata,
                        "reason": action.get("reason"),
                        "paused_member": action.get("member")
                        if action["action"] == "skip"
                        else None,
                        "limit": action.get("limit"),
                        "waiting": action["action"] == "wait_for_owner",
                        "rule_event_pending": action["action"] == "post",
                    },
                    mentions=[
                        m.id
                        for m in d.scalars(
                            select(TeamMember).where(
                                TeamMember.workspace_id == workspace.id,
                                TeamMember.role == "human",
                            )
                        )
                    ]
                    if action["action"] in {"wait_for_owner", "limit"}
                    else [],
                )
            )
    d.flush()


def route_message(d, workspace, message, *, trigger="message"):
    from types import SimpleNamespace

    from .research_team import active_run, channel_of

    if message.data.get("mode") == "record":
        return []
    channel = channel_of(d, workspace, message.channel_id)
    tagged = list(message.mentions or [])
    author = d.get(TeamMember, message.author_id) if message.author_id else None
    if author and author.role != "human" and not message.data.get("research_forwarded"):
        # Agents wake members only by naming them in `to`; @ in their text is a
        # reference. Mentions of the researcher still notify.
        human = [i for i in tagged if d.get(TeamMember, i).role == "human"]
        tagged = [*message.data.get("to", []), *human]
    if channel.member_id and author and author.role == "human" and not tagged:
        tagged = [channel.member_id]
    flow = None
    thread = message.thread_id
    if thread and thread.startswith("research:"):
        project = d.get(ResearchProject, thread[9:])
        from .research_workflows import adopt_project

        adopt_project(d, project)
        flow = project.workflow
        workspace.workflow_state = prime(
            project,
            workspace.workflow_state,
            channel.id,
            workspace.id,
            references(d, workspace)[0],
        )
        if (
            author
            and author.role == "human"
            and message.data.get("mode") == "immediate"
            and not tagged
        ):
            # Address the currently working member through an implicit mention;
            # admission and the configurable relay limit still belong to match().
            tagged = [
                m.id
                for m in d.scalars(
                    select(TeamMember).where(TeamMember.workspace_id == workspace.id)
                )
                if active_run(d, m) and m.role != "human"
            ][:1]
    proxy = SimpleNamespace(
        id=message.id,
        channel_id=message.channel_id,
        thread_id=thread,
        author_id=message.author_id,
        mentions=tagged,
        kind=message.kind,
        created_at=message.created_at,
        data=message.data,
    )
    if message.data.get("waiting"):
        flow = deepcopy(flow or workspace.workflow)
        flow["rules"] = [
            {
                "id": "owner-question",
                "enabled": True,
                "when": {"event": "conclusion_proposed"},
                "then": {"action": "wait_for_owner"},
            }
        ]
        trigger = "conclusion_proposed"
    return event(
        d,
        workspace,
        proxy,
        trigger="conclusion_proposed" if message.kind == "conclusion" else trigger,
        workflow=flow,
    )


def prime(project, state, channel, team, members=None):
    """Resume migrated stages at their current rule cursor, without replaying history."""
    scope = json.dumps(
        [
            team,
            channel,
            f"research:{project.id}" if project.workspace_id else project.id,
        ],
        separators=(",", ":"),
    )
    wk = key(project.workflow)
    if wk in state.get("threads", {}).get(scope, {}).get("workflows", {}):
        return state
    from .research_workflows import execution, is_native

    native = is_native(project)
    steps = execution(project).get("steps", [])
    step_states = (project.workflow_state or {}).get("steps", [])
    index = (project.workflow_state or {}).get("current", 0)
    if native:
        cursor = {
            "scoping": "start",
            "experiments": "step:1",
            "conclusion": "confirm:1",
            "retrospective": "step:2",
            "done": "done",
        }.get(project.stage, "start")
    else:
        prepared = -1
        mapped = {}
        for i, spec in enumerate(steps):
            merged = (
                spec.get("action") == "conclusion"
                and i > 0
                and steps[i - 1]["type"] == "experiment"
            )
            if not merged:
                prepared += 1
            mapped[i] = prepared
        position = mapped.get(index, index)
        item = step_states[index] if index < len(step_states) else {}
        cursor = (
            "start" if index == 0 and not item.get("rounds") else f"step:{position}"
        )
        if (
            index < len(steps)
            and steps[index].get("action") == "conclusion"
            or item.get("status") == "waiting"
        ):
            cursor = f"confirm:{position}"
        if index >= len(steps) and steps:
            cursor = "done"
    state = deepcopy(state)
    partition = state.setdefault("threads", {}).setdefault(
        scope, {"relay": 0, "waiting": False, "workflows": {}}
    )
    reviews = {}
    if not native and members:
        routes = state.get("linear", {}).get(wk, {})
        for i, spec in enumerate(steps):
            if spec["type"] != "review":
                continue
            target = f"step:{mapped[i]}"
            for rule in project.workflow["rules"]:
                then = rule["then"]
                if then["action"] != "review" or not any(
                    route.get("to") == target
                    for route in team_rules.route_options(routes.get(rule["id"]))
                ):
                    continue
                if reviews.get(rule["id"], {}).get("pending"):
                    continue
                reviews[rule["id"]] = {
                    "reviewer": team_rules._resolve(
                        then.get("member") or then["role"],
                        members,
                        role=not bool(then.get("member")),
                    ),
                    "on_fail": team_rules._resolve(then["on_fail"], members),
                    "returns": (
                        step_states[i].get("retries", 0) if i < len(step_states) else 0
                    ),
                    "cursor": target,
                    "pending": i == index and project.status == "active",
                }
    partition["workflows"][wk] = {"counts": {}, "reviews": reviews, "cursor": cursor}
    return state


def research_event(
    d, project, trigger, *, role=None, kind="text", text="", source=None
):
    """Research side effects stay in their tools; only rules choose the next actor."""
    from types import SimpleNamespace

    from . import research_workflows

    research_workflows.adopt_project(d, project)
    flow = project.workflow
    workspace = (
        d.get(ResearchWorkspace, project.workspace_id) if project.workspace_id else None
    )
    if workspace:
        from .research_team import ensure, stable

        ensure(d, workspace)
        members, _ = references(d, workspace)
        channel_id = stable(workspace, "experiments")
        author = next((m for m in members if m["role"] == role), None)
        state = deepcopy(workspace.workflow_state)
        state.setdefault("linear", {}).update(
            {
                k: v
                for k, v in project.workflow_state.get("rule_state", {})
                .get("linear", {})
                .items()
                if k not in state.get("linear", {})
            }
        )
        workspace.workflow_state = prime(
            project, state, channel_id, workspace.id, members
        )
        message = SimpleNamespace(
            channel_id=channel_id,
            thread_id=f"research:{project.id}",
            author_id=author["id"] if author else None,
            mentions=[],
            kind=kind,
            created_at=now(),
        )
        actions = event(
            d,
            workspace,
            message,
            trigger=trigger,
            author=author,
            kind=kind,
            workflow=flow,
            enqueue=False,
        )
    else:
        members = [
            {
                "id": r,
                "name": r,
                "kind": "human" if r == "owner" else "agent",
                "role": r,
            }
            for r in (
                "owner",
                "advisor",
                "executor",
                "librarian",
                "reviewer",
                "writer",
                "distiller",
            )
        ]
        author = next((m for m in members if m["role"] == role), None)
        state = prime(
            project,
            project.workflow_state.get("rule_state", seed(d, flow)),
            "research",
            project.id,
            members,
        )
        actions, state = team_rules.match(
            flow,
            dict(
                type=trigger,
                team=project.id,
                channel="research",
                thread=project.id,
                author=author,
                kind=kind,
                mentions=[],
                at=now(),
            ),
            state,
            members=members,
        )
        project.workflow_state = {**project.workflow_state, "rule_state": state}
    state = deepcopy(project.workflow_state)
    state["pending_actions"] = [{**a, **provenance(flow, a)} for a in actions]
    if source:
        state["routed_source"] = source
    project.workflow_state = state
    if workspace and actions:
        for action in actions:
            if action["action"] in {"post", "wait_for_owner", "limit", "skip"}:
                waiting = action["action"] == "wait_for_owner"
                stopped = action["action"] in {"wait_for_owner", "limit"}
                d.add(
                    TeamMessage(
                        workspace_id=workspace.id,
                        channel_id=action.get("channel", channel_id),
                        thread_id=(
                            action.get("thread")
                            if action.get("channel", channel_id) == channel_id
                            else None
                        ),
                        kind="member_paused"
                        if action["action"] == "skip"
                        else "relay_limit"
                        if stopped
                        else "text",
                        text=action.get("text") or "",
                        mentions=[m["id"] for m in members if m["role"] == "owner"]
                        if stopped
                        else [],
                        data={
                            **provenance(flow, action),
                            "waiting": waiting,
                            "reason": action.get("reason"),
                            "paused_member": action.get("member")
                            if action["action"] == "skip"
                            else None,
                            "limit": action.get("limit"),
                            "rule_event_pending": action["action"] == "post",
                        },
                    )
                )
    return actions


def pending(project):
    return next(
        (
            a
            for a in (project.workflow_state or {}).get("pending_actions", [])
            if a["action"] in {"wake", "review"}
        ),
        None,
    )


def next_research_action(d, project, history, suggested, *, scoping=False):
    """Translate research evidence/cadence to a message kind; rules choose who runs."""
    from .research_worker import _last_human_message
    from .research_workflows import current, is_native

    adopt = not project.workflow or "rules" not in project.workflow
    if adopt:
        from .research_workflows import adopt_project

        adopt_project(d, project)
    action = pending(project)
    if action:
        return action
    latest = history[-1] if history else None
    human = _last_human_message(d, project)
    source = f"{latest.id if latest else 'start'}:{human or ''}:{project.stage}"
    if project.workflow_state.get("routed_source") == source:
        return None
    if scoping:
        trigger, role, kind = "message", "owner", "text"
    elif not latest or latest.role == "scoping":
        trigger, role, kind = "plan_approved", "owner", "plan"
        if (current(project) and current(project)["type"] == "agent") or (
            not is_native(project) and project.stage == "workflow"
        ):
            trigger, kind = "message", "text"
    elif human and latest.created_at < human:
        trigger, role, kind = "message", "owner", "text"
    else:
        role = {"workflow": "executor", "review": "advisor"}.get(
            latest.role, latest.role
        )
        spec = current(project)
        if spec and spec["type"] in {"agent", "review"}:
            role = spec.get("role", role)
            trigger, kind = "message", "text"
        else:
            trigger, kind = (
                "message",
                (
                    "review"
                    if role == "advisor"
                    else "result"
                    if suggested == "advisor"
                    else "text"
                ),
            )
        if role == "advisor":
            from .research_worker import _events

            if any(
                e.action == "drift_judged" and not e.detail.get("on_track")
                for e in _events(d, latest)
            ):
                trigger = "review_failed"
        # A completed waiting_on group resumes its executor, exactly once.
        if latest.waiting_on:
            trigger, role, kind = "job_finished", None, "result"
    actions = research_event(d, project, trigger, role=role, kind=kind, source=source)
    if any(a["action"] == "wait_for_owner" for a in actions):
        project.status = "waiting"
    elif any(a["action"] == "limit" for a in actions):
        project.status = "paused"
    return pending(project)


def action_role(d, project, action, fallback):
    if not action:
        return None
    member = d.get(TeamMember, action["member"])
    role = member.role if member else action["member"]
    if role == "advisor" and project.stage == "scoping":
        return "scoping"
    from .research_workflows import current

    spec = current(project)
    if spec and spec["type"] in {"agent", "review"}:
        return "review" if action["action"] == "review" else "workflow"
    return role


def consumed(project):
    actions = list(project.workflow_state.get("pending_actions", []))
    first = pending(project)
    if first:
        actions.remove(first)
    project.workflow_state = {
        **project.workflow_state,
        "pending_actions": [a for a in actions if a["action"] in {"wake", "review"}],
    }
