"""Custom members: owned templates, routing and runtime boundaries, no models."""

import asyncio
import importlib
import json
from pathlib import Path

import pytest
from sqlalchemy import select

from backend import agent_worker, research_team as team
from backend.agent_tools import execute, TOOLS
from backend.models import AgentRun, ResearchWorkspace, TeamMember, TeamMessage
from backend.team_members import MemberConfig, apply_runtime
from backend.tests.test_research_team import (
    world,
    send,
    deliveries,
    finish,
)  # noqa: F401
from backend.tests.test_acceptance import env as cloud_env  # noqa: F401
from backend.tests.test_research_routes import env  # noqa: F401


def create(world, **patch):
    _, a, _, _, _, _, _, base, _ = world
    body = MemberConfig(
        name="Ada", role_description="# Role\nCheck the evidence", **patch
    ).model_dump()
    response = a.post(base + "/members", json={"config": body})
    assert response.status_code == 200, response.text
    return response.json()["id"], body


def test_create_edit_delete_and_isolation(world):
    app, a, b, _, _, _, _, base, _ = world
    mid, body = create(world)
    overview = a.get(base).json()
    member = next(m for m in overview["members"] if m["id"] == mid)
    assert member["name"] == "Ada" and not member["builtin"]
    assert any(c["member_id"] == mid for c in overview["channels"])
    assert b.patch(base + f"/members/{mid}", json={"enabled": False}).status_code == 404
    body["name"] = "Ada II"
    assert a.patch(base + f"/members/{mid}", json={"config": body}).status_code == 200
    send(world, "@Ada II verify")
    assert deliveries(app)[0].member_id == mid
    assert a.get(base + f"/members/{mid}").json()["activity"] == "@Ada II verify"
    assert a.delete(base + f"/members/{mid}").status_code == 200
    assert a.get(base + f"/members/{mid}").status_code == 404
    with app.state.maker() as d:
        assert d.get(TeamMember, mid).deleted
        assert team.mentions(d, d.get(ResearchWorkspace, world[6]), "@Ada II") == []


def test_copy_builtin_identity_and_configuration_are_editable(world):
    _, a, _, _, _, model, _, base, overview = world
    executor = next(m for m in overview["members"] if m["role"] == "executor")
    copied = a.post(base + "/members", json={"copy_from": executor["id"]})
    assert copied.status_code == 200
    clone = a.get(base + f"/members/{copied.json()['id']}").json()
    assert clone["role_description"] == executor["role_description"]
    assert clone["permissions"] == executor["permissions"] and not clone["builtin"]
    assert a.delete(base + f"/members/{executor['id']}").status_code == 422
    fields = {k: executor[k] for k in MemberConfig.model_fields}
    fields.update(model_config_id=model, wake_turns=2, wake_tokens=500)
    fields["permissions"]["commands"] = False
    response = a.patch(base + f"/members/{executor['id']}", json={"config": fields})
    assert response.status_code == 200, response.text
    fields["name"] = "Hacked"
    assert (
        a.patch(
            base + f"/members/{executor['id']}", json={"config": fields}
        ).status_code
        == 200
    )


def test_disabled_member_cancels_queued_and_rules_do_not_wake(world):
    app, a, _, settings, _, _, _, base, _ = world
    mid, _ = create(world)
    send(world, "@Ada first")
    first = deliveries(app)[0]
    # Busy, so the second message queues instead of joining the unstarted wake.
    with app.state.maker() as d:
        d.get(AgentRun, first.run_id).status = "running"
        d.commit()
    send(world, "@Ada second")
    assert deliveries(app)[1].status == "queued"
    assert a.patch(base + f"/members/{mid}", json={"enabled": False}).status_code == 200
    assert deliveries(app)[1].status == "cancelled"
    finish(app, first.run_id, "done")
    send(world, "@Ada third")
    team.settle(settings, app.state.maker)
    assert len(deliveries(app)) == 2
    flow = a.get(base + "/workflow").json()
    flow["rules"] = [
        {
            "id": "disabled",
            "enabled": True,
            "when": {"event": "message"},
            "then": {"action": "wake", "member": mid},
            "limit": {"per_thread": 10},
        }
    ]
    assert a.put(base + "/workflow", json=flow).status_code == 200
    send(world, "try disabled rule")
    assert len(deliveries(app)) == 2


def test_overview_distinguishes_queued_deliveries_runs_and_idle(world):
    app, a, _, settings, _, _, _, base, _ = world
    mid, _ = create(world)

    def status():
        return next(m for m in a.get(base).json()["members"] if m["id"] == mid)

    assert status()["status"] == "idle"
    send(world, "@Ada first")
    first = deliveries(app)[0]
    # A delivery has a run before a worker claims it.
    assert status()["status"] == "queued"
    assert status()["active_run_id"] == first.run_id
    with app.state.maker() as d:
        d.get(AgentRun, first.run_id).status = "running"
        d.commit()
    assert status()["status"] == "working"
    # Busy, so the second message queues instead of joining the unstarted wake.
    send(world, "@Ada second")
    assert deliveries(app)[1].status == "queued"
    finish(app, first.run_id, "done")
    assert status()["status"] == "queued"
    assert status()["active_run_id"] is None
    team.settle(settings, app.state.maker)
    assert status()["status"] == "queued"
    finish(app, deliveries(app)[1].run_id, "done")
    team.settle(settings, app.state.maker)
    assert status()["status"] == "idle"
    assert all(m["status"] == "idle" for m in a.get(base).json()["members"])


def test_overview_member_limit_waits_instead_of_queueing(world):
    app, a, _, _, _, _, _, base, _ = world
    response = a.post(
        base + "/members",
        json={
            "source": "---\nname: Ada\nbudget: {total_tokens: 10}\n---\nCheck evidence"
        },
    )
    assert response.status_code == 200, response.text
    mid = response.json()["id"]
    with app.state.maker() as d:
        d.get(TeamMember, mid).tokens = 10
        d.commit()
    send(world, "@Ada verify")
    assert deliveries(app)[0].status == "queued"
    member = next(m for m in a.get(base).json()["members"] if m["id"] == mid)
    assert member["status"] == "waiting" and member["active_run_id"] is None


def test_subscribers_are_real_members_and_share_rule_limit(world):
    app, a, _, _, _, _, _, base, overview = world
    channel = next(c["id"] for c in overview["channels"] if c["key"] == "general")
    mid, _ = create(world)
    assert (
        a.patch(base + f"/members/{mid}", json={"subscriptions": [channel]}).status_code
        == 200
    )
    flow = a.get(base + "/workflow").json()
    flow["rules"] = [
        {
            "id": "listeners",
            "enabled": True,
            "when": {"event": "message", "channel": channel},
            "then": {"action": "wake", "subscribers": True},
            "limit": {"per_thread": 1},
        }
    ]
    saved = a.put(base + "/workflow", json=flow)
    assert saved.status_code == 200, saved.text
    send(world, "new evidence")
    assert [r.member_id for r in deliveries(app)] == [mid]
    send(world, "rule limit")
    assert len(deliveries(app)) == 1


def test_library_sync_preserves_each_teams_overrides_and_requires_choice(world):
    _, a, b, _, _, _, _, base, _ = world
    mid, body = create(world)
    library = a.get(base + "/library").json()[0]
    wid2 = a.post("/api/v1/research/workspaces", json={"name": "Other"}).json()["id"]
    base2 = f"/api/v1/research/workspaces/{wid2}/team"
    other = a.post(base2 + "/members", json={"library_id": library["id"]})
    assert other.status_code == 200, other.text
    oid = other.json()["id"]
    override = {**body, "role_description": "Team-specific skill"}
    assert (
        a.patch(base2 + f"/members/{oid}", json={"config": override}).status_code == 200
    )
    path = base + f"/library/{library['id']}"
    changed = {**body, "role_description": "New library skill", "wake_turns": 5}
    assert a.patch(path, json={"config": changed, "version": 1}).status_code == 422
    assert (
        b.patch(path, json={"config": changed, "version": 1, "sync": True}).status_code
        == 404
    )
    assert (
        a.patch(path, json={"config": changed, "version": 1, "sync": True}).status_code
        == 200
    )
    assert (
        a.get(base + f"/members/{mid}").json()["role_description"]
        == "New library skill"
    )
    synced = a.get(base2 + f"/members/{oid}").json()
    assert (
        synced["role_description"] == "Team-specific skill"
        and synced["wake_turns"] == 5
    )
    assert (
        a.patch(path, json={"config": changed, "version": 1, "sync": True}).status_code
        == 409
    )
    changed["role_description"] = "Library only"
    assert (
        a.patch(path, json={"config": changed, "version": 2, "sync": False}).status_code
        == 200
    )
    assert (
        a.get(base + f"/members/{mid}").json()["role_description"]
        == "New library skill"
    )
    assert (
        a.patch(base2 + f"/members/{oid}", json={"reset_overrides": True}).status_code
        == 200
    )
    assert a.get(base2 + f"/members/{oid}").json()["role_description"] == "Library only"


@pytest.mark.parametrize("research_round", [False, True])
def test_permission_checks_and_denials_are_persisted(world, research_round):
    app, a, _, _, owner, _, _, base, _ = world
    mid, body = create(
        world,
        permissions={
            "papers": False,
            "files": True,
            "commands": False,
            "readonly": False,
            "machines": [],
        },
    )
    send(world, "@Ada act")
    run_id = deliveries(app)[0].run_id
    with app.state.maker() as d:
        run = d.get(AgentRun, run_id)
        run.status = "running"
        run.runtime = {
            "team": {**run.runtime["team"], "research_round": research_round},
            **({"research": {"role": "executor"}} if research_round else {}),
        }
        session_id = run.session_id
        d.commit()
    for name, args in [
        ("bash", {"command": "echo should-not-run"}),
        ("read_paper", {"id": "11111111-1111-4111-8111-111111111111"}),
        ("read", {"path": "x"}),
    ]:
        with pytest.raises(ValueError, match="permission denied"):
            asyncio.run(
                execute(app, owner, session_id, name, args, "test", sandbox_id=run_id)
            )
    with app.state.maker() as d:
        denied = list(
            d.scalars(
                select(TeamMessage).where(TeamMessage.kind == "permission_denied")
            )
        )
        assert {m.data["tool"] for m in denied} == {"bash", "read_paper", "read"}
        member = d.get(TeamMember, mid)
        payload = {
            "tools": TOOLS,
            "system_prompt": "Runtime rules",
            "context": "Brief",
            "limits": {"model_turns": 32, "output_tokens": 8192},
        }
        apply_runtime(d, d.get(AgentRun, run_id), payload, {"member_id": mid})
        names = {t["name"] for t in payload["tools"]}
        assert "bash" not in names and "read_paper" not in names
        from backend.models import ResearchWorkspace
        from backend.research_team import language_part

        prefix = (
            language_part(d, d.get(ResearchWorkspace, world[6]))
            + f"You are {body['name']}, a member of this team."
        )
        assert body["role_description"] in payload["context"]
        assert payload["context"].startswith(prefix)
        assert payload["system_prompt"].startswith(prefix)


@pytest.mark.parametrize("turns,tokens", [(1, 1000), (10, 20)])
def test_per_wake_budget_stops_before_next_model_call(
    world, tmp_path, monkeypatch, turns, tokens
):
    app, a, _, _, _, _, _, base, _ = world
    mid, _ = create(world, wake_turns=turns, wake_tokens=tokens)
    send(world, "@Ada work")
    run_id = deliveries(app)[0].run_id
    with app.state.maker() as d:
        d.get(AgentRun, run_id).status = "running"
        d.commit()
    captured = tmp_path / "payload.json"
    node = tmp_path / "fake-node"
    node.write_text(
        f"""#!{Path(".venv/bin/python").resolve()}
import json, sys
payload = json.loads(sys.stdin.readline())
open({str(captured)!r}, 'w').write(json.dumps(payload))
for i in range(2):
 print(json.dumps({{'type':'model_request','id':str(i)}}), flush=True)
 if not sys.stdin.readline(): break
 print(json.dumps({{'type':'usage','usage':{{'input':10,'output':20}}}}), flush=True)
print(json.dumps({{'type':'done'}}), flush=True)
"""
    )
    node.chmod(0o755)
    monkeypatch.setenv("AGENT_NODE", str(node))
    agent_worker.process(app, run_id)
    with app.state.maker() as d:
        run = d.get(AgentRun, run_id)
        assert run.status == "failed" and "wake budget exhausted" in run.error
        assert d.get(TeamMember, mid).tokens == 30
    payload = json.loads(captured.read_text())
    assert payload["limits"]["model_turns"] == min(32, turns)
    assert payload["limits"]["output_tokens"] == min(32768, tokens)


def test_member_validation_and_migration(world):
    app, a, _, _, _, _, _, base, _ = world
    for patch in (
        {"name": " "},
        {"wake_turns": -1},
        {"wake_tokens": -1},
        {"avatar_color": "url(x)"},
    ):
        body = {**MemberConfig(name="Valid").model_dump(), **patch}
        assert a.post(base + "/members", json={"config": body}).status_code == 422
    assert (
        a.post(
            base + "/members",
            json={
                "config": MemberConfig(name="Valid").model_dump(),
                "subscriptions": ["foreign"],
            },
        ).status_code
        == 422
    )
    migration = importlib.import_module(
        "backend.migrations.versions.0046_custom_team_members"
    )
    assert migration.down_revision == "0045"


def test_migration_upgrades_old_rows_and_is_idempotent(tmp_path):
    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    engine = sa.create_engine("sqlite:///" + str(tmp_path / "old.db"))
    migration = importlib.import_module(
        "backend.migrations.versions.0046_custom_team_members"
    )
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "CREATE TABLE team_members (id VARCHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL)"
            )
        )
        connection.execute(
            sa.text("INSERT INTO team_members VALUES ('old', 'Advisor')")
        )
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            migration.upgrade()
            row = (
                connection.execute(sa.text("SELECT * FROM team_members"))
                .mappings()
                .one()
            )
            assert row["name"] == "Advisor" and row["enabled"] == 1
            assert row["wake_tokens"] == 200000
            migration.downgrade()
        assert {
            c["name"] for c in sa.inspect(connection).get_columns("team_members")
        } == {"id", "name"}


def test_readonly_denies_file_writes_even_with_commands_granted(world):
    app, _, _, _, owner, _, _, _, _ = world
    mid, _ = create(
        world,
        permissions={
            "papers": True,
            "files": True,
            "commands": True,
            "readonly": True,
            "machines": ["host"],
        },
    )
    send(world, "@Ada review only")
    run_id = deliveries(app)[0].run_id
    with app.state.maker() as d:
        run = d.get(AgentRun, run_id)
        run.status = "running"
        session = run.session_id
        d.commit()
    for name, args in [
        ("write", {"path": "result.txt", "content": "must not write"}),
        ("bash", {"command": "echo must not run"}),
    ]:
        with pytest.raises(ValueError, match="permission denied"):
            asyncio.run(
                execute(app, owner, session, name, args, "test", sandbox_id=run_id)
            )
    with app.state.maker() as d:
        assert (
            len(
                list(
                    d.scalars(
                        select(TeamMessage).where(
                            TeamMessage.kind == "permission_denied"
                        )
                    )
                )
            )
            == 2
        )
