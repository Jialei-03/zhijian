"""Build an offline, disposable local workspace for README screenshots.

    .venv/bin/python scripts/demo_workspace.py --data /tmp/ora-demo --lang zh

All papers, conversations and measurements are synthetic. No experiment, model,
Git command or download is run. The target must be new or empty.
"""

import argparse
import hashlib
import json
import os
import random
import sys
import textwrap
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy import select

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import (
    agent_files,
    research_map,
    research_repo,
    research_sandbox,
    research_workspaces,
)
from backend.config import Settings, database
from backend.models import (
    AgentRun,
    AgentSession,
    Paper,
    PaperPreparation,
    PreparationSetting,
    ReadingArtifact,
    ResearchEvent,
    ResearchJob,
    ResearchNode,
    ResearchNote,
    ResearchSprint,
    TeamChannel,
    TeamMember,
    TeamMessage,
    Version,
)
from backend.paper_metadata import PaperMetadata
from backend.research_team import stable


def stamp(minutes=0):
    start = datetime(2026, 10, 23, 9, tzinfo=timezone.utc)
    return (start + timedelta(minutes=minutes)).isoformat()


@contextmanager
def demo_environment(data):
    """Keep migrations and credential helpers inside this new data directory."""
    values = {
        "APP_MODE": "local",
        "APP_ENV": "development",
        "APP_HOST": "127.0.0.1",
        "DATABASE_URL": "sqlite:///" + str(data / "workspace.db"),
        "STORAGE_DIR": str(data / "files"),
        "TRANSLATION_CONFIG_DIR": str(data / "translation-credentials"),
        "PLATFORM_MODEL_CONFIG": str(data / "platform-model.json"),
        "SCHOLAR_OFFLINE": "1",
    }
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def paper_pdf(title, authors, abstract):
    """Two searchable pages using only PDF's built-in fonts, like e2e/fixtures/pdf.ts."""
    pages = [
        [
            *[(line, 18, True) for line in textwrap.wrap(title, 48)],
            (authors, 10, False),
            ("Abstract", 13, True),
            *[(line, 11, False) for line in textwrap.wrap(abstract, 84)],
            ("1  Introduction", 13, True),
            *[
                (line, 11, False)
                for line in textwrap.wrap(
                    "Long documents require selective access to earlier evidence. "
                    "We study which attention heads support distant lookups, using "
                    "controlled passages with facts placed at several depths. "
                    "The evaluation separates retrieval quality from memory cost.",
                    84,
                )
            ],
            ("2  Evaluation", 13, True),
            (
                "Compare full attention, selected retrieval heads and random heads.",
                11,
                False,
            ),
            (
                "Measure exact-match recall and peak memory at 8k and 32k tokens.",
                11,
                False,
            ),
        ],
        [
            ("3  Results", 16, True),
            (
                "At 32k tokens, full attention reaches 93.8% recall with 16.0 GB memory.",
                11,
                False,
            ),
            (
                "Selected heads reach 93.4% recall with 6.4 GB; random heads reach 70.8%.",
                11,
                False,
            ),
            ("4  Discussion", 13, True),
            (
                "Head selection matters more than head count in this controlled setting.",
                11,
                False,
            ),
            ("5  Limitations", 13, True),
            (
                "These examples cover English fact retrieval, not dense aggregation.",
                11,
                False,
            ),
            ("Cross-language transfer remains an open question.", 11, False),
        ],
    ]
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [5 0 R 7 0 R] /Count 2 >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    ]
    for lines in pages:
        commands, y = [], 730
        for line, size, bold in lines:
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            commands.append(
                f"BT /{'F2' if bold else 'F1'} {size} Tf 42 {y} Td ({escaped}) Tj ET"
            )
            y -= 30 if bold else 20
        stream = "\n".join(commands)
        content = len(objects) + 2
        objects.extend(
            [
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                "/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> "
                f"/Contents {content} 0 R >>",
                f"<< /Length {len(stream.encode())} >>\nstream\n{stream}\nendstream",
            ]
        )
    output = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n{obj}\nendobj\n".encode())
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(output)


PAPERS = [
    (
        "Retrieval Heads for Long-Context Reading",
        "Mira Chen; Leo Patel; Hana Sato",
        "ICLR",
        "A small set of attention heads retrieves distant facts. Selecting these "
        "heads preserves recall while reducing the memory needed for long documents.",
    ),
    (
        "Tracing Evidence Across Long Documents",
        "Nora Evans; Amir Rahman",
        "NeurIPS",
        "Controlled evidence placement reveals how models recover facts from long "
        "documents. Recall depends on both document depth and the attention route.",
    ),
    (
        "When Sparse Attention Preserves Recall",
        "Hana Sato; Elena Rossi",
        "arXiv",
        "Sparse attention can preserve fact retrieval when the selected heads are "
        "matched to the task. Random selection provides a necessary control.",
    ),
    (
        "A Practical Benchmark for Context Recall",
        "Leo Patel; Jun Park",
        "NeurIPS",
        "A reproducible benchmark varies context length, evidence position and "
        "random seed to measure exact-match recall independently of answer style.",
    ),
    (
        "Memory-Efficient Reading with Selective Heads",
        "Elena Rossi; Mira Chen",
        "ICLR",
        "Selective key-value retention reduces peak memory during document reading. "
        "The study reports recall and memory together rather than speed alone.",
    ),
    (
        "Beyond English: Testing Retrieval Transfer",
        "Amir Rahman; Nora Evans; Jun Park",
        "arXiv",
        "Retrieval patterns may change across languages. A paired evaluation "
        "separates lexical overlap from the ability to recover distant evidence.",
    ),
]


def seed(data, lang):
    if lang not in {"zh", "en"}:
        raise ValueError("--lang must be zh or en")
    data = Path(data).expanduser().resolve()
    if data.exists() and any(data.iterdir()):
        raise ValueError(f"演示目录必须为空 / Demo directory must be empty: {data}")
    data.mkdir(parents=True, exist_ok=True)
    with demo_environment(data):
        return populate(data, lang)


def populate(data, lang):
    from argon2 import PasswordHasher

    from backend.local.cli import migrate
    from backend.local.session import local_user
    from backend.translation_settings import write_config
    from backend.translations import store_file

    def text(zh, en):
        return zh if lang == "zh" else en

    migrate()
    settings = Settings.env()
    Path(settings.storage).mkdir(parents=True, exist_ok=True)
    engine, maker = database(settings)
    try:
        with maker() as d:
            reader = local_user(d, PasswordHasher())
            reader.id = str(uuid5(NAMESPACE_URL, "ora-readme:reader"))
            reader.created_at = stamp()
            d.flush()
            # The service supplies its no-secret local sentinel. Port 9 is never called.
            model_id = write_config(
                settings,
                reader.id,
                {
                    "base_url": "http://127.0.0.1:9/v1",
                    "model": "demo",
                    "name": text("演示", "Demo"),
                },
            )["active_id"]
            d.add(PreparationSetting(owner=reader.id, enabled=False))
            workspace = research_workspaces.create(
                d,
                reader.id,
                text("长上下文检索头", "Retrieval heads in long context"),
                text("比较检索质量与显存开销。", "Compare recall and memory use."),
            )
            workspace.created_at, workspace.updated_at = stamp(), stamp(90)
            folder = research_repo.repo_dir(settings, workspace.id)
            folder.mkdir(parents=True, exist_ok=True)
            channel = TeamChannel(
                workspace_id=workspace.id,
                key="experiments",
                name=text("综合", "General"),
                created_at=stamp(),
            )
            d.add(channel)
            d.flush()
            members = {}
            rng = random.Random(20261023)
            for role, zh, en in [
                ("human", "研究者", "Researcher"),
                ("librarian", "文献员", "Librarian"),
                ("executor", "执行者", "Executor"),
                ("writer", "写手", "Writer"),
                ("reviewer", "审稿人", "Reviewer"),
            ]:
                name = text(zh, en)
                session = None
                if role != "human":
                    session = AgentSession(
                        owner=reader.id,
                        workspace_id=workspace.id,
                        kind="team_member",
                        title=name,
                        created_at=stamp(),
                        updated_at=stamp(90),
                    )
                    d.add(session)
                    d.flush()
                member = TeamMember(
                    id=stable(workspace, role),
                    workspace_id=workspace.id,
                    role=role,
                    legacy_name=name,
                    session_id=session.id if session else None,
                )
                if session:
                    # save_member/ensure_team also commit to Git. Export the parsed
                    # definition directly so this generator only writes files and ORM rows.
                    source = agent_files.render(
                        {
                            "name": name,
                            "description": name,
                            "role_description": text(
                                "围绕研究问题协作，记录证据与结论。",
                                "Work from the research question; record evidence and conclusions.",
                            ),
                            "avatar": f"pixel:{rng.getrandbits(32):08x}",
                            "channels": ["#" + channel.name],
                        },
                        role=role,
                    )
                    agent_files.parse(source, role)
                    member.file_path = f".ora/agents/{name}.md"
                    agent_files.atomic_write(folder / member.file_path, source)
                    agent_files.atomic_write(
                        agent_files.state_path(settings, member.id), source
                    )
                d.add(member)
                members[role] = member
            d.flush()
            direct = TeamChannel(
                workspace_id=workspace.id,
                key="dm:reviewer",
                name=text("审稿人", "Reviewer"),
                member_id=members["reviewer"].id,
                created_at=stamp(),
            )
            d.add(direct)
            d.flush()

            papers, files = [], []
            for index, (title, authors, venue, abstract) in enumerate(PAPERS):
                paper = Paper(
                    owner=reader.id,
                    title=title,
                    authors=authors,
                    abstract=abstract,
                    tags=[text("长上下文", "Long context")],
                    reading_status="reading" if index < 3 else "unread",
                    agent_status="completed",
                    favorite=index == 0,
                    created_at=stamp(-60 - index),
                    updated_at=stamp(-index),
                )
                d.add(paper)
                d.flush()
                version = Version(
                    owner=reader.id,
                    paper_id=paper.id,
                    label="v1",
                    provenance="Synthetic README demo",
                    created_at=paper.created_at,
                )
                d.add(version)
                d.flush()
                paper.current_version = version.id
                file = store_file(
                    d,
                    settings,
                    paper,
                    version.id,
                    "paper.pdf",
                    paper_pdf(title, authors, abstract),
                )
                file.created_at = paper.created_at
                d.add(
                    PaperMetadata(
                        paper_id=paper.id,
                        owner=reader.id,
                        data={"venue": venue, "year": 2025},
                        fetched_at=stamp(),
                    )
                )
                d.add(
                    PaperPreparation(
                        owner=reader.id,
                        paper_id=paper.id,
                        file_id=file.id,
                        version_id=version.id,
                        status="completed",
                        stage="",
                        guide_status="completed",
                        translation_status="completed",
                        layout_status="completed",
                        created_at=stamp(),
                        updated_at=stamp(),
                    )
                )
                papers.append(paper)
                files.append(file)

            summary = text(
                "保留检索头后，32k 上下文召回率为 93.4%，显存从 16.0 GB 降至 6.4 GB。随机选头仅为 70.8%。结论限于英文事实检索，跨语言泛化仍待验证。",
                "At 32k tokens, selected heads retain 93.4% recall while memory falls from 16.0 to 6.4 GB. Random heads reach only 70.8%. The result covers English fact retrieval; cross-language transfer remains open.",
            )
            guide = {
                "cited": True,
                "keywords": [
                    text("检索头", "Retrieval heads"),
                    text("稀疏注意力", "Sparse attention"),
                ],
                "summary": [
                    text(
                        "少量注意力头承担远距离事实检索。",
                        "A small set of heads retrieves distant facts.",
                    ),
                    text(
                        "定向保留比随机选头更可靠。",
                        "Targeted selection is more reliable than random selection.",
                    ),
                ],
                "sections": [
                    {
                        "title": text("方法", "Method"),
                        "body": text(
                            "比较完整注意力、检索头和随机选头，记录召回率与峰值显存。",
                            "Compare full attention, retrieval heads and random heads; record recall and peak memory.",
                        ),
                        "pages": [1],
                    },
                    {"title": text("结果", "Results"), "body": summary, "pages": [2]},
                    {
                        "title": text("边界", "Scope"),
                        "body": text(
                            "英文事实检索；尚未覆盖跨语言与全篇聚合。",
                            "English fact retrieval; cross-language transfer and dense aggregation are untested.",
                        ),
                        "pages": [2],
                    },
                ],
            }
            d.add(
                ReadingArtifact(
                    owner=reader.id,
                    paper_id=papers[0].id,
                    file_id=files[0].id,
                    version_id=files[0].version_id,
                    file_sha256=files[0].sha256,
                    cache_key=hashlib.sha256(f"demo-guide:{lang}".encode()).hexdigest(),
                    kind="guide",
                    model_config_id=model_id,
                    model="demo",
                    status="completed",
                    result=guide,
                    created_at=stamp(),
                    updated_at=stamp(),
                )
            )

            def message(role, body, minute, *, target=channel, payload=None):
                row = TeamMessage(
                    workspace_id=workspace.id,
                    channel_id=target.id,
                    author_id=members[role].id,
                    text=body,
                    kind="text",
                    data=payload or {},
                    created_at=stamp(minute),
                )
                d.add(row)
                return row

            message(
                "human",
                text(
                    "只保留检索头，能否在长上下文里保持召回率？先核对文献，再做对照实验。",
                    "Can we keep long-context recall with retrieval heads alone? Check the literature, then run a controlled comparison.",
                ),
                1,
            )
            citations = "\n".join(
                f"{i + 1}. [{p.title}](#paper/{p.id}) — {PAPERS[i][2]}"
                for i, p in enumerate(papers[:3])
            )
            message(
                "librarian",
                text(
                    "这三篇最相关，分别覆盖机制、证据定位和稀疏对照：\n",
                    "These three cover the mechanism, evidence placement and sparse controls:\n",
                )
                + citations,
                5,
                payload={"to": [members["executor"].id]},
            )
            result_message = message(
                "executor",
                text(
                    "两轮实验已完成。32k 下完整注意力为 93.8%，检索头为 93.4%，随机选头为 70.8%；检索头显存减少 60%。结果与图已保存。",
                    "Both rounds are complete. At 32k: full attention 93.8%, retrieval heads 93.4%, random heads 70.8%. Selected heads use 60% less memory. Results and the figure are saved.",
                ),
                65,
                payload={
                    "to": [members["writer"].id],
                    "files": [
                        {"path": path, "name": path}
                        for path in ["results.csv", "recall.svg"]
                    ],
                    # An offline change summary, deliberately without a fabricated Git SHA.
                    "changes": {
                        "commit": "",
                        "files": [
                            {
                                "path": "results.csv",
                                "added": 7,
                                "removed": 0,
                                "status": "A",
                            },
                            {
                                "path": "recall.svg",
                                "added": 1,
                                "removed": 0,
                                "status": "A",
                            },
                        ],
                        "added": 8,
                        "removed": 0,
                    },
                },
            )
            message(
                "writer",
                text(
                    "结论已写入 conclusion.md：优势来自选对检索头，而非单纯减少头数。保留英文检索这一适用边界。",
                    "The conclusion is in conclusion.md: the benefit comes from choosing the right heads, not just using fewer. Its scope remains English retrieval.",
                ),
                75,
                payload={"files": [{"path": "conclusion.md", "name": "conclusion.md"}]},
            )
            message(
                "reviewer",
                text(
                    "已核对表格、图和结论，数字一致。跨语言实验留作后续。",
                    "The table, figure and conclusion agree. Cross-language tests remain follow-up work.",
                ),
                80,
                target=direct,
            )

            question = text(
                "只保留检索头，能否保持长上下文召回率？",
                "Can retrieval heads preserve long-context recall?",
            )
            project = research_map.create_project(
                d, reader.id, question, "", model_id, language=lang
            )
            project.workspace_id = workspace.id
            project.title = text(
                "检索头的质量与显存", "Recall and memory with retrieval heads"
            )
            project.status, project.stage, project.end_reason = (
                "finished",
                "done",
                "concluded",
            )
            project.compute_id = "host"
            project.created_at, project.updated_at = stamp(10), stamp(90)
            research_session = d.get(AgentSession, project.session_id)
            research_session.workspace_id = workspace.id
            research_session.title = project.title
            research_session.created_at, research_session.updated_at = stamp(10), stamp(
                90
            )
            root = research_map.root(d, project)
            timed_events = set()

            def event(action, detail, minute, actor="executor", node=None, sprint=None):
                row = research_map.event(
                    d, project, node, actor, action, detail, sprint
                )
                row.created_at = stamp(minute)
                timed_events.add(row.id)
                return row

            event("message", {"text": question}, 10, "human")
            hypotheses = [
                (
                    text(
                        "检索头可保留召回率并降低显存",
                        "Retrieval heads preserve recall with less memory",
                    ),
                    text(
                        "召回率下降超过 1 个百分点",
                        "Recall drops by more than one percentage point",
                    ),
                    "supported",
                ),
                (
                    text(
                        "随机选取同样多的头也有效",
                        "The same number of random heads works equally well",
                    ),
                    text(
                        "随机选头比检索头低 5 个百分点以上",
                        "Random heads trail selected heads by over five points",
                    ),
                    "refuted",
                ),
                (
                    text(
                        "检索头可跨语言迁移",
                        "Retrieval heads transfer across languages",
                    ),
                    text(
                        "跨语言召回率下降超过 3 个百分点",
                        "Cross-language recall drops by over three points",
                    ),
                    "active",
                ),
            ]
            project.plan = {
                "version": 1,
                "question": question,
                "goal": text(
                    "测量检索质量与显存的权衡", "Measure the recall-memory tradeoff"
                ),
                "metric": text(
                    "精确匹配召回率、峰值显存", "Exact-match recall and peak memory"
                ),
                "baseline": text(
                    "完整注意力与随机选头", "Full attention and random heads"
                ),
                "hypotheses": [
                    {"title": title, "kill_if": kill, "value": "high", "cost": "low"}
                    for title, kill, _ in hypotheses
                ],
                "datasets": [],
                "compute_id": "host",
                "budget": {"max_sprints": None, "max_job_hours": None},
                "summary": text(
                    "先做 8k 对照，再验证 32k；跨语言迁移另行跟进。",
                    "Compare at 8k, validate at 32k, and follow up on language transfer.",
                ),
                "approved_at": stamp(15),
            }
            event(
                "plan_proposed",
                {"plan": {**project.plan, "approved_at": None}},
                12,
                "advisor",
            )
            event(
                "message",
                {
                    "text": text(
                        "计划通过，先验证英文事实检索。",
                        "Plan approved. Start with English fact retrieval.",
                    )
                },
                15,
                "human",
            )
            nodes = []
            for title, kill, _ in hypotheses:
                node = research_map.add_node(
                    d,
                    project,
                    root.id,
                    "hypothesis",
                    title,
                    kill_if=kill,
                    actor="human",
                    reason=project.plan["summary"],
                )
                node.created_at, node.updated_at = stamp(16), stamp(70)
                nodes.append(node)
            sprints = []
            for number, (length, recall, memory) in enumerate(
                [(8192, 93.9, 2.1), (32768, 93.4, 6.4)], 1
            ):
                minute = 25 + number * 15
                title = text(
                    f"第 {number} 轮：{length // 1024}k 对照",
                    f"Round {number}: {length // 1024}k comparison",
                )
                experiment = research_map.add_node(
                    d,
                    project,
                    nodes[0].id,
                    "experiment",
                    title,
                    actor="executor",
                    reason=project.plan["summary"],
                )
                experiment.created_at = stamp(minute - 10)
                reply = text(
                    f"{length // 1024}k 对照完成：检索头召回率 {recall}%，峰值显存 {memory} GB。",
                    f"{length // 1024}k comparison complete: selected heads reach {recall}% recall at {memory} GB peak memory.",
                )
                run = AgentRun(
                    owner=reader.id,
                    session_id=project.session_id,
                    model_config_id=model_id,
                    model="demo",
                    prompt=title,
                    response=reply,
                    status="completed",
                    created_at=stamp(minute - 10),
                    updated_at=stamp(minute),
                )
                d.add(run)
                d.flush()
                sprint = ResearchSprint(
                    project_id=project.id,
                    number=number,
                    role="executor",
                    run_id=run.id,
                    status="ended",
                    summary=reply,
                    focus_node_id=experiment.id,
                    created_at=run.created_at,
                    updated_at=run.updated_at,
                )
                d.add(sprint)
                d.flush()
                sprints.append(sprint)
                job = ResearchJob(
                    project_id=project.id,
                    node_id=experiment.id,
                    sprint_id=sprint.id,
                    command=f"python evaluate.py --round {number}",
                    status="succeeded",
                    exit_code=0,
                    compute_id="host",
                    timeout_seconds=0,
                    config={"context_length": length, "seeds": [11, 23, 47]},
                    metrics={"recall": recall, "peak_memory_gb": memory},
                    started_at=run.created_at,
                    finished_at=run.updated_at,
                    log_lines=2,
                )
                d.add(job)
                d.flush()
                agent_files.atomic_write(
                    research_sandbox.logdir(settings, project.id) / f"{job.id}.log",
                    f"recall={recall}\npeak_memory_gb={memory}\n",
                )
                research_map.update_node(
                    d,
                    experiment,
                    status="supported",
                    confidence=0.95,
                    actor="executor",
                    reason=reply,
                    sprint_id=sprint.id,
                )
                experiment.updated_at = stamp(minute)
                event("message", {"text": reply}, minute, sprint=sprint.id)
            for node, (_, _, status) in zip(nodes, hypotheses):
                research_map.update_node(
                    d, node, status=status, actor="executor", reason=summary
                )
                node.updated_at = stamp(70)
            project.spent = {**project.spent, "sprints": 2}
            project.conclusion = {
                "status": "concluded",
                "answer": summary,
                "summary": summary,
                "proposed_at": stamp(80),
                "accepted": True,
                "note": text("结论通过", "Conclusion accepted"),
                "decided_at": stamp(85),
            }
            event("message", {"text": summary}, 80, "advisor")
            research_map.update_node(
                d, root, status="supported", actor="human", reason=summary
            )
            root.created_at, root.updated_at = stamp(10), stamp(85)
            event(
                "concluded",
                {"status": "concluded", "summary": summary},
                85,
                "human",
                sprint=sprints[-1].id,
            )
            # Service-generated audit events use wall time; order this historical
            # snapshot alongside the explicitly timed dialogue and rounds.
            for row in d.scalars(
                select(ResearchEvent).where(ResearchEvent.project_id == project.id)
            ):
                if row.id in timed_events:
                    continue
                if row.sprint_id:
                    row.created_at = d.get(ResearchSprint, row.sprint_id).updated_at
                elif row.action == "create_project":
                    row.created_at = stamp(10)
                elif row.action == "add_node":
                    node = d.get(ResearchNode, row.node_id)
                    sprint = next(
                        (s for s in sprints if s.focus_node_id == node.id), sprints[0]
                    )
                    row.sprint_id, row.created_at = sprint.id, sprint.created_at
                else:
                    row.sprint_id = sprints[-1].id
                    row.created_at = stamp(70)
            for note in d.scalars(
                select(ResearchNote).where(ResearchNote.project_id == project.id)
            ):
                note.created_at = d.get(ResearchEvent, note.event_id).created_at

            csv = "round,context_tokens,method,recall,peak_memory_gb\n1,8192,full,94.2,4.8\n1,8192,retrieval,93.9,2.1\n1,8192,random,72.1,2.1\n2,32768,full,93.8,16.0\n2,32768,retrieval,93.4,6.4\n2,32768,random,70.8,6.4\n"
            agent_files.atomic_write(
                folder / "AGENTS.md", f"# {workspace.name}\n\n{workspace.description}\n"
            )
            agent_files.atomic_write(
                folder / "plan.md",
                f"# {project.title}\n\n{question}\n\n{project.plan['summary']}\n",
            )
            agent_files.atomic_write(folder / "results.csv", csv)
            agent_files.atomic_write(
                folder / "conclusion.md",
                f"# {text('结论', 'Conclusion')}\n\n{summary}\n",
            )
            agent_files.atomic_write(
                folder / "evaluate.py",
                '"""Replay the synthetic measurements used in this demo; no model is called."""\nimport argparse\nimport csv\nfrom pathlib import Path\n\np = argparse.ArgumentParser()\np.add_argument("--round", required=True, type=int)\nargs = p.parse_args()\nwith Path(__file__).with_name("results.csv").open() as f:\n    for row in csv.DictReader(f):\n        if int(row["round"]) == args.round:\n            print(row)\n',
            )
            labels = [
                text("完整注意力", "Full attention"),
                text("检索头", "Retrieval heads"),
                text("随机选头", "Random heads"),
            ]
            bars = "".join(
                f'<text x="28" y="{80 + i * 90}" font-size="18">{label}</text><rect x="180" y="{58 + i * 90}" width="{score * 4}" height="32" rx="5" fill="{color}"/><text x="{190 + score * 4}" y="{80 + i * 90}" font-size="18">{score}%</text>'
                for i, (label, score, color) in enumerate(
                    zip(labels, [93.8, 93.4, 70.8], ["#94a3b8", "#0d9488", "#cbd5e1"])
                )
            )
            agent_files.atomic_write(
                folder / "recall.svg",
                f'<svg xmlns="http://www.w3.org/2000/svg" width="680" height="340" viewBox="0 0 680 340"><rect width="680" height="340" fill="white"/><g font-family="sans-serif" fill="#334155"><text x="28" y="30" font-size="20">{text("32k 上下文召回率", "Recall at 32k tokens")}</text>{bars}</g></svg>\n',
            )
            d.flush()
            manifest = {
                "lang": lang,
                "clock": stamp(90),
                "owner_id": reader.id,
                "workspace_id": workspace.id,
                "channel_id": channel.id,
                "dm_id": direct.id,
                "research_id": project.id,
                "paper_ids": [p.id for p in papers],
                "file_id": files[0].id,
                "changes_message_id": result_message.id,
                "folder": str(folder),
            }
            d.commit()
            agent_files.atomic_write(
                data / "demo.json",
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            )
            return manifest
    finally:
        engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--lang", choices=["zh", "en"], default="zh")
    args = parser.parse_args()
    try:
        manifest = seed(args.data, args.lang)
    except ValueError as error:
        parser.error(str(error))
    print(f"{args.lang}: {args.data.resolve()} ({len(manifest['paper_ids'])} papers)")


if __name__ == "__main__":
    main()
