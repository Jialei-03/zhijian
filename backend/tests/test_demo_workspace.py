"""The README fixture is a local workspace, built without external effects."""

import io
import json
import socket
import subprocess
import sys
from pathlib import Path

import pytest
from pypdf import PdfReader
from sqlalchemy import func, select

from backend import agent_files, research_map, research_repo, research_team
from backend.config import Settings, database
from backend.models import (
    AgentRun,
    AgentSession,
    File,
    Paper,
    PaperPreparation,
    PreparationSetting,
    ReadingArtifact,
    ResearchEvent,
    ResearchJob,
    ResearchNode,
    ResearchNote,
    ResearchProject,
    ResearchSprint,
    ResearchWorkspace,
    TeamChannel,
    TeamDelivery,
    TeamMember,
    TeamMessage,
    User,
    Version,
)
from backend.paper_metadata import PaperMetadata
from scripts.demo_workspace import seed


@pytest.mark.parametrize("lang", ["zh", "en"])
def test_demo_workspace_is_complete_and_offline(tmp_path, monkeypatch, lang):
    def forbidden(*args, **kwargs):
        pytest.fail("Demo generation must not invoke Git, a process or the network")

    monkeypatch.setattr(research_repo, "git", forbidden)
    real_popen = subprocess.Popen

    def offline_process(command, *args, **kwargs):
        # store_file uses the normal isolated PDF inspector. No other process
        # (model runtime, shell, Git or SSH) is allowed in this fixture.
        assert command == [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "media.py"),
            "pdf",
        ]
        return real_popen(command, *args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", offline_process)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    # Ambient configuration must never redirect the fixture toward real credentials.
    monkeypatch.setenv("PLATFORM_MODEL_CONFIG", str(tmp_path / "do-not-read"))
    monkeypatch.setenv("TRANSLATION_CONFIG_DIR", str(tmp_path / "do-not-create"))
    data = tmp_path / lang
    manifest = seed(data, lang)
    assert json.loads((data / "demo.json").read_text()) == manifest
    assert not (tmp_path / "do-not-create").exists()
    assert not list(data.rglob(".git"))
    engine, maker = database(
        Settings(
            database_url="sqlite:///" + str(data / "workspace.db"),
            storage=str(data / "files"),
            mode="local",
        )
    )
    try:
        with maker() as d:
            counts = {
                User: 1,
                ResearchWorkspace: 1,
                TeamMember: 5,
                TeamChannel: 2,
                TeamMessage: 5,
                TeamDelivery: 0,
                ResearchProject: 1,
                ResearchEvent: 19,
                ResearchNode: 6,
                ResearchNote: 1,
                ResearchSprint: 2,
                ResearchJob: 2,
                AgentSession: 5,
                AgentRun: 2,
                Paper: 6,
                Version: 6,
                File: 6,
                PaperMetadata: 6,
                PaperPreparation: 6,
                PreparationSetting: 1,
                ReadingArtifact: 1,
            }
            for model, count in counts.items():
                assert d.scalar(select(func.count()).select_from(model)) == count, model
            workspace = d.get(ResearchWorkspace, manifest["workspace_id"])
            assert workspace.name == (
                "长上下文检索头" if lang == "zh" else "Retrieval heads in long context"
            )
            project = d.get(ResearchProject, manifest["research_id"])
            assert research_map.language(d, project) == lang
            assert project.status == "finished" and project.stage == "done"
            assert project.plan["approved_at"] and project.conclusion["accepted"]
            assert all(value is None for value in project.budget.values())
            assert {
                node.status
                for node in d.scalars(
                    select(ResearchNode).where(ResearchNode.kind == "hypothesis")
                )
            } == {"supported", "refuted", "active"}
            for job in d.scalars(select(ResearchJob)):
                assert job.status == "succeeded" and job.exit_code == 0
                assert job.timeout_seconds == 0
            assert all(run.status == "completed" for run in d.scalars(select(AgentRun)))
            assert set(d.scalars(select(ResearchEvent.action))) >= {
                "create_project",
                "plan_proposed",
                "message",
                "concluded",
            }
            folder = research_repo.repo_dir(d.info["settings"], workspace.id)
            assert folder == Path(manifest["folder"])
            assert {path.name for path in folder.iterdir()} >= {
                "plan.md",
                "results.csv",
                "recall.svg",
                "conclusion.md",
                "evaluate.py",
            }
            for member in d.scalars(select(TeamMember)):
                if member.role == "human":
                    continue
                definition = agent_files.parse((folder / member.file_path).read_text())
                assert definition["avatar"].startswith("pixel:")
                assert definition["wake_turns"] == definition["wake_tokens"] == 0
                assert definition["max_tokens"] == 0
            changes = d.get(TeamMessage, manifest["changes_message_id"])
            assert len(changes.data["changes"]["files"]) == 2
            for file in d.scalars(select(File)):
                raw = (data / "files" / file.id).read_bytes()
                pdf = PdfReader(io.BytesIO(raw))
                assert len(pdf.pages) == file.pages == 2
                assert "Abstract" in pdf.pages[0].extract_text()
            assert {row.data["venue"] for row in d.scalars(select(PaperMetadata))} == {
                "NeurIPS",
                "ICLR",
                "arXiv",
            }
            # Read the UI projections without the app's normal Git initialization.
            monkeypatch.setattr(research_repo, "ensure_repo", lambda *a, **kw: folder)
            team = research_team.overview(d, workspace)
            assert len(team["members"]) == 5 and len(team["channels"]) == 2
            history = research_team.history(
                d,
                workspace,
                d.get(TeamChannel, manifest["channel_id"]),
                "research:" + project.id,
            )
            assert len(history["research"]["sprints"]) == 2
            assert len(history["research"]["jobs"]) == 2
    finally:
        engine.dispose()


def test_demo_workspace_refuses_nonempty_directory(tmp_path):
    existing = tmp_path / "keep.txt"
    existing.write_text("keep")
    with pytest.raises(ValueError, match="must be empty"):
        seed(tmp_path, "zh")
    assert existing.read_text() == "keep"
    assert sorted(path.name for path in tmp_path.iterdir()) == ["keep.txt"]
