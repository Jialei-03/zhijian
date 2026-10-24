"""Owner-scoped model credentials stored outside public files and data exports."""

import asyncio
import contextlib
import fcntl
import json
import logging
import os
import re
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .agent_limits import OUTPUT_TOKENS, output_tokens
from .model_errors import (
    EMPTY,
    TRUNCATED,
    ModelError,
    from_status,
    from_transport,
)
from .model_options import controls, options, request_options, validate_options
from .platform_model import apply_limit, model_slot, shared_config, shared_configs

# How long one model call may wait for the provider to say something, and to
# answer the connection. Tests shrink them.
MODEL_TIMEOUT_SECONDS = 300
MODEL_CONNECT_SECONDS = 15

KNOWN_HOSTS = {
    "api.openai.com",
    "api.anthropic.com",
    "api.deepseek.com",
    "api.moonshot.cn",
    "open.bigmodel.cn",
    "openrouter.ai",
    "generativelanguage.googleapis.com",
    "api.siliconflow.cn",
    "api.minimax.cn",
    "api.minimaxi.com",
    "api.minimax.io",
}


def config_path(settings, owner):
    if not re.fullmatch(r"[0-9a-f-]{36}", owner):
        raise ValueError("Invalid owner")
    root = Path(
        os.getenv(
            "TRANSLATION_CONFIG_DIR",
            str(Path(settings.storage).parent / "translation-credentials"),
        )
    )
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root / (owner + ".json")


def allowed_hosts():
    # The local build may use a model server on this machine (local_endpoint).
    local = (
        {"127.0.0.1", "localhost"}
        if os.getenv("APP_MODE", "").strip().lower() == "local"
        else set()
    )
    return sorted(
        KNOWN_HOSTS
        | local
        | set(filter(None, os.getenv("TRANSLATION_ALLOWED_HOSTS", "").split(",")))
    )


# Ollama and LM Studio ignore the key but the OpenAI protocol sends one.
LOCAL_MODEL_KEY = "local"


def local_endpoint(value):
    """A model server on this machine, allowed only in the local build."""
    if os.getenv("APP_MODE", "").strip().lower() != "local":
        return False
    u = urlparse(value.rstrip("/"))
    try:
        u.port
    except ValueError:
        return False
    return (
        u.scheme in {"http", "https"}
        and u.hostname in {"127.0.0.1", "localhost", "::1"}
        and not (u.username or u.password or u.query or u.fragment)
    )


def validate_endpoint(value):
    if local_endpoint(value):
        return value.rstrip("/")
    u = urlparse(value.rstrip("/"))
    # The local build runs for one person with their own key, so any HTTPS
    # model service is theirs to choose; the hosted site keeps its list.
    local = os.getenv("APP_MODE", "").strip().lower() == "local"
    if (
        u.scheme != "https"
        or not u.hostname
        or (not local and u.hostname not in allowed_hosts())
        or u.username
        or u.password
        or u.query
        or u.fragment
        or u.port not in {None, 443}
    ):
        raise ValueError(
            "请使用支持的 HTTPS 模型地址；自定义服务域名需加入服务器 TRANSLATION_ALLOWED_HOSTS"
        )
    return value.rstrip("/")


def read_store(settings, owner):
    path = config_path(settings, owner)
    value = json.loads(path.read_text()) if path.exists() else {}
    if "models" in value:
        return value
    if value.get("api_key"):
        return {
            "active_id": "legacy",
            "models": [
                {
                    **value,
                    "id": "legacy",
                    "protocol": "openai",
                    "name": value.get("model", ""),
                }
            ],
        }
    return {"active_id": "", "models": []}


def read_config(settings, owner, profile_id=None):
    store = read_store(settings, owner)
    shared = shared_config(settings)
    chosen = (
        profile_id if profile_id is not None else store["active_id"] or shared.get("id")
    )
    row = next(
        (
            row
            for row in shared_configs(settings) + store["models"]
            if row["id"] == chosen
        ),
        {},
    )
    if not row:
        return {}
    return {
        **apply_limit(row, shared),
        **store.get("model_options", {}).get(chosen, {}),
    }


def public_config(settings, owner):
    store = read_store(settings, owner)
    cfg = read_config(settings, owner)
    rows = shared_configs(settings) + store["models"]
    return {
        "base_url": cfg.get("base_url", "https://api.openai.com/v1"),
        "model": cfg.get("model", ""),
        "protocol": cfg.get("protocol", "openai"),
        "configured": bool(cfg.get("api_key") and cfg.get("model")),
        "active_id": cfg.get("id", ""),
        "models": [
            {
                **{
                    k: row.get(k, "")
                    for k in ("id", "name", "model", "protocol", "base_url")
                },
                "context_length": row.get("context_length")
                or (1000000 if row.get("model", "").lower() == "minimax-m3" else None),
                **options({**row, **store.get("model_options", {}).get(row["id"], {})}),
                "controls": controls(row),
                "vision": bool(row.get("vision", False)),
                "shared": bool(row.get("shared", False)),
                "badge": row.get("badge", ""),
                "concurrency_limit": row.get("concurrency_limit"),
            }
            for row in rows
        ],
        "allowed_hosts": allowed_hosts(),
        "local_models": os.getenv("APP_MODE", "").strip().lower() == "local",
    }


def mutate_store(settings, owner, change):
    path = config_path(settings, owner)
    fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        store = read_store(settings, owner)
        change(store)
        fd, temp = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(fd, "w") as out:
                json.dump(store, out)
            os.replace(temp, path)
        finally:
            Path(temp).unlink(missing_ok=True)
    return public_config(settings, owner)


def write_config(settings, owner, values, create=False):
    if any(row["id"] == values.get("id") for row in shared_configs(settings)):
        raise ValueError("平台模型由管理员维护，不能修改")
    url = validate_endpoint(values["base_url"])
    protocol = values.get("protocol", "openai")
    if protocol not in {"openai", "anthropic"}:
        raise ValueError("不支持的模型协议")

    def change(store):
        chosen = values.get("id") or (
            ""
            if create or store["active_id"].startswith("platform-")
            else store["active_id"]
        )
        current = next((row for row in store["models"] if row["id"] == chosen), {})
        if chosen and not current:
            raise ValueError("模型配置不存在")
        same = url == current.get("base_url", url) and protocol == current.get(
            "protocol", protocol
        )
        if not same and not values.get("api_key"):
            raise ValueError("更换服务地址或协议时请重新输入对应的 API Key")
        key = values.get("api_key") or current.get("api_key", "")
        if not key and local_endpoint(url):
            key = LOCAL_MODEL_KEY
        if not key:
            raise ValueError("请填写 API Key")
        if current and (not same or current.get("model") != values["model"]):
            store.get("model_options", {}).pop(chosen, None)
        row = {
            "id": chosen or str(uuid.uuid4()),
            "name": values.get("name") or values["model"],
            "base_url": url,
            "protocol": protocol,
            "model": values["model"],
            "api_key": key,
            "context_length": values.get("context_length"),
            "vision": bool(values.get("vision", False)),
        }
        store["models"] = [
            row if old["id"] == chosen else old for old in store["models"]
        ]
        if not current:
            store["models"].append(row)
        if not store["active_id"] or (not create and not values.get("id")):
            store["active_id"] = row["id"]

    return mutate_store(settings, owner, change)


def select_config(settings, owner, profile_id):
    def change(store):
        if not any(
            row["id"] == profile_id
            for row in store["models"] + shared_configs(settings)
        ):
            raise ValueError("模型配置不存在")
        store["active_id"] = profile_id

    return mutate_store(settings, owner, change)


def delete_config(settings, owner, profile_id):
    if any(row["id"] == profile_id for row in shared_configs(settings)):
        raise ValueError("不能移除平台共享模型")

    def change(store):
        store["models"] = [row for row in store["models"] if row["id"] != profile_id]
        store.get("model_options", {}).pop(profile_id, None)
        if store["active_id"] == profile_id:
            store["active_id"] = store["models"][0]["id"] if store["models"] else ""

    return mutate_store(settings, owner, change)


def save_options(settings, owner, profile_id, values):
    def change(store):
        config = next(
            (
                row
                for row in shared_configs(settings) + store["models"]
                if row["id"] == profile_id
            ),
            None,
        )
        if not config:
            raise ValueError("模型配置不存在")
        validate_options(config, values)
        store.setdefault("model_options", {})[profile_id] = values

    return mutate_store(settings, owner, change)


def endpoint(base, protocol, resource):
    base = (
        validate_endpoint(base)
        .removesuffix("/chat/completions")
        .removesuffix("/messages")
    )
    if protocol == "anthropic" and not base.endswith("/v1"):
        base += "/v1"
    return base + "/" + resource


def auth_headers(key, protocol):
    return (
        {"x-api-key": key, "anthropic-version": "2023-06-01"}
        if protocol == "anthropic"
        else {"Authorization": "Bearer " + key}
    )


def list_models(settings, owner, values):
    base = validate_endpoint(values["base_url"])
    protocol = values.get("protocol", "openai")
    current = read_config(settings, owner, values.get("id") or None)
    if current.get("shared"):
        current = {}
    key = values.get("api_key") or (
        current.get("api_key")
        if base == current.get("base_url")
        and protocol == current.get("protocol", "openai")
        else ""
    )
    if not key and local_endpoint(base):
        key = LOCAL_MODEL_KEY
    if not key:
        raise ValueError("请填写该服务的 API Key 后获取模型")
    try:
        models, cursor, seen = set(), "", set()
        with httpx.Client(
            timeout=20, follow_redirects=False, trust_env=False
        ) as client:
            for _ in range(20):
                response = client.get(
                    endpoint(base, protocol, "models"),
                    headers=auth_headers(key, protocol),
                    params={"after_id" if protocol == "anthropic" else "after": cursor}
                    if cursor
                    else None,
                )
                if response.status_code != 200:
                    raise ValueError(
                        f"无法获取模型列表（HTTP {response.status_code}），可手动填写模型名称"
                    )
                data = response.json()
                rows = data["data"]
                models.update(
                    row["id"]
                    for row in rows
                    if isinstance(row.get("id"), str) and 0 < len(row["id"]) <= 200
                )
                if not data.get("has_more"):
                    break
                cursor = data.get("last_id") or (rows[-1].get("id") if rows else None)
                if not cursor or cursor in seen:
                    raise ValueError("上游模型分页异常，请稍后重试")
                seen.add(cursor)
            else:
                raise ValueError("上游模型列表过长，请手动填写模型名称")
        if not models:
            raise ValueError("服务未返回可用模型，可手动填写模型名称")
        return {"models": sorted(models)}
    except (httpx.HTTPError, KeyError, TypeError, AttributeError, json.JSONDecodeError):
        raise ValueError("获取模型列表失败，可重试或手动填写模型名称") from None


def complete(
    config, system, content, *, cancelled=None, on_delta=None, max_tokens=None
):
    with model_slot(config, cancelled=cancelled):
        recorder = config.get("_usage_start")
        identifier = recorder() if recorder else None
        try:
            return _complete(
                config,
                system,
                content,
                identifier,
                cancelled=cancelled,
                on_delta=on_delta,
                max_tokens=max_tokens,
            )
        except Exception:
            if identifier:
                config["_usage_finish"](identifier, None, "failed")
            raise


async def _post_cancellable(url, headers, body, cancelled, on_delta=None):
    # Cancel the transport itself, then release its connection and model slot.
    # This cannot guarantee the provider stops work it has already accepted.
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(MODEL_TIMEOUT_SECONDS, connect=MODEL_CONNECT_SECONDS),
        follow_redirects=False,
        trust_env=False,
    ) as client:
        if on_delta is not None:
            from .model_stream import streamed_post

            operation = streamed_post(client, url, headers, body, on_delta)
        else:
            operation = client.post(url, headers=headers, json=body)
        request = asyncio.create_task(operation)
        try:
            while not request.done():
                if cancelled():
                    raise ValueError("翻译已停止")
                await asyncio.wait({request}, timeout=0.1)
            if cancelled():
                raise ValueError("翻译已停止")
            return await request
        finally:
            if not request.done():
                request.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await request


def _complete(
    config,
    system,
    content,
    usage_id=None,
    *,
    cancelled=None,
    on_delta=None,
    max_tokens=None,
):
    base = validate_endpoint(config["base_url"])
    protocol = config.get("protocol", "openai")
    minimax = config.get("model", "").lower().startswith("minimax-") or (
        urlparse(base).hostname
        in {"api.minimax.cn", "api.minimaxi.com", "api.minimax.io"}
    )
    # M3.1 thinking shares the generation budget with translated text. Treating
    # it as a legacy 8K model can exhaust the budget before the answer is done.
    budget = (
        max_tokens
        if max_tokens is not None
        else (output_tokens(config) if minimax else OUTPUT_TOKENS)
    )
    body = {
        "model": config["model"],
        "messages": [{"role": "user", "content": content}],
    }
    if protocol == "anthropic":
        body.update(system=system, max_tokens=budget)
    else:
        body["messages"].insert(0, {"role": "system", "content": system})
        body["temperature"] = 1 if minimax else 0
        if minimax:
            body.update(reasoning_split=True)
        if budget > OUTPUT_TOKENS:
            body["max_completion_tokens"] = budget
        else:
            body["max_tokens"] = budget
    body.update(request_options(config))
    try:
        url = endpoint(
            base,
            protocol,
            "messages" if protocol == "anthropic" else "chat/completions",
        )
        headers = auth_headers(config["api_key"], protocol)
        if cancelled is not None:
            r = asyncio.run(
                _post_cancellable(
                    url,
                    headers,
                    body,
                    cancelled,
                    on_delta=on_delta if protocol != "anthropic" else None,
                )
            )
        else:
            with httpx.Client(
                timeout=httpx.Timeout(
                    MODEL_TIMEOUT_SECONDS, connect=MODEL_CONNECT_SECONDS
                ),
                follow_redirects=False,
                trust_env=False,
            ) as client:
                r = client.post(url, headers=headers, json=body)
        if r.status_code != 200:
            raise from_status(r.status_code)
        result_body = r.json()
        if usage_id:
            config["_usage_finish"](usage_id, result_body.get("usage"), "completed")
        if protocol == "anthropic":
            result = result_body
            truncated = result.get("stop_reason") == "max_tokens"
            text = "".join(
                block["text"]
                for block in result["content"]
                if block.get("type") == "text"
            )
        else:
            result = result_body["choices"][0]
            truncated = result.get("finish_reason") == "length"
            # A reasoning model can end with no content at all (all thinking).
            message = result.get("message") or {}
            text = message.get("content")
            if not truncated and not isinstance(text, str):
                logging.getLogger(__name__).warning(
                    "Answer without content: finish=%s keys=%s",
                    result.get("finish_reason"),
                    sorted(message),
                )
        if truncated:
            raise ModelError("truncated", TRUNCATED)
        if isinstance(text, str):
            text = re.sub(r"^\s*<think>[\s\S]*?</think>\s*", "", text).strip()
        if not isinstance(text, str) or not text.strip():
            raise ModelError("empty", EMPTY)
        return text
    except (
        httpx.HTTPError,
        KeyError,
        IndexError,
        TypeError,
        json.JSONDecodeError,
    ) as error:
        # Say what went wrong in words; never expose the exception, headers,
        # body or credentials.
        raise from_transport(error) from None


def probe_vision(config):
    """A fresh image-only challenge; an HTTP 200 alone does not verify vision."""
    import base64
    import io
    import secrets

    from PIL import Image, ImageDraw, ImageFont

    code = "".join(str(secrets.randbelow(10)) for _ in range(6))
    im = Image.new("RGB", (420, 100), "white")
    ImageDraw.Draw(im).text(
        (25, 18), code, fill="black", font=ImageFont.load_default(size=60)
    )
    raw = io.BytesIO()
    im.save(raw, "PNG")
    data = base64.b64encode(raw.getvalue()).decode()
    image = (
        {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": data},
        }
        if config.get("protocol") == "anthropic"
        else {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64," + data},
        }
    )
    answer = complete(
        config,
        "Read the image. Return only its six digits; no explanation.",
        [{"type": "text", "text": "What digits are in this image?"}, image],
    )
    if re.sub(r"\s", "", answer) != code:
        raise ValueError(
            "未通过图片识别测试：接口可能未接收图片，或模型识别结果不正确。请检查模型与协议。"
        )
    return True
