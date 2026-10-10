"""Fake model mode (`DAL_FAKE_LLM=1`, PLAN_V2 §3.12): recorded replies instead of live calls, never a network call.

Lookup, per call kind:
    vision/tests/fixtures/model_replies/<kind>/<key>.json     key = sha256 of the call's text blocks, 12 hex chars
    vision/tests/fixtures/model_replies/<kind>/default.json
(`DAL_FAKE_REPLIES_DIR` overrides the root.) A reply file is either the model-facing output object itself, or an
envelope `{"stop_reason": "end_turn" | "refusal" | "max_tokens", "output": {...}, "latency_s": 2.5}` to replay
refusals, truncations and slow answers.

With no reply file the call returns `skipped` ("fake_no_reply"), which is exactly the model-off path: the
heuristic perception, the keyword parser and the greedy designer carry the build.

`DAL_FAKE_DELAY_S` adds a delay to every fake call (for example 40 to rehearse the 25 s design deadline); a delay
past the call's deadline returns `failed` ("timeout"), as a live timeout would.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from app.config import VISION_DIR

T = TypeVar("T", bound=BaseModel)

DEFAULT_ROOT = VISION_DIR / "tests" / "fixtures" / "model_replies"


def replies_root() -> Path:
    raw = os.environ.get("DAL_FAKE_REPLIES_DIR", "").strip()
    return Path(raw).expanduser() if raw else DEFAULT_ROOT


def content_key(content: list[dict[str, Any]]) -> str:
    texts = [b.get("text", "") for b in content if b.get("type") == "text"]
    return hashlib.sha256("\n".join(texts).encode("utf-8")).hexdigest()[:12]


def find_reply(kind: str, content: list[dict[str, Any]]) -> dict[str, Any] | None:
    root = replies_root() / kind
    for name in (f"{content_key(content)}.json", "default.json"):
        p = root / name
        if p.exists():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(data, dict):
                return data
    return None


def _delay_s() -> float:
    try:
        return max(0.0, float(os.environ.get("DAL_FAKE_DELAY_S", "0") or 0))
    except ValueError:
        return 0.0


async def reply(kind: str, schema: type[T], content: list[dict[str, Any]], *, deadline: float) -> dict[str, Any]:
    """Returns {status, value?, stop_reason, latency_s, error?} for client._finish; never raises."""
    t0 = time.perf_counter()
    data = find_reply(kind, content)
    if data is None:
        return {"status": "skipped", "error": "fake_no_reply"}
    envelope = "output" in data and isinstance(data.get("output"), (dict, type(None)))
    stop = str(data.get("stop_reason", "end_turn")) if envelope else "end_turn"
    out = data.get("output") if envelope else data
    wait = _delay_s() + (float(data.get("latency_s", 0) or 0) if envelope else 0.0)
    left = deadline - time.monotonic()
    if wait > 0:
        await asyncio.sleep(max(0.0, min(wait, left)))
        if wait > left:
            return {"status": "failed", "error": "timeout (fake)", "latency_s": time.perf_counter() - t0}
    if stop == "refusal":
        return {"status": "refused", "stop_reason": "refusal", "latency_s": time.perf_counter() - t0}
    if stop == "max_tokens":
        return {"status": "truncated", "stop_reason": "max_tokens", "latency_s": time.perf_counter() - t0}
    try:
        value = schema.model_validate(out)
    except ValidationError as e:
        return {"status": "failed", "error": f"fake reply does not match {schema.__name__}: {e.error_count()} errors",
                "latency_s": time.perf_counter() - t0}
    return {"status": "ok", "value": value, "stop_reason": "end_turn", "latency_s": time.perf_counter() - t0}
