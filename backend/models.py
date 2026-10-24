import uuid
from datetime import datetime, timezone
from typing import ClassVar

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def uid():
    return str(uuid.uuid4())


def now():
    return datetime.now(timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    username: Mapped[str] = mapped_column(String(32), unique=True)
    email: Mapped[str | None] = mapped_column(String(254), unique=True, nullable=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    password: Mapped[str] = mapped_column(Text)
    admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class Session(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"))
    csrf: Mapped[str] = mapped_column(String(64))
    expires: Mapped[str] = mapped_column(String(40))


class AccountChallenge(Base):
    __tablename__ = "account_challenges"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"))
    purpose: Mapped[str] = mapped_column(String(16))
    email: Mapped[str] = mapped_column(String(254))
    expires: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class Invitation(Base):
    __tablename__ = "invitations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    username: Mapped[str] = mapped_column(String(32))
    expires: Mapped[str] = mapped_column(String(40))
    used: Mapped[bool] = mapped_column(Boolean, default=False)


class Token(Base):
    __tablename__ = "tokens"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    digest: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    scopes: Mapped[list] = mapped_column(JSON)
    expires: Mapped[str] = mapped_column(String(40))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class Paper(Base):
    __tablename__ = "papers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(500))
    authors: Mapped[str] = mapped_column(Text, default="")
    abstract: Mapped[str] = mapped_column(Text, default="")
    external_id: Mapped[str] = mapped_column(String(200), default="")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    current_version: Mapped[str] = mapped_column(String(36), default="")
    agent_status: Mapped[str] = mapped_column(String(30), default="pending")
    reading_status: Mapped[str] = mapped_column(String(30), default="unread")
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}


class Version(Base):
    __tablename__ = "versions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id"))
    label: Mapped[str] = mapped_column(String(100))
    provenance: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    __table_args__ = (UniqueConstraint("paper_id", "label"),)


class File(Base):
    __tablename__ = "files"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id"))
    version_id: Mapped[str] = mapped_column(ForeignKey("versions.id"))
    name: Mapped[str] = mapped_column(String(255))
    source_path: Mapped[str] = mapped_column(String(500))
    mime: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class InkStroke(Base):
    __tablename__ = "ink_strokes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id"), index=True)
    file_id: Mapped[str] = mapped_column(ForeignKey("files.id"), index=True)
    page: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict] = mapped_column(JSON)
    size: Mapped[int] = mapped_column(Integer)
    deleted: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class TextAnnotation(Base):
    __tablename__ = "text_annotations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id"), index=True)
    file_id: Mapped[str] = mapped_column(ForeignKey("files.id"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("versions.id"))
    page: Mapped[int] = mapped_column(Integer)
    quote: Mapped[str] = mapped_column(Text)
    prefix: Mapped[str] = mapped_column(Text, default="")
    rects: Mapped[list] = mapped_column(JSON)
    color: Mapped[str] = mapped_column(String(7))
    comment: Mapped[str] = mapped_column(Text, default="")
    size: Mapped[int] = mapped_column(Integer)
    deleted: Mapped[bool] = mapped_column(default=False)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)
    __mapper_args__: ClassVar[dict] = {
        "version_id_col": revision,
        "version_id_generator": False,
    }


class Item(Base):
    __tablename__ = "items"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(30), index=True)
    paper_id: Mapped[str | None] = mapped_column(ForeignKey("papers.id"), nullable=True)
    title: Mapped[str] = mapped_column(String(500), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(30), default="open")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    paper_ids: Mapped[list] = mapped_column(JSON, default=list)
    evidence_ids: Mapped[list] = mapped_column(JSON, default=list)
    locator: Mapped[dict] = mapped_column(JSON, default=dict)
    attribution: Mapped[str] = mapped_column(String(150))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}


class Revision(Base):
    __tablename__ = "revisions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    object_id: Mapped[str] = mapped_column(String(36), index=True)
    number: Mapped[int] = mapped_column(Integer)
    snapshot: Mapped[dict] = mapped_column(JSON)
    actor: Mapped[str] = mapped_column(String(150))
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class Event(Base):
    __tablename__ = "events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id"))
    kind: Mapped[str] = mapped_column(String(30))
    body: Mapped[str] = mapped_column(Text)
    locator: Mapped[dict] = mapped_column(JSON, default=dict)
    confirmed: Mapped[bool] = mapped_column(Boolean)
    actor: Mapped[str] = mapped_column(String(150))
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class Feedback(Base):
    __tablename__ = "feedback"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id"))
    action: Mapped[str] = mapped_column(String(30))
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    __table_args__ = (UniqueConstraint("owner", "paper_id"),)


class Idempotency(Base):
    __tablename__ = "idempotency"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"))
    key: Mapped[str] = mapped_column(String(200))
    fingerprint: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSON)
    __table_args__ = (UniqueConstraint("owner", "key"),)


def public(obj):
    return {
        c.name: getattr(obj, c.name)
        for c in obj.__table__.columns
        if c.name not in {"owner", "password", "digest", "csrf"}
    }


class ResearchProfile(Base):
    __tablename__ = "research_profiles"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True)
    body: Mapped[str] = mapped_column(Text, default="")
    interests: Mapped[list] = mapped_column(JSON, default=list)
    excluded: Mapped[list] = mapped_column(JSON, default=list)
    tracking: Mapped[bool] = mapped_column(Boolean, default=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)
    __mapper_args__ = {"version_id_col": revision, "version_id_generator": False}


class DiscoveryCandidate(Base):
    __tablename__ = "discovery_candidates"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    external_id: Mapped[str] = mapped_column(String(200))
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    action: Mapped[str] = mapped_column(String(30), default="")
    updated_at: Mapped[str] = mapped_column(String(40), default=now)
    __table_args__ = (UniqueConstraint("owner", "external_id"),)


class TranslationJob(Base):
    __tablename__ = "translation_jobs"
    __table_args__ = (
        Index(
            "uq_active_translation",
            "owner",
            "paper_id",
            "engine",
            unique=True,
            sqlite_where=text("status IN ('queued', 'running')"),
            postgresql_where=text("status IN ('queued', 'running')"),
        ),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("versions.id"))
    arxiv_id: Mapped[str] = mapped_column(String(80))
    engine: Mapped[str] = mapped_column(
        String(20), default="latex", server_default="latex"
    )
    preparation_id: Mapped[str] = mapped_column(
        String(36), default="", server_default=""
    )
    status: Mapped[str] = mapped_column(String(24), default="queued")
    stage: Mapped[str] = mapped_column(String(100), default="等待处理")
    completed: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    source_file: Mapped[str] = mapped_column(String(36), default="")
    translated_file: Mapped[str] = mapped_column(String(36), default="")
    source_archive: Mapped[str] = mapped_column(String(36), default="")
    translated_archive: Mapped[str] = mapped_column(String(36), default="")
    model_config_id: Mapped[str] = mapped_column(String(36), default="")
    model_options: Mapped[dict] = mapped_column(JSON, default=dict)
    protocol: Mapped[str] = mapped_column(String(20), default="openai")
    model: Mapped[str] = mapped_column(String(200), default="")
    base_url: Mapped[str] = mapped_column(String(500), default="")
    error: Mapped[str] = mapped_column(Text, default="")
    alignment: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class AgentSession(Base):
    __tablename__ = "agent_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(100), default="新会话")
    kind: Mapped[str] = mapped_column(String(24), default="chat", server_default="chat")
    source_session_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    source_run_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    pinned_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    archived_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    read_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    paper_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # A conversation inside a research project (research_chat); none for the reader's.
    workspace_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    # The model the conversation goes on with (changed from its composer); none: the default.
    model_config_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class AgentSessionEntry(Base):
    """One entry of a conversation's Pi session (messages, model changes,
    compactions), in the order Pi wrote them; Pi rebuilds the session from them."""

    __tablename__ = "agent_session_entries"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    session_id: Mapped[str] = mapped_column(ForeignKey("agent_sessions.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    entry: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class AgentRun(Base):
    __tablename__ = "agent_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("agent_sessions.id"), index=True)
    attachment_ids: Mapped[list] = mapped_column(JSON, default=list)
    model_config_id: Mapped[str] = mapped_column(String(36))
    model: Mapped[str] = mapped_column(String(200))
    prompt: Mapped[str] = mapped_column(Text)
    context: Mapped[str] = mapped_column(Text, default="")
    writable: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(24), default="queued")
    response: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(String(500), default="")
    steps: Mapped[list] = mapped_column(JSON, default=list)
    runtime: Mapped[dict] = mapped_column(JSON, default=dict)
    # "" is the reader's conversation; "translation" is bulk page translation,
    # which runs beside it and never holds more than its share of the workers.
    lane: Mapped[str] = mapped_column(String(16), default="", server_default="")
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ReadingArtifact(Base):
    __tablename__ = "reading_artifacts"
    __table_args__ = (UniqueConstraint("owner", "cache_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id"), index=True)
    file_id: Mapped[str] = mapped_column(ForeignKey("files.id"))
    version_id: Mapped[str] = mapped_column(ForeignKey("versions.id"))
    file_sha256: Mapped[str] = mapped_column(String(64))
    cache_key: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16))
    model_config_id: Mapped[str] = mapped_column(String(36))
    model: Mapped[str] = mapped_column(String(200))
    model_options: Mapped[dict] = mapped_column(JSON, default=dict)
    parameters: Mapped[dict] = mapped_column(JSON, default=dict)
    run_id: Mapped[str] = mapped_column(String(36), default="")
    session_id: Mapped[str] = mapped_column(String(36), default="")
    status: Mapped[str] = mapped_column(String(24), default="queued")
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    evidence_pages: Mapped[list] = mapped_column(JSON, default=list)
    evidence_text: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(String(500), default="")
    size: Mapped[int] = mapped_column(Integer, default=131072)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class PreparationSetting(Base):
    __tablename__ = "preparation_settings"
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class PaperPreparation(Base):
    __tablename__ = "paper_preparations"
    __table_args__ = (UniqueConstraint("owner", "file_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    paper_id: Mapped[str] = mapped_column(ForeignKey("papers.id"), index=True)
    file_id: Mapped[str] = mapped_column(ForeignKey("files.id"))
    version_id: Mapped[str] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(24), default="queued")
    stage: Mapped[str] = mapped_column(String(100), default="等待自动准备")
    completed: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    guide_status: Mapped[str] = mapped_column(String(24), default="queued")
    translation_status: Mapped[str] = mapped_column(String(24), default="queued")
    layout_status: Mapped[str] = mapped_column(String(24), default="queued")
    error: Mapped[str] = mapped_column(String(500), default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    retry_at: Mapped[str] = mapped_column(String(40), default="")
    priority: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class TranslationMemory(Base):
    __tablename__ = "translation_memory"
    __table_args__ = (UniqueConstraint("owner", "cache_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    file_sha256: Mapped[str] = mapped_column(String(64), index=True)
    cache_key: Mapped[str] = mapped_column(String(64))
    original: Mapped[str] = mapped_column(Text)
    translation: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(16), default="text")
    size: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class AgentQuota(Base):
    __tablename__ = "agent_quotas"
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    day: Mapped[str] = mapped_column(String(10))
    runs: Mapped[int] = mapped_column(Integer, default=0)
    imports: Mapped[int] = mapped_column(Integer, default=0)


class NoteImage(Base):
    __tablename__ = "note_images"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class AgentAttachment(Base):
    __tablename__ = "agent_attachments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[str] = mapped_column(String(40), default=now)

    @property
    def paper_id(self):
        return None


class ModelUsage(Base):
    __tablename__ = "model_usage"
    __table_args__ = (Index("ix_model_usage_owner_created", "owner", "created_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"))
    source: Mapped[str] = mapped_column(String(20))
    task_id: Mapped[str] = mapped_column(String(36))
    model: Mapped[str] = mapped_column(String(200))
    shared: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="started")
    input_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    cache_read_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    cache_write_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    reserved_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


def _research_budget():
    # No limits until the researcher sets them in the plan.
    return {"max_sprints": None, "max_tokens": None, "max_job_seconds": None}


def _research_spent():
    return {"sprints": 0, "tokens": 0, "job_seconds": 0}


class ResearchWorkspace(Base):
    """A project: the researches pursued together, their board, and what they share
    (instructions every agent reads, a default environment and model)."""

    __tablename__ = "research_workspaces"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    # A physical folder; an empty legacy value resolves to its managed repo.
    location: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    instructions: Mapped[str] = mapped_column(Text, default="")
    workflow: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    workflow_state: Mapped[dict] = mapped_column(
        JSON, default=dict, server_default="{}"
    )
    # Evaluation runs are kept apart from research a person leads.
    kind: Mapped[str] = mapped_column(String(16), default="research")
    compute_id: Mapped[str] = mapped_column(String(64), default="")
    model_config_id: Mapped[str] = mapped_column(String(36), default="")
    session_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, unique=True
    )
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchEvaluationBatch(Base):
    """A question by workflow matrix, referencing independent researches."""

    __tablename__ = "research_evaluation_batches"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("research_workspaces.id"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    questions: Mapped[list] = mapped_column(JSON, default=list)
    workflows: Mapped[list] = mapped_column(JSON, default=list)
    cells: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchCollection(Base):
    """An optional classification of researches, independent of their files."""

    __tablename__ = "research_collections"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    archived: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchCard(Base):
    """A card of a project's board that is not a research or a node of one: an
    idea or a task a person wrote down. Starting a research from it links them."""

    __tablename__ = "research_cards"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("research_workspaces.id"), index=True
    )
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    # triage (an idea), todo, dropped; once a research starts it follows that research
    status: Mapped[str] = mapped_column(String(16), default="triage")
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str] = mapped_column(String(16), default="human")
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchProject(Base):
    """A research question pursued over many sprints, from a persistent map."""

    __tablename__ = "research_projects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    question: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(String(300), default="", server_default="")
    collection_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    on_board: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    # The project it belongs to (research_workspaces); set for every research.
    workspace_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True, index=True
    )
    background: Mapped[str] = mapped_column(Text, default="")
    spawned_by: Mapped[str] = mapped_column(
        String(16), default="human", server_default="human"
    )
    model_config_id: Mapped[str] = mapped_column(String(36))
    # active, waiting (for a person), paused, finished
    status: Mapped[str] = mapped_column(String(16), default="active")
    # "", concluded, refuted, budget, stopped
    end_reason: Mapped[str] = mapped_column(String(16), default="")
    budget: Mapped[dict] = mapped_column(JSON, default=_research_budget)
    spent: Mapped[dict] = mapped_column(JSON, default=_research_spent)
    session_id: Mapped[str] = mapped_column(ForeignKey("agent_sessions.id"))
    # scoping (the plan, until a person approves it), experiments, conclusion
    # (until a person accepts it), retrospective, done
    stage: Mapped[str] = mapped_column(
        String(16), default="experiments", server_default="experiments"
    )
    # Where experiments run: an entry of the research settings' computes.
    compute_id: Mapped[str] = mapped_column(
        String(64), default="local", server_default="local"
    )
    # What the run environment looked like, per compute: {compute_id: {...}}.
    environment: Mapped[dict] = mapped_column(JSON, default=dict)
    # The plan agreed in conversation during scoping: {version, goal, metric,
    # hypotheses, datasets, compute_id, budget, approved_at}.
    plan: Mapped[dict] = mapped_column(JSON, default=dict)
    # The answer once proposed: {status, answer, summary, proposed_at, accepted, note}.
    conclusion: Mapped[dict] = mapped_column(JSON, default=dict)
    workflow: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    workflow_state: Mapped[dict] = mapped_column(
        JSON, default=dict, server_default="{}"
    )
    # Research forks keep their own map, Pi session and immutable source history.
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    forked_from: Mapped[dict] = mapped_column(JSON, default=dict)
    fork_key: Mapped[str | None] = mapped_column(
        String(100), nullable=True, unique=True
    )
    inherited_history: Mapped[dict] = mapped_column(JSON, default=dict)
    merged: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchDataset(Base):
    """A dataset a project uses: where it came from, and what exactly it was."""

    __tablename__ = "research_datasets"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("research_projects.id"), index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    # registry (fetched by the system) or upload (given by the researcher)
    source: Mapped[str] = mapped_column(String(16))
    # Where experiments find it: /data/<name> or /work/data/<file>.
    path: Mapped[str] = mapped_column(String(300))
    # pending, ready, failed
    status: Mapped[str] = mapped_column(String(16), default="pending")
    files: Mapped[list] = mapped_column(JSON, default=list)
    bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchNode(Base):
    """A node of the research map: a question, hypothesis, experiment or finding."""

    __tablename__ = "research_nodes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("research_projects.id"), index=True
    )
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    kind: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(300))
    # open, active, supported, refuted, abandoned, parked
    status: Mapped[str] = mapped_column(String(16), default="open")
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    kill_if: Mapped[str] = mapped_column(Text, default="")
    budget_tokens: Mapped[int] = mapped_column(Integer, default=0)
    # Estimates, high / medium / low ("" when none): what working on it may teach, and what it costs.
    value: Mapped[str] = mapped_column(String(8), default="", server_default="")
    cost: Mapped[str] = mapped_column(String(8), default="", server_default="")
    evidence_for: Mapped[list] = mapped_column(JSON, default=list)
    evidence_against: Mapped[list] = mapped_column(JSON, default=list)
    doubts: Mapped[list] = mapped_column(JSON, default=list)
    spent_tokens: Mapped[int] = mapped_column(Integer, default=0)
    spent_job_seconds: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchEvent(Base):
    """One change to a research project: who made it, in which sprint, and why."""

    __tablename__ = "research_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("research_projects.id"), index=True
    )
    node_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    sprint_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # executor, advisor, human, system
    actor: Mapped[str] = mapped_column(String(16))
    action: Mapped[str] = mapped_column(String(32))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchNote(Base):
    """A research event delivered to the project's main conversation."""

    __tablename__ = "research_notes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("research_workspaces.id"), index=True
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("research_projects.id"), index=True
    )
    event_id: Mapped[str] = mapped_column(ForeignKey("research_events.id"), unique=True)
    kind: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchSprint(Base):
    """One run of the research agent on a project, ended by a handoff."""

    __tablename__ = "research_sprints"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("research_projects.id"), index=True
    )
    number: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(16), default="executor")
    run_id: Mapped[str] = mapped_column(String(36))
    # running, ended, abnormal
    status: Mapped[str] = mapped_column(String(16), default="running")
    focus_node_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    next_focus: Mapped[str] = mapped_column(Text, default="")
    waiting_on: Mapped[list] = mapped_column(JSON, default=list)
    tokens: Mapped[int] = mapped_column(Integer, default=0)
    # The checkpoint of the research's worktree when the round ended (research_repo).
    commit_sha: Mapped[str] = mapped_column(String(64), default="", server_default="")
    # Only snapshots sealed at the round boundary are eligible for a research fork.
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchJob(Base):
    """A background experiment in the project's sandbox; its log is evidence."""

    __tablename__ = "research_jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("research_projects.id"), index=True
    )
    node_id: Mapped[str] = mapped_column(String(36))
    sprint_id: Mapped[str] = mapped_column(String(36))
    command: Mapped[str] = mapped_column(Text)
    # running, succeeded, failed, timeout, lost
    status: Mapped[str] = mapped_column(String(16), default="running")
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    container: Mapped[str] = mapped_column(String(64), default="")
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=7200)
    started_at: Mapped[str] = mapped_column(String(40), default=now)
    finished_at: Mapped[str] = mapped_column(String(40), default="")
    log_lines: Mapped[int] = mapped_column(Integer, default=0)
    compute_id: Mapped[str] = mapped_column(
        String(64), default="local", server_default="local"
    )
    # How it ran on a remote compute: {host, base, pid}.
    remote: Mapped[dict] = mapped_column(JSON, default=dict)
    # What the experiment itself reported through `ora`: its settings, last
    # values, and how many points it logged.
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    points: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    tracker_url: Mapped[str] = mapped_column(String(500), default="", server_default="")


from . import library_collections  # noqa: E402,F401

from . import citations  # noqa: E402,F401

from . import paper_shares  # noqa: E402,F401


class AgentControl(Base):
    """A durable instruction addressed to exactly one running Pi conversation."""

    __tablename__ = "agent_controls"
    __table_args__ = (UniqueConstraint("owner", "client_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("agent_sessions.id"), index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), index=True)
    client_id: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="queued")
    error: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchMerge(Base):
    """A reviewed, immutable selection of research results to apply to main."""

    __tablename__ = "research_merges"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("research_workspaces.id"), index=True
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("research_projects.id"), index=True
    )
    kind: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="preview")
    expected_main_commit: Mapped[str] = mapped_column(String(64))
    expected_source_commit: Mapped[str] = mapped_column(String(64))
    paths: Mapped[list] = mapped_column(JSON, default=list)
    preview: Mapped[dict] = mapped_column(JSON, default=dict)
    commit_sha: Mapped[str] = mapped_column(String(64), default="")
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchWorkflow(Base):
    __tablename__ = "research_workflows"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    version: Mapped[int] = mapped_column(Integer, default=1)
    definition: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchSchedule(Base):
    __tablename__ = "research_schedules"
    __table_args__ = (Index("ix_research_schedules_due", "paused", "next_run_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("research_workspaces.id"))
    title: Mapped[str] = mapped_column(String(200))
    prompt: Mapped[str] = mapped_column(Text)
    destination: Mapped[str] = mapped_column(String(16), default="new")
    research_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    workflow_id: Mapped[str] = mapped_column(
        String(64), default="research", server_default="research"
    )
    frequency: Mapped[str] = mapped_column(String(16), default="daily")
    local_time: Mapped[str] = mapped_column(String(5), default="09:00")
    weekday: Mapped[int] = mapped_column(Integer, default=0)
    interval_hours: Mapped[int] = mapped_column(Integer, default=4)
    timezone: Mapped[str] = mapped_column(String(100))
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    next_run_at: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class ResearchScheduleRun(Base):
    __tablename__ = "research_schedule_runs"
    __table_args__ = (
        Index("ix_research_schedule_runs_history", "schedule_id", "started_at"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    schedule_id: Mapped[str] = mapped_column(ForeignKey("research_schedules.id"))
    trigger: Mapped[str] = mapped_column(String(16))
    scheduled_for: Mapped[str] = mapped_column(String(40))
    started_at: Mapped[str] = mapped_column(String(40), default=now)
    finished_at: Mapped[str] = mapped_column(String(40), default="")
    status: Mapped[str] = mapped_column(String(16), default="running")
    research_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    error: Mapped[str] = mapped_column(Text, default="")


class MemberLibrary(Base):
    __tablename__ = "member_library"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(String(100), index=True)
    legacy_config: Mapped[dict] = mapped_column("config", JSON, default=dict)
    file_path: Mapped[str] = mapped_column(Text, default="", server_default="")

    @property
    def config(self):
        from .agent_files import library_config

        return library_config(self)

    @config.setter
    def config(self, value):
        self.legacy_config = value

    version: Mapped[int] = mapped_column(Integer, default=1)


def _member_definition(key):
    def read(member):
        from .agent_files import member_value

        return member_value(member, key)

    def archive(member, value):
        setattr(member, "legacy_" + key, value)

    return property(read, archive)


class TeamMember(Base):
    __tablename__ = "team_members"
    paused: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    library_id: Mapped[str | None] = mapped_column(
        ForeignKey("member_library.id", name="fk_team_members_library", use_alter=True),
        nullable=True,
    )
    legacy_overrides: Mapped[list] = mapped_column(
        "overrides", JSON, default=list, server_default="[]"
    )
    legacy_role_description: Mapped[str] = mapped_column(
        "role_description", Text, default="", server_default=""
    )
    legacy_avatar_color: Mapped[str] = mapped_column(
        "avatar_color", String(24), default="blue", server_default="blue"
    )
    legacy_permissions: Mapped[dict] = mapped_column(
        "permissions", JSON, default=dict, server_default="{}"
    )
    legacy_subscriptions: Mapped[list] = mapped_column(
        "subscriptions", JSON, default=list, server_default="[]"
    )
    legacy_enabled: Mapped[bool] = mapped_column(
        "enabled", Boolean, default=True, server_default="1"
    )
    deleted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    legacy_wake_turns: Mapped[int] = mapped_column(
        "wake_turns", Integer, default=32, server_default="32"
    )
    legacy_wake_tokens: Mapped[int] = mapped_column(
        "wake_tokens", Integer, default=200000, server_default="200000"
    )
    __table_args__ = (UniqueConstraint("workspace_id", "role"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("research_workspaces.id"), index=True
    )
    role: Mapped[str] = mapped_column(String(24))
    legacy_name: Mapped[str] = mapped_column("name", String(100))
    session_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_sessions.id"), nullable=True
    )
    legacy_model_config_id: Mapped[str] = mapped_column(
        "model_config_id", String(36), default=""
    )
    legacy_max_tokens: Mapped[int] = mapped_column(
        "max_tokens", Integer, default=2000000
    )
    tokens: Mapped[int] = mapped_column(Integer, default=0)

    file_path: Mapped[str] = mapped_column(Text, default="", server_default="")

    overrides = _member_definition("overrides")
    role_description = _member_definition("role_description")
    avatar_color = _member_definition("avatar_color")
    permissions = _member_definition("permissions")
    subscriptions = _member_definition("subscriptions")
    enabled = _member_definition("enabled")
    wake_turns = _member_definition("wake_turns")
    wake_tokens = _member_definition("wake_tokens")
    wake_minutes = _member_definition("wake_minutes")
    max_tokens = _member_definition("max_tokens")
    name = _member_definition("name")
    model_config_id = _member_definition("model_config_id")


class TeamChannel(Base):
    __tablename__ = "team_channels"
    __table_args__ = (UniqueConstraint("workspace_id", "key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("research_workspaces.id"), index=True
    )
    key: Mapped[str] = mapped_column(String(100))
    name: Mapped[str] = mapped_column(String(100))
    member_id: Mapped[str | None] = mapped_column(
        ForeignKey("team_members.id"), nullable=True
    )
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    read_at: Mapped[str] = mapped_column(String(40), default="")
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class TeamMessage(Base):
    __tablename__ = "team_messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("research_workspaces.id"), index=True
    )
    channel_id: Mapped[str] = mapped_column(ForeignKey("team_channels.id"), index=True)
    thread_id: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    author_id: Mapped[str | None] = mapped_column(
        ForeignKey("team_members.id"), nullable=True
    )
    text: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String(24), default="message")
    mentions: Mapped[list] = mapped_column(JSON, default=list)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    relay: Mapped[int] = mapped_column(Integer, default=0)
    source_key: Mapped[str | None] = mapped_column(
        String(100), nullable=True, unique=True
    )
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class TeamMessageReaction(Base):
    __tablename__ = "team_message_reactions"
    # Legacy runs and research roots have virtual message IDs, too.
    message_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("research_workspaces.id", ondelete="CASCADE"), index=True
    )
    member_id: Mapped[str] = mapped_column(
        ForeignKey("team_members.id", ondelete="CASCADE"), primary_key=True
    )
    emoji: Mapped[str] = mapped_column(String(8), primary_key=True)
    author_id: Mapped[str | None] = mapped_column(
        ForeignKey("team_members.id"), nullable=True, index=True
    )
    excerpt: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String(40), default=now, index=True)


class TeamMessageMark(Base):
    __tablename__ = "team_message_marks"
    __table_args__ = (UniqueConstraint("workspace_id", "message_id", "kind", "owner"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("research_workspaces.id"), index=True
    )
    channel_id: Mapped[str] = mapped_column(ForeignKey("team_channels.id"), index=True)
    # Research and imported chat roots also have virtual message IDs.
    message_id: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(16))
    owner: Mapped[str] = mapped_column(String(36), default="")
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class TeamReminder(Base):
    __tablename__ = "team_reminders"
    __table_args__ = (
        Index("ix_team_reminders_due", "workspace_id", "delivered_at", "remind_at"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("research_workspaces.id"))
    channel_id: Mapped[str] = mapped_column(ForeignKey("team_channels.id"))
    message_id: Mapped[str] = mapped_column(String(80))
    thread_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    excerpt: Mapped[str] = mapped_column(Text, default="")
    remind_at: Mapped[str] = mapped_column(String(40))
    delivered_at: Mapped[str] = mapped_column(String(40), default="", server_default="")
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class TeamDelivery(Base):
    __tablename__ = "team_deliveries"
    action: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    __table_args__ = (UniqueConstraint("message_id", "member_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    message_id: Mapped[str] = mapped_column(ForeignKey("team_messages.id"), index=True)
    member_id: Mapped[str] = mapped_column(ForeignKey("team_members.id"), index=True)
    mode: Mapped[str] = mapped_column(String(16), default="queue")
    status: Mapped[str] = mapped_column(String(24), default="queued")
    run_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_runs.id"), nullable=True
    )
    control_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_controls.id"), nullable=True
    )
    error: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[str] = mapped_column(String(40), default=now)
