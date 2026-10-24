"""Why a model call failed, as a code the app can store and a sentence a reader can act on.

``ModelError`` is a ``ValueError``, so everything that already catches
``ValueError`` or shows ``str(error)`` keeps working. Messages that carry an
HTTP status keep the words ``HTTP {status}``: the retry rules in
``translation_memory``, ``preparation_worker`` and ``direct_runs`` read them.
Messages never name an exception class and never carry headers or bodies.
"""

import json
import logging
from typing import Literal

import httpx

ModelErrorCode = Literal[
    "timeout",
    "connection",
    "interrupted",
    "malformed",
    "rate_limited",
    "server_error",
    "auth",
    "not_found",
    "bad_request",
    "truncated",
    "empty",
    "too_long",
]

CONNECTION = "连不上模型服务，请检查地址和网络后重试"
INTERRUPTED = "模型的回答中途断开了，请重试"
MALFORMED = "模型服务返回的内容无法识别，请确认地址和接口协议设置正确后重试"
STREAM_FAILED = "模型流式响应失败，请重试"
TRUNCATED = "模型输出被截断，请换用支持更长输出的模型"
EMPTY = "模型返回空内容，请重试或换一个模型"
TOO_LONG = "模型返回内容过长"


class ModelError(ValueError):
    def __init__(self, code: ModelErrorCode, message: str):
        super().__init__(message)
        self.code = code


def from_status(status: int) -> ModelError:
    """The provider answered, but not with a success."""
    head = f"模型服务返回 HTTP {status}"
    if status == 429:
        return ModelError("rate_limited", f"{head}：请求太频繁或额度用完了，请稍后重试")
    if status in (401, 403):
        return ModelError("auth", f"{head}：API 密钥无效或没有权限，请在设置里检查密钥")
    if status == 404:
        return ModelError(
            "not_found", f"{head}：找不到这个模型或地址，请在设置里检查模型名称和地址"
        )
    if status == 408:
        # direct_runs.TRANSIENT retries "HTTP 408", so the words must stay.
        return ModelError("timeout", f"{head}：请求超时，请稍后重试")
    if status >= 500:
        return ModelError("server_error", f"{head}：服务暂时出错，请稍后重试")
    return ModelError("bad_request", f"{head}：请求被拒绝，请检查模型配置后重试")


def from_transport(error: Exception) -> ModelError:
    """The call itself broke: no answer, a cut-off answer or one that is not an answer."""
    if isinstance(error, (httpx.ConnectError, httpx.ConnectTimeout)):
        return ModelError("connection", CONNECTION)
    if isinstance(error, (httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout)):
        # Read at raise time: it is a setting of translation_settings, which
        # imports this module.
        from . import translation_settings

        seconds = translation_settings.MODEL_TIMEOUT_SECONDS
        return ModelError(
            "timeout",
            f"模型服务超过 {seconds:g} 秒没有回应，已停止；请稍后重试或换一个模型",
        )
    if isinstance(error, (httpx.RemoteProtocolError, httpx.ReadError)):
        return ModelError("interrupted", INTERRUPTED)
    if isinstance(error, (json.JSONDecodeError, KeyError, IndexError, TypeError)):
        # These also arise from our own parsing; keep the trace for diagnosis.
        logging.getLogger(__name__).warning(
            "Model response not understood", exc_info=error
        )
        return ModelError("malformed", MALFORMED)
    # Any other transport trouble (refused write, bad redirect, ...) means the
    # service could not be used as configured.
    return ModelError("connection", CONNECTION)
