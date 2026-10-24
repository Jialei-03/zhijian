"""User-owned inference preferences and protocol-specific request fields."""

EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"]


def model_key(config):
    """The model as these tables know it: a release and its preview behave alike."""
    return config.get("model", "").lower().removesuffix("-preview")


def controls(config):
    model = model_key(config)
    modes = ["default", "disabled", "adaptive"]
    efforts = EFFORTS
    note = ""
    if model == "minimax-m3.1-flash":
        modes = ["default", "adaptive"]
        note = "此模型必须思考，可通过 effort 调整强度。"
    elif model == "minimax-m3":
        efforts = ["default"]
        note = "M3 支持关闭或自适应思考，不支持独立 effort。"
    elif model.startswith("minimax-m2"):
        modes = ["default"]
        efforts = ["default"]
        note = "此模型由上游控制思考，不支持关闭。"
    elif config.get("protocol") == "anthropic":
        modes.append("enabled")
        note = "可用模式取决于模型版本；不确定时使用模型默认。"
    else:
        note = "自定义服务需支持对应参数；不确定时使用模型默认。"
    return {"thinking_modes": modes, "effort_levels": efforts, "note": note}


def options(config):
    default = (
        "disabled" if config.get("model", "").lower() == "minimax-m3" else "default"
    )
    return {
        "thinking_mode": config.get("thinking_mode", default),
        "reasoning_effort": config.get("reasoning_effort", "default"),
    }


# Jobs that only copy, translate or locate text gain nothing from reasoning and
# pay for it in waiting time, so they run at the lowest strength the model
# allows whatever the reader chose for conversation. Reading a paper closely
# (guide, quiz) and answering questions is what thinking is for: those keep it.
FAST = {"translate", "extract", "probe"}
ARTIFACT_TASKS = {
    "guide": "analyze",
    "quiz": "analyze",
    "page_translation": "translate",
    "outline": "extract",
    "highlights": "extract",
    "keypoints": "extract",
}
# Only models whose parameters are known get an override. Sending a field a
# provider never advertised risks a rejected request, so anything else keeps
# the saved preference.
LOWEST = {
    "minimax-m3.1-flash": {
        "thinking_mode": "default",
        "reasoning_effort": "low",
    },
    "minimax-m3": {"thinking_mode": "disabled", "reasoning_effort": "default"},
}


def task_of(*, artifact=None, action=None):
    """What kind of job a run is, from the reading artifact or reader action."""
    if artifact:
        return ARTIFACT_TASKS.get(artifact, "analyze")
    return "translate" if action == "translate" else "chat"


# What conversation and analysis use when the reader has not chosen a strength.
# Measured on a real 28-page paper with MiniMax-M3.1-Flash-Preview: its own
# default thinks far longer than these need (a guide took 153 s by default, 38 s
# at medium and 18 s at low; explaining a passage 19-30 s, 14 s and 10 s).
UNCHOSEN = {
    "minimax-m3.1-flash": {
        "analyze": {"thinking_mode": "default", "reasoning_effort": "low"},
        "chat": {"thinking_mode": "default", "reasoning_effort": "medium"},
    },
}


def task_options(config, task="chat"):
    """The inference options a job of this kind should use with this model."""
    task = ARTIFACT_TASKS.get(task, task)
    model = model_key(config)
    if task in FAST and model in LOWEST:
        return dict(LOWEST[model])
    chosen = options(config)
    # A strength the reader picked is always theirs; an unpicked one is ours.
    if (chosen["reasoning_effort"] == "default"
            and chosen["thinking_mode"] in {"default", "adaptive"}
            and task in UNCHOSEN.get(model, {})):
        # Adaptive selects the thinking mode, not a reasoning strength. Supply
        # the measured task default while preserving that selected mode.
        return {**UNCHOSEN[model][task], "thinking_mode": chosen["thinking_mode"]}
    return chosen


def validate_options(config, values):
    available = controls(config)
    if values["thinking_mode"] not in available["thinking_modes"]:
        raise ValueError("该模型不支持所选思考模式")
    if values["reasoning_effort"] not in available["effort_levels"]:
        raise ValueError("该模型不支持所选 effort")
    if (
        values["thinking_mode"] == "disabled"
        and values["reasoning_effort"] != "default"
    ):
        raise ValueError("关闭思考时请将 effort 设为模型默认")
    return values


def request_options(config):
    value = options(config)
    mode, effort = value["thinking_mode"], value["reasoning_effort"]
    fields = {}
    minimax = config.get("model", "").lower().startswith("minimax-")
    anthropic = config.get("protocol") == "anthropic"
    if mode != "default":
        if minimax or anthropic:
            fields["thinking"] = {"type": mode}
            if mode == "enabled":
                fields["thinking"]["budget_tokens"] = 1024
        elif mode == "disabled":
            fields["reasoning_effort"] = "none"
        elif mode == "adaptive" and effort == "default":
            fields["reasoning_effort"] = "medium"
    if effort != "default" and mode != "disabled":
        if anthropic and not minimax:
            fields["output_config"] = {"effort": effort}
        else:
            fields["reasoning_effort"] = effort
    return fields
