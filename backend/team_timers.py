"""The schedule center and workflow canvas share one rule dispatcher.

ResearchSchedule retains launch options/history and anchored hour intervals that
five-field cron cannot express. It never wakes a runner without match().
"""

from copy import deepcopy
from datetime import UTC, datetime
from types import SimpleNamespace

from sqlalchemy import select

from . import team_rules, team_workflows as flows
from .models import ResearchSchedule, ResearchWorkspace, TeamMessage, now


def rule_id(item):
    return f"schedule:{item.id}"


def cron(item):
    hour, minute = map(int, item.local_time.split(":"))
    if item.frequency == "interval":
        # Exact phase/long intervals are the legacy launch descriptor's gate.
        return "* * * * *"
    return f"{minute} {hour} * * {(item.weekday + 1) % 7 if item.frequency == 'weekly' else '*'}"


def sync(d, item, *, remove=False):
    from .research_team import ensure

    workspace = d.get(ResearchWorkspace, item.workspace_id)
    ensure(d, workspace)
    flow = deepcopy(workspace.workflow)
    rid = rule_id(item)
    old = next((r for r in flow["rules"] if r["id"] == rid), None)
    flow["rules"] = [r for r in flow["rules"] if r["id"] != rid]
    if not remove:
        flow["rules"].append(
            {
                "id": rid,
                "enabled": not item.paused,
                "when": {
                    "event": "schedule",
                    "cron": cron(item),
                    "timezone": item.timezone,
                },
                "then": {
                    "action": "wake",
                    "role": "advisor",
                    "instruction": item.prompt,
                },
                **({"position": old["position"]} if old and "position" in old else {}),
            }
        )
    flows.save(d, workspace, flow, sync_launches=False)


def adopt(d, workspace):
    """Idempotent lazy upgrade for schedules made before 0045."""
    existing = {r["id"] for r in workspace.workflow["rules"]}
    for item in d.scalars(
        select(ResearchSchedule).where(ResearchSchedule.workspace_id == workspace.id)
    ):
        if rule_id(item) not in existing:
            sync(d, item)


def center_rows(d, owner):
    """Pure rule timers also appear in the schedule center, linked to the editor."""
    rows = []
    for workspace in d.scalars(
        select(ResearchWorkspace).where(ResearchWorkspace.owner == owner)
    ):
        from .research_team import ensure

        ensure(d, workspace)
        adopt(d, workspace)
        for rule in workspace.workflow["rules"]:
            if rule["when"]["event"] != "schedule":
                continue
            rid = rule["id"]
            next_at = team_rules.next_cron(
                rule["when"]["cron"], rule["when"]["timezone"], now()
            ).isoformat()
            rows.append(
                {
                    "id": f"rule:{workspace.id}:{rid}",
                    "title": rule["then"].get("instruction") or rid,
                    "prompt": rule["then"].get("instruction", ""),
                    "workspace_id": workspace.id,
                    "destination": "existing",
                    "research_id": None,
                    "workflow_id": workspace.workflow["id"],
                    "frequency": "daily",
                    "local_time": "09:00",
                    "weekday": 0,
                    "interval_hours": 4,
                    "timezone": rule["when"]["timezone"],
                    "paused": not rule["enabled"],
                    "next_run_at": next_at,
                    "created_at": workspace.created_at,
                    "updated_at": workspace.updated_at,
                    "rule": rid,
                    "cron": rule["when"]["cron"],
                    "editor_url": f"team/{workspace.id}/settings?thread=rule%3A{workspace.workflow['id']}%3A{workspace.workflow['version']}%3A{rid}",
                }
            )
    return rows


def route(d, workspace, rule, at, *, thread=None, manual=False):
    from .research_team import stable

    proxy = SimpleNamespace(
        channel_id=rule["when"].get("channel") or stable(workspace, "experiments"),
        thread_id=thread,
        author_id=None,
        mentions=[],
        kind="text",
        created_at=at.isoformat(),
    )
    ready = {
        **workspace.workflow,
        "rules": [{**rule, "enabled": True} if manual else rule],
    }
    return flows.event(
        d, workspace, proxy, trigger="schedule", workflow=ready, enqueue=False
    )


def run_legacy(settings, d, item, at, *, manual=False):
    """Retain the schedule run receipt and launcher; rules control admission."""
    from .research_schedules import deliver, next_time, stamp
    from .models import ResearchScheduleRun
    from .research_team import ensure

    workspace = d.get(ResearchWorkspace, item.workspace_id)
    ensure(d, workspace)
    d.refresh(item)
    adopt(d, workspace)
    rule = next(
        (r for r in workspace.workflow["rules"] if r["id"] == rule_id(item)), None
    )
    if not rule or (
        not manual and (not rule["enabled"] or item.next_run_at > stamp(at))
    ):
        return None
    scheduled_for = stamp(at) if manual else item.next_run_at
    if not manual:
        item.next_run_at = (
            next_time(item, at, item.next_run_at)
            if item.frequency == "interval" and rule["when"]["cron"] == "* * * * *"
            else stamp(
                team_rules.next_cron(rule["when"]["cron"], rule["when"]["timezone"], at)
            )
        )
    state = deepcopy(workspace.workflow_state)
    state.setdefault("last_runs", {}).setdefault(flows.key(workspace.workflow), {})[
        rule["id"]
    ] = stamp(at)
    workspace.workflow_state = state
    record = ResearchScheduleRun(
        schedule_id=item.id,
        trigger="manual" if manual else "scheduled",
        scheduled_for=scheduled_for,
        started_at=stamp(at),
    )
    d.add(record)
    d.flush()
    try:
        default_launch = (
            rule["then"]["action"] == "wake" and rule["then"].get("role") == "advisor"
        )
        project_id = item.research_id
        members, _ = flows.references(d, workspace)
        advisor_paused = default_launch and any(
            m["role"] == "advisor" and m.get("paused") for m in members
        )
        if advisor_paused:
            actions = route(
                d,
                workspace,
                rule,
                at,
                thread=f"research:{project_id}" if project_id else None,
                manual=manual,
            )
            from .research_team import stable

            message = TeamMessage(
                workspace_id=workspace.id,
                channel_id=rule["when"].get("channel")
                or stable(workspace, "experiments"),
                thread_id=f"research:{project_id}" if project_id else None,
                text=item.prompt,
                kind="text",
                data={"timer": rule["id"]},
            )
            d.add(message)
            d.flush()
            flows.apply(d, workspace, message, workspace.workflow, actions)
        elif default_launch and item.destination == "new":
            # Allocate the final research thread before routing its timer. New
            # research launches each get their own relay/count partition.
            with d.begin_nested():
                project_id = deliver(settings, d, item)
                actions = route(
                    d,
                    workspace,
                    rule,
                    at,
                    thread=f"research:{project_id}",
                    manual=manual,
                )
                if not any(a["action"] in {"wake", "review"} for a in actions):
                    raise ValueError("等你 / Waiting for you")
                record.research_id = project_id
        else:
            actions = route(
                d,
                workspace,
                rule,
                at,
                thread=f"research:{project_id}" if project_id else None,
                manual=manual,
            )
            if default_launch and any(
                a["action"] in {"wake", "review"} for a in actions
            ):
                with d.begin_nested():
                    from .models import ResearchProject

                    project = d.get(ResearchProject, project_id)
                    if project:
                        project.workflow_state = {
                            **project.workflow_state,
                            "pending_actions": [
                                *project.workflow_state.get("pending_actions", []),
                                *[
                                    {**a, **flows.provenance(workspace.workflow, a)}
                                    for a in actions
                                ],
                            ],
                        }
                    record.research_id = deliver(settings, d, item)
            else:
                from .research_team import stable

                message = TeamMessage(
                    workspace_id=workspace.id,
                    channel_id=rule["when"].get("channel")
                    or stable(workspace, "experiments"),
                    thread_id=f"research:{project_id}" if project_id else None,
                    kind="text",
                    text=rule["then"].get("instruction") or item.prompt,
                    data={"timer": rule["id"]},
                )
                d.add(message)
                d.flush()
                flows.apply(d, workspace, message, workspace.workflow, actions)
                record.research_id = project_id
        record.status = (
            "succeeded"
            if actions
            and any(a["action"] not in {"wait_for_owner", "skip"} for a in actions)
            else "failed"
        )
        if record.status == "failed":
            record.error = (
                "成员暂停中 / Member paused"
                if any(a["action"] == "skip" for a in actions)
                else "等你 / Waiting for you"
            )
    except Exception as exc:  # noqa: BLE001 — persist failed delivery receipts
        record.status, record.error = "failed", str(exc)[:2000] or type(exc).__name__
    record.finished_at = now()
    return record


def tick(settings, maker, at=None):
    if settings.mode != "local":
        return
    at = at or datetime.now(UTC)
    with maker() as d:
        identifiers = list(d.scalars(select(ResearchWorkspace.id)))
    for identifier in identifiers:
        with maker() as d:
            from .research_team import ensure, stable

            workspace = d.get(ResearchWorkspace, identifier)
            ensure(d, workspace)
            from .team_reminders import deliver_due

            deliver_due(d, workspace, at)
            adopt(d, workspace)
            from .research_schedules import stamp

            flow = workspace.workflow
            members, _ = flows.references(d, workspace)
            last_runs = workspace.workflow_state.get("last_runs", {}).get(
                flows.key(flow), {}
            )
            planned = team_rules.due(flow, at, last_runs, members=members)
            due_ids = {a["rule"] for a in planned}
            legacy = {
                rule_id(s): s
                for s in d.scalars(
                    select(ResearchSchedule).where(
                        ResearchSchedule.workspace_id == identifier
                    )
                )
            }
            # Existing exact intervals and imported overdue timestamps retain their
            # phase; they join the same rule claim/dispatch loop.
            due_ids.update(
                rid for rid, item in legacy.items() if item.next_run_at <= stamp(at)
            )
            for rule in flow["rules"]:
                if rule["id"] not in due_ids or not rule["enabled"]:
                    continue
                if rule["id"] in legacy:
                    item = legacy[rule["id"]]
                    if item.next_run_at <= stamp(at):
                        run_legacy(settings, d, item, at)
                    continue
                if workspace.archived:
                    continue
                state = deepcopy(workspace.workflow_state)
                state.setdefault("last_runs", {}).setdefault(flows.key(flow), {})[
                    rule["id"]
                ] = at.isoformat()
                workspace.workflow_state = state
                try:
                    with d.begin_nested():
                        actions = route(d, workspace, rule, at)
                        message = TeamMessage(
                            workspace_id=workspace.id,
                            channel_id=rule["when"].get("channel")
                            or stable(workspace, "experiments"),
                            text=rule["then"].get("instruction") or rule["id"],
                            kind="text",
                            data={"timer": rule["id"]},
                        )
                        d.add(message)
                        d.flush()
                        flows.apply(d, workspace, message, flow, actions)
                except ValueError as exc:
                    state = deepcopy(workspace.workflow_state)
                    state.setdefault("timer_errors", {})[rule["id"]] = str(exc)[:500]
                    workspace.workflow_state = state
            d.commit()
