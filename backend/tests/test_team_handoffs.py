"""Deliverable decisions and handoffs; isolated DB, forbidden network/subprocesses."""

from types import SimpleNamespace
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from backend import research_team as team, team_rules
from backend.models import (
    AgentControl,
    AgentRun,
    ResearchWorkspace,
    TeamDelivery,
    TeamMessage,
)
from backend.research_team_tools import TEAM_TOOLS, _call
from backend.tests.test_team_message_features import (
    features,
    member_message,
    post,
)  # noqa: F401


def decide(features, message, status="changes_requested", feedback="补充来源"):
    return features.client.post(
        f"{features.base}/messages/{message}/decision",
        json={"status": status, "feedback": feedback},
    )


def workflow(features, event, action):
    body = {
        **features.client.get(features.base + "/workflow").json(),
        "rules": [{"id": "rule", "when": {"event": event}, "then": action}],
    }
    result = features.client.put(features.base + "/workflow", json=body)
    assert result.status_code == 200, result.text


def test_team_handoffs_changes_requested_is_durable_idempotent_and_wakes_author(
    features,
):
    mid = member_message(features, kind="draft", data={"done_when": "每个结论都有来源"})
    assert decide(features, mid, feedback=" \n ").status_code == 409
    result = decide(features, mid)
    assert result.status_code == 200, result.text
    decision = result.json()["data"]["decision"]
    assert decision["status"] == "changes_requested"
    assert decision["feedback"] == "补充来源"
    assert decide(features, mid).json()["data"]["decision"] == decision
    with features.maker() as d:
        event = d.get(TeamMessage, decision["event_id"])
        assert event.kind == "changes_requested"
        delivery = d.scalar(select(TeamDelivery))
        assert delivery.member_id == features.members["librarian"]
        run = d.get(AgentRun, delivery.run_id)
        assert "补充来源" in run.prompt and "useful" in run.prompt
        assert "每个结论都有来源" in run.prompt
        assert (
            d.scalar(
                select(TeamMessage).where(TeamMessage.source_key == f"run:{run.id}")
            ).data["done_when"]
            == "每个结论都有来源"
        )
        assert len(list(d.scalars(select(TeamDelivery)))) == 1


def test_team_handoffs_decision_rules_match_original_author_without_duplicate_wake(
    features,
):
    workflow(
        features,
        "changes_requested",
        {"action": "wake", "member": "$author", "instruction": "核对全部引用"},
    )
    mid = member_message(features, kind="result")
    result = decide(features, mid)
    assert result.status_code == 200, result.text
    with features.maker() as d:
        deliveries = list(d.scalars(select(TeamDelivery)))
        assert len(deliveries) == 1
        assert deliveries[0].action["rule"] == "rule"
        assert "核对全部引用" in d.get(AgentRun, deliveries[0].run_id).prompt
    for status in ("accepted", "changes_requested"):
        members = [
            {"id": "human", "kind": "human", "role": "owner"},
            {"id": "writer", "kind": "agent", "role": "writer"},
        ]
        flow = {
            "id": "f",
            "name": "f",
            "version": 1,
            "rules": [
                {
                    "id": "r",
                    "when": {"event": status, "from_role": "writer", "kind": "draft"},
                    "then": {"action": "wake", "member": "$author"},
                }
            ],
        }
        event = {
            "type": status,
            "team": "t",
            "channel": "c",
            "thread": None,
            "at": "2026-10-24T00:00:00Z",
            "author": members[0],
            "original_author": members[1],
            "kind": "draft",
        }
        assert (
            team_rules.match(flow, event, {}, members=members).actions[0]["member"]
            == "writer"
        )


@pytest.mark.parametrize("action", ["wake", "review"])
def test_team_handoffs_acceptance_records_event_without_waking_even_with_rule(
    features, action
):
    workflow(
        features,
        "accepted",
        {
            "action": action,
            "member": "$author",
            **(
                {"on_fail": features.members["librarian"]} if action == "review" else {}
            ),
        },
    )
    mid = member_message(
        features, data={"files": [{"path": "draft.md", "name": "draft.md"}]}
    )
    result = decide(features, mid, "accepted", "")
    assert result.status_code == 200, result.text
    with features.maker() as d:
        assert not d.scalar(select(TeamDelivery))
        assert not d.scalar(select(AgentRun))
        assert not any(
            execution["reviews"]
            for scope in d.get(ResearchWorkspace, "workspace")
            .workflow_state.get("threads", {})
            .values()
            for execution in scope.get("workflows", {}).values()
        )
        assert (
            d.get(TeamMessage, result.json()["data"]["decision"]["event_id"]).kind
            == "accepted"
        )


@pytest.mark.parametrize(
    "kind", ["plan", "conclusion", "event_reference", "sprint_reference", "text"]
)
def test_team_handoffs_decisions_do_not_replace_approvals_or_apply_to_chat(
    features, kind
):
    mid = member_message(
        features, kind=kind, data={"event_id": "missing", "sprint_id": "missing"}
    )
    assert decide(features, mid).status_code == 409
    assert decide(features, "missing").status_code == 404
    human = member_message(features, role="human", kind="draft")
    assert decide(features, human).status_code == 409


def test_team_handoffs_record_only_bypasses_mentions_dm_and_all_workflow_actions(
    features,
):
    workflow(
        features, "message", {"action": "wake", "member": features.members["reviewer"]}
    )
    for channel in ("general", "dm:librarian"):
        result = post(
            features, channel, text="@writer 备忘", mode="record", done_when="可重现"
        )
        assert result.status_code == 200, result.text
        assert features.members["writer"] in result.json()["mentions"]
    with features.maker() as d:
        assert not d.scalar(select(TeamDelivery))
        assert not d.scalar(select(AgentRun))
        assert not d.scalar(select(AgentControl))
    result = post(features, "dm:librarian", text="继续")
    assert result.status_code == 200, result.text
    with features.maker() as d:
        run = d.scalar(select(AgentRun))
        assert "备忘" in run.context and "可重现" in run.context


def test_team_handoffs_done_when_survives_queue_merge_and_immediate_steering(features):
    first = post(features, "dm:librarian", text="开始", done_when="包含证据")
    assert first.status_code == 200, first.text
    with features.maker() as d:
        delivery = d.scalar(select(TeamDelivery))
        run = d.get(AgentRun, delivery.run_id)
        assert "包含证据" in run.prompt
        queued_id = run.id
    # A queued run absorbs another message and its completion criterion.
    assert (
        post(features, "dm:librarian", text="补充", done_when="给出数据").status_code
        == 200
    )
    with features.maker() as d:
        run = d.get(AgentRun, queued_id)
        assert "给出数据" in run.prompt
        run.status = "running"
        d.commit()
    assert (
        post(
            features,
            "dm:librarian",
            text="更新",
            mode="immediate",
            done_when="附上脚本",
        ).status_code
        == 200
    )
    with features.maker() as d:
        control = d.scalar(select(AgentControl))
        assert "附上脚本" in control.text


def test_team_handoffs_tool_done_when_crosses_channels_and_reaches_reviewer(features):
    result = post(features, "dm:librarian", text="查找来源")
    assert result.status_code == 200, result.text
    with features.maker() as d:
        delivery = d.scalar(select(TeamDelivery))
        run = d.get(AgentRun, delivery.run_id)
        info = {**run.runtime["team"], "run_id": run.id}
        run.status = "completed"
        d.commit()
    app = SimpleNamespace(
        state=SimpleNamespace(maker=features.maker, settings=SimpleNamespace())
    )
    result = _call(
        app,
        "owner",
        info,
        "team_send_message",
        {
            "text": "请审阅",
            "kind": "draft",
            "channel_id": features.channels["general"],
            "wake": ["reviewer"],
            "done_when": "引用可核验",
        },
    )
    with features.maker() as d:
        incoming = d.get(TeamMessage, result["message_id"])
        assert incoming.data["done_when"] == "引用可核验"
        delivery = d.scalar(
            select(TeamDelivery).where(
                TeamDelivery.member_id == features.members["reviewer"]
            )
        )
        team.dispatch(
            SimpleNamespace(), d, d.get(ResearchWorkspace, "workspace"), delivery
        )
        run = d.get(AgentRun, delivery.run_id)
        assert "引用可核验" in run.prompt and "引用可核验" in run.context
        d.commit()
    spec = next(s for s in TEAM_TOOLS if s["name"] == "team_send_message")
    assert (
        spec["parameters"]["properties"]["done_when"]["description"]
        == "完成的标准，可选"
    )


def test_team_handoffs_tool_reply_inherits_criteria_for_later_review(features):
    result = post(features, "dm:librarian", text="查来源", done_when="引用可核验")
    assert result.status_code == 200, result.text
    with features.maker() as d:
        run = d.scalar(select(AgentRun))
        info = {**run.runtime["team"], "run_id": run.id}
        run.status = "completed"
        d.commit()
    app = SimpleNamespace(
        state=SimpleNamespace(maker=features.maker, settings=SimpleNamespace())
    )
    result = _call(
        app,
        "owner",
        info,
        "team_send_message",
        {"text": "草稿", "kind": "draft", "wake": ["reviewer"]},
    )
    with features.maker() as d:
        response = d.get(TeamMessage, result["message_id"])
        assert response.data["done_when"] == "引用可核验"
        from backend.team_workflows import route_message

        workspace = d.get(ResearchWorkspace, "workspace")
        route_message(d, workspace, response)
        delivery = d.scalar(
            select(TeamDelivery).where(
                TeamDelivery.member_id == features.members["reviewer"]
            )
        )
        team.dispatch(SimpleNamespace(), d, workspace, delivery)
        run = d.get(AgentRun, delivery.run_id)
        assert "引用可核验" in run.prompt and "引用可核验" in run.context


def test_team_handoffs_event_adapter_keeps_timer_proxies_working(features):
    from backend.team_timers import route

    with features.maker() as d:
        workspace = d.get(ResearchWorkspace, "workspace")
        rule = {
            "id": "timer",
            "enabled": True,
            "when": {"event": "schedule", "cron": "0 9 * * *", "timezone": "UTC"},
            "then": {"action": "wake", "member": features.members["writer"]},
        }
        actions = route(d, workspace, rule, datetime(2026, 10, 24, 9, tzinfo=UTC))
        assert actions[0]["member"] == features.members["writer"]
