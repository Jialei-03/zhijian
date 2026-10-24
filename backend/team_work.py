"""Human work board and attention ledger, projected without writes or routing."""

import json
from datetime import UTC, datetime
from statistics import median

from sqlalchemy import or_, select

from .models import (
    AgentRun,
    AgentSession,
    ResearchEvent,
    ResearchProject,
    ResearchSprint,
    TeamChannel,
    TeamDelivery,
    TeamMember,
    TeamMessage,
    now,
)

GROUPS = ("waiting", "review", "working", "queued", "done")
# A human-only badge, never an execution timeout or a routing condition.
STUCK_WAIT_SECONDS = 3600


def stamp(value):
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.replace(tzinfo=parsed.tzinfo or UTC).timestamp()
    except (ValueError, TypeError, AttributeError):
        return None


def union_seconds(intervals):
    end, total = float("-inf"), 0
    for start, stop in sorted(intervals):
        total += max(0, stop - max(start, end))
        end = max(end, stop)
    return total


def metrics(asks, spans, through, *, partial=False):
    intervals, answered = [], []
    for ask in asks:
        start, stop = stamp(ask["start"]), stamp(ask["end"]) if ask["end"] else through
        if start is None or stop is None:
            partial = True
            continue
        stop = min(through, max(start, stop))
        intervals.append((start, stop))
        if (
            ask["end"]
            and not ask.get("estimated_end")
            and not ask.get("estimated_start")
        ):
            answered.append(stop - start)
    duration = union_seconds(spans + intervals)
    waiting = union_seconds(intervals)
    return {
        "asks": len(asks),
        "pending": sum(not ask["end"] for ask in asks),
        "median_wait_seconds": median(answered) if answered else None,
        "waiting_seconds": waiting,
        "total_seconds": duration,
        "waiting_share": waiting / duration if duration else None,
        "partial": partial or any(ask["partial"] for ask in asks),
    }


def project(d, workspace, *, through=None):
    from .research_team import plain_text, stable

    generated_at = through or now()
    clock = stamp(generated_at)
    members = list(
        d.scalars(select(TeamMember).where(TeamMember.workspace_id == workspace.id))
    )
    by_member = {m.id: m for m in members}
    channels = {
        c.id: c
        for c in d.scalars(
            select(TeamChannel).where(TeamChannel.workspace_id == workspace.id)
        )
    }
    messages = list(
        d.scalars(
            select(TeamMessage)
            .where(TeamMessage.workspace_id == workspace.id)
            .order_by(TeamMessage.created_at, TeamMessage.id)
        )
    )
    by_message = {m.id: m for m in messages}
    projects = list(
        d.scalars(
            select(ResearchProject).where(
                ResearchProject.workspace_id == workspace.id,
                ResearchProject.owner == workspace.owner,
            )
        )
    )
    by_project = {p.id: p for p in projects}
    sessions = {m.session_id: m.id for m in members if m.session_id}
    project_sessions = {p.session_id: p.id for p in projects}
    runs = list(
        d.scalars(
            select(AgentRun).where(
                AgentRun.owner == workspace.owner,
                or_(
                    AgentRun.session_id.in_([*sessions, *project_sessions]),
                    AgentRun.session_id.in_(
                        select(AgentSession.id).where(
                            AgentSession.workspace_id == workspace.id
                        )
                    ),
                    AgentRun.runtime["team"]["workspace_id"].as_string()
                    == workspace.id,
                ),
            )
        )
    )
    by_run = {r.id: r for r in runs}
    sprints = {
        s.id: s
        for s in d.scalars(
            select(ResearchSprint).where(ResearchSprint.project_id.in_(by_project))
        )
    }
    sprint_runs = {s.run_id: s for s in sprints.values()}
    events = list(
        d.scalars(
            select(ResearchEvent)
            .where(ResearchEvent.project_id.in_(by_project))
            .order_by(ResearchEvent.created_at, ResearchEvent.id)
        )
    )
    human = {m.id for m in members if m.role == "human"}
    experiment_channel = next(
        (c.id for c in channels.values() if c.key == "experiments"),
        stable(workspace, "experiments"),
    )
    scopes = {}

    def scope(channel, thread):
        return scopes.setdefault(
            (channel, thread),
            {
                "channel_id": channel,
                "thread_id": thread,
                "runs": [],
                "deliveries": [],
                "messages": [],
                "reviews": [],
                "waiting": False,
                "project": None,
            },
        )

    def location_of(channel, thread, routing=None):
        if (
            isinstance(routing, list)
            and len(routing) == 3
            and routing[0] == workspace.id
            and routing[1] in channels
            and (routing[2] is None or isinstance(routing[2], str))
        ):
            return routing[1], routing[2]
        return channel, thread

    def message_location(message):
        return location_of(
            message.channel_id, message.thread_id, message.data.get("routing_scope")
        )

    def role_member(role):
        role = {
            "scoping": "advisor",
            "discussion": "advisor",
            "review": "advisor",
            "workflow": "executor",
        }.get(role, role)
        found = [m.id for m in members if m.role == role and m.role != "human"]
        return found[0] if len(found) == 1 else None

    for p in projects:
        scope(experiment_channel, f"research:{p.id}")["project"] = p
    for m in messages:
        scope(*message_location(m))["messages"].append(m)
    run_locations = {}
    for run in runs:
        runtime = run.runtime or {}
        origin, research = runtime.get("team", {}), runtime.get("research", {})
        sprint = sprint_runs.get(run.id)
        pid = (
            research.get("project_id")
            or (sprint.project_id if sprint else None)
            or project_sessions.get(run.session_id)
        )
        if origin.get("workspace_id") not in (None, workspace.id):
            continue
        if origin.get("channel_id") in channels:
            location = location_of(
                origin["channel_id"],
                origin.get("thread_id"),
                origin.get("routing_scope"),
            )
            member = origin.get("member_id") or sessions.get(run.session_id)
        elif pid in by_project:
            location = (experiment_channel, f"research:{pid}")
            member = research.get("member_id") or role_member(
                research.get("role") or (sprint.role if sprint else "advisor")
            )
        else:
            response = next(
                (m for m in messages if m.data.get("run_id") == run.id), None
            )
            if not response:
                session = d.get(AgentSession, run.session_id)
                advisor = role_member("advisor")
                direct = next(
                    (c for c in channels.values() if c.member_id == advisor), None
                )
                if (
                    not session
                    or session.kind not in {"project_lead", "project_chat"}
                    or not direct
                ):
                    continue
                location, member = (direct.id, f"legacy:{run.id}"), advisor
            else:
                location, member = (
                    message_location(response),
                    response.author_id,
                )
        run_locations[run.id] = (*location, member)
        scope(*location)["runs"].append((run, member))
    for delivery in d.scalars(
        select(TeamDelivery)
        .join(TeamMessage)
        .where(TeamMessage.workspace_id == workspace.id)
    ):
        m = by_message[delivery.message_id]
        target = scope(*message_location(m))
        target["deliveries"].append(delivery)
        if delivery.run_id in by_run and delivery.run_id not in run_locations:
            target["runs"].append((by_run[delivery.run_id], delivery.member_id))
    for key, state in (workspace.workflow_state or {}).get("threads", {}).items():
        try:
            wid, channel, thread = json.loads(key)
        except (ValueError, TypeError):
            continue
        if wid != workspace.id or channel not in channels:
            continue
        target = scope(channel, thread)
        target["waiting"] = bool(state.get("waiting"))
        target["reviews"] = [
            review
            for flow in state.get("workflows", {}).values()
            for review in flow.get("reviews", {}).values()
            if review.get("pending")
        ]

    asks = []
    for target in list(scopes.values()):
        pending = []
        for m in target["messages"]:
            if m.author_id in human:
                for ask in pending:
                    ask["end"] = m.created_at
                pending = []
            elif (
                m.data.get("waiting")
                and not m.data.get("event_id")
                and m.kind != "thread_broadcast"
            ):
                # Workflow notices duplicate the originating explicit wait.
                if m.author_id is None and pending:
                    continue
                member = m.author_id if m.author_id in by_member else None
                channel_id, thread_id = target["channel_id"], target["thread_id"]
                ask = {
                    "id": m.id,
                    "start": m.created_at,
                    "end": None,
                    "member_id": member,
                    "research_id": thread_id[9:]
                    if (thread_id or "").startswith("research:")
                    else None,
                    "location": (channel_id, thread_id),
                    # A filled run placeholder retains its original timestamp.
                    "partial": not member or bool(m.data.get("run_id")),
                    "estimated_start": bool(m.data.get("run_id")),
                }
                asks.append(ask)
                pending.append(ask)

    for p in projects:
        if (p.budget or {}).get("auto_decide"):
            continue
        history = [e for e in events if e.project_id == p.id]
        answers = {
            e.detail.get("request_id"): e
            for e in history
            if e.action == "human_decision"
        }
        for event in history:
            if event.action not in {"decision_requested", "plan_proposed"}:
                continue
            sprint = sprints.get(event.sprint_id)
            run = by_run.get(sprint.run_id) if sprint else None
            explicit = event.detail.get("member_id") or (
                (
                    (run.runtime or {}).get("team")
                    or (run.runtime or {}).get("research")
                    or {}
                ).get("member_id")
                if run
                else None
            )
            member = explicit if explicit in by_member else role_member(event.actor)
            end, estimated = None, False
            if event.action == "decision_requested":
                answer = answers.get(event.id)
                end = answer.created_at if answer else None
                if (
                    not end
                    and event.detail.get("kind") == "conclusion"
                    and (
                        (p.conclusion or {}).get("accepted") is not None
                        or p.stage not in {"conclusion", "workflow"}
                    )
                ):
                    end, estimated = p.updated_at, True
            else:
                later = [
                    e for e in history if stamp(e.created_at) >= stamp(event.created_at)
                ]
                approved = next(
                    (
                        e
                        for e in later
                        if e.action == "stage_changed"
                        and e.actor == "human"
                        and e.detail.get("from") == "scoping"
                    ),
                    None,
                )
                end = approved.created_at if approved else None
                if not end and (stamp((p.plan or {}).get("approved_at")) or 0) >= (
                    stamp(event.created_at) or clock
                ):
                    end = p.plan["approved_at"]
                superseded = next(
                    (
                        e
                        for e in later
                        if e.action == "plan_proposed"
                        and (e.created_at, e.id) > (event.created_at, event.id)
                    ),
                    None,
                )
                if superseded and (not end or superseded.created_at < end):
                    end, estimated = superseded.created_at, True
                if not end and p.stage != "scoping":
                    end, estimated = p.updated_at, True
            if not end and p.status == "finished":
                end, estimated = p.updated_at, True
            asks.append(
                {
                    "id": event.id,
                    "start": event.created_at,
                    "end": end,
                    "member_id": member,
                    "research_id": p.id,
                    "location": (experiment_channel, f"research:{p.id}"),
                    "partial": explicit not in by_member or estimated,
                    "estimated_end": estimated,
                }
            )

    # Research approvals can release a team wait without creating a human
    # TeamMessage. Keep those explicit waits aligned with the same scope.
    for ask in asks:
        if ask["id"] not in by_message or ask["research_id"] not in by_project:
            continue
        p = by_project[ask["research_id"]]
        answer = next(
            (
                e
                for e in events
                if e.project_id == p.id
                and e.actor in {"human", "lead"}
                and e.action
                in {"message", "human_decision", "stage_changed", "concluded"}
                and (stamp(e.created_at) or 0) >= (stamp(ask["start"]) or clock)
            ),
            None,
        )
        if answer and (not ask["end"] or stamp(answer.created_at) < stamp(ask["end"])):
            ask["end"] = answer.created_at
        if not ask["end"] and p.status == "finished":
            ask.update(end=p.updated_at, partial=True, estimated_end=True)

    spans = []
    member_spans = {m.id: [] for m in members if m.role != "human"}
    research_spans = {}
    for p in projects:
        start, end = (
            stamp(p.created_at),
            stamp(p.updated_at) if p.status == "finished" else clock,
        )
        research_spans[p.id] = (
            [(start, max(start, end))] if start is not None and end is not None else []
        )
        spans.extend(research_spans[p.id])
    for target in scopes.values():
        for run, member in target["runs"]:
            start, end = (
                stamp(run.created_at),
                clock if run.status in {"running", "queued"} else stamp(run.updated_at),
            )
            if start is not None and end is not None:
                interval = (start, max(start, end))
                spans.append(interval)
                if member in member_spans:
                    member_spans[member].append(interval)
        for delivery in target["deliveries"]:
            if delivery.run_id or delivery.status not in {
                "queued",
                "steering",
                "running",
            }:
                continue
            start = stamp(delivery.created_at)
            if start is not None:
                interval = (start, max(start, clock))
                spans.append(interval)
                if delivery.member_id in member_spans:
                    member_spans[delivery.member_id].append(interval)
    untraced_waits = {
        location
        for location, target in scopes.items()
        if (
            target["waiting"]
            or target["project"]
            and target["project"].status == "waiting"
        )
        and not any(a["location"] == location and not a["end"] for a in asks)
    }
    ledger = {
        "total": metrics(asks, spans, clock, partial=bool(untraced_waits)),
        "researches": [
            {
                "research_id": p.id,
                "title": p.title or p.question,
                **metrics(
                    [a for a in asks if a["research_id"] == p.id],
                    research_spans[p.id],
                    clock,
                    partial=(experiment_channel, f"research:{p.id}") in untraced_waits,
                ),
            }
            for p in projects
        ],
        "members": {
            mid: metrics(
                [a for a in asks if a["member_id"] == mid],
                intervals,
                clock,
                partial=bool(untraced_waits)
                or any(a["member_id"] is None for a in asks),
            )
            for mid, intervals in member_spans.items()
        },
    }
    items = []
    for location, target in scopes.items():
        channel = channels.get(target["channel_id"])
        if not channel or channel.archived:
            continue
        p = target["project"]
        pending = [a for a in asks if a["location"] == location and not a["end"]]
        latest = {}
        for run, mid in sorted(
            target["runs"], key=lambda pair: (pair[0].created_at, pair[0].id)
        ):
            latest[mid] = run
        active = [
            (r, mid) for r, mid in target["runs"] if r.status in {"running", "queued"}
        ]
        running = [(r, mid) for r, mid in active if r.status == "running"]
        deliveries = [
            v
            for v in target["deliveries"]
            if v.status in {"queued", "running", "steering"}
            and (
                not v.run_id
                or v.run_id not in by_run
                or by_run[v.run_id].status in {"running", "queued"}
            )
        ]
        reviews = target["reviews"]
        receipts = [(r.created_at, r.id, mid, r.status) for r, mid in target["runs"]]
        receipts += [
            (
                v.created_at,
                v.id,
                v.member_id,
                by_run[v.run_id].status if v.run_id in by_run else v.status,
            )
            for v in target["deliveries"]
        ]
        latest_status = {}
        for _, _, mid, status in sorted(receipts):
            latest_status[mid] = status
        failed = "failed" in latest_status.values()
        if p and p.status == "finished":
            group = "done"
        elif pending or target["waiting"] or p and p.status == "waiting":
            group = "waiting"
        elif reviews:
            group = "review"
        elif running or any(v.status == "steering" for v in deliveries):
            group = "working"
        elif active or deliveries:
            group = "queued"
        elif p:
            group = "working" if failed or p.status == "active" else "queued"
        elif latest or target["deliveries"]:
            group = "working" if failed else "done"
        else:
            continue
        reviewer_running = any(
            mid in {r.get("reviewer") for r in reviews} for _, mid in running
        )
        reasons = (["failed"] if failed else []) + (
            ["reviewer_absent"] if reviews and not reviewer_running else []
        )
        if group == "done":
            reasons = []
        wait_start = min((a["start"] for a in pending), default=None)
        if group == "waiting" and not wait_start:
            wait_start = p.updated_at if p else workspace.updated_at
        if (
            group == "waiting"
            and wait_start
            and clock - stamp(wait_start) >= STUCK_WAIT_SECONDS
        ):
            reasons.append("owner_wait")
        responsible = list(
            dict.fromkeys(
                [a["member_id"] for a in pending]
                + [r.get("reviewer") for r in reviews]
                + [mid for _, mid in running or active]
                + [v.member_id for v in deliveries]
            )
        )
        if not any(responsible):
            responsible = list(latest) or [v.member_id for v in target["deliveries"]]
        responsible = [
            mid for mid in responsible if mid in by_member and mid not in human
        ]
        selected_run = next(
            (r for r, mid in running or active if mid in responsible), None
        )
        if selected_run is None and latest:
            selected_run = max(latest.values(), key=lambda r: (r.created_at, r.id))
        start_values = [r.created_at for r, _ in target["runs"]] + [
            v.created_at for v in target["deliveries"]
        ]
        start_values += [p.created_at] if p else []
        start_values += [a["start"] for a in asks if a["location"] == location]
        end_values = [r.updated_at for r, _ in target["runs"]] + [
            m.created_at for m in target["messages"]
        ]
        end_values += [p.updated_at] if p else []
        start = min(start_values, default=workspace.created_at)
        end = max(end_values, default=start) if group == "done" else generated_at
        root = by_message.get(target["thread_id"])
        items.append(
            {
                "id": json.dumps(location, separators=(",", ":")),
                "channel_id": target["channel_id"],
                "thread_id": target["thread_id"],
                "research_id": p.id if p else None,
                "title": p.title or p.question
                if p
                else plain_text(root.text)[:200]
                if root
                else channel.name,
                "group": group,
                "member_ids": responsible,
                "status": "failed"
                if failed and group != "done"
                else "paused"
                if p and p.status == "paused"
                else group,
                "current_step": (selected_run.steps or [None])[-1]
                if selected_run
                else None,
                "elapsed_seconds": max(
                    0, (stamp(end) or clock) - (stamp(start) or clock)
                ),
                "stuck": reasons,
            }
        )
    items.sort(key=lambda item: (GROUPS.index(item["group"]), item["id"]))
    return {
        "generated_at": generated_at,
        "items": items,
        "counts": {group: sum(i["group"] == group for i in items) for group in GROUPS},
        "attention": ledger,
    }
