"""Channel pins and private saved messages, including virtual research roots."""

import sqlalchemy as sa
from alembic import op

revision = "0051"
down_revision = "0050"
branch_labels = None
depends_on = None


def upgrade():
    if "team_message_marks" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "team_message_marks",
        sa.Column("id", sa.String(36), primary_key=True),
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
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("owner", sa.String(36), nullable=False),
        sa.Column("completed", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.UniqueConstraint("workspace_id", "message_id", "kind", "owner"),
    )
    op.create_index(
        "ix_team_message_marks_workspace_id", "team_message_marks", ["workspace_id"]
    )
    op.create_index(
        "ix_team_message_marks_channel_id", "team_message_marks", ["channel_id"]
    )


def downgrade():
    op.drop_table("team_message_marks")
