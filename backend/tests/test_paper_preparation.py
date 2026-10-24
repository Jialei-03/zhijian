import json
import pytest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from sqlalchemy import select
from backend.models import (
    PaperPreparation,
    ReadingArtifact,
    TranslationMemory,
    AgentSession,
    TranslationJob,
)
from backend.paper_preparation import ensure
from backend.preparation_worker import reconcile, process
from backend.translation_memory import SentenceMemory
from backend.tests.test_acceptance import env, paper, attach
from backend.tests.test_agents import pdf_bytes


def fixture(env):
    app, a, b, settings = env
    p = paper(a)
    f = attach(a, p, "paper.pdf", pdf_bytes())
    return app, a, b, settings, p, f


def test_preparation_reconciles_without_browser_and_is_owner_scoped(env, monkeypatch):
    app, a, b, settings, p, f = fixture(env)
    reconcile(settings, app.state.maker)
    reconcile(settings, app.state.maker)
    assert a.get(f"/api/v1/papers/{p['id']}/preparation").json()["status"] == "queued"
    assert b.get(f"/api/v1/papers/{p['id']}/preparation").status_code == 404
    with app.state.maker() as d:
        assert len(list(d.scalars(select(PaperPreparation)))) == 1
    assert (
        a.post(
            f"/api/v1/papers/{p['id']}/preparation", json={"action": "pause"}
        ).json()["status"]
        == "paused"
    )
    reconcile(settings, app.state.maker)
    assert a.get(f"/api/v1/papers/{p['id']}/preparation").json()["status"] == "paused"
    assert (
        a.post(
            f"/api/v1/papers/{p['id']}/preparation", json={"action": "resume"}
        ).json()["status"]
        == "queued"
    )
    assert a.patch("/api/v1/preparation-settings", json={"enabled": False}).json() == {
        "enabled": False
    }
    with app.state.maker() as d:
        assert not list(d.scalars(select(AgentSession)))


def test_shared_units_survive_failure_reuse_layout_and_isolate_owners(env, monkeypatch):
    app, a, b, settings, p, f = fixture(env)
    with app.state.maker() as d:
        owners = list(
            d.scalars(
                select(__import__("backend.models", fromlist=["User"]).User).order_by(
                    __import__("backend.models", fromlist=["User"]).User.username
                )
            )
        )
    calls = []

    def complete(cfg, system, content, **kwargs):
        calls.append(content)
        units = json.loads(content)
        return json.dumps(
            {
                "sentences": [
                    {
                        "id": u["id"],
                        "kind": "text",
                        "translation": "翻译 " + u["original"],
                    }
                    for u in units
                ]
            }
        )

    monkeypatch.setattr("backend.translation_memory.complete", complete)
    cfg = {"model": "test", "base_url": "https://api.openai.com/v1"}
    m = SentenceMemory(settings, app.state.maker, owners[0].id, f["sha256"], cfg)
    originals = ["First source sentence.", "Second source sentence."]
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: m.translate(originals), range(2)))
    assert len(calls) == 1 and results[0] == results[1]
    source = "## Here is the input:\n" + json.dumps(
        [{"id": 7, "input": " ".join(originals)}]
    )
    result = json.loads(m.layout(source, True))
    assert result == [
        {"id": 7, "output": " ".join(r["translation"] for r in results[0])}
    ]
    assert len(calls) == 1
    bob_paper = paper(b)
    attach(b, bob_paper, "same.pdf", pdf_bytes())
    SentenceMemory(settings, app.state.maker, owners[1].id, f["sha256"], cfg).translate(
        originals
    )
    assert len(calls) == 2

    def fail(*a, **kw):
        raise ValueError("HTTP 429")

    monkeypatch.setattr("backend.translation_memory.complete", fail)
    import pytest

    with pytest.raises(ValueError):
        m.translate(["Third source sentence."])
    assert m.translate(originals) == results[0]


@pytest.mark.parametrize("canonical", [True, False])
def test_existing_guide_and_pages_do_not_create_chat_or_repeat_models(env, monkeypatch, canonical):
    app, a, b, settings, p, f = fixture(env)
    cfg = {
        "id": "test",
        "api_key": "private-test",
        "model": "MiniMax-M3.1-Flash-Preview",
        "base_url": "https://api.openai.com/v1",
        "protocol": "openai",
    }
    monkeypatch.setattr("backend.preparation_worker.read_config", lambda *args: cfg)
    monkeypatch.setattr("backend.preparation_worker.bind", lambda cfg, *args: cfg)
    if not canonical:
        monkeypatch.setattr("backend.preparation_worker.page_units", lambda _: None)
        monkeypatch.setattr("backend.direct_runs.page_units", lambda _: None)
    # A deterministic page extraction, and the actual shared translator interface.
    monkeypatch.setattr(
        "backend.preparation_worker.extract_pdf_pages",
        lambda *args, **kw: ["Hello world."],
    )
    guide = {
        "keywords": ["memory"],
        "summary": ["一", "二", "三"],
        "sections": [
            {"title": t, "body": "正文", "pages": [1]}
            for t in ["研究问题", "方法", "主要结果", "适用边界"]
        ],
    }
    calls = []

    def complete(cfg, system, content, **kwargs):
        assert cfg["reasoning_effort"] == "low"
        calls.append(system)
        if system.startswith("Translate each"):
            return json.dumps(
                {"sentences": [{"id": 0, "kind": "text", "translation": "你好世界。"}]}
            )
        if system.startswith("You translate one page"):
            return json.dumps({"paragraphs": [{"original": "Hello world.", "translation": "你好世界。", "kind": "text"}]})
        return json.dumps(guide, ensure_ascii=False)

    monkeypatch.setattr("backend.translation_memory.complete", complete)
    settings.pdf_layout_image = "test-image"
    reconcile(settings, app.state.maker)
    with app.state.maker() as d:
        row = d.scalar(select(PaperPreparation))
        row.status = "running"
        identifier = row.id
        d.commit()
    process(settings, app.state.maker, identifier)
    with app.state.maker() as d:
        assert len(list(d.scalars(select(ReadingArtifact)))) == 2
        assert len(list(d.scalars(select(AgentSession)))) == 0
        assert len(list(d.scalars(select(TranslationJob)))) == 1
        row = d.get(PaperPreparation, identifier)
        row.status = "running"
        d.commit()
    process(settings, app.state.maker, identifier)
    assert len(calls) == 2
    with app.state.maker() as d:
        assert len(list(d.scalars(select(TranslationJob)))) == 1

    with app.state.maker() as d:
        job = d.scalar(select(TranslationJob))
        job.status = "failed"
        job.error = "Compile fixture failure"
        row = d.get(PaperPreparation, identifier)
        row.status = "running"
        d.commit()
    process(settings, app.state.maker, identifier)
    with app.state.maker() as d:
        assert len(list(d.scalars(select(TranslationJob)))) == 1
        assert d.get(PaperPreparation, identifier).layout_status == "failed"
    assert len(calls) == 2


def test_pause_only_cancels_owned_automatic_layout_and_resume_reuses_job(env):
    app, a, b, settings, p, f = fixture(env)
    reconcile(settings, app.state.maker)
    other = paper(a)
    with app.state.maker() as d:
        row = d.scalar(select(PaperPreparation))
        automatic = TranslationJob(
            arxiv_id="",
            owner=row.owner,
            paper_id=p["id"],
            version_id=p["current_version"],
            source_file=f["id"],
            preparation_id=row.id,
            status="running",
        )
        manual = TranslationJob(
            arxiv_id="",
            owner=row.owner,
            paper_id=other["id"],
            version_id=other["current_version"],
            status="queued",
        )
        d.add_all([automatic, manual])
        d.commit()
        automatic_id = automatic.id
        manual_id = manual.id
    a.post(f"/api/v1/papers/{p['id']}/preparation", json={"action": "pause"})
    with app.state.maker() as d:
        assert d.get(TranslationJob, automatic_id).status == "cancelled"
        assert d.get(TranslationJob, manual_id).status == "queued"
    a.post(f"/api/v1/papers/{p['id']}/preparation", json={"action": "resume"})
    with app.state.maker() as d:
        assert d.get(TranslationJob, automatic_id).status == "queued"
        assert len(list(d.scalars(select(TranslationJob)))) == 2


def test_completed_layout_does_not_hide_missing_guide(env):
    app, a, b, settings, p, f = fixture(env)
    reconcile(settings, app.state.maker)
    with app.state.maker() as d:
        row = d.scalar(select(PaperPreparation))
        row.status = "waiting"
        row.translation_status = "completed"
        row.guide_status = "failed"
        d.add(
            TranslationJob(
                arxiv_id="",
                owner=row.owner,
                paper_id=p["id"],
                version_id=p["current_version"],
                source_file=f["id"],
                status="completed",
            )
        )
        d.commit()
    reconcile(settings, app.state.maker)
    with app.state.maker() as d:
        row = d.scalar(select(PaperPreparation))
        assert row.status == "failed" and row.guide_status == "failed"


def test_source_controls_page_number_hint_and_literal_json_newlines(env, monkeypatch):
    app, a, _, settings, _, f = fixture(env)
    from backend.models import User
    from backend.reading_artifacts import check_result

    with app.state.maker() as d:
        owner = d.scalar(select(User.id).where(User.username == "alice"))
    source = "This is an ordinary source sentence."
    monkeypatch.setattr(
        "backend.translation_memory.complete",
        lambda *args, **kwargs: '{"sentences":[{"id":0,"kind":"page_number",'
        '"translation":"这是普通的\n原文句子。"}]}',
    )
    memory = SentenceMemory(settings, app.state.maker, owner, f["sha256"], {})
    result = memory.translate([source])
    assert result[0]["kind"] == "text"
    check_result(
        "page_translation", json.dumps({"paragraphs": result}),
        parameters={"page": 1, "language": "zh"}, expected={1},
        evidence_pages={1}, evidence_text={"1": source},
    )
    # A previously cached incorrect hint is repaired without another model call.
    with app.state.maker() as d:
        saved = d.scalar(select(TranslationMemory))
        saved.kind = "page_number"
        d.commit()
    monkeypatch.setattr(
        "backend.translation_memory.complete",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("No duplicate call")),
    )
    assert memory.translate([source])[0]["kind"] == "text"
    assert memory.lookup([source])[0]["kind"] == "text"


def test_prepared_artifacts_record_actual_task_options_on_create_and_retry(env):
    from backend.models import File
    from backend.preparation_worker import save_artifact, artifact_key

    app, a, b, settings, p, f = fixture(env)
    reconcile(settings, app.state.maker)
    config = {"id": "fixture-profile", "model": "MiniMax-M3.1-Flash-Preview",
              "base_url": "https://api.openai.com/v1", "protocol": "openai",
              "thinking_mode": "adaptive", "reasoning_effort": "default"}
    with app.state.maker() as d:
        row = d.scalar(select(PaperPreparation)); row.status = "running"
        file = d.get(File, f["id"])
        d.commit()
    guide_key = artifact_key(row, file, config, "guide", {})
    save_artifact(settings, app.state.maker, row, file, config, "guide", {}, {"summary": ["导读"]})
    save_artifact(settings, app.state.maker, row, file, config, "page_translation",
                  {"page": 1, "language": "zh"}, {"paragraphs": []})
    with app.state.maker() as d:
        guide = d.scalar(select(ReadingArtifact).where(ReadingArtifact.kind == "guide"))
        page = d.scalar(select(ReadingArtifact).where(ReadingArtifact.kind == "page_translation"))
        assert guide.model_options == {"thinking_mode": "adaptive", "reasoning_effort": "low"}
        assert page.model_options == {"thinking_mode": "default", "reasoning_effort": "low"}
        guide_id = guide.id
        guide.model_options = {"thinking_mode": "default", "reasoning_effort": "low"}
        guide.model_config_id = "old-profile"
        d.commit()
    save_artifact(settings, app.state.maker, row, file, config, "guide", {}, {"summary": ["更新导读"]})
    with app.state.maker() as d:
        guide = d.get(ReadingArtifact, guide_id)
        assert guide.cache_key == guide_key
        assert guide.model_config_id == config["id"]
        assert guide.model_options == {"thinking_mode": "adaptive", "reasoning_effort": "low"}
        assert len(list(d.scalars(select(ReadingArtifact)))) == 2


@pytest.mark.parametrize("failure", ["", "guide", "page", "both"])
def test_preparation_failures_are_saved_per_feature_without_layout_notice(env, monkeypatch, failure):
    app, a, _, settings, p, _ = fixture(env)
    cfg = {"id": "fixture", "api_key": "fake-only", "model": "fixture",
           "base_url": "https://example.invalid/v1"}
    monkeypatch.setattr("backend.preparation_worker.read_config", lambda *a: cfg)
    monkeypatch.setattr("backend.preparation_worker.bind", lambda cfg, *a: cfg)
    monkeypatch.setattr("backend.preparation_worker.layout_available", lambda _: False)
    monkeypatch.setattr("backend.preparation_worker.extract_pdf_pages", lambda _: [
        "First source sentence.", "Second source sentence.",
    ])
    guide = {"keywords": ["test"], "summary": ["一", "二", "三"],
             "sections": [{"title": t, "body": "正文", "pages": [1]}
                          for t in ["研究问题", "方法", "主要结果", "适用边界"]]}

    def make_guide(*args):
        if failure in {"guide", "both"}:
            raise ValueError("导读模型失败")
        return json.dumps(guide)

    def translate(self, originals):
        if failure in {"page", "both"} and originals == ["Second source sentence."]:
            raise ValueError("第 2 页模型失败")
        return [{"original": original, "translation": "译文。", "kind": "text"}
                for original in originals]

    monkeypatch.setattr("backend.preparation_worker.whole_paper", make_guide)
    monkeypatch.setattr(SentenceMemory, "translate", translate)
    reconcile(settings, app.state.maker)
    with app.state.maker() as d:
        row = d.scalar(select(PaperPreparation))
        row.status = "running"
        identifier = row.id
        d.commit()
    process(settings, app.state.maker, identifier)
    state = a.get(f"/api/v1/papers/{p['id']}/preparation").json()
    assert state["layout_status"] == "unavailable"
    assert state["status"] == ("failed" if failure else "completed")
    assert "布局" not in state["error"]
    assert state["error"] == "；".join(
        (["第 2 页模型失败"] if failure in {"page", "both"} else [])
        + (["导读模型失败"] if failure in {"guide", "both"} else [])
    )
    rows = a.get(f"/api/v1/papers/{p['id']}/reading-artifacts").json()
    assert len(rows) == 3
    saved_guide = next(r for r in rows if r["kind"] == "guide")
    pages = {r["parameters"]["page"]: r for r in rows if r["kind"] == "page_translation"}
    assert saved_guide["error"] == ("导读模型失败" if failure in {"guide", "both"} else "")
    assert pages[1]["status"] == "completed" and pages[1]["error"] == ""
    assert pages[2]["error"] == ("第 2 页模型失败" if failure in {"page", "both"} else "")
    # The parent can restart independently; terminal feature failures stay local.
    with app.state.maker() as d:
        d.get(PaperPreparation, identifier).status = "running"
        d.commit()
    again = a.get(f"/api/v1/papers/{p['id']}/reading-artifacts").json()
    for row in again:
        assert row["status"] == next(r["status"] for r in rows if r["id"] == row["id"])
    if not failure:
        with app.state.maker() as d:
            d.get(PaperPreparation, identifier).status = "completed"
            d.commit()
        reconcile(settings, app.state.maker)
        assert a.get(f"/api/v1/papers/{p['id']}/preparation").json()["status"] == "completed"
        monkeypatch.setattr("backend.preparation_worker.layout_available", lambda _: True)
        reconcile(settings, app.state.maker)
        assert a.get(f"/api/v1/papers/{p['id']}/preparation").json()["status"] == "queued"


def test_preparation_source_failure_is_kept_with_the_guide(env, monkeypatch):
    app, a, _, settings, p, _ = fixture(env)
    monkeypatch.setattr("backend.preparation_worker.read_config", lambda *a: {
        "id": "fixture", "api_key": "fake-only", "model": "fixture",
    })
    monkeypatch.setattr("backend.preparation_worker.extract_pdf_pages", lambda _: [""])
    reconcile(settings, app.state.maker)
    with app.state.maker() as d:
        row = d.scalar(select(PaperPreparation))
        row.status = "running"
        identifier = row.id
        d.commit()
    process(settings, app.state.maker, identifier)
    state = a.get(f"/api/v1/papers/{p['id']}/preparation").json()
    assert state["status"] == "failed" and state["guide_status"] == "failed"
    rows = a.get(f"/api/v1/papers/{p['id']}/reading-artifacts").json()
    assert len(rows) == 1
    assert rows[0]["kind"] == "guide" and rows[0]["status"] == "failed"
    assert "没有文字层" in rows[0]["error"]
