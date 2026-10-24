"""Read OpenAI SSE responses while exposing only visible answer text."""

import json
import logging

import httpx

from .model_errors import INTERRUPTED, MALFORMED, STREAM_FAILED, TOO_LONG, ModelError


async def streamed_post(client, url, headers, body, on_delta):
    body = {**body, "stream": True, "stream_options": {"include_usage": True}}
    async with client.stream("POST", url, headers=headers, json=body) as response:
        if (
            response.status_code != 200
            or "text/event-stream" not in response.headers.get("content-type", "")
        ):
            await response.aread()
            return response
        parts, usage, finish = [], None, None
        size = 0
        async for line in response.aiter_lines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            if not payload:
                continue
            try:
                value = json.loads(payload)
            except json.JSONDecodeError:
                # The fragment is model output, never credentials.
                logging.getLogger(__name__).warning(
                    "Unparseable stream event: %r", payload[:200]
                )
                raise ModelError("malformed", MALFORMED) from None
            if not isinstance(value, dict):
                logging.getLogger(__name__).warning(
                    "Unexpected stream event: %r", payload[:200]
                )
                raise ModelError("malformed", MALFORMED)
            if value.get("error"):
                raise ModelError("server_error", STREAM_FAILED)
            usage = value.get("usage") or usage
            choices = value.get("choices") or []
            if not choices:
                continue
            choice = choices[0]
            finish = choice.get("finish_reason") or finish
            text = (choice.get("delta") or {}).get("content")
            if isinstance(text, str) and text:
                size += len(text)
                if size > 2_000_000:
                    raise ModelError("too_long", TOO_LONG)
                parts.append(text)
                on_delta(text)
        if finish is None:
            raise ModelError("interrupted", INTERRUPTED)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"finish_reason": finish, "message": {"content": "".join(parts)}}
                ],
                "usage": usage,
            },
        )
