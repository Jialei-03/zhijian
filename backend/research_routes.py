# ruff: noqa: B008
"""The research projects API: create, read, and pause, resume or stop a project."""

from pathlib import Path

from fastapi import Depends, HTTPException, Query, Response, UploadFile
from typing import Literal

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, update

from . import research_datasets, research_files, research_map
from .models import (
    AgentRun,
    AgentSession,
    ResearchCard,
    ResearchWorkspace,
    ResearchEvent,
    ResearchJob,
    ResearchNode,
    ResearchProject,
    ResearchSprint,
    User,
    now,
)
from .translation_settings import read_config, read_store

LOCAL_ONLY = "研究功能只在本机版提供，请在自己的电脑上部署后使用"
UPLOAD_BYTES = 200 * 1024 * 1024


class Budget(BaseModel):
    max_sprints: int | None = Field(default=None, ge=1, le=500)
    max_tokens: int | None = Field(default=None, ge=1000, le=10**9)
    max_job_seconds: int | None = Field(default=None, ge=60, le=10**7)
    # Evaluation runs: nobody is there to decide, and some must not learn or be taught.
    auto_decide: bool | None = None
    playbook: bool | None = None
    distill: bool | None = None
    advisor: bool | None = None


class DecisionInput(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=2000)


class ProjectInput(BaseModel):
    # Either a first message (the plan is then talked through), or a question
    # given outright (evaluation runs, which start experimenting at once).
    message: str = Field(default="", max_length=8000)
    question: str = Field(default="", max_length=2000)
    background: str = Field(default="", max_length=20000)
    model_config_id: str = Field(min_length=1, max_length=64)
    budget: Budget | None = None
    datasets: list[str] = Field(default_factory=list, max_length=5)
    compute_id: str = Field(default="", max_length=64)
    workspace_id: str = Field(default="", max_length=64)
    collection_id: str | None = Field(default=None, max_length=36)
    defer_start: bool = False
    workflow_id: str | None = Field(default=None, max_length=64)

    @field_validator("message", "question")
    @classmethod
    def trimmed(cls, value):
        return value.strip()


class WorkspaceInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    location: dict = Field(default_factory=lambda: {"kind": "managed"})
    create_folder: bool = False


class WorkspacePatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    instructions: str | None = Field(default=None, max_length=20000)
    compute_id: str | None = Field(default=None, max_length=64)
    model_config_id: str | None = Field(default=None, max_length=64)
    archived: bool | None = None


class CardInput(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    body: str = Field(default="", max_length=8000)


class CardPatch(BaseModel):
    title: str | None = Field(default=None, max_length=300)
    body: str | None = Field(default=None, max_length=8000)
    status: str | None = Field(default=None, max_length=16)


class StartInput(BaseModel):
    model_config_id: str = Field(default="", max_length=64)


class MessageInput(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


class ModelInput(BaseModel):
    model_config_id: str = Field(min_length=1, max_length=64)


class ChatInput(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    model_config_id: str = Field(default="", max_length=64)
    # "/compact": summarize the conversation so far (Pi's compaction).
    command: Literal["compact"] | None = None


class SessionCreate(BaseModel):
    title: str = Field(default="新对话", min_length=1, max_length=100)


class LimitsInput(BaseModel):
    note: str = Field(default="", max_length=2000)


class QuestionInput(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    note: str = Field(default="", max_length=2000)

    @field_validator("question")
    @classmethod
    def not_blank(cls, value):
        if not value.strip():
            raise ValueError("研究问题不能为空")
        return value.strip()


class ComputeInput(BaseModel):
    compute_id: str = Field(min_length=1, max_length=64)


class PlanApproval(BaseModel):
    version: int = Field(ge=1)
    note: str = Field(default="", max_length=2000)


def project_out(p, *, location=None):
    from .research_workflows import view

    return {
        "workflow": view(p),
        "id": p.id,
        "question": p.question,
        "title": p.title or p.question,
        "collection_id": p.collection_id,
        "on_board": p.on_board,
        "background": p.background,
        "model_config_id": p.model_config_id,
        "status": p.status,
        "end_reason": p.end_reason,
        "budget": p.budget,
        "spent": p.spent,
        "session_id": p.session_id,
        "workspace_id": p.workspace_id,
        "location": location or {},
        "stage": p.stage,
        "compute_id": p.compute_id,
        "plan": p.plan or {},
        "conclusion_record": p.conclusion or {},
        "environment": p.environment or {},
        "parent_id": p.parent_id,
        "forked_from": p.forked_from or {},
        "merged": p.merged or {},
        "created_at": p.created_at,
        "updated_at": p.updated_at,
    }


def node_out(n):
    return {
        k: getattr(n, k)
        for k in (
            "id",
            "parent_id",
            "kind",
            "title",
            "status",
            "confidence",
            "kill_if",
            "budget_tokens",
            "value",
            "cost",
            "evidence_for",
            "evidence_against",
            "doubts",
            "spent_tokens",
            "spent_job_seconds",
            "created_at",
            "updated_at",
        )
    }


def sprint_out(s):
    return {
        k: getattr(s, k)
        for k in (
            "id",
            "number",
            "role",
            "run_id",
            "status",
            "focus_node_id",
            "summary",
            "next_focus",
            "waiting_on",
            "tokens",
            "created_at",
            "updated_at",
        )
    }


def job_out(j, d=None):
    from .research_sandbox import queue_position

    extra = (
        {"queue_position": queue_position(d, j)}
        if j.status == "queued" and d is not None
        else {}
    )
    return extra | {
        k: getattr(j, k)
        for k in (
            "id",
            "node_id",
            "sprint_id",
            "command",
            "status",
            "exit_code",
            "timeout_seconds",
            "started_at",
            "finished_at",
            "log_lines",
            "compute_id",
            "config",
            "metrics",
            "points",
            "tracker_url",
        )
    }


def event_out(e):
    return {
        k: getattr(e, k)
        for k in (
            "id",
            "node_id",
            "sprint_id",
            "actor",
            "action",
            "detail",
            "created_at",
        )
    }


def docker_state():
    """Whether experiments can run here; replaced by the sandbox's own check."""
    try:
        from .research_sandbox import docker_status
    except ImportError:
        return {"available": False, "reason": "未检测"}
    return docker_status()


def input_needed(d, p):
    """What the advisor said the project waits for, while it waits for it."""
    if p.status != "waiting":
        return ""
    last = d.scalars(
        select(ResearchEvent)
        .where(ResearchEvent.project_id == p.id, ResearchEvent.action == "input_needed")
        .order_by(ResearchEvent.created_at.desc())
    ).first()
    return last.detail.get("summary", "") if last else ""


def conclusion(d, p):
    """How a finished project was answered, in the advisor's words; "" if it was not."""
    if p.status != "finished":
        return ""
    last = d.scalars(
        select(ResearchEvent)
        .where(
            ResearchEvent.project_id == p.id,
            ResearchEvent.action.in_(("concluded", "input_needed")),
        )
        .order_by(ResearchEvent.created_at.desc())
    ).first()
    return last.detail.get("summary", "") if last else ""


def install_research_routes(app, settings, db, auth, human, owned):
    def allowed(a, d):
        """Research runs experiments on the researcher's own machines: the
        local edition only, for every account of the hosted site alike."""
        human(a)
        if settings.mode != "local":
            raise HTTPException(403, LOCAL_ONLY)

    def project_of(d, id, a, writable=False):
        allowed(a, d)
        project = owned(d, ResearchProject, id, a)
        if writable and project.workspace_id:
            from . import research_chat, research_workspaces
            from .models import AgentSession

            session = owned(d, AgentSession, project.session_id, a)
            workspace = owned(d, ResearchWorkspace, project.workspace_id, a)
            research_chat.lock_session(d, session)
            research_workspaces.lock_workspace(d, workspace)
            d.refresh(project)
            if workspace.archived or session.archived_at:
                raise HTTPException(409, "请先恢复项目或研究会话")
        return project

    research_files.install_research_files(app, settings, db, auth, project_of)
    from .research_branches import install_branch_routes
    from .research_merge import install_merge_routes
    from .research_changes import install_change_routes

    install_branch_routes(app, settings, db, auth, project_of, project_out)
    install_merge_routes(app, settings, db, auth, human, owned)
    install_change_routes(app, settings, db, auth, project_of)
    from .research_hub import install_hub_routes
    from .research_locations import install_location_routes

    install_hub_routes(app, settings, db, auth, human, owned, project_of, project_out)
    install_location_routes(app, settings, db, auth, human, owned)

    def workspace_for(d, a, workspace_id, budget=None):
        from . import research_workspaces

        if workspace_id:
            w = d.get(ResearchWorkspace, workspace_id)
            if w is None or w.owner != a["id"]:
                raise HTTPException(404, "Not found")
        else:
            if budget is not None and budget.auto_decide:
                research_workspaces.ensure(d, a["id"])
            w = research_workspaces.default_for(d, a["id"])
        research_workspaces.lock_workspace(d, w)
        if w.archived:
            raise HTTPException(409, "请先恢复这个项目")
        return w

    def workspace_of(d, id, a):
        allowed(a, d)
        w = d.get(ResearchWorkspace, id)
        if w is None or w.owner != a["id"]:
            raise HTTPException(404, "Not found")
        return w

    from .research_schedules import install_schedule_routes

    install_schedule_routes(
        app, settings, db, auth, allowed, owned, workspace_of, project_of
    )
    from .research_workflows import install_workflow_routes

    install_workflow_routes(app, settings, db, auth, allowed, owned)

    from .research_team_routes import install_team_routes

    install_team_routes(app, settings, db, auth, workspace_of)

    @app.get("/api/v1/research/workspaces")
    def workspaces(a=Depends(auth), d=Depends(db)):
        from . import research_workspaces

        allowed(a, d)
        out = research_workspaces.overview(d, a["id"])
        d.commit()
        return out

    @app.get("/api/v1/research/recent")
    def recent_researches(limit: int = 6, a=Depends(auth), d=Depends(db)):
        """The researches touched last, with how far each has come (home)."""
        from . import research_workspaces

        allowed(a, d)
        out = research_workspaces.recent(d, a["id"], max(1, min(limit, 20)))
        d.commit()
        return out

    @app.post("/api/v1/research/workspaces")
    def new_workspace(body: WorkspaceInput, a=Depends(auth), d=Depends(db)):
        from . import research_workspaces

        allowed(a, d)
        try:
            from .research_locations import validate_location

            if not body.name.strip():
                raise ValueError("项目名称不能为空")
            location = validate_location(
                settings,
                body.location,
                create_folder=body.name.strip() if body.create_folder else "",
            )
            if location["kind"] in {"local", "ssh"}:
                # A physical folder has one admission lock. Serialize creation
                # before checking identity, including concurrent first requests.
                d.execute(
                    update(User)
                    .where(User.id == a["id"])
                    .values(username=User.username)
                )
                for existing in d.scalars(
                    select(ResearchWorkspace).where(ResearchWorkspace.owner == a["id"])
                ):
                    saved = existing.location or {}
                    if (
                        saved.get("kind"),
                        saved.get("path"),
                        saved.get("connection_id") or "",
                    ) == (
                        location["kind"],
                        location["path"],
                        location.get("connection_id") or "",
                    ):
                        raise HTTPException(
                            409, "这个目录已有工作区，请打开或恢复已有工作区"
                        )
            w = research_workspaces.create(
                d, a["id"], body.name, body.description, location=location
            )
            from .research_team import ensure as ensure_team

            ensure_team(d, w)
        except (ValueError, OSError) as e:
            raise HTTPException(422, str(e)) from None
        d.commit()
        from .research_locations import location_for

        return research_workspaces.workspace_out(w) | {
            "location": location_for(settings, w)
        }

    @app.get("/api/v1/research/workspaces/{id}")
    def workspace(id: str, a=Depends(auth), d=Depends(db)):
        from . import research_workspaces
        from .research_locations import location_for

        w = workspace_of(d, id, a)
        return research_workspaces.workspace_out(w) | {
            "location": location_for(settings, w),
            "researches": [
                research_workspaces.summary(d, p)
                for p in research_workspaces.researches(d, w)
            ],
        }

    @app.get("/api/v1/research/workspaces/{id}/notes")
    def workspace_notes(id: str, a=Depends(auth), d=Depends(db)):
        from . import research_notes

        w = workspace_of(d, id, a)
        return research_notes.present(d, w)

    @app.patch("/api/v1/research/workspaces/{id}")
    def edit_workspace(id: str, body: WorkspacePatch, a=Depends(auth), d=Depends(db)):
        from . import research_workspaces

        w = workspace_of(d, id, a)
        try:
            research_workspaces.update(d, w, body.model_dump())
        except ValueError as e:
            raise HTTPException(409 if body.archived is True else 422, str(e)) from None
        d.commit()
        return research_workspaces.workspace_out(w)

    def chat_out(d, session):
        from .research_chat import session_out

        return session_out(d, session)

    @app.get("/api/v1/research/sessions")
    def find_sessions(
        search: str = Query("", max_length=200),
        cursor: str = Query("", max_length=1000),
        limit: int = Query(8, ge=1, le=50),
        a=Depends(auth),
        d=Depends(db),
    ):
        from . import research_chat

        allowed(a, d)
        try:
            return research_chat.search_sessions(d, a["id"], search, cursor, limit)
        except ValueError as e:
            raise HTTPException(422, str(e)) from None

    @app.get("/api/v1/research/workspaces/{id}/sessions")
    def workspace_sessions(
        id: str,
        search: str = Query("", max_length=200),
        cursor: str = Query("", max_length=1000),
        limit: int = Query(40, ge=1, le=100),
        archived: bool = False,
        a=Depends(auth),
        d=Depends(db),
    ):
        from . import research_chat

        w = workspace_of(d, id, a)
        try:
            result = research_chat.session_page(d, w, search, cursor, limit, archived)
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        d.commit()
        return result

    @app.post("/api/v1/research/workspaces/{id}/sessions")
    def new_session(id: str, body: SessionCreate, a=Depends(auth), d=Depends(db)):
        workspace_of(d, id, a)
        raise HTTPException(410, "请从工作区新建研究")

    def chat_of(d, id, a):
        from .models import AgentSession

        allowed(a, d)
        session = d.get(AgentSession, id)
        if session is None or session.owner != a["id"] or not session.workspace_id:
            raise HTTPException(404, "Not found")
        return session

    @app.get("/api/v1/research/workspaces/{id}/chats")
    def workspace_chats(id: str, a=Depends(auth), d=Depends(db)):
        """The project's conversations, the last spoken in first."""
        from . import research_chat

        return [chat_out(d, s) for s in research_chat.chats(d, workspace_of(d, id, a))]

    @app.post("/api/v1/research/workspaces/{id}/chats")
    def new_chat(id: str, body: ChatInput, a=Depends(auth), d=Depends(db)):
        workspace_of(d, id, a)
        raise HTTPException(410, "请从工作区新建研究")

    @app.post("/api/v1/research/chats/{id}/messages")
    def chat_message(id: str, body: ChatInput, a=Depends(auth), d=Depends(db)):
        from . import research_chat

        session = chat_of(d, id, a)
        w = research_chat.workspace_of(d, session)
        if w is None or w.owner != a["id"]:
            raise HTTPException(404, "Not found")
        try:
            research_chat.ask(
                settings,
                d,
                a["id"],
                session,
                w,
                body.message,
                body.model_config_id,
                body.command,
            )
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        d.commit()
        return chat_out(d, session)

    @app.post("/api/v1/research/chats/{id}/clone")
    def clone_chat(id: str, a=Depends(auth), d=Depends(db)):
        """ "/clone": the conversation copied, to go on with apart from the original."""
        from . import research_chat

        session = chat_of(d, id, a)
        if d.scalar(
            select(AgentRun.id).where(
                AgentRun.session_id == session.id,
                AgentRun.status.in_(["queued", "running"]),
            )
        ):
            raise HTTPException(409, "等这一轮回答完再复制")
        try:
            copy = research_chat.clone(d, session)
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        d.commit()
        return chat_out(d, copy)

    @app.get("/api/v1/research/workspaces/{id}/board")
    def workspace_board(id: str, a=Depends(auth), d=Depends(db)):
        from . import research_workspaces

        return research_workspaces.board(d, workspace_of(d, id, a))

    @app.post("/api/v1/research/workspaces/{id}/cards")
    def new_card(id: str, body: CardInput, a=Depends(auth), d=Depends(db)):
        from . import research_workspaces

        w = workspace_of(d, id, a)
        try:
            card = research_workspaces.add_card(d, w, body.title, body.body)
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        d.commit()
        return {"id": card.id, "title": card.title, "status": card.status}

    def card_of(d, id, a):
        card = d.get(ResearchCard, id)
        if card is None:
            raise HTTPException(404, "Not found")
        workspace_of(d, card.workspace_id, a)
        return card

    @app.patch("/api/v1/research/cards/{id}")
    def edit_card(id: str, body: CardPatch, a=Depends(auth), d=Depends(db)):
        from . import research_workspaces

        card = card_of(d, id, a)
        try:
            if body.status:
                research_workspaces.move_card(d, card, body.status)
            if body.title is not None and body.title.strip():
                card.title = body.title.strip()
            if body.body is not None:
                card.body = body.body
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        card.updated_at = now()
        d.commit()
        return {"id": card.id, "title": card.title, "status": card.status}

    @app.post("/api/v1/research/cards/{id}/start")
    def start_card(id: str, body: StartInput, a=Depends(auth), d=Depends(db)):
        """An idea becomes a research: its words open the talk with the advisor."""
        card = card_of(d, id, a)
        if card.project_id:
            raise HTTPException(409, "这张卡已经开始研究")
        w = d.get(ResearchWorkspace, card.workspace_id)
        message = card.title + (f"\n\n{card.body}" if card.body.strip() else "")
        made = create(
            ProjectInput(
                message=message,
                model_config_id=body.model_config_id
                or w.model_config_id
                or read_store(settings, a["id"]).get("active_id", "")
                or "none",
                compute_id=w.compute_id,
                workspace_id=w.id,
            ),
            a,
            d,
        )
        card = d.get(ResearchCard, id)
        card.project_id = made["id"]
        card.updated_at = now()
        d.commit()
        return made

    def create_research(body, a, d, *, persist=True):
        from . import research_datasets, research_settings, research_stages
        from .research_hub import collection_of
        from .research_locations import bind, compute_for

        allowed(a, d)
        if not body.message and not body.question:
            raise HTTPException(422, "说说你想研究什么")
        cfg = read_config(settings, a["id"], body.model_config_id)
        if not cfg.get("api_key") or not cfg.get("model"):
            raise HTTPException(409, "请先添加并选择可用模型")
        budget = (
            {k: v for k, v in body.budget.model_dump().items() if v is not None}
            if body.budget
            else None
        )
        try:
            home = workspace_for(d, a, body.workspace_id, body.budget)
            collection = collection_of(d, a["id"], body.collection_id, writable=True)
            compute_id = compute_for(settings, home)
            if body.compute_id and body.compute_id != compute_id:
                raise ValueError("执行位置由工作区目录决定，请选择对应的工作区")
            research_settings.compute(settings, compute_id)
            p = research_map.create_project(
                d,
                a["id"],
                body.question or body.message[:2000],
                body.background,
                body.model_config_id,
                budget,
                first_message=body.message or body.question,
            )
            p.compute_id = compute_id
            p.workspace_id = home.id
            p.collection_id = collection.id if collection else None
            d.get(AgentSession, p.session_id).workspace_id = home.id
            if persist:
                bind(settings, home, p)
            research_datasets.request(d, p, body.datasets)
            if not (budget or {}).get("auto_decide"):
                # The plan is talked through first; nothing runs until it is approved.
                p.stage = "scoping"
                if body.defer_start:
                    p.status = "paused"
                research_stages.say(d, p, "human", body.message or body.question)
            from .research_workflows import snapshot

            snapshot(d, p, body.workflow_id)
            if body.defer_start:
                p.status = "paused"
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        if not persist:
            return p
        d.commit()
        from . import research_repo

        if research_repo.available():
            try:
                # Its worktree in the project's repository, before anything is written.
                research_repo.adopt(settings, home, p)
            except (research_repo.GitError, OSError) as e:
                # The worker's housekeeping tries again; the research starts anyway.
                print(f"research_repo: {e}"[:300], flush=True)
        from .research_locations import location_for

        return project_out(p, location=location_for(settings, home))

    @app.post("/api/v1/research/projects")
    def create(body: ProjectInput, a=Depends(auth), d=Depends(db)):
        return create_research(body, a, d)

    from .team_compare import install_compare_routes

    install_compare_routes(
        app, db, auth, allowed, owned, project_of, workspace_of, create_research
    )

    @app.post("/api/v1/research/projects/{id}/messages")
    def message(id: str, body: MessageInput, a=Depends(auth), d=Depends(db)):
        from .research_dialogue import post

        p = project_of(d, id, a, writable=True)
        try:
            post(settings, d, p, body.text)
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        d.commit()
        return project_out(p)

    @app.post("/api/v1/research/projects/{id}/limits")
    def lift_limits(id: str, body: LimitsInput, a=Depends(auth), d=Depends(db)):
        """No limits on rounds, tokens or experiment time; a project the budget
        ended goes back to its experiments (a retrospective under way stops)."""
        from . import research_stages

        p = project_of(d, id, a, writable=True)
        if p.status == "finished" and p.end_reason not in {"budget"}:
            raise HTTPException(409, "研究已结束")
        if p.end_reason == "budget":
            distilling = [
                s.run_id
                for s in d.scalars(
                    select(ResearchSprint).where(
                        ResearchSprint.project_id == p.id,
                        ResearchSprint.role == "distiller",
                        ResearchSprint.status == "running",
                    )
                )
            ]
            if distilling:
                d.execute(
                    update(AgentRun)
                    .where(
                        AgentRun.id.in_(distilling),
                        AgentRun.status.in_(["queued", "running"]),
                    )
                    .values(status="cancelled", updated_at=now())
                )
                d.execute(
                    update(ResearchSprint)
                    .where(ResearchSprint.run_id.in_(distilling))
                    .values(
                        status="abnormal",
                        summary="研究者取消了上限，复盘停止",
                        updated_at=now(),
                    )
                )
        research_stages.lift_limits(d, p, body.note)
        d.commit()
        return project_out(p)

    @app.post("/api/v1/research/projects/{id}/question")
    def restate(id: str, body: QuestionInput, a=Depends(auth), d=Depends(db)):
        """The researcher, as the one in charge, restates what is being asked."""
        p = project_of(d, id, a, writable=True)
        if p.status == "finished":
            raise HTTPException(409, "研究已结束")
        before = p.question
        if body.question != before:
            p.question = body.question
            research_map.root(d, p).title = body.question[:300]
            research_map.event(
                d,
                p,
                None,
                "human",
                "question_changed",
                {"from": before, "to": body.question, "note": body.note},
            )
            p.updated_at = now()
        d.commit()
        return project_out(p)

    @app.post("/api/v1/research/projects/{id}/compute")
    def move_compute(id: str, body: ComputeInput, a=Depends(auth), d=Depends(db)):
        """Where the next experiments run; a job already running stays where it is."""
        from . import research_settings, research_stages

        p = project_of(d, id, a, writable=True)
        try:
            bound = research_stages.bound_compute(settings, d, p)
            if bound and body.compute_id != bound:
                raise HTTPException(
                    409, "执行位置由工作区目录决定，不能在研究中切换到其他机器"
                )
            research_settings.compute(settings, body.compute_id)
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        if body.compute_id != p.compute_id:
            old = (
                research_settings.compute(settings, p.compute_id)
                if not bound
                else {"kind": "host"}
            )
            if old["kind"] == "ssh":
                from . import research_remote

                ran_there = d.scalars(
                    select(ResearchJob.id).where(
                        ResearchJob.project_id == p.id,
                        ResearchJob.compute_id == old["id"],
                    )
                ).first()
                try:
                    research_remote.pull(settings, old, p.id)
                except ValueError as e:
                    # Nothing ran there yet: there is nothing to bring back.
                    if p.stage != "scoping" and ran_there is not None:
                        raise HTTPException(
                            409, "没能把远程工作区拿回来：" + str(e)
                        ) from None
            research_map.event(
                d,
                p,
                None,
                "human",
                "compute_changed",
                {"from": p.compute_id, "to": body.compute_id},
            )
            p.compute_id = body.compute_id
            if p.plan and not p.plan.get("approved_at"):
                # The person's latest choice is what approving the plan starts on.
                p.plan = {**p.plan, "compute_id": body.compute_id}
            p.updated_at = now()
        d.commit()
        return project_out(p)

    @app.post("/api/v1/research/projects/{id}/model")
    def move_model(id: str, body: ModelInput, a=Depends(auth), d=Depends(db)):
        """The model the next rounds run on (advisor and executor alike); a round
        already running finishes on the one it started with."""
        p = project_of(d, id, a, writable=True)
        chosen = read_config(settings, a["id"], body.model_config_id)
        if not chosen.get("model"):
            raise HTTPException(422, "这个模型不可用，先在设置里检查它")
        if body.model_config_id != p.model_config_id:
            research_map.event(
                d,
                p,
                None,
                "human",
                "model_changed",
                {
                    "from": p.model_config_id,
                    "to": body.model_config_id,
                    # Said in the research thread as it was then.
                    "name": chosen.get("name") or chosen["model"],
                },
            )
            p.model_config_id = body.model_config_id
            p.updated_at = now()
        d.commit()
        return project_out(p)

    @app.post("/api/v1/research/projects/{id}/plan/approve")
    def approve_plan(id: str, body: PlanApproval, a=Depends(auth), d=Depends(db)):
        from . import research_stages

        p = project_of(d, id, a, writable=True)
        try:
            research_stages.approve_plan(settings, d, p, body.version, body.note)
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
        d.commit()
        return project_out(p)

    @app.get("/api/v1/research/projects/{id}/jobs/{job_id}/series")
    def job_series(id: str, job_id: str, a=Depends(auth), d=Depends(db)):
        from .research_sandbox import series

        p = project_of(d, id, a)
        job = d.get(ResearchJob, job_id)
        if not job or job.project_id != p.id:
            raise HTTPException(404, "Not found")
        return series(settings, job)

    @app.get("/api/v1/research/settings")
    def research_settings_get(a=Depends(auth), d=Depends(db)):
        from . import research_datasets, research_settings

        allowed(a, d)
        return research_settings.public(research_settings.load(settings)) | {
            "datasets": research_datasets.catalog()
        }

    @app.put("/api/v1/research/settings")
    def research_settings_put(body: dict, a=Depends(auth), d=Depends(db)):
        from . import research_settings

        allowed(a, d)
        try:
            return research_settings.public(research_settings.update(settings, body))
        except (ValueError, TypeError) as e:
            raise HTTPException(422, str(e)) from None

    def run_out(run, sprint=None, step_chars=4000):
        runtime = run.runtime or {}
        steps = []
        for step in run.steps or []:
            step = dict(step)
            result = step.get("result")
            if isinstance(result, dict) and isinstance(result.get("summary"), str):
                step["result"] = {**result, "summary": result["summary"][:step_chars]}
            steps.append(step)
        out = {
            "id": run.id,
            "status": run.status,
            "response": run.response or "",
            "error": run.error or "",
            "steps": steps,
            "role": (runtime.get("research") or {}).get("role", ""),
            "runtime": {
                k: runtime.get(k)
                for k in ("phase", "execution_seconds", "waiting_seconds", "rule")
                if k in runtime
            },
            "created_at": run.created_at,
            "updated_at": run.updated_at,
        }
        if sprint is not None:
            out |= {
                "sprint_id": sprint.id,
                "sprint_number": sprint.number,
                "role": sprint.role,
            }
        return out

    @app.get("/api/v1/research/projects/{id}/runs")
    def project_runs(id: str, a=Depends(auth), d=Depends(db)):
        """What each recent round did, step by step: the thread shows it inline."""
        p = project_of(d, id, a)
        sprints = list(
            d.scalars(
                select(ResearchSprint)
                .where(ResearchSprint.project_id == p.id)
                .order_by(ResearchSprint.number.desc())
                .limit(40)
            )
        )
        out = []
        for sprint in reversed(sprints):
            run = d.get(AgentRun, sprint.run_id) if sprint.run_id else None
            if run is not None:
                out.append(run_out(run, sprint))
        return out

    @app.get("/api/v1/research/runs/{run_id}")
    def research_run(run_id: str, a=Depends(auth), d=Depends(db)):
        """One agent run of research (a sprint, a scoping turn, a preparation), as it goes."""
        allowed(a, d)
        run = d.get(AgentRun, run_id)
        if run is None or run.owner != a["id"] or run.lane != "research":
            raise HTTPException(404, "Not found")
        return run_out(run)

    @app.post("/api/v1/research/environments/{env_id}/check")
    def check_environment(env_id: str, a=Depends(auth), d=Depends(db)):
        """Can the environment be reached, and what does it offer? Kept in its state."""
        from . import research_environment

        allowed(a, d)
        try:
            return research_environment.check(settings, env_id)
        except ValueError as e:
            raise HTTPException(404, str(e)) from None

    @app.get("/api/v1/research/ssh-hosts")
    def ssh_hosts(a=Depends(auth), d=Depends(db)):
        """The SSH connections of this machine (~/.ssh/config), for the settings list."""
        from . import research_environment

        allowed(a, d)
        return research_environment.ssh_hosts()

    @app.post("/api/v1/research/computes/{compute_id}/test")
    def test_compute(compute_id: str, a=Depends(auth), d=Depends(db)):
        """Reaches the compute and reports what it offers (Python, packages, GPUs)."""
        import subprocess

        from . import research_sandbox, research_settings

        allowed(a, d)
        try:
            item = research_settings.compute(settings, compute_id)
            if item["kind"] in ("ssh", "host"):
                from . import research_environment

                st = research_environment.check(settings, compute_id)
                if st["status"] != "connected":
                    raise ValueError(st["error"])
                return st["probe"]
            status = research_sandbox.docker_status()
            if not status["available"]:
                raise ValueError(status["reason"])
            done = research_sandbox.run(
                [
                    "docker",
                    "run",
                    "--rm",
                    *research_sandbox.limits(item),
                    "--mount",
                    f"type=bind,source={research_sandbox.ORA_DIR},target=/opt/ora,readonly",
                    research_sandbox.IMAGE,
                    "python3",
                    "/opt/ora/probe.py",
                ],
                capture_output=True,
                text=True,
                timeout=90,
            )
            import json as _json

            return _json.loads((done.stdout or "{}").strip().splitlines()[-1])
        except (ValueError, OSError, IndexError, subprocess.TimeoutExpired) as e:
            raise HTTPException(409, str(e) or "检测失败") from None

    @app.get("/api/v1/research/projects")
    def projects(a=Depends(auth), d=Depends(db)):
        allowed(a, d)
        return [
            project_out(p) | {"conclusion": conclusion(d, p)[:300]}
            for p in d.scalars(
                select(ResearchProject)
                .where(ResearchProject.owner == a["id"])
                .order_by(ResearchProject.updated_at.desc())
            )
        ]

    @app.get("/api/v1/research/projects/{id}")
    def project(id: str, a=Depends(auth), d=Depends(db)):
        from .research_locations import research_location

        p = project_of(d, id, a)
        workspace = d.get(ResearchWorkspace, p.workspace_id) if p.workspace_id else None
        sprints = d.scalars(
            select(ResearchSprint)
            .where(ResearchSprint.project_id == p.id)
            .order_by(ResearchSprint.number.desc())
            .limit(50)
        )
        jobs = d.scalars(
            select(ResearchJob)
            .where(ResearchJob.project_id == p.id)
            .order_by(ResearchJob.started_at.desc())
            .limit(50)
        )
        return {
            "project": project_out(
                p,
                location=(
                    research_location(settings, workspace, p) if workspace else None
                ),
            ),
            "inherited_history": p.inherited_history or {"events": [], "sprints": []},
            "nodes": [node_out(n) for n in research_map.nodes(d, p)],
            "sprints": [sprint_out(s) for s in sprints],
            "jobs": [job_out(j, d) for j in jobs],
            "docker": docker_state(),
            "input_needed": input_needed(d, p),
            "datasets": [
                research_datasets.out(r) for r in research_datasets.of(d, p.id)
            ],
        }

    @app.get("/api/v1/research/projects/{id}/metrics")
    def project_metrics(id: str, a=Depends(auth), d=Depends(db)):
        from .research_metrics import metrics

        return metrics(d, project_of(d, id, a))

    @app.get("/api/v1/research/projects/{id}/report")
    def project_report(id: str, lang: str = "zh", a=Depends(auth), d=Depends(db)):
        from .research_report import report

        p = project_of(d, id, a)
        return Response(
            report(d, p, lang),
            media_type="text/markdown; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="research-{p.id[:8]}.md"'
            },
        )

    @app.get("/api/v1/research/projects/{id}/events")
    def events(id: str, after: str = "", a=Depends(auth), d=Depends(db)):
        p = project_of(d, id, a)
        query = select(ResearchEvent).where(ResearchEvent.project_id == p.id)
        if after:
            query = query.where(ResearchEvent.created_at > after)
        return [
            event_out(e)
            for e in d.scalars(
                query.order_by(ResearchEvent.created_at, ResearchEvent.id).limit(200)
            )
        ]

    @app.get("/api/v1/research/projects/{id}/jobs/{job_id}/log")
    def job_log(
        id: str,
        job_id: str,
        offset: int = 0,
        limit: int = 500,
        a=Depends(auth),
        d=Depends(db),
    ):
        p = project_of(d, id, a)
        job = d.get(ResearchJob, job_id)
        if not job or job.project_id != p.id:
            raise HTTPException(404, "Not found")
        from .research_sandbox import read_log

        try:
            return read_log(settings, job, max(0, offset), min(max(limit, 1), 500))
        except ValueError as e:
            raise HTTPException(409, str(e)) from None

    def decisions_of(d, p):
        rows = list(
            d.scalars(
                select(ResearchEvent)
                .where(
                    ResearchEvent.project_id == p.id,
                    ResearchEvent.action.in_(["decision_requested", "human_decision"]),
                )
                .order_by(ResearchEvent.created_at)
            )
        )
        answered = {
            r.detail.get("request_id") for r in rows if r.action == "human_decision"
        }
        return [
            {**event_out(r), "open": r.id not in answered}
            for r in rows
            if r.action == "decision_requested"
        ]

    @app.get("/api/v1/research/projects/{id}/decisions")
    def decisions(id: str, a=Depends(auth), d=Depends(db)):
        return decisions_of(d, project_of(d, id, a))

    @app.post("/api/v1/research/projects/{id}/decisions/{event_id}")
    def decide(
        id: str, event_id: str, body: DecisionInput, a=Depends(auth), d=Depends(db)
    ):
        from .research_advice import act

        project_of(d, id, a, writable=True)
        # One answer at a time: a second click waits, then finds it answered.
        p = d.scalars(
            select(ResearchProject).where(ResearchProject.id == id).with_for_update()
        ).one()
        request = d.get(ResearchEvent, event_id)
        if (
            request is None
            or request.project_id != p.id
            or request.action != "decision_requested"
        ):
            raise HTTPException(404, "Not found")
        if not next(x for x in decisions_of(d, p) if x["id"] == event_id)["open"]:
            raise HTTPException(409, "这件事已经决定过了")
        from . import research_stages

        applied = False
        if research_stages.decide(d, p, request, body.approve, body.note):
            applied = True
        elif body.approve:
            node = d.get(ResearchNode, request.detail.get("node_id"))
            sprint = d.get(ResearchSprint, request.sprint_id)
            if (
                node is not None
                and sprint is not None
                and research_map.is_live(d, node)
            ):
                applied = act(
                    d,
                    p,
                    sprint,
                    node,
                    request.detail.get("proposal", "continue"),
                    {**request.detail, "reason": "研究者同意：" + body.note},
                )
        research_map.event(
            d,
            p,
            None,
            "human",
            "human_decision",
            {
                "request_id": request.id,
                "approve": body.approve,
                "note": body.note,
                "applied": applied,
            },
            request.sprint_id,
        )
        if p.status == "waiting" and not any(
            x["open"] for x in decisions_of(d, p) if x["id"] != event_id
        ):
            p.status = "active"
        p.updated_at = now()
        d.commit()
        return project_out(p)

    @app.get("/api/v1/research/projects/{id}/files")
    def workspace_files(id: str, a=Depends(auth), d=Depends(db)):
        """What the researcher put in the project's data folder."""
        from .research_sandbox import workdir

        p = project_of(d, id, a)
        root = workdir(settings, p.id)
        folder = root / "data"
        if not folder.is_dir():
            return []
        return [
            {"path": str(f.relative_to(root)), "size": f.stat().st_size}
            for f in sorted(folder.rglob("*"))
            if f.is_file() and not f.is_symlink()
        ]

    @app.post("/api/v1/research/projects/{id}/files")
    async def upload_file(id: str, file: UploadFile, a=Depends(auth), d=Depends(db)):
        """A data file for the experiments, kept at /work/data/<name>."""
        from .research_sandbox import WORKSPACE_BYTES, _size, workdir

        p = project_of(d, id, a, writable=True)
        name = Path(file.filename or "").name.strip()
        if not name or name.startswith(".") or len(name) > 200:
            raise HTTPException(422, "文件名不合法")
        data = await file.read(UPLOAD_BYTES + 1)
        if len(data) > UPLOAD_BYTES:
            raise HTTPException(413, "单个文件最多 200 MB")
        root = workdir(settings, p.id)
        if _size(root) + len(data) > WORKSPACE_BYTES:
            raise HTTPException(413, "工作区空间不够")
        folder = root / "data"
        folder.mkdir(exist_ok=True)
        (folder / name).write_bytes(data)
        research_datasets.record_upload(d, p, f"data/{name}", data)
        research_map.event(
            d,
            p,
            None,
            "human",
            "file_added",
            {"path": f"data/{name}", "size": len(data)},
        )
        d.commit()
        return {"path": f"data/{name}", "size": len(data)}

    @app.get("/api/v1/research/roles")
    def research_roles(a=Depends(auth), d=Depends(db)):
        from .research_skills import list_roles

        allowed(a, d)
        return list_roles()

    @app.get("/api/v1/research/roles/{role_id}")
    def research_role(role_id: str, a=Depends(auth), d=Depends(db)):
        from .research_skills import read_role

        allowed(a, d)
        try:
            return read_role(role_id)
        except (OSError, UnicodeError) as error:
            raise HTTPException(404, "Not found") from error

    @app.get("/api/v1/research/playbook")
    def playbook(a=Depends(auth), d=Depends(db)):
        from . import research_playbook

        allowed(a, d)
        book = research_playbook.load(settings)
        return {
            "version": book["version"],
            "rules": book["rules"],
            "history": book["history"][-50:],
        }

    @app.post("/api/v1/research/playbook/rules/{rule_id}")
    def review_rule(rule_id: str, body: DecisionInput, a=Depends(auth), d=Depends(db)):
        """A person admits a pending rule (it takes effect) or retires one."""
        from . import research_playbook

        allowed(a, d)
        book = research_playbook.load(settings)
        rule = next((r for r in book["rules"] if r["id"] == rule_id), None)
        if rule is None:
            raise HTTPException(404, "Not found")
        rule["status"] = "active" if body.approve else "retired"
        book["version"] += 1
        book["history"].append(
            {
                "version": book["version"],
                "project": None,
                "actor": "human",
                "at": now(),
                "rule": rule_id,
                "approve": body.approve,
                "note": body.note,
            }
        )
        research_playbook.save(settings, book)
        return rule

    def move(p, status, d, end_reason=None):
        p.status = status
        if end_reason is not None:
            p.end_reason = end_reason
        p.updated_at = now()
        research_map.event(
            d, p, None, "human", status, {"end_reason": end_reason or ""}
        )
        d.commit()
        return project_out(p)

    WAITING = "有待你拍板的事，先在研究页面上回答"

    @app.post("/api/v1/research/projects/{id}/pause")
    def pause(id: str, a=Depends(auth), d=Depends(db)):
        p = project_of(d, id, a)
        if p.status == "finished":
            raise HTTPException(409, "研究已结束")
        if p.status == "waiting":
            raise HTTPException(409, WAITING)
        from .research_sandbox import PAUSED_NOTE

        # Paused means nothing runs: not the round, not its experiments.
        halt(d, p, PAUSED_NOTE)
        return move(p, "paused", d)

    @app.post("/api/v1/research/projects/{id}/resume")
    def resume(id: str, a=Depends(auth), d=Depends(db)):
        p = project_of(d, id, a, writable=True)
        if p.status == "finished":
            raise HTTPException(409, "研究已结束，不能继续")
        if any(x["open"] for x in decisions_of(d, p)):
            raise HTTPException(409, WAITING)
        from . import research_datasets

        # Resuming after a failed download means: try it again.
        research_datasets.retry_failed(d, p)
        return move(p, "active", d)

    def halt(d, p, note):
        """The round in progress is cancelled and the running jobs stopped."""
        from . import research_sandbox

        running = [
            s.run_id
            for s in d.scalars(
                select(ResearchSprint).where(
                    ResearchSprint.project_id == p.id,
                    ResearchSprint.status == "running",
                )
            )
        ]
        if running:
            d.execute(
                update(AgentRun)
                .where(
                    AgentRun.id.in_(running),
                    AgentRun.status.in_(["queued", "running"]),
                )
                .values(status="cancelled", updated_at=now())
            )
            # The scheduler only looks at active researches: close the round here.
            from .research_worker import _settle

            d.flush()
            d.expire_all()
            for sprint in d.scalars(
                select(ResearchSprint).where(
                    ResearchSprint.project_id == p.id,
                    ResearchSprint.status == "running",
                )
            ):
                _settle(d, p, sprint)
        research_sandbox.stop_jobs(settings, d, p.id, note)

    @app.post("/api/v1/research/projects/{id}/stop")
    def stop(id: str, a=Depends(auth), d=Depends(db)):
        from .research_sandbox import STOPPED_NOTE

        p = project_of(d, id, a)
        halt(d, p, STOPPED_NOTE)
        return move(p, "finished", d, "stopped")
