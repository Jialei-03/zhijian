"""Legacy budget cleanup and workflow defaults, without runners or network I/O."""

import importlib
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from backend import research_worker as worker
from backend import research_workflows as workflows
from backend import team_workflows


@pytest.fixture
def migration_db():
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    projects = sa.Table(
        "research_projects",
        metadata,
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("budget", sa.JSON),
        sa.Column("spent", sa.JSON),
        sa.Column("plan", sa.JSON),
    )
    workspaces = sa.Table(
        "research_workspaces",
        metadata,
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("workflow_state", sa.JSON),
    )
    metadata.create_all(engine)
    migration = importlib.import_module(
        "backend.migrations.versions.0049_unlimited_defaults"
    )
    assert migration.down_revision == "0048"
    with engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            yield connection, projects, workspaces, migration
    engine.dispose()


@pytest.mark.parametrize(
    "spent",
    [None, {}, {"sprints": 0}, {"sprints": 29}, {"sprints": 30}, {"sprints": 31}],
)
@pytest.mark.parametrize(
    "plan",
    [
        None,
        {},
        {"approved_at": None},
        {"approved_at": ""},
        {"approved_at": "2026-10-23T00:00:00Z"},
    ],
)
def test_migration_clears_only_unapproved_unused_defaults(migration_db, spent, plan):
    connection, projects, _, migration = migration_db
    original = {
        "max_sprints": 30,
        "max_tokens": 2000000,
        "max_job_seconds": 36000,
        "custom": True,
    }
    connection.execute(
        projects.insert().values(id="p", budget=original, spent=spent, plan=plan)
    )
    expected = {**original, "max_tokens": None}
    if not (plan or {}).get("approved_at"):
        expected["max_job_seconds"] = None
        if (spent or {}).get("sprints", 0) < 30:
            expected["max_sprints"] = None
    for operation in (migration.upgrade, migration.upgrade, migration.downgrade):
        operation()
        row = connection.execute(sa.select(projects)).mappings().one()
        assert row["budget"] == expected
        assert row["spent"] == spent and row["plan"] == plan


@pytest.mark.parametrize(
    "budget,expected",
    [
        (None, None),
        ({}, {}),
        (
            {"max_sprints": None, "max_tokens": None, "max_job_seconds": None},
            {"max_sprints": None, "max_tokens": None, "max_job_seconds": None},
        ),
        (
            {"max_sprints": 0, "max_tokens": 0, "max_job_seconds": 0},
            {"max_sprints": 0, "max_tokens": 0, "max_job_seconds": 0},
        ),
        (
            {"max_sprints": 12, "max_tokens": 123456, "max_job_seconds": 7200},
            {"max_sprints": 12, "max_tokens": 123456, "max_job_seconds": 7200},
        ),
        (
            {"max_sprints": 12, "max_tokens": 2000000, "max_job_seconds": 36000},
            {"max_sprints": 12, "max_tokens": None, "max_job_seconds": None},
        ),
        (
            {"max_sprints": 30, "max_tokens": 123456, "max_job_seconds": 7200},
            {"max_sprints": None, "max_tokens": 123456, "max_job_seconds": 7200},
        ),
    ],
)
def test_migration_preserves_custom_project_limits(migration_db, budget, expected):
    connection, projects, _, migration = migration_db
    connection.execute(
        projects.insert().values(id="p", budget=budget, spent={}, plan={})
    )
    migration.upgrade()
    migration.upgrade()
    assert connection.scalar(sa.select(projects.c.budget)) == expected


@pytest.mark.parametrize(
    "state",
    [
        None,
        {},
        {"budget": {}},
        {
            "budget": {"relay_limit": 0, "max_tokens": 500, "max_concurrent": 2},
            "threads": {"root": {"relay": 20}},
        },
        {"budget": {"relay_limit": 6}},
        {"budget": {"max_tokens": 500}},
    ],
)
def test_migration_removes_only_team_relay_limit(migration_db, state):
    connection, _, workspaces, migration = migration_db
    connection.execute(
        workspaces.insert().values(id="w", workflow_state=state)
    )
    expected = state
    if state and "relay_limit" in state.get("budget", {}):
        expected = {
            **state,
            "budget": {
                key: value
                for key, value in state["budget"].items()
                if key != "relay_limit"
            },
        }
    for operation in (migration.upgrade, migration.upgrade, migration.downgrade):
        operation()
        assert connection.scalar(sa.select(workspaces.c.workflow_state)) == expected


@pytest.mark.parametrize("kind", ["agent", "plan", "experiment", "review"])
def test_research_steps_and_builtins_have_no_default_round_limits(kind):
    assert workflows.StepInput(name="Step", type=kind).max_rounds is None
    assert workflows.StepInput(name="Step", type=kind).max_retries == 0
    assert workflows.StepInput(name="Step", type=kind, max_rounds=0).max_rounds == 0
    explicit = workflows.StepInput(
        name="Step", type=kind, max_rounds=7, max_retries=2
    )
    assert explicit.max_rounds == 7 and explicit.max_retries == 2
    for flow in workflows.BUILTINS.values():
        for step in flow["steps"]:
            assert not step.get("max_rounds") and not step.get("max_retries")


@pytest.mark.parametrize("maximum", ["missing", None, 0, 3])
def test_research_worker_enforces_only_explicit_round_limit(monkeypatch, maximum):
    spec = {"type": "agent"}
    if maximum != "missing":
        spec["max_rounds"] = maximum
    project = SimpleNamespace(
        id="p",
        owner="owner",
        model_config_id="model",
        status="active",
        workflow_state={"current": 0, "steps": [{"rounds": 40}]},
    )
    monkeypatch.setattr(worker, "_schedulable", lambda *args: True)
    monkeypatch.setattr(workflows, "adopt_project", lambda *args: None)
    monkeypatch.setattr(workflows, "checkpoints", lambda *args: True)
    monkeypatch.setattr(workflows, "current", lambda *args: spec)
    monkeypatch.setattr(worker, "_over_budget", lambda *args: False)
    monkeypatch.setattr(worker, "read_config", lambda *args: {"model": "fake"})
    monkeypatch.setattr(team_workflows, "next_research_action", lambda *args: {})
    monkeypatch.setattr(team_workflows, "action_role", lambda *args: "workflow")
    start, block = MagicMock(), MagicMock()
    monkeypatch.setattr(worker, "_start", start)
    monkeypatch.setattr(workflows, "block", block)
    database = MagicMock()
    database.scalars.return_value.first.return_value = None
    worker._plan(
        SimpleNamespace(state=SimpleNamespace(settings=None)), database, project
    )
    assert start.call_count == (maximum != 3)
    assert block.call_count == (maximum == 3)
