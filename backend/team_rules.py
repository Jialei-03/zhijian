"""Pure team routing. Callers persist state and dispatch the returned actions.

Members/channels are contract dictionaries supplied by the team service. No model,
database, clock, or agent is accessed here. See docs/design/team-rules-engine.md
for the state and migration handoff.
"""

import calendar
import json
from copy import deepcopy
from datetime import UTC, datetime, time, timedelta
from typing import Annotated, Literal, NamedTuple, TypedDict
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, StrictBool, StrictInt, model_validator

from .schemas import Strict

EVENTS = Literal[
    "message",
    "mention",
    "job_finished",
    "plan_approved",
    "conclusion_proposed",
    "review_failed",
    "accepted",
    "changes_requested",
    "schedule",
]
KINDS = Literal["text", "result", "plan", "conclusion", "draft", "review"]
Text = Annotated[str, Field(min_length=1)]


class Action(TypedDict, total=False):
    rule: str
    action: Literal["wake", "review", "wait_for_owner", "post", "limit", "skip"]
    reason: str
    limit: int
    member: str
    instruction: str
    channel: str
    thread: str | None
    text: str


class MatchResult(NamedTuple):
    actions: list[Action]
    state: dict


class When(Strict):
    event: EVENTS
    channel: Text | None = None
    from_role: Text | None = None
    from_member: Text | None = None
    kind: KINDS | None = None
    cron: Text | None = None
    timezone: Text | None = None

    @model_validator(mode="after")
    def timing(self):
        if self.event == "schedule":
            if not self.cron or not self.timezone:
                raise ValueError("schedule requires cron and timezone")
            _cron(self.cron)
            try:
                ZoneInfo(self.timezone)
            except (ValueError, ZoneInfoNotFoundError):
                raise ValueError("unknown timezone") from None
            if self.from_role or self.from_member or self.kind:
                raise ValueError("schedule cannot filter a message author or kind")
        elif self.cron is not None or self.timezone is not None:
            raise ValueError("cron and timezone require a schedule trigger")
        return self


class Then(Strict):
    action: Literal["wake", "review", "wait_for_owner", "post"]
    member: Text | None = None
    subscribers: StrictBool | None = None
    role: Text | None = None
    instruction: str = ""
    on_fail: Text | None = None
    max_rounds: Annotated[StrictInt, Field(ge=0)] | None = None
    channel: Text | None = None
    text: Text | None = None

    @model_validator(mode="after")
    def fields(self):
        if self.action in {"wake", "review"}:
            if sum((bool(self.member), bool(self.role), bool(self.subscribers))) != 1:
                raise ValueError("wake/review requires exactly one of member or role")
        elif self.member or self.role or self.subscribers:
            raise ValueError("member/role requires wake or review")
        if self.subscribers and self.action != "wake":
            raise ValueError("subscribers requires wake")
        if self.action == "review":
            if not self.on_fail:
                raise ValueError("review requires on_fail")
        elif self.on_fail is not None or self.max_rounds is not None:
            raise ValueError("on_fail/max_rounds requires review")
        if self.action == "post":
            if not self.channel or not self.text:
                raise ValueError("post requires channel and text")
        elif self.channel is not None or self.text is not None:
            raise ValueError("channel/text requires post")
        return self


class Limit(Strict):
    per_thread: Annotated[StrictInt, Field(ge=0)] = 0


class Position(Strict):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)


class RuleInput(Strict):
    id: Text
    enabled: StrictBool = True
    when: When
    then: Then
    limit: Limit = Field(default_factory=Limit)
    position: Position | None = None

    @model_validator(mode="after")
    def subscribers_event(self):
        if self.then.subscribers and self.when.event != "message":
            raise ValueError("subscribers requires a message trigger")
        if self.then.member == "$author" and self.when.event not in {
            "accepted",
            "changes_requested",
        }:
            raise ValueError("original author requires a decision trigger")
        return self


class Layout(Strict):
    members: dict[str, Position] = Field(default_factory=dict)
    channels: dict[str, Position] = Field(default_factory=dict)


class WorkflowInput(Strict):
    id: Text
    name: Text
    builtin: StrictBool = False
    version: Annotated[StrictInt, Field(ge=1)] = 1
    rules: list[RuleInput]
    layout: Layout = Field(default_factory=Layout)

    @model_validator(mode="after")
    def unique_rules(self):
        ids = [rule.id for rule in self.rules]
        if len(ids) != len(set(ids)):
            raise ValueError("rule ids must be unique within a workflow")
        if "@mention" in ids:
            raise ValueError("rule id @mention is reserved for direct mentions")
        return self


def _resolve(ref, members, *, role=None):
    candidates = [m for m in members if m["id"] == ref] if role is not True else []
    if not candidates and role is not False:
        candidates = [m for m in members if m["role"] == ref]
    if len(candidates) != 1 or candidates[0]["kind"] != "agent":
        raise ValueError(f"member/role {ref!r} must resolve to exactly one agent")
    return candidates[0]["id"]


def _references(rule, members=None, channels=None):
    if members is not None:
        spec = rule["then"]
        if (
            spec["action"] in {"wake", "review"}
            and not spec.get("subscribers")
            and spec.get("member") != "$author"
        ):
            _resolve(
                spec.get("member") or spec["role"],
                members,
                role=not bool(spec.get("member")),
            )
        if spec.get("on_fail"):
            _resolve(spec["on_fail"], members)
        author = rule["when"].get("from_member")
        if author and not any(m["id"] == author for m in members):
            raise ValueError(f"unknown from_member {author!r}")
    if channels is not None:
        ids = {channel["id"] for channel in channels}
        for ref in (rule["when"].get("channel"), rule["then"].get("channel")):
            if ref and ref not in ids:
                raise ValueError(f"unknown channel {ref!r}")


def validate_rule(rule, *, members=None, channels=None) -> dict:
    """Return a detached, normalized rule; errors include the field or rule id."""
    result = RuleInput.model_validate(rule).model_dump(exclude_none=True)
    _references(result, members, channels)
    return result


def validate_workflow(workflow, *, members=None, channels=None) -> dict:
    result = WorkflowInput.model_validate(workflow).model_dump(exclude_none=True)
    for rule in result["rules"]:
        try:
            _references(rule, members, channels)
        except ValueError as exc:
            raise ValueError(f"rules[{rule['id']}]: {exc}") from exc
    if members is not None:
        unknown = set(result["layout"]["members"]) - {m["id"] for m in members}
        if unknown:
            raise ValueError(f"layout.members: unknown members {sorted(unknown)}")
    if channels is not None:
        unknown = set(result["layout"]["channels"]) - {c["id"] for c in channels}
        if unknown:
            raise ValueError(f"layout.channels: unknown channels {sorted(unknown)}")
    return result


def route_options(route):
    """One visible rule can have several linear execution entry points."""
    if not route:
        return []
    return [
        {k: v for k, v in route.items() if k != "alternatives"},
        *route.get("alternatives", []),
    ]


def deduplicate_workflow(workflow, state=None):
    """Collapse equal when/then pairs, retaining edits and all cursor routes.

    Enabled state, limits and canvas positions belong to the retained rule. A
    non-default value takes precedence over an untouched generated duplicate;
    different instructions/targets remain distinct rules.
    """
    flow, state = deepcopy(workflow), deepcopy(state or {})
    normalized_rules = [validate_rule(rule) for rule in flow["rules"]]
    groups = {}
    for index, normalized in enumerate(normalized_rules):
        signature = json.dumps([normalized["when"], normalized["then"]], sort_keys=True)
        groups.setdefault(signature, []).append((index, normalized))
    aliases, retained = {}, set()
    for group in groups.values():
        index, chosen = max(
            group,
            key=lambda item: (
                not item[1]["enabled"],
                bool(item[1]["limit"]["per_thread"]),
                "position" in item[1],
            ),
        )
        retained.add(index)
        aliases.update(
            {r["id"]: chosen["id"] for _, r in group if r["id"] != chosen["id"]}
        )
    flow["rules"] = [r for i, r in enumerate(normalized_rules) if i in retained]
    if not aliases:
        return flow, state
    wk = _workflow_key(flow)
    if flow.get("builtin") and wk not in state.get("linear", {}):
        state.setdefault("linear", {}).update(initial_state(workflow).get("linear", {}))
    routing = state.get("linear", {}).get(wk, {})
    for old, new in aliases.items():
        if old in routing:
            options = route_options(routing.get(new))
            options.extend(
                r for r in route_options(routing.pop(old)) if r not in options
            )
            routing[new] = {**options[0]}
            if len(options) > 1:
                routing[new]["alternatives"] = options[1:]
        for partition in state.get("threads", {}).values():
            current = partition.get("workflows", {}).get(wk, {})
            counts = current.get("counts", {})
            if old in counts:
                counts[new] = counts.get(new, 0) + counts.pop(old)
            reviews = current.get("reviews", {})
            if old in reviews:
                previous = reviews.pop(old)
                if new not in reviews or previous.get("pending"):
                    reviews[new] = previous
        timers = state.get("last_runs", {}).get(wk, {})
        if old in timers:
            previous = timers.pop(old)
            timers[new] = max(timers.get(new, previous), previous, key=_stamp)
        for fired in state.get("fired", []):
            if (
                fired.get("workflow") == flow["id"]
                and fired.get("version", flow["version"]) == flow["version"]
                and fired.get("rule") == old
            ):
                fired["rule"] = new
    return flow, state


def _stamp(value):
    at = datetime.fromisoformat(value) if isinstance(value, str) else value
    if not isinstance(at, datetime) or at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("time must be an ISO timestamp or datetime with a timezone")
    return at.astimezone(UTC)


def _cron(expression):
    """Five numeric fields: lists, ranges and steps; Sunday is 0 or 7."""
    fields = expression.split()
    if len(fields) != 5:
        raise ValueError("cron requires five fields: minute hour day month weekday")
    parsed = []
    for field, low, high in zip(fields, (0, 0, 1, 1, 0), (59, 23, 31, 12, 7)):
        values = set()
        try:
            for part in field.split(","):
                bits = part.split("/")
                if len(bits) > 2:
                    raise ValueError
                base, step = bits[0], int(bits[1]) if len(bits) == 2 else 1
                if step < 1:
                    raise ValueError
                if base == "*":
                    start, end = low, high
                elif "-" in base:
                    start, end = map(int, base.split("-"))
                else:
                    start = int(base)
                    end = high if len(bits) == 2 else start
                if not low <= start <= end <= high:
                    raise ValueError
                values.update(range(start, end + 1, step))
        except ValueError:
            raise ValueError(
                f"invalid cron field {field!r} (range {low}..{high})"
            ) from None
        parsed.append(values)
    parsed[4] = {day % 7 for day in parsed[4]}
    if fields[4] == "*" and not any(
        day <= calendar.monthrange(2000, month)[1]
        for day in parsed[2]
        for month in parsed[3]
    ):
        raise ValueError("cron has no occurrence for these day/month fields")
    return fields, parsed


def next_cron(cron: str, timezone_name: str, after) -> datetime:
    """First occurrence strictly after after, using research_schedules DST policy.

    Local candidates use fold=0: a gap moves forward and a fold runs once.
    Restricted day-of-month and weekday fields use standard cron OR semantics.
    """
    fields, (minutes, hours, days, months, weekdays) = _cron(cron)
    zone = ZoneInfo(timezone_name)
    after = _stamp(after)
    first = after.astimezone(zone).date()
    for offset in range(366 * 8):
        day = first + timedelta(days=offset)
        dom, dow = day.day in days, (day.weekday() + 1) % 7 in weekdays
        day_matches = (
            (dom and dow) if fields[2] == "*" or fields[4] == "*" else (dom or dow)
        )
        if day.month not in months or not day_matches:
            continue
        candidates = sorted(
            {
                datetime.combine(day, time(hour, minute), tzinfo=zone).astimezone(UTC)
                for hour in hours
                for minute in minutes
            }
        )
        for candidate in candidates:
            if candidate > after:
                return candidate
    raise ValueError(f"cron {cron!r} has no occurrence in the next eight years")


def _workflow_key(workflow):
    return json.dumps([workflow["id"], workflow["version"]], separators=(",", ":"))


def _matches(rule, event, *, mention=False):
    when = rule["when"]
    author = event.get("original_author") or event.get("author") or {}
    return when["event"] == ("mention" if mention else event["type"]) and all(
        when.get(key) is None or when[key] == value
        for key, value in (
            ("channel", event["channel"]),
            ("from_role", author.get("role")),
            ("from_member", author.get("id")),
            ("kind", event.get("kind")),
        )
    )


def _action(rule, event, members):
    spec = rule["then"]
    result: Action = {
        "rule": rule["id"],
        "action": spec["action"],
        "thread": event["thread"],
    }
    channel = spec.get("channel", event["channel"])
    if channel is not None:
        result["channel"] = channel
    if spec["action"] in {"wake", "review"}:
        result["member"] = _resolve(
            (
                (event.get("original_author") or event.get("author") or {}).get("id")
                if spec.get("member") == "$author"
                else spec.get("member") or spec["role"]
            ),
            members,
            role=not bool(spec.get("member")),
        )
    if spec.get("instruction"):
        result["instruction"] = spec["instruction"]
    if spec.get("text"):
        result["text"] = spec["text"]
    return result


def _actions(rule, event, members):
    if not rule["then"].get("subscribers"):
        return [_action(rule, event, members)]
    if event["type"] != "message":
        return []
    return [
        _action(
            {**rule, "then": {**rule["then"], "subscribers": False, "member": m["id"]}},
            event,
            members,
        )
        for m in members
        if m["kind"] == "agent"
        and m.get("enabled", True)
        and event["channel"] in m.get("subscriptions", [])
        and m["id"] != (event.get("author") or {}).get("id")
    ]


def match(workflow, event, state, *, members) -> MatchResult:
    """Return (actions, new_state), without mutating any input.

    State is scoped by team/channel/thread; null threads use the channel scope.
    Only the human owner resets the relay and releases an explicit owner wait.
    Review failures correlate with an outstanding review by reviewer and scope.
    """
    workflow, state = deduplicate_workflow(
        validate_workflow(workflow, members=members), state
    )
    if event.get("type") not in EVENTS.__args__:
        raise ValueError("match requires a contract event type")
    if not event.get("team") or not event.get("channel") or "thread" not in event:
        raise ValueError("event requires team, channel and thread")
    _stamp(event["at"])
    result = deepcopy(state)
    key = _workflow_key(workflow)
    if workflow["builtin"] and key not in result.get("linear", {}):
        result.setdefault("linear", {}).update(
            initial_state(workflow).get("linear", {})
        )
    scope_key = json.dumps(
        event.get("scope") or [event["team"], event["channel"], event["thread"]],
        separators=(",", ":"),
    )
    scope = result.setdefault("threads", {}).setdefault(
        scope_key,
        {
            "relay": 0,
            "waiting": False,
            "workflows": {},
        },
    )
    current = scope["workflows"].setdefault(
        key, {"counts": {}, "reviews": {}, "cursor": "start"}
    )
    routing = result.get("linear", {}).get(key, {})
    author = event.get("author") or {}
    if author and not any(
        all(m.get(k) == author.get(k) for k in ("id", "kind", "role")) for m in members
    ):
        raise ValueError("event author does not match a supplied team member")
    owner = author.get("kind") == "human" and author.get("role") == "owner"
    if owner:
        scope["relay"], scope["waiting"] = 0, False
        scope.pop("limit_notified", None)
    if scope["waiting"]:
        return MatchResult([], result)
    actions = []
    cursor = current["cursor"]

    def route_for(rule):
        return next(
            (r for r in route_options(routing.get(rule["id"])) if r["from"] == cursor),
            None,
        )

    def active(rule):
        return rule["enabled"] and (
            rule["id"] not in routing or route_for(rule) is not None
        )

    def eligible(rule):
        return active(rule) and (
            not rule["limit"]["per_thread"]
            or current["counts"].get(rule["id"], 0) < rule["limit"]["per_thread"]
        )

    def emit(rule, action, *, advance=True):
        if action["action"] in {"wake", "review"}:
            if any(m["id"] == action["member"] and m.get("paused") for m in members):
                if rule:
                    name = next(
                        m["name"] for m in members if m["id"] == action["member"]
                    )
                    actions.append(
                        {
                            **action,
                            "action": "skip",
                            "reason": "paused",
                            "text": f"{name} 暂停中 / {name} is paused",
                        }
                    )
                return False
            if any(
                m["id"] == action["member"] and not m.get("enabled", True)
                for m in members
            ):
                return False
            if scope["waiting"]:
                return False
            target = action["member"]
            if target in event.get("pending_members", []):
                pass  # Merge an inbox entry without spending another relay hop.
            elif not owner:
                scope["relay"] += 1
        if action["action"] == "wait_for_owner":
            scope["waiting"] = True
            for execution in scope["workflows"].values():
                for review in execution["reviews"].values():
                    review["pending"] = False
        actions.append(action)
        if rule:
            rid = rule["id"]
            current["counts"][rid] = current["counts"].get(rid, 0) + 1
            if advance and rid in routing:
                route = route_for(rule)
                if route:
                    current["cursor"] = route["to"]
        return action["action"] not in {"wait_for_owner", "limit"}

    # Failures only affect the review actually requested, never an arbitrary rule.
    if event["type"] == "review_failed":
        pending = [
            (rid, review)
            for rid, review in current["reviews"].items()
            if review["pending"] and review["reviewer"] == author.get("id")
        ]
        if len(pending) > 1:
            raise ValueError(
                "review_failed is ambiguous: multiple pending reviews for this reviewer"
            )
        if pending:
            rid, review = pending[0]
            rule = next((r for r in workflow["rules"] if r["id"] == rid), None)
            if (
                rule
                and rule["enabled"]
                and (
                    not rule["limit"]["per_thread"]
                    or current["counts"].get(rid, 0) < rule["limit"]["per_thread"]
                )
            ):
                review["pending"] = False
                maximum = rule["then"].get("max_rounds", 0)
                action = {
                    "rule": rid,
                    "action": "limit",
                    "reason": "review",
                    "limit": maximum,
                    "channel": event["channel"],
                    "thread": event["thread"],
                }
                if not maximum or review["returns"] < maximum:
                    action.update(
                        action="wake",
                        member=review["on_fail"],
                        instruction="按评审意见修改。 / Revise using the review feedback.",
                    )
                    action.pop("reason", None)
                    action.pop("limit", None)
                if emit(rule, action, advance=False):
                    review["returns"] += 1
                    if rid in routing:
                        route = next(
                            (
                                r
                                for r in route_options(routing[rid])
                                if r["to"] == current["cursor"]
                            ),
                            routing[rid],
                        )
                        current["cursor"] = route.get("on_fail", route["from"])
            return MatchResult(actions, result)
    elif event["type"] == "message" and event.get("kind") == "review":
        pending = [
            review
            for review in current["reviews"].values()
            if review["pending"] and review["reviewer"] == author.get("id")
        ]
        if len(pending) > 1:
            raise ValueError(
                "review result is ambiguous: multiple pending reviews for this reviewer"
            )
        for review in pending:
            review["pending"] = False

    # Snapshot the eligible set so a single event cannot run successive stages.
    candidates = [r for r in workflow["rules"] if eligible(r)]
    matched = [r for r in candidates if _matches(r, event)]
    waits = [r for r in matched if r["then"]["action"] == "wait_for_owner"]
    if waits:
        for rule in waits:
            emit(rule, _action(rule, event, members))
        return MatchResult(actions, result)

    mentions = list(dict.fromkeys(event.get("mentions", [])))
    claimed = set()
    if mentions or event["type"] == "mention":
        explicit = [
            r
            for r in workflow["rules"]
            if active(r) and _matches(r, event, mention=True)
        ]
        explicit_targets = {
            a["member"]
            for r in explicit
            for a in _actions(r, event, members)
            if r["then"]["action"] in {"wake", "review"}
        }
        # A result @advisor still uses its review rule (and records on_fail),
        # while an explicit mention rule takes precedence for the same target.
        compatible = [
            r
            for r in matched
            if r["then"]["action"] in {"wake", "review"}
            and any(
                a["member"] not in explicit_targets for a in _actions(r, event, members)
            )
        ]
        matched = [
            r for r in candidates if _matches(r, event, mention=True)
        ] + compatible
        claimed.update(explicit_targets)
        for rule in workflow["rules"]:
            if (
                active(rule)
                and _matches(rule, event)
                and rule["then"]["action"] in {"wake", "review"}
            ):
                claimed.update(a["member"] for a in _actions(rule, event, members))
    delivered = set()
    for rule in matched:
        before = current["counts"].get(rule["id"], 0)
        for action in _actions(rule, event, members):
            if action["action"] in {"wake", "review"}:
                target = action["member"]
                if mentions and target not in mentions:
                    continue
                if target in delivered:
                    continue
                if action["action"] == "review" and current["reviews"].get(
                    rule["id"], {}
                ).get("pending"):
                    continue
                if not emit(rule, action):
                    if any(m["id"] == target and m.get("paused") for m in members):
                        continue
                    break
                delivered.add(target)
                if action["action"] == "review":
                    previous = current["reviews"].get(rule["id"], {})
                    current["reviews"][rule["id"]] = {
                        "reviewer": target,
                        "on_fail": _resolve(rule["then"]["on_fail"], members),
                        "returns": (
                            previous.get("returns", 0)
                            if previous.get("cursor", current["cursor"])
                            == current["cursor"]
                            else 0
                        ),
                        "cursor": current["cursor"],
                        "pending": True,
                    }
            else:
                emit(rule, action)
                if scope["waiting"]:
                    break
        if (
            rule["then"].get("subscribers")
            and current["counts"].get(rule["id"], 0) > before
        ):
            current["counts"][rule["id"]] = before + 1
    for member in mentions:
        if member not in delivered | claimed and any(
            m["id"] == member
            and m["kind"] == "agent"
            and m.get("enabled", True)
            and not m.get("paused")
            for m in members
        ):
            action = {
                "rule": "@mention",
                "action": "wake",
                "member": member,
                "channel": event["channel"],
                "thread": event["thread"],
            }
            if not emit(None, action):
                break
    return MatchResult(actions, result)


def due(workflow, now, last_runs, *, members) -> list[Action]:
    """Emit at most one action per due rule, without changing last_runs.

    last_runs maps rule ids to the last *delivery time*, including failed attempts.
    Persist now after claiming delivery, so missed occurrences coalesce once.
    Missing entries only fire in a currently scheduled minute; initialize them at
    activation to support catch-up after downtime. Schedule actions have no thread.
    """
    workflow = validate_workflow(workflow, members=members)
    now = _stamp(now)
    actions = []
    for rule in workflow["rules"]:
        when = rule["when"]
        if not rule["enabled"] or when["event"] != "schedule":
            continue
        previous = last_runs.get(rule["id"])
        after = (
            _stamp(previous)
            if previous is not None
            else now.replace(second=0, microsecond=0) - timedelta(microseconds=1)
        )
        if next_cron(when["cron"], when["timezone"], after) <= now:
            actions.append(
                _action(rule, {"channel": when.get("channel"), "thread": None}, members)
            )
    return actions


def convert_linear_workflow(definition, *, roles=None) -> tuple[dict, dict]:
    """Compile a legacy definition into contract rules and detached initial state.

    roles optionally supplies one agent role for each original step. Rules contain
    only contract fields; state.linear holds their cursor transitions. This migrates
    definitions, not in-flight legacy runs or their checkpoint/approval records.
    """
    from .team_rule_templates import compile_linear

    return compile_linear(definition, roles=roles)


def builtin_workflows(locale="zh") -> dict[str, dict]:
    """Detached contract workflow data, with English/Chinese names and instructions."""
    from .team_rule_templates import definitions

    return {
        key: convert_linear_workflow(value, roles=roles)[0]
        for key, (value, roles) in definitions(locale).items()
    }


def initial_state(workflow) -> dict:
    """Initial routing state for a built-in. Custom migrations return their own state."""
    from .team_rule_templates import definitions

    if workflow.get("builtin"):
        template = definitions().get(workflow["id"])
        if template:
            definition, roles = template
            definition["version"] = workflow.get("version", 1)
            generated, state = convert_linear_workflow(definition, roles=roles)
            ids = {r["id"] for r in workflow["rules"]}
            # An older saved duplicate may retain the edited rule's former id.
            # Transfer the generated rule's routes to that surviving identity.
            missing = []
            for rule in generated["rules"]:
                if rule["id"] in ids:
                    continue
                for item in workflow["rules"]:
                    when = {k: v for k, v in item["when"].items() if k != "channel"}
                    if rule["when"] == when and rule["then"] == item["then"]:
                        missing.append({**rule, "when": item["when"]})
                        break
            return deduplicate_workflow(
                {**workflow, "rules": [*workflow["rules"], *missing]}, state
            )[1]
    return {}
