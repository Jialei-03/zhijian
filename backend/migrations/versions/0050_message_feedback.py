"""Researcher reactions to team messages."""

import sqlalchemy as sa
from alembic import op

revision = "0050"
down_revision = "0049"
branch_labels = None
depends_on = None


def upgrade():
    if "team_message_reactions" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "team_message_reactions",
        sa.Column("message_id", sa.String(80), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("research_workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "member_id",
            sa.String(36),
            sa.ForeignKey("team_members.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("emoji", sa.String(8), primary_key=True),
        sa.Column(
            "author_id",
            sa.String(36),
            sa.ForeignKey("team_members.id"),
            nullable=True,
        ),
        sa.Column("excerpt", sa.Text(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
    )
    op.create_index(
        "ix_team_message_reactions_workspace_id",
        "team_message_reactions",
        ["workspace_id"],
    )
    op.create_index(
        "ix_team_message_reactions_author_id", "team_message_reactions", ["author_id"]
    )
    op.create_index(
        "ix_team_message_reactions_created_at", "team_message_reactions", ["created_at"]
    )


def downgrade():
    op.drop_table("team_message_reactions")
