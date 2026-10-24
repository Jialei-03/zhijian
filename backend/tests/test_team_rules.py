"""Contract-only event simulations: no database, runner, network or model calls."""

import json
from copy import deepcopy
from datetime import datetime

import pytest
from pydantic import ValidationError

from backend import team_rules as rules


@pytest.fixture
def members():
    return [
        {"id": "me", "name": "Owner", "kind": "human", "role": "owner"},
        {"id": "guest", "name": "Guest", "kind": "human", "role": "guest"},
        *[
            {"id": f"m-{role}", "name": role, "kind": "agent", "role": role}
            for role in (
                "executor",
                "advisor",
                "librarian",
                "reviewer",
                "writer",
                "distiller",
            )
        ],
    ]


def event(members, role="owner", type="message", kind="text", **extra):
    author = next((m for m in members if m["role"] == role), None)
    return {
        "type": type,
        "team": "t",
        "channel": "c",
        "thread": "root",
        "author": {k: author[k] for k in ("id", "kind", "role")} if author else None,
        "kind": kind,
        "mentions": [],
        "at": "2026-10-23T01:00:00+00:00",
        **extra,
    }


def rule(id="r", trigger="message", action="wake", **extra):
    then = {"action": action}
    if action in {"wake", "review"}:
        then.update(role="executor", instruction="Do the work")
    if action == "review":
        then.update(role="advisor", on_fail="executor")
    if action == "post":
        then.update(channel="out", text="Report")
    return {
        "id": id,
        "enabled": True,
        "when": {"event": trigger},
        "then": then,
        **extra,
    }


def workflow(*items):
    return {
        "id": "w",
        "name": "Test",
        "builtin": False,
        "version": 1,
        "rules": list(items),
        "layout": {"members": {}, "channels": {}},
    }


def run(flow, item, state, members):
    return rules.match(flow, item, state, members=members)


def scope(state):
    return next(iter(state["threads"].values()))


def brief(actions):
    return [(a["action"], a.get("member")) for a in actions]


@pytest.mark.parametrize(
    "trigger",
    [
        "message",
        "mention",
        "job_finished",
        "plan_approved",
        "conclusion_proposed",
        "review_failed",
        "schedule",
    ],
)
def test_each_event_trigger(trigger, members):
    item = event(
        members, type=trigger, mentions=["m-executor"] if trigger == "mention" else []
    )
    spec = rule(trigger=trigger)
    if trigger == "schedule":
        spec["when"].update(cron="0 9 * * *", timezone="Asia/Singapore")
    actions, _ = run(workflow(spec), item, {}, members)
    assert brief(actions) == [("wake", "m-executor")]
    assert actions[0]["rule"] == "r"


@pytest.mark.parametrize("action", ["wake", "review", "wait_for_owner", "post"])
def test_each_action_uses_contract_fields(action, members):
    actions, state = run(workflow(rule(action=action)), event(members), {}, members)
    assert actions[0]["rule"] == "r" and actions[0]["action"] == action
    assert actions[0]["thread"] == "root"
    if action == "post":
        assert actions[0]["channel"] == "out" and actions[0]["text"] == "Report"
    else:
        assert actions[0]["channel"] == "c"
    assert scope(state)["waiting"] == (action == "wait_for_owner")


@pytest.mark.parametrize(
    "field,value",
    [
        ("channel", "elsewhere"),
        ("from_role", "advisor"),
        ("from_member", "m-advisor"),
        ("kind", "draft"),
    ],
)
def test_filters_are_conjunctive(field, value, members):
    spec = rule()
    spec["when"].update(
        channel="c", from_role="executor", from_member="m-executor", kind="result"
    )
    assert run(
        workflow(spec), event(members, "executor", kind="result"), {}, members
    ).actions
    spec["when"][field] = value
    assert (
        run(
            workflow(spec), event(members, "executor", kind="result"), {}, members
        ).actions
        == []
    )


def test_disabled_rules_and_target_by_id(members):
    disabled = rule("off", enabled=False)
    target = rule(
        "id", then={"action": "wake", "member": "m-writer", "instruction": "Draft"}
    )
    actions, _ = run(workflow(disabled, target), event(members), {}, members)
    assert actions == [
        {
            "rule": "id",
            "action": "wake",
            "member": "m-writer",
            "instruction": "Draft",
            "channel": "c",
            "thread": "root",
        }
    ]


def test_mentions_override_default_routing_and_deduplicate(members):
    flow = workflow(rule())
    actions, _ = run(
        flow,
        event(members, mentions=["m-writer", "m-writer", "me", "missing"]),
        {},
        members,
    )
    assert brief(actions) == [("wake", "m-writer")]
    assert actions[0]["rule"] == "@mention"
    assert run(flow, event(members, mentions=["me"]), {}, members).actions == []


def test_mention_rule_instruction_filter_and_limit(members):
    mention = rule(trigger="mention", limit={"per_thread": 1})
    mention["when"].update(channel="c", from_role="owner", kind="text")
    flow = workflow(rule("default"), mention)
    item = event(members, mentions=["m-executor", "m-writer"])
    actions, state = run(flow, item, {}, members)
    assert [a["rule"] for a in actions] == ["r", "@mention"]
    assert actions[0]["instruction"] == "Do the work"
    actions, _ = run(flow, item, state, members)
    assert brief(actions) == [("wake", "m-writer")]
    actions, _ = run(flow, event(members, mentions=["m-advisor"]), {}, members)
    assert brief(actions) == [("wake", "m-advisor")]


def test_rule_limit_per_thread_team_and_channel(members):
    flow = workflow(rule(limit={"per_thread": 1}))
    item = event(members)
    actions, state = run(flow, item, {}, members)
    assert len(actions) == 1
    assert run(flow, item, state, members).actions == []
    for change in ({"thread": "other"}, {"team": "other"}, {"channel": "other"}):
        assert run(flow, {**item, **change}, state, members).actions
    no_thread = {**item, "thread": None}
    actions, state = run(flow, no_thread, state, members)
    assert actions[0]["thread"] is None
    assert run(flow, no_thread, state, members).actions == []


def test_owner_wait_blocks_messages_jobs_and_mentions_until_owner_speaks(members):
    flow = workflow(
        rule("wake"),
        rule("wait", trigger="conclusion_proposed", action="wait_for_owner"),
    )
    actions, state = run(
        flow, event(members, "advisor", type="conclusion_proposed"), {}, members
    )
    assert brief(actions) == [("wait_for_owner", None)]
    for item in (
        event(members, "advisor", mentions=["m-executor"]),
        event(members, "guest"),
        event(members, None, type="job_finished"),
    ):
        actions, state = run(flow, item, state, members)
        assert actions == [] and scope(state)["waiting"]
    assert run(flow, event(members, "owner"), state, members).actions
    assert run(flow, event(members, "advisor", thread="other"), state, members).actions


def test_wait_has_priority_even_when_last_and_event_mentions_someone(members):
    flow = workflow(
        rule("wake"), rule("post", action="post"), rule("wait", action="wait_for_owner")
    )
    actions, _ = run(flow, event(members, mentions=["m-writer"]), {}, members)
    assert brief(actions) == [("wait_for_owner", None)]


def test_agent_handoffs_are_never_capped(members):
    flow = workflow(rule(), rule("job", trigger="job_finished"))
    state = {}
    for index in range(40):
        item = (
            event(members, "advisor", mentions=["m-executor"])
            if index % 2
            else event(members, None, type="job_finished")
        )
        actions, state = run(flow, item, state, members)
        assert brief(actions) == [("wake", "m-executor")]


@pytest.mark.parametrize("maximum", [1, 3])
def test_review_returns_at_most_n_times(maximum, members):
    spec = rule(action="review", limit={"per_thread": 30})
    spec["when"].update(from_role="executor", kind="result")
    spec["then"]["max_rounds"] = maximum
    flow = workflow(spec)
    state = {}
    for attempt in range(maximum + 1):
        actions, state = run(
            flow, event(members, "executor", kind="result"), state, members
        )
        assert brief(actions) == [("review", "m-advisor")]
        failed = event(members, "advisor", type="review_failed", kind="review")
        actions, state = run(flow, failed, state, members)
        expected = [("wake", "m-executor")] if attempt < maximum else [("limit", None)]
        assert brief(actions) == expected
        assert all(a["rule"] == "r" for a in actions)
        assert run(flow, failed, state, members).actions == []


@pytest.mark.parametrize("maximum", [None, 0])
@pytest.mark.parametrize("limit", [None, {}, {"per_thread": 0}])
def test_missing_or_zero_limits_allow_repeated_reviews(maximum, limit, members):
    spec = rule(action="review")
    spec["when"].update(from_role="executor", kind="result")
    if maximum is not None:
        spec["then"]["max_rounds"] = maximum
    if limit is not None:
        spec["limit"] = limit
    flow = workflow(spec)
    state = {}
    for _ in range(40):
        actions, state = run(
            flow, event(members, "executor", kind="result"), state, members
        )
        assert brief(actions) == [("review", "m-advisor")]
        actions, state = run(
            flow, event(members, "advisor", type="review_failed"), state, members
        )
        assert brief(actions) == [("wake", "m-executor")]


def test_review_failure_needs_pending_reviewer_and_scope(members):
    flow = workflow(rule(action="review"))
    failed = event(members, "advisor", type="review_failed")
    assert run(flow, failed, {}, members).actions == []
    _, state = run(flow, event(members), {}, members)
    assert run(flow, {**failed, "thread": "other"}, state, members).actions == []
    assert (
        run(
            flow, event(members, "writer", type="review_failed"), state, members
        ).actions
        == []
    )
    assert brief(run(flow, failed, state, members).actions) == [("wake", "m-executor")]


def test_review_success_and_wait_invalidate_pending_failures(members):
    review = rule(action="review")
    review["when"].update(from_role="executor", kind="result")
    flow = workflow(
        review, rule("stop", trigger="conclusion_proposed", action="wait_for_owner")
    )
    _, state = run(flow, event(members, "executor", kind="result"), {}, members)
    assert (
        run(flow, event(members, "executor", kind="result"), state, members).actions
        == []
    )
    _, passed = run(flow, event(members, "advisor", kind="review"), state, members)
    failed = event(members, "advisor", type="review_failed")
    assert run(flow, failed, passed, members).actions == []
    _, waiting = run(
        flow, event(members, "advisor", type="conclusion_proposed"), state, members
    )
    _, resumed = run(flow, event(members), waiting, members)
    assert run(flow, failed, resumed, members).actions == []


def test_result_mentioning_reviewer_preserves_review_and_return(members):
    spec = rule(action="review")
    spec["when"].update(from_role="executor", kind="result")
    flow = workflow(spec, rule("other"))
    actions, state = run(
        flow,
        event(members, "executor", kind="result", mentions=["m-advisor"]),
        {},
        members,
    )
    assert brief(actions) == [("review", "m-advisor")]
    assert actions[0]["rule"] == "r"
    actions, _ = run(
        flow, event(members, "advisor", type="review_failed"), state, members
    )
    assert brief(actions) == [("wake", "m-executor")]


@pytest.mark.parametrize("trigger", ["review_failed", "message"])
def test_ambiguous_review_result_is_explicit(trigger, members):
    first, second = rule("first", action="review"), rule("second", action="review")
    first["when"]["kind"], second["when"]["kind"] = "result", "draft"
    flow = workflow(first, second)
    _, state = run(flow, event(members, "executor", kind="result"), {}, members)
    _, state = run(flow, event(members, "writer", kind="draft"), state, members)
    with pytest.raises(ValueError, match="ambiguous"):
        run(
            flow, event(members, "advisor", type=trigger, kind="review"), state, members
        )


def test_returns_obey_rule_limit(members):
    flow = workflow(rule(action="review", limit={"per_thread": 1}))
    _, state = run(flow, event(members), {}, members)
    assert (
        run(
            flow, event(members, "advisor", type="review_failed"), state, members
        ).actions
        == []
    )


def test_pure_deterministic_detached_and_json_serializable(members):
    flow, item, state = workflow(rule()), event(members), {"unrelated": {"value": [1]}}
    before = deepcopy((flow, item, state, members))
    first, second = run(flow, item, state, members), run(flow, item, state, members)
    assert first == second
    assert (flow, item, state, members) == before
    first.state["unrelated"]["value"].append(2)
    assert state == before[2] and second.state["unrelated"]["value"] == [1]
    assert json.loads(json.dumps(second.state)) == second.state


@pytest.mark.parametrize(
    "change,error",
    [
        ({"when": {"event": "unknown"}}, "when.event"),
        ({"when": {"event": "message", "kind": "unknown"}}, "when.kind"),
        ({"when": {"event": "schedule"}}, "schedule requires cron and timezone"),
        (
            {"when": {"event": "message", "cron": "0 9 * * *"}},
            "cron and timezone require",
        ),
        ({"then": {"action": "wake"}}, "exactly one"),
        (
            {"then": {"action": "wake", "member": "m-executor", "role": "executor"}},
            "exactly one",
        ),
        ({"then": {"action": "review", "role": "advisor"}}, "review requires on_fail"),
        (
            {"then": {"action": "wake", "role": "executor", "max_rounds": 3}},
            "requires review",
        ),
        (
            {"then": {"action": "post", "channel": "c"}},
            "post requires channel and text",
        ),
        (
            {"then": {"action": "wait_for_owner", "member": "me"}},
            "member/role requires",
        ),
        ({"limit": {"per_thread": -1}}, "limit.per_thread"),
        ({"limit": {"per_thread": True}}, "limit.per_thread"),
        ({"enabled": "yes"}, "enabled"),
        ({"position": {"x": float("inf"), "y": 0}}, "position.x"),
        ({"unexpected": 1}, "unexpected"),
    ],
)
def test_rule_validation_explains_field(change, error):
    with pytest.raises(ValidationError, match=error):
        rules.validate_rule({**rule(), **change})


def test_workflow_validation_and_references(members):
    channels = [{"id": "c", "name": "Research", "kind": "channel"}]
    flow = workflow(rule(limit={"per_thread": 0}))
    assert rules.validate_workflow(flow, members=members, channels=channels) == flow
    for bad, error in [
        (workflow(rule(), rule()), "unique"),
        ({**flow, "name": " "}, "name"),
        ({**flow, "version": 0}, "version"),
        (workflow(rule("@mention")), "reserved"),
        (workflow(rule(then={"action": "wake", "member": "me"})), "exactly one agent"),
        (
            workflow(rule(then={"action": "wake", "member": "executor"})),
            "exactly one agent",
        ),
        (
            workflow(rule(when={"event": "message", "channel": "absent"})),
            "unknown channel",
        ),
        (
            workflow(rule(when={"event": "message", "from_member": "absent"})),
            "unknown from_member",
        ),
        (
            {**flow, "layout": {"members": {"missing": {"x": 0, "y": 0}}}},
            "layout.members",
        ),
    ]:
        with pytest.raises(ValueError, match=error):
            rules.validate_workflow(bad, members=members, channels=channels)
    duplicated_role = [
        *members,
        {"id": "another", "name": "Another", "kind": "agent", "role": "executor"},
    ]
    with pytest.raises(ValueError, match="exactly one agent"):
        rules.validate_workflow(flow, members=duplicated_role)


def test_owner_cannot_be_spoofed_in_event(members):
    with pytest.raises(ValueError, match="author does not match"):
        run(
            workflow(rule()),
            event(members, author={"id": "guest", "kind": "human", "role": "owner"}),
            {},
            members,
        )


def scheduled(cron="0 9 * * *", zone="Asia/Singapore", **extra):
    spec = rule(trigger="schedule", action="post", **extra)
    spec["when"].update(cron=cron, timezone=zone, channel="c")
    return workflow(spec)


def test_due_timezone_once_after_many_missed_runs_and_no_mutation(members):
    flow = scheduled()
    now, last = "2026-10-23T01:00:00+00:00", {"r": "2026-10-01T01:00:00+00:00"}
    before = deepcopy((flow, last))
    actions = rules.due(flow, now, last, members=members)
    assert actions == [
        {
            "rule": "r",
            "action": "post",
            "channel": "out",
            "thread": None,
            "text": "Report",
        }
    ]
    assert (flow, last) == before
    assert rules.due(flow, now, {"r": now}, members=members) == []
    assert rules.due(flow, "2026-10-23T01:00:30Z", {"r": now}, members=members) == []
    assert rules.due(flow, "2026-10-24T01:00:00Z", {"r": now}, members=members)


def test_due_first_activation_future_and_disabled_rules(members):
    flow = scheduled()
    assert rules.due(flow, "2026-10-23T01:00:59Z", {}, members=members)
    assert rules.due(flow, "2026-10-23T01:01:00Z", {}, members=members) == []
    assert rules.due(flow, "2026-10-23T00:59:59Z", {}, members=members) == []
    assert (
        rules.due(
            flow, "2026-10-23T01:00:00Z", {"r": "2026-10-24T01:00:00Z"}, members=members
        )
        == []
    )
    assert (
        rules.due(scheduled(enabled=False), "2026-10-23T01:00:00Z", {}, members=members)
        == []
    )


@pytest.mark.parametrize("action", ["wake", "review", "wait_for_owner", "post"])
def test_schedule_each_action(action, members):
    flow = scheduled()
    flow["rules"][0]["then"] = rule(action=action)["then"]
    result = rules.due(flow, "2026-10-23T01:00:00Z", {}, members=members)
    assert len(result) == 1 and result[0]["action"] == action


def test_due_delivery_through_match_obeys_wait_and_tracks_review(members):
    flow = scheduled()
    flow["rules"][0]["then"] = rule(action="review")["then"]
    now = "2026-10-23T01:00:00Z"
    planned = rules.due(flow, now, {}, members=members)
    ids = {a["rule"] for a in planned}
    ready = {**flow, "rules": [r for r in flow["rules"] if r["id"] in ids]}
    delivery = event(members, None, type="schedule")
    actions, state = run(ready, delivery, {}, members)
    assert brief(actions) == [("review", "m-advisor")]
    assert brief(
        run(
            flow, event(members, "advisor", type="review_failed"), state, members
        ).actions
    ) == [("wake", "m-executor")]
    stop = {**flow, "rules": [rule("wait", action="wait_for_owner")]}
    _, state = run(stop, event(members), state, members)
    assert run(ready, delivery, state, members).actions == []


@pytest.mark.parametrize(
    "cron,after,expected",
    [
        ("*/15 9-10 * * 1-5", "2026-10-23T01:00:00Z", "2026-10-23T01:15:00+00:00"),
        ("5,35 9 * * *", "2026-10-23T01:05:00Z", "2026-10-23T01:35:00+00:00"),
        ("0 9 * * 0", "2026-10-23T01:00:00Z", "2026-10-25T01:00:00+00:00"),
        ("0 9 * * 7", "2026-10-23T01:00:00Z", "2026-10-25T01:00:00+00:00"),
        ("0 9 1 * 1", "2026-10-23T01:00:00Z", "2026-10-26T01:00:00+00:00"),
        ("0 9 1 * *", "2026-10-23T01:00:00Z", "2026-11-01T01:00:00+00:00"),
        ("0 9 29 2 *", "2026-10-23T01:00:00Z", "2028-02-29T01:00:00+00:00"),
    ],
)
def test_cron_lists_ranges_steps_calendar_and_sunday(cron, after, expected):
    assert rules.next_cron(cron, "Asia/Singapore", after).isoformat() == expected


@pytest.mark.parametrize(
    "cron,after,expected",
    [
        ("0 9 * * *", "2026-03-07T14:00:00Z", "2026-03-08T13:00:00+00:00"),
        ("30 2 * * *", "2026-03-08T06:00:00Z", "2026-03-08T07:30:00+00:00"),
        ("30 1 * * *", "2026-11-01T05:30:00Z", "2026-11-02T06:30:00+00:00"),
    ],
)
def test_dst_matches_existing_schedule_semantics(cron, after, expected):
    assert rules.next_cron(cron, "America/New_York", after).isoformat() == expected


def test_fold_does_not_deliver_twice_and_gap_is_due_at_shifted_time(members):
    flow = scheduled("30 1 * * *", "America/New_York")
    assert (
        rules.due(
            flow, "2026-11-01T06:30:00Z", {"r": "2026-11-01T05:30:00Z"}, members=members
        )
        == []
    )
    flow = scheduled("30 2 * * *", "America/New_York")
    assert (
        rules.due(
            flow, "2026-03-08T07:29:00Z", {"r": "2026-03-07T07:30:00Z"}, members=members
        )
        == []
    )
    assert rules.due(
        flow, "2026-03-08T07:30:00Z", {"r": "2026-03-07T07:30:00Z"}, members=members
    )


@pytest.mark.parametrize(
    "cron",
    [
        "* * * *",
        "60 * * * *",
        "* 24 * * *",
        "* * 0 * *",
        "* * * 13 *",
        "* * * * 8",
        "*/0 * * * *",
        "10-1 * * * *",
        "a * * * *",
        "*/2/3 * * * *",
        ",1 * * * *",
    ],
)
def test_invalid_cron_is_rejected(cron):
    with pytest.raises(ValueError, match="cron"):
        rules.validate_workflow(scheduled(cron))


def test_invalid_zone_and_naive_time(members):
    with pytest.raises(ValueError, match="unknown timezone"):
        rules.validate_workflow(scheduled(zone="Unknown/Place"))
    with pytest.raises(ValueError, match="timezone"):
        rules.due(scheduled(), datetime(2026, 10, 23), {}, members=members)
    with pytest.raises(ValueError, match="no occurrence"):
        rules.next_cron("0 0 31 2 *", "UTC", "2026-01-01T00:00:00Z")


def simulate(key, sequence, members, *, locale="zh"):
    flow = rules.builtin_workflows(locale)[key]
    state, actual = {}, []
    for role, trigger, kind in sequence:
        actions, state = run(
            flow, event(members, role, type=trigger, kind=kind), state, members
        )
        actual.append(brief(actions))
    return actual, state


def test_research_complete_event_stream_with_rework_owner_gate_and_retrospective(
    members,
):
    actual, state = simulate(
        "research",
        [
            ("owner", "plan_approved", "plan"),
            ("executor", "message", "result"),
            ("advisor", "review_failed", "review"),
            ("executor", "message", "result"),
            ("advisor", "conclusion_proposed", "conclusion"),
            ("executor", "message", "result"),
            ("owner", "plan_approved", "conclusion"),
            ("distiller", "message", "result"),
        ],
        members,
    )
    assert actual == [
        [("wake", "m-executor")],
        [("review", "m-advisor")],
        [("wake", "m-executor")],
        [("review", "m-advisor")],
        [("wait_for_owner", None)],
        [],
        [("wake", "m-distiller")],
        [("wait_for_owner", None)],
    ]
    assert scope(state)["waiting"]


def test_research_planning_and_job_handoff(members):
    actual, _ = simulate(
        "research",
        [
            ("owner", "message", "text"),
            ("advisor", "message", "plan"),
            ("owner", "plan_approved", "plan"),
            (None, "job_finished", "result"),
            ("executor", "message", "result"),
            ("advisor", "message", "review"),
        ],
        members,
    )
    assert actual == [
        [("wake", "m-advisor")],
        [("wait_for_owner", None)],
        [("wake", "m-executor")],
        [("wake", "m-executor")],
        [("review", "m-advisor")],
        [("wake", "m-executor")],
    ]


def test_literature_review_order_and_rework(members):
    actual, _ = simulate(
        "literature-review",
        [
            ("owner", "message", "text"),
            ("librarian", "message", "result"),
            ("librarian", "message", "result"),
            ("writer", "message", "draft"),
            ("reviewer", "review_failed", "review"),
            ("writer", "message", "draft"),
            ("reviewer", "message", "review"),
        ],
        members,
    )
    assert actual == [
        [("wake", "m-librarian")],
        [("wake", "m-librarian")],
        [("wake", "m-writer")],
        [("review", "m-reviewer")],
        [("wake", "m-writer")],
        [("review", "m-reviewer")],
        [("wait_for_owner", None)],
    ]


def test_reproduction_requires_plan_then_report(members):
    actual, _ = simulate(
        "reproduction",
        [
            ("owner", "message", "text"),
            ("executor", "message", "plan"),
            ("owner", "plan_approved", "plan"),
            ("executor", "message", "result"),
            ("advisor", "conclusion_proposed", "conclusion"),
            ("writer", "message", "draft"),
        ],
        members,
    )
    assert actual == [
        [("wake", "m-executor")],
        [("wait_for_owner", None)],
        [("wake", "m-executor")],
        [("review", "m-advisor")],
        [("wake", "m-writer")],
        [("wait_for_owner", None)],
    ]


def test_paper_writing_waits_after_self_review(members):
    actual, _ = simulate(
        "paper-writing",
        [
            ("owner", "message", "text"),
            ("writer", "message", "draft"),
            ("writer", "message", "draft"),
            ("reviewer", "message", "review"),
            ("owner", "message", "text"),
        ],
        members,
    )
    assert actual == [
        [("wake", "m-writer")],
        [("wake", "m-writer")],
        [("review", "m-reviewer")],
        [("wait_for_owner", None)],
        [],
    ]


def test_read_to_write_preserves_direction_choice_child_research_and_paper(members):
    actual, _ = simulate(
        "read-to-write",
        [
            ("owner", "message", "text"),
            ("librarian", "message", "result"),
            ("librarian", "message", "result"),
            ("writer", "message", "draft"),
            ("reviewer", "message", "review"),
            ("advisor", "message", "result"),
            ("executor", "message", "result"),
            ("owner", "plan_approved", "plan"),
            ("executor", "message", "result"),
            ("writer", "message", "draft"),
            ("writer", "message", "draft"),
            ("reviewer", "message", "review"),
        ],
        members,
    )
    assert actual == [
        [("wake", "m-librarian")],
        [("wake", "m-librarian")],
        [("wake", "m-writer")],
        [("review", "m-reviewer")],
        [("wake", "m-advisor")],
        [("wait_for_owner", None)],
        [],
        [("wake", "m-executor")],
        [("wake", "m-writer")],
        [("wake", "m-writer")],
        [("review", "m-reviewer")],
        [("wait_for_owner", None)],
    ]


def test_builtin_data_is_detached_and_bilingual_with_same_rule_identity(members):
    zh, en = rules.builtin_workflows(), rules.builtin_workflows("en")
    assert set(zh) == {
        "research",
        "literature-review",
        "reproduction",
        "paper-writing",
        "read-to-write",
    }
    for key in zh:
        rules.validate_workflow(zh[key], members=members)
        assert zh[key]["name"] != en[key]["name"]
        assert [r["id"] for r in zh[key]["rules"]] == [
            r["id"] for r in en[key]["rules"]
        ]
        assert rules.initial_state(zh[key]) == rules.initial_state(en[key])
        for flow in (zh[key], en[key]):
            signatures = [
                json.dumps([spec["when"], spec["then"]], sort_keys=True)
                for spec in flow["rules"]
            ]
            assert len(signatures) == len(set(signatures))
            for spec in flow["rules"]:
                assert spec["limit"]["per_thread"] == 0
                assert not spec["then"].get("max_rounds")
    zh["research"]["rules"].clear()
    assert rules.builtin_workflows()["research"]["rules"]


@pytest.mark.parametrize("cursor", ["start", "confirm:0"])
def test_compiled_approval_retains_both_entry_points(cursor, members):
    flow = rules.builtin_workflows()["research"]
    state = rules.initial_state(flow)
    state["threads"] = {
        '["t","c","root"]': {
            "relay": 0,
            "waiting": False,
            "workflows": {
                rules._workflow_key(flow): {
                    "cursor": cursor,
                    "counts": {},
                    "reviews": {},
                }
            },
        }
    }
    actions, state = run(
        flow, event(members, type="plan_approved", kind="plan"), state, members
    )
    assert brief(actions) == [("wake", "m-executor")]
    assert next(iter(scope(state)["workflows"].values()))["cursor"] == "step:1"


@pytest.mark.parametrize(
    "cursor", ["confirm:1", "done", "step:2", "confirm:0", "step:0", "step:1"]
)
def test_compiled_discussion_retains_every_entry_point(cursor, members):
    flow = rules.builtin_workflows()["research"]
    state = rules.initial_state(flow)
    state["threads"] = {
        '["t","c","root"]': {
            "relay": 0,
            "waiting": False,
            "workflows": {
                rules._workflow_key(flow): {
                    "cursor": cursor,
                    "counts": {},
                    "reviews": {},
                }
            },
        }
    }
    actions, state = run(flow, event(members), state, members)
    assert brief(actions) == [("wake", "m-advisor")]
    expected = "step:0" if cursor == "confirm:0" else cursor
    assert next(iter(scope(state)["workflows"].values()))["cursor"] == expected


@pytest.mark.parametrize(
    "edit",
    [
        {"enabled": False},
        {"limit": {"per_thread": 7}},
        {"position": {"x": 10, "y": 20}},
    ],
)
def test_deduplicate_keeps_user_edits_and_routing_state(edit):
    original = rule("generated")
    edited = {**deepcopy(original), "id": "edited", **edit}
    flow = workflow(original, rule("other", action="post"), edited)
    wk = rules._workflow_key(flow)
    state = {
        "linear": {
            wk: {
                "generated": {"from": "start", "to": "step:1"},
                "edited": {"from": "confirm:0", "to": "step:1"},
            }
        },
        "threads": {
            "thread": {
                "workflows": {
                    wk: {
                        "cursor": "step:1",
                        "counts": {"generated": 2, "edited": 1},
                        "reviews": {},
                    }
                }
            }
        },
    }
    before = deepcopy((flow, state))
    clean, migrated = rules.deduplicate_workflow(flow, state)
    assert [r["id"] for r in clean["rules"]] == ["other", "edited"]
    assert clean["rules"][1] == rules.validate_rule(edited)
    assert {
        r["from"] for r in rules.route_options(migrated["linear"][wk]["edited"])
    } == {"start", "confirm:0"}
    assert migrated["threads"]["thread"]["workflows"][wk]["counts"] == {"edited": 3}
    assert rules.deduplicate_workflow(clean, migrated) == (clean, migrated)
    assert (flow, state) == before


def test_deduplicate_keeps_distinct_user_instructions():
    original = rule("generated")
    edited = {**deepcopy(original), "id": "edited"}
    edited["then"]["instruction"] = "My revised experiment"
    clean, _ = rules.deduplicate_workflow(workflow(original, edited))
    assert [r["id"] for r in clean["rules"]] == ["generated", "edited"]
    assert clean["rules"][1]["then"]["instruction"] == "My revised experiment"


def test_deduplicate_same_id_keeps_the_edited_copy():
    original = rule()
    edited = {**deepcopy(original), "enabled": False}
    clean, state = rules.deduplicate_workflow(workflow(original, edited))
    assert clean["rules"] == [rules.validate_rule(edited)]
    assert state == {}


def test_edited_builtin_duplicate_keeps_routing_when_state_is_reseeded(members):
    flow = rules.builtin_workflows()["research"]
    for spec in flow["rules"]:
        spec["when"]["channel"] = "c"
    original = next(r for r in flow["rules"] if r["id"] == "research:approved-start")
    flow["rules"].append(
        {**deepcopy(original), "id": "research:0:approved", "limit": {"per_thread": 7}}
    )
    clean, _ = rules.deduplicate_workflow(flow)
    # Exercise a later read whose routing state must be initialized afresh.
    _, state = run(clean, event(members), {}, members)
    actions, state = run(clean, event(members, type="plan_approved"), state, members)
    assert actions == []  # The planning step has not submitted its plan yet.
    _, state = run(clean, event(members, "advisor", kind="plan"), state, members)
    actions, _ = run(clean, event(members, type="plan_approved"), state, members)
    assert brief(actions) == [("wake", "m-executor")]
    assert actions[0]["rule"] == "research:0:approved"


def test_builtin_accepts_additional_rules_without_linear_cursor_conditions(members):
    flow = rules.builtin_workflows()["research"]
    flow["rules"].append(rule("announce", action="post"))
    actions, state = run(flow, event(members), {}, members)
    assert brief(actions) == [("wake", "m-advisor"), ("post", None)]
    actions, _ = run(flow, event(members, "guest"), state, members)
    assert brief(actions) == [("post", None)]


def test_inactive_linear_rules_do_not_consume_direct_mentions(members):
    flow = rules.builtin_workflows()["research"]
    _, state = run(flow, event(members), {}, members)
    actions, _ = run(flow, event(members, mentions=["m-executor"]), state, members)
    assert brief(actions) == [("wake", "m-executor")]
    assert actions[0]["rule"] == "@mention"


def test_migrate_existing_linear_definitions_preserves_instructions_outputs_and_retries(
    members,
):
    from backend.research_workflows import BUILTINS

    for key, value in BUILTINS.items():
        source = {"id": key, "version": 2, "builtin": False, **deepcopy(value)}
        before = deepcopy(source)
        flow, state = rules.convert_linear_workflow(source)
        assert source == before and flow["version"] == 2
        rules.validate_workflow(flow, members=members)
        assert state["linear"]
        instructions = "\n".join(
            r["then"].get("instruction", "") for r in flow["rules"]
        )
        for step in source["steps"]:
            if step.get("action") != "conclusion":
                assert all(path in instructions for path in step.get("outputs", []))
        if key == "literature-review":
            review = next(r for r in flow["rules"] if r["then"]["action"] == "review")
            assert review["then"]["max_rounds"] == 0


def test_custom_linear_cursor_and_retry_return_to_previous_step(members):
    source = {
        "id": "custom",
        "name": "Custom",
        "steps": [
            {"name": "One", "type": "agent", "outputs": ["one.md"]},
            {"name": "Two", "type": "agent", "outputs": ["two.md"]},
            {"name": "Check", "type": "review", "max_retries": 1},
        ],
    }
    flow, state = rules.convert_linear_workflow(source)
    sequence = [("owner", "text"), ("executor", "result"), ("executor", "result")]
    actual = []
    for role, kind in sequence:
        actions, state = run(flow, event(members, role, kind=kind), state, members)
        actual.append(brief(actions))
    assert actual == [
        [("wake", "m-executor")],
        [("wake", "m-executor")],
        [("review", "m-advisor")],
    ]
    actions, state = run(
        flow, event(members, "advisor", type="review_failed"), state, members
    )
    assert brief(actions) == [("wake", "m-executor")]
    actions, state = run(
        flow, event(members, "executor", kind="result"), state, members
    )
    assert brief(actions) == [("review", "m-advisor")]
    actions, _ = run(
        flow, event(members, "advisor", type="review_failed"), state, members
    )
    assert brief(actions) == [("limit", None)]


def test_coalesced_reviews_keep_each_steps_retry_boundary(members):
    source = {
        "id": "repeat",
        "name": "Repeat",
        "steps": [
            {"name": "Work", "type": "agent"},
            {"name": "Check", "type": "review", "max_retries": 1},
        ]
        * 2,
    }
    flow, state = rules.convert_linear_workflow(source)
    assert len([r for r in flow["rules"] if r["then"]["action"] == "review"]) == 1
    actions, state = run(flow, event(members), state, members)
    assert brief(actions) == [("wake", "m-executor")]
    for final_cursor in ["step:2", "done"]:
        actions, state = run(
            flow, event(members, "executor", kind="result"), state, members
        )
        assert brief(actions) == [("review", "m-advisor")]
        actions, state = run(
            flow, event(members, "advisor", type="review_failed"), state, members
        )
        assert brief(actions) == [("wake", "m-executor")]
        actions, state = run(
            flow, event(members, "executor", kind="result"), state, members
        )
        assert brief(actions) == [("review", "m-advisor")]
        _, state = run(flow, event(members, "advisor", kind="review"), state, members)
        assert next(iter(scope(state)["workflows"].values()))["cursor"] == final_cursor


@pytest.mark.parametrize("index", [1, 3])
def test_resume_coalesced_review_uses_the_current_step(index, members):
    from types import SimpleNamespace

    from backend.team_workflows import prime

    source = {
        "id": "repeat",
        "name": "Repeat",
        "steps": [
            {"name": "Work", "type": "agent"},
            {"name": "Check", "type": "review", "max_retries": 1},
        ]
        * 2,
    }
    flow, state = rules.convert_linear_workflow(source)
    project = SimpleNamespace(
        id="root",
        workspace_id=None,
        workflow=flow,
        status="active",
        workflow_state={"execution": source, "current": index, "steps": [{}] * 4},
    )
    state = prime(project, state, "c", "t", members)
    review = next(
        iter(next(iter(scope(state)["workflows"].values()))["reviews"].values())
    )
    assert review["pending"] and review["cursor"] == f"step:{index}"
    actions, state = run(
        flow, event(members, "advisor", type="review_failed"), state, members
    )
    assert brief(actions) == [("wake", "m-executor")]
    assert (
        next(iter(scope(state)["workflows"].values()))["cursor"] == f"step:{index - 1}"
    )


@pytest.mark.parametrize(
    "steps,error",
    [
        ([], "non-empty"),
        ([{"name": "Review", "type": "review"}], "preceding"),
        ([{"name": "Bad", "type": "other"}], "type"),
        ([{"type": "agent"}], "name"),
    ],
)
def test_migration_errors(steps, error):
    with pytest.raises(ValueError, match=error):
        rules.convert_linear_workflow({"id": "x", "name": "X", "steps": steps})
