"""Remove unused legacy default budgets and the retired relay cap."""

import sqlalchemy as sa
from alembic import op

revision = "0049"
down_revision = "0048"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    projects = sa.Table("research_projects", sa.MetaData(), autoload_with=bind)
    for row in bind.execute(
        sa.select(projects.c.id, projects.c.budget, projects.c.spent, projects.c.plan)
    ).mappings():
        budget = dict(row["budget"] or {})
        if not (row["plan"] or {}).get("approved_at"):
            if budget.get("max_sprints") == 30 and (row["spent"] or {}).get(
                "sprints", 0
            ) < 30:
                budget["max_sprints"] = None
            if budget.get("max_job_seconds") == 36000:
                budget["max_job_seconds"] = None
        if budget.get("max_tokens") == 2000000:
            budget["max_tokens"] = None
        if budget != (row["budget"] or {}):
            bind.execute(
                projects.update()
                .where(projects.c.id == row["id"])
                .values(budget=budget)
            )

    workspaces = sa.Table("research_workspaces", sa.MetaData(), autoload_with=bind)
    for row in bind.execute(
        sa.select(workspaces.c.id, workspaces.c.workflow_state)
    ).mappings():
        state = dict(row["workflow_state"] or {})
        budget = dict(state.get("budget") or {})
        if "relay_limit" in budget:
            budget.pop("relay_limit")
            state["budget"] = budget
            bind.execute(
                workspaces.update()
                .where(workspaces.c.id == row["id"])
                .values(workflow_state=state)
            )


def downgrade():
    pass
