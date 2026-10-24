"""What one run of the agent may do, in one place.

The worker enforces these numbers, the runtime is handed them, and the
capabilities shown to readers are written from them, so a limit is changed here
and nowhere else and what readers are told cannot drift from what happens.
"""

from .agent_budget import EXECUTION_SECONDS

MODEL_TURNS = 32  # model calls in one run
TOOL_CALLS = 64  # tool calls in one run
CONTEXT_CHARS = 240_000  # what one model call may be sent
HISTORY_RUNS = 8  # earlier runs of the session that the model is shown
HISTORY_TOOL_STEPS = 6  # tool results kept from each of them
HISTORY_REPLY_CHARS = 8_000
TOOL_ARGUMENT_CHARS = 120_000
TOOL_RESULT_CHARS = 60_000
REPLY_CHARS = 100_000
PAGES_PER_READ = 5  # pages one read_file call returns
PAGE_CHARS = 18_000  # text kept of each page
IMAGES_PER_RUN = 8  # pictures a run can send to the model
IMAGE_SIDE = 1800  # longest side of a picture, in pixels

# Models whose thinking shares the output budget with the answer: a budget that
# is too small cuts the answer off in the middle (a JSON guide, a long quiz).
LARGE_OUTPUT = {"minimax-m3", "minimax-m3.1-flash"}
OUTPUT_TOKENS = 8_192
LARGE_OUTPUT_TOKENS = 32_768


def output_tokens(config):
    """Most tokens one model call may produce for this model."""
    from .model_options import model_key

    large = model_key(config) in LARGE_OUTPUT
    return LARGE_OUTPUT_TOKENS if large else OUTPUT_TOKENS


# Overridable (tests make Pi compact a short conversation).
COMPACTION = {}


def runtime_limits(config):
    """The numbers the agent runtime is handed with each task."""
    return {
        "output_tokens": output_tokens(config),
        "tool_calls": TOOL_CALLS,
        "model_turns": MODEL_TURNS,
        "context_chars": CONTEXT_CHARS,
        # Pi's compaction settings; empty: Pi's own defaults.
        "compaction": dict(COMPACTION),
    }


def describe():
    """The limits as readers are told them."""
    return [
        f"文字 PDF：可按附件或论文读取，每次最多 {PAGES_PER_READ} 页。多份附件不能确定时会要求选择。",
        "论文定位：可全文搜索文字、读取框选区域文字、列出图表标题及页码。搜索不包含没有文字层的扫描页；图表列表来自标题文字，可能遗漏。",
        "扫描 PDF、图片及图表：可展示，开启视觉输入的模型可接收真实图片进行识别；OCR 结果仍需核对。",
        "笔记：可读写并保留版本，默认编辑已有笔记；需要开启允许修改。",
        "翻译：可提交和查询任务；提交成功不代表翻译已完成。",
        "通用业务 API：支持论文、笔记、版本、阅读记录、方向、偏好、发现与翻译；按用户明确要求可删除其对象。Pi 文件/Bash 工具运行于独立容器；公开网页与文件通过网络工具获取。账号、密钥、宿主机及内网访问隔离。",
        f"源码图表支持 PNG、JPEG、WebP、GIF 与 PDF；SVG / EPS 请查看论文页面。每轮最多发送 {IMAGES_PER_RUN} 张图片，最长边 {IMAGE_SIDE} 像素。",
        "模型名称不能证明视觉能力：需在模型设置中开启图片输入，纯文字模型仍可展示图片，但不能识图。",
        f"每轮最多 {MODEL_TURNS} 次模型调用、{TOOL_CALLS} 次工具调用、{EXECUTION_SECONDS // 60} 分钟。",
    ]
