# ruff: noqa: B008
"""Read-only comparison projections and grouped workflow evaluations.

Only a research's own rounds/jobs are charged; inherited fork history is context.
The team message adapter can supply contract-shaped participation per thread.
"""

import math
import re
from collections import Counter
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select

from .models import (
    ResearchEvaluationBatch,
    ResearchEvent,
    ResearchJob,
    ResearchNode,
    ResearchSprint,
    ResearchWorkflow,
    now,
)

NUMBER = re.compile(
    r"([\w./%-]+)\s*(?:[=:：]|\s)\s*"
    r"([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(%)?"
)


def _stamp(value):
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _seconds(start, end):
    start, end = _stamp(start), _stamp(end)
    return max(0, int((end - start).total_seconds())) if start and end else 0


def _sentence(text):
    text = " ".join((text or "").split())
    return re.split(r"(?<=[。！？!?])\s*|(?<=\.)\s+", text, maxsplit=1)[0][:400]


def _workflow_name(d, project):
    from .research_workflows import BUILTINS

    workflow = project.workflow or {}
    identifier = workflow.get("id") or "research"
    name = workflow.get("name")
    if name and name != identifier:
        return name
    if identifier in BUILTINS:
        return BUILTINS[identifier]["name"]
    definition = d.get(ResearchWorkflow, identifier)
    if definition and definition.owner == project.owner:
        return definition.name
    return name or identifier


def _numbers(project, nodes, jobs):
    """Prefer metrics named by the conclusion/plan and evidence cited by the map.

    Named measurements only: arbitrary numbers in commands or log lines are not
    results. Never optimize every metric upward (loss and latency go downward).
    """
    context = " ".join(
        str(value)
        for value in [
            project.conclusion.get("summary", ""),
            project.conclusion.get("answer", ""),
            project.plan.get("metric", ""),
        ]
    ).lower()
    candidates, cited = [], set()
    for node in sorted(nodes, key=lambda n: (n.status != "supported", n.id)):
        for entry in reversed([*node.evidence_against, *node.evidence_for]):
            cited.update(
                e["job_id"] for e in entry.get("evidence", []) if e.get("job_id")
            )
            for name, raw, percent in NUMBER.findall(entry.get("summary", "")):
                value = float(raw)
                if math.isfinite(value):
                    candidates.append((name + ("%" if percent else ""), value, 1))
    for job in reversed(jobs):
        if job.status != "succeeded":
            continue
        for name, value in (job.metrics or {}).items():
            if type(value) in (int, float) and math.isfinite(value):
                candidates.append((name, value, 0 if job.id in cited else 2))
    candidates.sort(
        key=lambda item: (item[0].lower().rstrip("%") not in context, item[2])
    )
    found = {}
    for name, value, _ in candidates:
        found.setdefault(name, value)
    return [{"name": name, "value": value} for name, value in list(found.items())[:5]]


def comparison(d, projects, *, members_by_thread=None, at=None):
    """Project authorized ResearchProjects into the Comparison contract.

    members_by_thread: {research_id: [{id, name, messages, tokens}]} from the
    team message layer. Without it, roles stand in for members and a round is
    one message when the legacy research did not persist a message event.
    """
    at = at or now()
    threads = []
    for project in projects:
        sprints = list(
            d.scalars(
                select(ResearchSprint)
                .where(ResearchSprint.project_id == project.id)
                .order_by(ResearchSprint.number)
            )
        )
        jobs = list(
            d.scalars(
                select(ResearchJob)
                .where(ResearchJob.project_id == project.id)
                .order_by(ResearchJob.started_at, ResearchJob.id)
            )
        )
        nodes = list(
            d.scalars(select(ResearchNode).where(ResearchNode.project_id == project.id))
        )
        events = list(
            d.scalars(
                select(ResearchEvent)
                .where(ResearchEvent.project_id == project.id)
                .order_by(ResearchEvent.created_at, ResearchEvent.id)
            )
        )
        counts = Counter(s.role for s in sprints)
        tokens = Counter()
        for sprint in sprints:
            tokens[sprint.role] += sprint.tokens
        messages = Counter(
            e.actor for e in events if e.action == "message" and e.actor != "system"
        )
        roles = sorted(counts.keys() | messages.keys())
        members = [
            {
                "id": role,
                "name": role,
                "messages": messages.get(role, counts[role]),
                "tokens": tokens[role],
            }
            for role in roles
        ]
        if members_by_thread is not None and project.id in members_by_thread:
            members = members_by_thread[project.id]
        answer = project.conclusion.get("summary") or project.conclusion.get("answer")
        if not answer:
            answer = next(
                (
                    e.detail.get("summary", "")
                    for e in reversed(events)
                    if e.action in {"concluded", "input_needed"}
                ),
                "",
            )
        end = project.updated_at if project.status in {"finished", "paused"} else at
        threads.append(
            {
                "id": project.id,
                "title": project.title or project.question,
                "workflow": _workflow_name(d, project),
                "status": project.status,
                "conclusion": _sentence(answer),
                "numbers": _numbers(project, nodes, jobs),
                "tokens": max(
                    project.spent.get("tokens", 0),
                    sum(s.tokens for s in sprints),
                    sum(m["tokens"] for m in members),
                ),
                "job_seconds": max(
                    project.spent.get("job_seconds", 0),
                    sum(
                        _seconds(
                            j.started_at,
                            j.finished_at
                            or (at if j.status == "running" else j.started_at),
                        )
                        for j in jobs
                        if j.status != "queued"
                    ),
                ),
                "elapsed_seconds": _seconds(project.created_at, end),
                "rounds": len(sprints),
                "members": members,
            }
        )
    return {"threads": threads}


class BatchInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    questions: list[str] = Field(min_length=1, max_length=50)
    workflow_ids: list[str] = Field(min_length=1, max_length=10)
    model_config_id: str = Field(min_length=1, max_length=64)
    defer_start: bool = False

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value):
        if not value.strip():
            raise ValueError("评测名称不能为空")
        return value.strip()

    @field_validator("questions", "workflow_ids")
    @classmethod
    def items(cls, values, info):
        limit = 2000 if info.field_name == "questions" else 64
        values = [v.strip() for v in values]
        if any(not v or len(v) > limit for v in values):
            raise ValueError("问题或工作流无效")
        if len(set(values)) != len(values):
            raise ValueError("问题或工作流重复")
        return values

    @model_validator(mode="after")
    def size(self):
        if len(self.questions) * len(self.workflow_ids) > 100:
            raise ValueError("每批最多 100 项研究")
        return self


def create_batch(d, owner, workspace, body, create_research):
    """Create a Cartesian product in one transaction; caller commits.

    create_research(ProjectInput) -> ResearchProject uses the normal research
    creator with persistence deferred. No model, job or Git operation runs here.
    """
    from .research_routes import ProjectInput
    from .research_workflows import definition

    if workspace.owner != owner:
        raise HTTPException(404, "Not found")
    if workspace.kind != "eval" or workspace.archived:
        raise HTTPException(409, "评测项目不可用")
    workflows = [
        definition(d, owner, id, workspace=workspace) for id in body.workflow_ids
    ]
    batch = ResearchEvaluationBatch(
        owner=owner,
        workspace_id=workspace.id,
        name=body.name,
        questions=body.questions,
        workflows=[{"id": w["id"], "name": w["name"]} for w in workflows],
    )
    d.add(batch)
    d.flush()
    cells = []
    for index, question in enumerate(body.questions):
        for workflow in workflows:
            project = create_research(
                ProjectInput(
                    question=question,
                    workspace_id=workspace.id,
                    model_config_id=body.model_config_id,
                    workflow_id=workflow["id"],
                    budget={"auto_decide": True},
                    defer_start=body.defer_start,
                )
            )
            cells.append(
                {
                    "question": index,
                    "workflow_id": workflow["id"],
                    "research_id": project.id,
                }
            )
    batch.cells = cells
    d.flush()
    return batch


def batch_out(batch):
    return {
        key: getattr(batch, key)
        for key in (
            "id",
            "workspace_id",
            "name",
            "questions",
            "workflows",
            "cells",
            "created_at",
        )
    }


def install_compare_routes(
    app, db, auth, allowed, owned, project_of, workspace_of, create_research
):
    @app.get("/api/v1/research/compare")
    def read(
        ids: list[str] = Query(min_length=1, max_length=12),
        a=Depends(auth),
        d=Depends(db),
    ):
        allowed(a, d)
        projects = [project_of(d, id, a) for id in dict.fromkeys(ids)]
        from .research_team import comparison_members

        result = comparison(
            d, projects, members_by_thread=comparison_members(d, projects)
        )
        d.commit()
        return result

    @app.post("/api/v1/research/workspaces/{id}/evaluations")
    def create(id: str, body: BatchInput, a=Depends(auth), d=Depends(db)):
        workspace = workspace_of(d, id, a)
        from .research_workspaces import lock_workspace

        lock_workspace(d, workspace)
        try:
            batch = create_batch(
                d,
                a["id"],
                workspace,
                body,
                lambda body: create_research(body, a, d, persist=False),
            )
            d.commit()
        except BaseException:
            d.rollback()
            raise
        return batch_out(batch)

    @app.get("/api/v1/research/workspaces/{id}/evaluations")
    def listing(id: str, a=Depends(auth), d=Depends(db)):
        workspace_of(d, id, a)
        return [
            batch_out(b)
            for b in d.scalars(
                select(ResearchEvaluationBatch)
                .where(
                    ResearchEvaluationBatch.workspace_id == id,
                    ResearchEvaluationBatch.owner == a["id"],
                )
                .order_by(ResearchEvaluationBatch.created_at.desc())
            )
        ]

    @app.get("/api/v1/research/evaluations/{id}")
    def results(id: str, a=Depends(auth), d=Depends(db)):
        allowed(a, d)
        batch = owned(d, ResearchEvaluationBatch, id, a)
        workspace_of(d, batch.workspace_id, a)
        projects = [project_of(d, cell["research_id"], a) for cell in batch.cells]
        from .research_team import comparison_members

        result = {
            **batch_out(batch),
            **comparison(
                d, projects, members_by_thread=comparison_members(d, projects)
            ),
        }
        d.commit()
        return result
