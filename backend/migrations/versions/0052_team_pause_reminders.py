"""Member leave and private message reminders."""

import sqlalchemy as sa
from alembic import op

revision = "0052"
down_revision = "0051"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    if "paused" not in {c["name"] for c in sa.inspect(bind).get_columns("team_members")}:
        op.add_column(
            "team_members",
            sa.Column("paused", sa.Boolean(), nullable=False, server_default="0"),
        )
    if "team_reminders" in sa.inspect(bind).get_table_names():
        return
    op.create_table(
        "team_reminders",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("research_workspaces.id"),
            nullable=False,
        ),
        sa.Column(
            "channel_id",
            sa.String(36),
            sa.ForeignKey("team_channels.id"),
            nullable=False,
        ),
        sa.Column("message_id", sa.String(80), nullable=False),
        sa.Column("thread_id", sa.String(80), nullable=True),
        sa.Column("excerpt", sa.Text(), nullable=False),
        sa.Column("remind_at", sa.String(40), nullable=False),
        sa.Column("delivered_at", sa.String(40), nullable=False, server_default=""),
        sa.Column("created_at", sa.String(40), nullable=False),
    )
    op.create_index("ix_team_reminders_owner", "team_reminders", ["owner"])
    op.create_index(
        "ix_team_reminders_due",
        "team_reminders",
        ["workspace_id", "delivered_at", "remind_at"],
    )


def downgrade():
    op.drop_table("team_reminders")
    op.drop_column("team_members", "paused")
