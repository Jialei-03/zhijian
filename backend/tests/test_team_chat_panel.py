"""Panel data only: in-memory SQLite, with no runtime or provider calls."""

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend import research_team as team
from backend.models import AgentRun, Base, ResearchWorkspace, TeamChannel, TeamMessage


def test_team_chat_panel_includes_thread_outputs_and_original_model():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as d:
        workspace = ResearchWorkspace(id="workspace", owner="owner", name="Team")
        channel = TeamChannel(
            id="channel", workspace_id=workspace.id, key="general", name="Chat"
        )
        other = TeamChannel(
            id="other", workspace_id=workspace.id, key="other", name="Other"
        )
        run = AgentRun(
            id="run",
            owner="owner",
            session_id="session",
            model_config_id="original",
            model="offline-model",
            status="completed",
            response="Answer",
            prompt="Request",
        )
        root = TeamMessage(
            id="request",
            workspace_id=workspace.id,
            channel_id=channel.id,
            text="Request",
        )
        data = {
            "run_id": run.id,
            "to": ["writer"],
            "files": [{"path": "draft.md", "name": "draft.md"}],
            "paper": {"title": "Paper", "url": "https://example.test/paper"},
        }
        reply = TeamMessage(
            id="reply",
            workspace_id=workspace.id,
            channel_id=channel.id,
            thread_id=root.id,
            text="Answer",
            data=data,
        )
        unrelated = TeamMessage(
            id="unrelated",
            workspace_id=workspace.id,
            channel_id=other.id,
            text="Other",
        )
        d.add_all([workspace, channel, other, run, root, reply, unrelated])
        d.commit()

        result = team.history(d, workspace, channel)
        assert [m["id"] for m in result["messages"]] == [root.id]
        assert {m["id"] for m in result["activity"]} == {root.id, reply.id}
        output = next(m for m in result["activity"] if m["id"] == reply.id)
        assert output["thread_id"] == root.id
        assert output["data"] == data
        assert output["run"]["model_config_id"] == "original"
        assert output["run"]["model"] == "offline-model"
        assert "prompt" not in output["run"]

        thread = team.history(d, workspace, channel, root.id)
        assert [m["id"] for m in thread["messages"]] == [reply.id]
        assert thread["activity"] == []
    engine.dispose()
