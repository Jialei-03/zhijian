"""Fixed jobs choose their own thinking strength; conversation keeps the reader's."""

import json

import httpx
import pytest

from backend.model_options import options, request_options, task_of, task_options
from backend.tests.test_acceptance import attach, paper, write
from backend.tests.test_acceptance import env as env  # noqa: PLC0414
from backend.tests.test_agents import pdf_bytes
from backend.tests.test_platform_model import configure_shared
from backend.translation_settings import save_options

FLASH = "platform-minimax-flash"
FAST_FLASH = {"thinking_mode": "default", "reasoning_effort": "low"}


def flash(**saved):
    return {"model": "MiniMax-M3.1-Flash-Preview", "protocol": "openai", **saved}


def test_translation_runs_at_the_lowest_strength_the_model_allows():
    chosen = {"thinking_mode": "adaptive", "reasoning_effort": "high"}
    assert task_options(flash(**chosen), "translate") == FAST_FLASH
    assert request_options({**flash(), **FAST_FLASH}) == {"reasoning_effort": "low"}
    # M3 can switch thinking off, which is the fastest there is.
    m3 = {"model": "MiniMax-M3", "protocol": "openai", "thinking_mode": "adaptive"}
    assert task_options(m3, "translate") == {
        "thinking_mode": "disabled",
        "reasoning_effort": "default",
    }
    assert request_options({**m3, **task_options(m3, "translate")}) == {
        "thinking": {"type": "disabled"}
    }


@pytest.mark.parametrize("task", ["translate", "extract", "probe"])
def test_every_fast_task_ignores_what_the_reader_chose_for_conversation(task):
    chosen = flash(thinking_mode="adaptive", reasoning_effort="max")
    assert task_options(chosen, task) == FAST_FLASH


@pytest.mark.parametrize("task", ["chat", "analyze"])
def test_conversation_and_analysis_keep_a_strength_the_reader_chose(task):
    chosen = flash(thinking_mode="adaptive", reasoning_effort="high")
    assert task_options(chosen, task) == options(chosen)
    lowest = flash(thinking_mode="default", reasoning_effort="low")
    assert task_options(lowest, task) == options(lowest)


def test_without_a_choice_each_task_uses_what_was_measured_on_the_model():
    # Measured on a real 28-page paper: the model's own default thinks for far
    # longer than these need (a guide: 153 s by default, 38 s at medium, 18 s
    # at low; an explanation: 19-30 s by default, 14 s at medium, 10 s at low).
    assert task_options(flash(), "analyze") == FAST_FLASH
    assert task_options(flash(), "chat") == {
        "thinking_mode": "default",
        "reasoning_effort": "medium",
    }
    # M3 answers quickly with thinking off already; there is nothing to change.
    m3 = {"model": "MiniMax-M3", "protocol": "openai"}
    assert task_options(m3, "chat") == options(m3)
    assert task_options(m3, "analyze") == options(m3)


def test_models_whose_parameters_are_unknown_are_left_alone():
    # Sending an effort or thinking field a provider never advertised would risk
    # a rejected request, so only the saved preference is used there.
    custom = {"model": "custom-model", "protocol": "openai", "reasoning_effort": "high"}
    assert task_options(custom, "translate") == options(custom)
    older = {"model": "MiniMax-M2.5", "protocol": "openai"}
    assert task_options(older, "translate") == options(older)


@pytest.mark.parametrize(
    "artifact,action,expected",
    [
        ("page_translation", None, "translate"),
        ("outline", None, "extract"),
        ("highlights", None, "extract"),
        ("guide", None, "analyze"),
        ("quiz", None, "analyze"),
        # An artifact decides the task even when an action is also present.
        ("guide", "translate", "analyze"),
        (None, "translate", "translate"),
        (None, "explain", "chat"),
        (None, "formula", "chat"),
        (None, "ask", "chat"),
        (None, "guide", "chat"),
        (None, None, "chat"),
    ],
)
def test_the_task_follows_what_the_reader_asked_for(artifact, action, expected):
    assert task_of(artifact=artifact, action=action) == expected


def shared_flash(settings):
    path = configure_shared(settings)
    value = json.loads(path.read_text())
    value["models"] = [
        {"id": FLASH, "model": "MiniMax-M3.1-Flash-Preview", "vision": True}
    ]
    path.write_text(json.dumps(value))


def setup(env):
    app, a, b, settings = env
    shared_flash(settings)
    owner = a.get("/api/v1/auth/me").json()["user"]["id"]
    # What the reader chose for conversation: slow, careful thinking.
    save_options(
        settings,
        owner,
        FLASH,
        {"thinking_mode": "adaptive", "reasoning_effort": "high"},
    )
    p = paper(a)
    f = attach(a, p, "source.pdf", pdf_bytes())
    return app, a, settings, owner, p, f


def artifact(a, p, f, kind, **extra):
    response = write(
        a,
        f"/papers/{p['id']}/reading-artifacts",
        {"file_id": f["id"], "model_config_id": FLASH, "kind": kind, **extra},
    )
    assert response.status_code == 200, response.text
    return response.json()


def run_options(app, run_id):
    from backend.models import AgentRun

    with app.state.maker() as d:
        return d.get(AgentRun, run_id).runtime["model_options"]


def stop(a, run_id):
    assert write(a, f"/agent/runs/{run_id}/cancel", {}).status_code == 200


def test_new_runs_are_given_the_strength_of_their_task(env):
    app, a, _settings, _owner, p, f = setup(env)
    chosen = {"thinking_mode": "adaptive", "reasoning_effort": "high"}

    translation = artifact(a, p, f, "page_translation", page=1)
    assert translation["model_options"] == FAST_FLASH
    assert run_options(app, translation["run_id"]) == FAST_FLASH
    stop(a, translation["run_id"])
    outline = artifact(a, p, f, "outline")
    assert run_options(app, outline["run_id"]) == FAST_FLASH
    stop(a, outline["run_id"])

    # Reading the whole paper and answering questions is what thinking is for.
    guide = artifact(a, p, f, "guide")
    assert guide["model_options"] == chosen
    assert run_options(app, guide["run_id"]) == chosen
    stop(a, guide["run_id"])

    session = write(a, "/agent/sessions", {}).json()["id"]

    def ask(action):
        context = {
            "paper_id": p["id"],
            "file_id": f["id"],
            "page": 1,
            "source": "page",
            "action": action,
        }
        response = write(
            a,
            f"/agent/sessions/{session}/runs",
            {"prompt": "x", "model_config_id": FLASH, "reader_context": context},
        )
        assert response.status_code == 200, response.text
        run = response.json()
        options_used = run_options(app, run["id"])
        stop(a, run["id"])
        return options_used

    assert ask("translate") == FAST_FLASH
    assert ask("explain") == chosen
    assert ask("ask") == chosen


def test_changing_the_conversation_setting_keeps_cached_translations(env):
    app, a, settings, owner, p, f = setup(env)
    translation = artifact(a, p, f, "page_translation", page=1)
    stop(a, translation["run_id"])
    guide = artifact(a, p, f, "guide")
    stop(a, guide["run_id"])
    save_options(
        settings, owner, FLASH, {"thinking_mode": "default", "reasoning_effort": "low"}
    )
    # A translated page does not depend on how hard the reader wants the
    # assistant to think, so the same page is found, not translated again.
    again = artifact(a, p, f, "page_translation", page=1)
    assert again["id"] == translation["id"]
    stop(a, again["run_id"])
    # A guide does, so a different strength is a different guide.
    assert artifact(a, p, f, "guide")["id"] != guide["id"]


def test_layout_translation_jobs_do_not_inherit_the_conversation_setting(env):
    _app, a, _settings, _owner, _p, _f = setup(env)
    p = write(a, "/papers", {"title": "Layout", "external_id": "2504.19413v1"}).json()
    job = write(a, f"/papers/{p['id']}/translations", {"model_config_id": FLASH})
    assert job.status_code == 200, job.text
    assert job.json()["model_options"] == FAST_FLASH


def test_connection_tests_use_the_fast_strength(env, monkeypatch):
    from backend import translation_settings

    _app, a, _settings, _owner, _p, _f = setup(env)
    sent = []

    def reply(request):
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={"choices": [{"finish_reason": "stop", "message": {"content": "OK"}}]},
        )

    real = httpx.Client
    monkeypatch.setattr(
        translation_settings.httpx,
        "Client",
        lambda **kw: real(transport=httpx.MockTransport(reply)),
    )
    response = write(a, f"/translation-settings/configs/{FLASH}/test", {})
    assert response.status_code == 200, response.text
    assert sent[0]["reasoning_effort"] == "low"
    assert "thinking" not in sent[0]


@pytest.mark.parametrize("task", ["guide", "quiz", "analyze"])
def test_adaptive_analysis_without_explicit_effort_uses_low_on_wire(task):
    # Automatic preparation calls guide directly; reader actions use analyze.
    # Both must retain adaptive while supplying the same fast task default.
    cfg = flash(thinking_mode="adaptive", reasoning_effort="default")
    selected = task_options(cfg, task)
    assert selected == {"thinking_mode": "adaptive", "reasoning_effort": "low"}
    assert request_options({**cfg, **selected}) == {
        "thinking": {"type": "adaptive"}, "reasoning_effort": "low"
    }
    assert cfg["reasoning_effort"] == "default"


@pytest.mark.parametrize("task", ["guide", "quiz", "analyze"])
@pytest.mark.parametrize("effort", ["low", "medium", "high", "xhigh", "max"])
def test_direct_analysis_names_preserve_explicit_user_strength(task, effort):
    cfg = flash(thinking_mode="adaptive", reasoning_effort=effort)
    assert task_options(cfg, task) == {"thinking_mode": "adaptive", "reasoning_effort": effort}
    assert request_options({**cfg, **task_options(cfg, task)})["reasoning_effort"] == effort


def test_direct_guide_and_chat_apply_distinct_defaults_without_changing_mode():
    assert task_options(flash(), "guide") == FAST_FLASH
    cfg = flash(thinking_mode="adaptive", reasoning_effort="default")
    assert task_options(cfg, "chat") == {"thinking_mode": "adaptive", "reasoning_effort": "medium"}
    custom = {"model": "custom", "protocol": "openai", **options(cfg)}
    assert task_options(custom, "guide") == options(custom)


def test_a_strength_chosen_with_the_question_is_used_for_that_run_only(env):
    app, a, _settings, _owner, p, f = setup(env)
    session = write(a, "/agent/sessions", {}).json()["id"]
    context = {"paper_id": p["id"], "file_id": f["id"], "page": 1, "source": "page"}

    def ask(**extra):
        response = write(
            a,
            f"/agent/sessions/{session}/runs",
            {
                "prompt": "x",
                "model_config_id": FLASH,
                "reader_context": {**context, "action": "ask"},
                **extra,
            },
        )
        return response

    picked = {"thinking_mode": "default", "reasoning_effort": "low"}
    response = ask(model_options=picked)
    assert response.status_code == 200, response.text
    assert run_options(app, response.json()["id"]) == picked
    stop(a, response.json()["id"])

    # Without it, the saved strength still applies.
    response = ask()
    assert run_options(app, response.json()["id"]) == {
        "thinking_mode": "adaptive",
        "reasoning_effort": "high",
    }
    stop(a, response.json()["id"])

    # A strength the model does not offer is refused.
    refused = ask(model_options={"thinking_mode": "enabled"})
    assert refused.status_code == 422


def test_release_and_preview_minimax_share_task_strengths():
    from backend.agent_limits import LARGE_OUTPUT_TOKENS, output_tokens
    from backend.model_options import task_options

    for name in ("MiniMax-M3.1-Flash", "MiniMax-M3.1-Flash-Preview"):
        config = {"model": name}
        assert task_options(config, "guide")["reasoning_effort"] == "low"
        assert task_options(config, "page_translation")["reasoning_effort"] == "low"
        assert output_tokens(config) == LARGE_OUTPUT_TOKENS
