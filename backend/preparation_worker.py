"""Persistent reconciliation: imports and legacy papers prepare without a browser.

Run separately from HTTP and chat workers. Completed artifacts are reused;
page checkpoints survive failures. A render job consumes the same sentence memory.
"""

import hashlib
import json
import logging
import signal
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import select, update

from .filelock import lock_nowait
from .parent_watch import watch_parent
from .config import Settings, database
from .direct_runs import page_units, whole_paper
from .layout_install import layout_available
from .model_options import task_of, task_options
from .model_usage import bind
from .models import File, Paper, PaperPreparation, ReadingArtifact, TranslationJob, now
from .paper_preparation import enabled, ensure
from .pdf_text import extract_pdf_pages
from .reading_artifacts import RESULT_LIMIT, artifact_prompt, check_result
from .storage_budget import lock_owner, require_space
from .translation_dispatch import TaskExecutor
from .translation_memory import SentenceMemory, request
from .translation_settings import read_config

LOG = logging.getLogger(__name__)


def artifacts(d, row, kind):
    return list(
        d.scalars(
            select(ReadingArtifact)
            .where(
                ReadingArtifact.owner == row.owner,
                ReadingArtifact.file_id == row.file_id,
                ReadingArtifact.kind == kind,
            )
            .order_by(ReadingArtifact.updated_at.desc())
        )
    )


def artifact_key(row, file, config, kind, parameters):
    return hashlib.sha256(
        json.dumps(
            [
                2,
                row.owner,
                file.id,
                file.sha256,
                kind,
                parameters,
                config.get("model"),
                config.get("base_url"),
            ],
            sort_keys=True,
        ).encode()
    ).hexdigest()


def save_artifact(
    settings, maker, row, file, config, kind, parameters, result, pages=None, *, error=""
):
    """Publish one artifact; ``pages`` are the pages it was made from."""
    key = artifact_key(row, file, config, kind, parameters)
    with maker() as d:
        lock_owner(d, row.owner)
        current = d.get(PaperPreparation, row.id)
        if not current or current.status != "running" or not enabled(d, row.owner):
            raise ValueError("自动准备已停止")
        value = d.scalar(
            select(ReadingArtifact).where(
                ReadingArtifact.owner == row.owner, ReadingArtifact.cache_key == key
            )
        )
        if error and value is not None and value.status == "completed":
            return
        size = len(json.dumps(result, ensure_ascii=False).encode()) + 2048
        if size > RESULT_LIMIT:
            raise ValueError("阅读结果过长，未发布")
        require_space(
            d, settings, row.owner, max(0, size - (value.size if value else 0))
        )
        if value is None:
            value = ReadingArtifact(
                owner=row.owner,
                paper_id=row.paper_id,
                file_id=file.id,
                version_id=file.version_id,
                file_sha256=file.sha256,
                cache_key=key,
                kind=kind,
                model_config_id=config.get("id", ""),
                model=config["model"],
                parameters={**parameters, "preparation_id": row.id},
            )
            d.add(value)
        # Existing placeholders and retried artifacts must record the options
        # used for this artifact, rather than the translation task defaults.
        value.model_config_id = config.get("id", "")
        value.model = config["model"]
        value.model_options = task_options(config, task_of(artifact=kind))
        value.result = result
        value.status = "failed" if error else "completed"
        value.error = error[:500]
        if error and kind == "guide":
            current.guide_status = "failed"
        value.size = size
        value.updated_at = now()
        value.evidence_pages = (
            sorted(pages)
            if pages is not None
            else [parameters["page"]]
            if kind == "page_translation"
            else list(range(1, (file.pages or 0) + 1))
        )
        from .reading_artifacts import drop_older_page_translations

        if not error:
            drop_older_page_translations(d, value)
        d.commit()


def process(settings, maker, identifier):
    with maker() as d:
        row = d.get(PaperPreparation, identifier)
        if not row:
            return
        file = d.get(File, row.file_id)
        paper = d.get(Paper, row.paper_id)
        if not file or not paper or paper.current_version != row.version_id:
            row.status = "paused"
            row.stage = "论文版本已更新"
            d.commit()
            return
        config = read_config(settings, row.owner)

    def stop():
        with maker() as d:
            current = d.get(PaperPreparation, identifier)
            paper = d.get(Paper, row.paper_id)
            return (
                not current
                or current.status != "running"
                or not enabled(d, row.owner)
                or not paper
                or paper.current_version != row.version_id
            )

    def progress(**values):
        with maker() as d:
            changed = d.execute(
                update(PaperPreparation)
                .where(
                    PaperPreparation.id == identifier,
                    PaperPreparation.status == "running",
                )
                .values(**values, updated_at=now())
            )
            if changed.rowcount != 1:
                raise ValueError("自动准备已停止")
            d.commit()

    try:
        if not config.get("api_key") or not config.get("model"):
            progress(
                status="waiting", stage="等待可用模型", error="请在设置中选择可用模型"
            )
            return
        path = Path(settings.storage) / file.id
        if (
            path.is_symlink()
            or hashlib.sha256(path.read_bytes()).hexdigest() != file.sha256
        ):
            raise ValueError("原文文件缺失或已变更")
        # Keyed by the real page number. A page without a text layer (a scanned
        # figure, a signature page) is left out of page translation and the
        # guide; the rest of the paper is prepared as usual.
        texts = {
            n + 1: text
            for n, text in enumerate(extract_pdf_pages(path))
            if text.strip()
        }
        if not texts:
            raise ValueError(
                "这篇论文没有文字层（可能是扫描版），自动导读需要 OCR；原文仍可阅读"
            )
        progress(stage="准备导读与共用译文", total=len(texts), error="")
        translated = bind(
            {**config, **task_options(config, "translate")},
            maker,
            settings,
            row.owner,
            "translation",
            row.id,
        )
        memory = SentenceMemory(
            settings, maker, row.owner, file.sha256, translated, cancelled=stop
        )
        with maker() as d:
            guides = artifacts(d, row, "guide")
            pages = artifacts(d, row, "page_translation")
            done = {
                r.parameters.get("page")
                for r in pages
                if r.status == "completed" and r.parameters.get("language") == "zh"
            }
            guide_ready = any(r.status == "completed" for r in guides)
        # Close the reader session before seeding memory: remember/stop own
        # their transactions and must never require a nested pool connection.
        for cached in pages:
            if (
                cached.status == "completed"
                and cached.model == config["model"]
                and cached.parameters.get("language") == "zh"
            ):
                memory.remember(cached.result.get("paragraphs", []))
        progress(
            guide_status="completed" if guide_ready else "running",
            translation_status="running",
            completed=len(done),
        )
        counter_lock = threading.Lock()

        def page_task(number):
            if stop():
                raise ValueError("自动准备已停止")
            units = page_units(texts[number])
            if units is None:
                # Dense tables or unusual line layouts need the same verified
                # layout-aware fallback as an explicit reader translation.
                result = json.loads(
                    memory.page(
                        lambda s, c: request(translated, s, c, stop),
                        texts[number], number,
                    )
                )
                result["paragraphs"] = [
                    memory._validate_unit(pair["original"], pair)
                    for pair in result["paragraphs"]
                ]
            else:
                result = {"paragraphs": memory.translate([u["original"] for u in units])}
            # Verify complete source coverage and one source sentence per result.
            check_result(
                "page_translation",
                json.dumps(result, ensure_ascii=False),
                parameters={"page": number, "language": "zh"},
                expected=set(texts),
                evidence_pages={number},
                evidence_text={str(number): texts[number]},
            )
            if units is None:
                memory.remember(result["paragraphs"])
            save_artifact(
                settings,
                maker,
                row,
                file,
                config,
                "page_translation",
                {"page": number, "language": "zh"},
                result,
            )
            with counter_lock:
                done.add(number)
                progress(completed=len(done))

        def guide_task():
            if guide_ready:
                return
            body = SimpleNamespace(
                kind="guide", language="zh", page=1, question_count=5, difficulty="easy"
            )
            guide_cfg = bind(
                {**config, **task_options(config, task_of(artifact=body.kind))},
                maker,
                settings,
                row.owner,
                "guide",
                row.id,
            )

            def check(raw):
                return check_result(
                    "guide",
                    raw,
                    parameters={},
                    expected=set(texts),
                    evidence_pages=set(texts),
                    evidence_text={str(n): t for n, t in texts.items()},
                )

            # Like page translations, a rate limit or a server error is tried
            # again in place rather than failing the whole preparation.
            raw = whole_paper(
                lambda s, c: request(guide_cfg, s, c, stop),
                check,
                artifact_prompt(file, body, direct=True),
                texts,
            )
            # The guide is made from the pages with text; a scanned page is not
            # evidence for it.
            save_artifact(
                settings, maker, row, file, config, "guide", {}, check(raw), texts
            )
            progress(guide_status="completed")

        errors = []
        with TaskExecutor() as pool:
            futures = [
                (
                    pool.submit(page_task, n),
                    "page_translation",
                    {"page": n, "language": "zh"},
                )
                for n in texts
                if n not in done
            ] + [(pool.submit(guide_task), "guide", {})]
            for future, kind, parameters in futures:
                try:
                    future.result()
                except Exception as error:  # noqa: BLE001 — persist provider and parsing failures so the worker survives
                    reason = str(error) or "阅读准备失败"
                    errors.append(reason)
                    # The reader consumes each feature's own result/error, never
                    # the preparation's aggregate (which also includes layout).
                    save_artifact(
                        settings, maker, row, file, config, kind, parameters, {},
                        error=reason,
                    )
        progress(
            translation_status="completed" if len(done) == len(texts) else "failed"
        )
        # Layout is independent of guide completion and never requeues an existing failed compile.
        with maker() as d:
            lock_owner(d, row.owner)
            current = d.get(PaperPreparation, identifier)
            if (
                current is None
                or current.status != "running"
                or not enabled(d, row.owner)
            ):
                return
            jobs = list(
                d.scalars(
                    select(TranslationJob)
                    .where(
                        TranslationJob.owner == row.owner,
                        TranslationJob.paper_id == row.paper_id,
                        TranslationJob.version_id == row.version_id,
                        TranslationJob.source_file == row.file_id,
                    )
                    .order_by(TranslationJob.created_at.desc())
                )
            )
            ready = next((j for j in jobs if j.status == "completed"), None)
            pending = next((j for j in jobs if j.status in {"queued", "running"}), None)
            another_active = d.scalar(
                select(TranslationJob.id).where(
                    TranslationJob.owner == row.owner,
                    TranslationJob.paper_id == row.paper_id,
                    TranslationJob.status.in_(["queued", "running"]),
                )
            )
            failed = next(
                (
                    j
                    for j in jobs
                    if j.preparation_id == row.id
                    and j.status in {"failed", "cancelled"}
                ),
                None,
            )
            current.layout_status = (
                "completed"
                if ready
                else pending.status
                if pending
                else failed.status
                if failed
                else "waiting"
            )
            if failed and not ready and not pending:
                errors.append(ValueError(failed.error or "布局生成未完成，请手动重试"))
            if (
                not ready
                and not pending
                and not failed
                and not another_active
                and layout_available(settings)
                and len(done) == len(texts)
            ):
                job = TranslationJob(
                    preparation_id=row.id,
                    owner=row.owner,
                    paper_id=row.paper_id,
                    version_id=row.version_id,
                    arxiv_id="",
                    engine="pdf",
                    source_file=file.id,
                    model_config_id=config.get("id", ""),
                    model=config["model"],
                    base_url=config["base_url"],
                    protocol=config.get("protocol", "openai"),
                    model_options=task_options(config, "translate"),
                )
                d.add(job)
                current.layout_status = "queued"
            elif (
                not ready and not pending and not failed
                and not layout_available(settings)
            ):
                current.layout_status = "unavailable"
            if current.guide_status != "completed":
                current.guide_status = "failed"
            complete = ready or current.layout_status == "unavailable"
            current.status = "failed" if errors else "completed" if complete else "waiting"
            current.stage = (
                "准备未完成，已完成内容保留"
                if errors
                else "全部就绪"
                if complete
                else "等待布局 PDF"
            )
            current.error = "；".join(dict.fromkeys(str(e) for e in errors))[:500]
            if errors and any(
                "HTTP 429" in str(e) or "HTTP 5" in str(e) for e in errors
            ):
                current.attempts += 1
                current.retry_at = (
                    datetime.now(timezone.utc)
                    + timedelta(seconds=30 * 2 ** min(current.attempts, 5))
                ).isoformat()
            current.updated_at = now()
            d.commit()
    except Exception as error:  # noqa: BLE001 — persist provider and parsing failures so the worker survives
        LOG.warning("Preparation %s failed: %s", identifier, type(error).__name__)
        reason = str(error) or "阅读准备失败"
        # Source/extraction failures occur before feature tasks are submitted.
        # Keep that reason with the guide as well, without replacing a saved one.
        if config.get("model"):
            try:
                save_artifact(
                    settings, maker, row, file, config, "guide", {}, {},
                    error=reason,
                )
            except Exception:  # noqa: BLE001 — pausing or a full disk must not mask the original failure
                LOG.warning("Could not save guide failure for %s", identifier)
        with maker() as d:
            d.execute(
                update(PaperPreparation)
                .where(
                    PaperPreparation.id == identifier,
                    PaperPreparation.status == "running",
                )
                .values(
                    status="failed",
                    error=reason[:500],
                    stage="准备未完成，已完成内容保留",
                    updated_at=now(),
                )
            )
            d.commit()


def reconcile(settings, maker):
    with maker() as d:
        for paper in d.scalars(select(Paper).order_by(Paper.created_at.desc())):
            if enabled(d, paper.owner):
                ensure(d, paper)
        for row in d.scalars(
            select(PaperPreparation).where(
                PaperPreparation.status == "failed",
                PaperPreparation.retry_at != "",
                PaperPreparation.attempts < 3,
            )
        ):
            if enabled(d, row.owner) and row.retry_at <= now():
                row.status = "queued"
                row.retry_at = ""
        for row in d.scalars(
            select(PaperPreparation).where(PaperPreparation.status == "waiting")
        ):
            if row.translation_status == "completed":
                job = d.scalar(
                    select(TranslationJob)
                    .where(
                        TranslationJob.owner == row.owner,
                        TranslationJob.paper_id == row.paper_id,
                        TranslationJob.version_id == row.version_id,
                        TranslationJob.source_file == row.file_id,
                    )
                    .order_by(TranslationJob.created_at.desc())
                )
                if job:
                    row.layout_status = job.status
                    if job.status == "completed" and row.guide_status == "completed":
                        row.status = "completed"
                        row.stage = "全部就绪"
                    elif job.status == "completed":
                        row.status = "failed"
                        row.stage = "导读尚未完成"
                        row.error = row.error or "请重试导读准备"
                    elif job.status in {"failed", "cancelled"}:
                        row.status = "failed"
                        row.stage = "布局生成未完成"
                        row.error = job.error
                elif row.guide_status == "completed" and enabled(d, row.owner):
                    active_job = d.scalar(
                        select(TranslationJob.id).where(
                            TranslationJob.owner == row.owner,
                            TranslationJob.paper_id == row.paper_id,
                            TranslationJob.status.in_(["queued", "running"]),
                        )
                    )
                    if not active_job and layout_available(settings):
                        row.status = "queued"
            elif enabled(d, row.owner) and read_config(settings, row.owner).get(
                "api_key"
            ):
                row.status = "queued"
        # Installing a layout engine later makes that optional artifact available.
        if layout_available(settings):
            for row in d.scalars(
                select(PaperPreparation).where(
                    PaperPreparation.status == "completed",
                    PaperPreparation.layout_status == "unavailable",
                )
            ):
                if enabled(d, row.owner):
                    row.status = "queued"
        d.commit()


def main():
    watch_parent()
    logging.basicConfig(level=logging.WARNING)
    settings = Settings.env()
    engine, maker = database(settings)
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    path = Path(settings.storage).parent / "preparation-worker.lock"
    with path.open("a") as lock, TaskExecutor() as pool:
        lock_nowait(lock)
        with maker() as d:
            d.execute(
                update(PaperPreparation)
                .where(PaperPreparation.status == "running")
                .values(status="queued", stage="恢复准备进度")
            )
            d.commit()
        active = {}
        last = 0
        while not stopping.is_set():
            active = {key: f for key, f in active.items() if not f.done()}
            if time.monotonic() - last > 15:
                reconcile(settings, maker)
                last = time.monotonic()
            with maker() as d:
                ids = []
                for row in d.scalars(
                    select(PaperPreparation)
                    .where(PaperPreparation.status == "queued")
                    .order_by(
                        PaperPreparation.priority.desc(), PaperPreparation.created_at
                    )
                ):
                    if row.id in active or not enabled(d, row.owner):
                        continue
                    changed = d.execute(
                        update(PaperPreparation)
                        .where(
                            PaperPreparation.id == row.id,
                            PaperPreparation.status == "queued",
                        )
                        .values(status="running", updated_at=now())
                    )
                    if changed.rowcount == 1:
                        ids.append(row.id)
                d.commit()
            for identifier in ids:
                active[identifier] = pool.submit(process, settings, maker, identifier)
            stopping.wait(1)
    engine.dispose()


if __name__ == "__main__":
    main()
