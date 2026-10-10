"""The only module that talks to Anthropic (PLAN_V2 §3.10, D17).

Probe-validated call shape: `beta.messages.parse` on `claude-opus-5`, thinking omitted (adaptive is the Opus 5
default), `output_config={"effort": ...}`, server-side refusal fallbacks (`fallbacks="default"` with beta
`server-side-fallback-2026-07-01`), `max_retries=0` plus one retry on 529, and `stop_reason` checked before
`parsed_output`. `call()` never raises: every outcome is a MindResult. The key comes from the environment only and
is never logged or returned.

The async client is used directly: `AsyncAnthropic().beta.messages.parse` exists in anthropic 1.13.0 (checked
in the P0 bakeoff, docs/v2/latency.md), so no worker thread is needed.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Generic, Literal, TypeVar

import anthropic
import pydantic
from pydantic import BaseModel

from app.mind import budget, fake, ledger

log = logging.getLogger("dal.v2.mind")

MODEL = "claude-opus-5"
PRICE_IN, PRICE_OUT = 5.0, 25.0  # $/MTok; thinking bills as output
PRICE_CACHE_WRITE, PRICE_CACHE_READ = 6.25, 0.5
FAST_MULTIPLIER = 2.0
MIN_CALL_S = 3.0  # params.ts MODEL.min_call_s: a call with less time left than this is skipped
RETRY_529_MIN_LEFT_S = 8.0  # params.ts MODEL.retry_529_min_left_s
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FAST_BETA = "fast-mode-2026-02-01"
PROMPTS = Path(__file__).resolve().parent / "prompts"

CallKind = Literal["perceive", "design", "refine", "critic", "plan", "creature", "moderate", "look", "handwriting"]
Thinking = Literal["adaptive", "disabled"] | None
Status = Literal["ok", "failed", "refused", "truncated", "skipped"]
T = TypeVar("T", bound=BaseModel)


@dataclass(frozen=True)
class CallSpec:
    effort: Literal["low", "medium", "high"]
    max_tokens: int  # caps thinking + output together; ≈ 5× the measured output
    timeout_s: float
    thinking: Thinking = None  # None: omit the parameter (adaptive on Opus 5)


# §3.10 table, with the P0 bakeoff decisions (docs/v2/latency.md):
# - thinking stays omitted everywhere: `disabled` cut PERCEIVE p50 by only 11% (rule: adopt at ≥ 30%);
# - DESIGN at low missed the 10 s p50 rule (14.9 s), so DESIGN runs at medium on the async suggestions path only and
#   the greedy tiers are the synchronous Designed result (DESIGN_SYNCHRONOUS = False). REFINE and CRITIC already
#   deliver suggestions.
DESIGN_SYNCHRONOUS = False
CALLS: dict[str, CallSpec] = {
    "perceive": CallSpec("low", 6000, 20),
    "design": CallSpec("medium", 8000, 45),
    "refine": CallSpec("low", 4000, 10),
    "critic": CallSpec("low", 4000, 20),
    "plan": CallSpec("low", 6000, 20),
    "creature": CallSpec("low", 2000, 10),
    "moderate": CallSpec("low", 1500, 10),
    "handwriting": CallSpec("low", 1500, 10),  # sheet name / story lines (§8.1, §8.2); not tied to a draft
    "look": CallSpec("medium", 6000, 60),  # eval only, never a runtime gate
}


class MindResult(BaseModel, Generic[T]):
    kind: str
    status: Status
    value: T | None = None
    latency_s: float = 0.0
    cost_usd: float = 0.0
    fallback_used: bool = False
    stop_reason: str | None = None
    error: str | None = None
    in_tok: int = 0
    out_tok: int = 0
    cache_read_tok: int = 0
    served_by: str | None = None
    request_id: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"


@lru_cache(maxsize=None)
def system_prompt(kind: str) -> str:
    return (PROMPTS / f"{kind}.md").read_text(encoding="utf-8")


_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic()  # key from env only
    return _client


def has_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def mode() -> Literal["live", "fake", "off"]:
    """fake = DAL_FAKE_LLM=1 (recorded replies, app.mind.fake), live = a key is set, off = no key (model-off path)."""
    if os.environ.get("DAL_FAKE_LLM", "").strip().lower() in {"1", "true", "yes", "on"}:
        return "fake"
    return "live" if has_key() else "off"


def available() -> bool:
    """Whether a model call can run at all (budget aside)."""
    return mode() != "off"


def cost_of(usage: Any, fast: bool = False) -> float:
    def n(attr: str) -> int:
        return int(getattr(usage, attr, 0) or 0)

    usd = (n("input_tokens") * PRICE_IN + n("cache_creation_input_tokens") * PRICE_CACHE_WRITE
           + n("cache_read_input_tokens") * PRICE_CACHE_READ + n("output_tokens") * PRICE_OUT) / 1e6
    return usd * (FAST_MULTIPLIER if fast else 1.0)


_UNSET: Any = object()


async def call(
    kind: str,
    schema: type[T],
    content: list[dict[str, Any]],
    *,
    draft_id: str | None,
    deadline: float,
    thinking: Thinking = _UNSET,
    effort: str | None = None,
    fast: bool | None = None,
    timeout_s: float | None = None,
) -> MindResult[T]:
    """One structured call. `deadline` is a time.monotonic() instant. Overrides exist for the P0 bakeoff."""
    spec = CALLS[kind]
    think = spec.thinking if thinking is _UNSET else thinking
    eff = effort or spec.effort
    use_fast = bool(fast) if fast is not None else os.environ.get("DAL_FAST_MODE") == "1"
    m = mode()
    if m == "off":
        return MindResult[schema](kind=kind, status="skipped", error="no_key")  # type: ignore[valid-type]
    timeout = min(timeout_s or spec.timeout_s, deadline - time.monotonic())
    if timeout < MIN_CALL_S:
        return MindResult[schema](kind=kind, status="skipped", error="deadline")  # type: ignore[valid-type]
    if m == "fake":
        return await _fake_call(kind, schema, content, draft_id=draft_id, effort=eff,
                                deadline=time.monotonic() + timeout)
    if not budget.allow(kind, draft_id):
        return MindResult[schema](kind=kind, status="skipped", error="budget")  # type: ignore[valid-type]

    kwargs: dict[str, Any] = dict(
        model=MODEL,
        max_tokens=spec.max_tokens,
        system=[{"type": "text", "text": system_prompt(kind), "cache_control": {"type": "ephemeral"}}],
        output_config={"effort": eff},
        betas=[FALLBACK_BETA] + ([FAST_BETA] if use_fast else []),
        fallbacks="default",
        messages=[{"role": "user", "content": content}],
        output_format=schema,
    )
    if think is not None:
        kwargs["thinking"] = {"type": think}
    if use_fast:
        kwargs["speed"] = "fast"

    call_deadline = time.monotonic() + timeout
    t0 = time.perf_counter()
    resp: Any = None
    for attempt in (1, 2):
        left = call_deadline - time.monotonic()
        if left < 1:
            return _finish(kind, schema, draft_id, eff, t0, status="failed", error="deadline before retry")
        c = _get_client().with_options(timeout=left, max_retries=0)
        try:
            # the SDK timeout is the real limit; wait_for is a backstop so a stuck socket can never hold a build
            resp = await asyncio.wait_for(c.beta.messages.parse(**kwargs), left + 2)
            break
        except asyncio.TimeoutError:
            return _finish(kind, schema, draft_id, eff, t0, status="failed", error=f"timeout after {left:.1f} s")
        except anthropic.APIStatusError as e:
            if e.status_code == 529 and attempt == 1 and call_deadline - time.monotonic() > RETRY_529_MIN_LEFT_S:
                continue
            return _finish(kind, schema, draft_id, eff, t0, status="failed", error=f"http {e.status_code}: {e.message}"[:300])
        except (anthropic.APIConnectionError, pydantic.ValidationError, ValueError) as e:  # timeout ⊂ connection error
            return _finish(kind, schema, draft_id, eff, t0, status="failed", error=f"{type(e).__name__}: {e}"[:300])
        except Exception as e:  # noqa: BLE001 - MindResult never raises
            return _finish(kind, schema, draft_id, eff, t0, status="failed", error=f"{type(e).__name__}: {e}"[:300])
    if resp.stop_reason == "refusal":  # checked BEFORE parsed_output
        return _finish(kind, schema, draft_id, eff, t0, status="refused", resp=resp, fast=use_fast)
    if resp.stop_reason == "max_tokens":  # never partially applied
        return _finish(kind, schema, draft_id, eff, t0, status="truncated", resp=resp, fast=use_fast)
    if resp.parsed_output is None:
        return _finish(kind, schema, draft_id, eff, t0, status="failed", resp=resp, fast=use_fast, error="no_parse")
    return _finish(kind, schema, draft_id, eff, t0, status="ok", resp=resp, fast=use_fast, value=resp.parsed_output)


async def _fake_call(
    kind: str, schema: type[T], content: list[dict[str, Any]], *, draft_id: str | None, effort: str, deadline: float,
) -> MindResult[T]:
    t0 = time.perf_counter()
    try:
        r = await fake.reply(kind, schema, content, deadline=deadline)
    except Exception as e:  # noqa: BLE001 - MindResult never raises
        r = {"status": "failed", "error": f"{type(e).__name__}: {e}"[:300]}
    if r["status"] == "skipped":
        return MindResult[schema](kind=kind, status="skipped", error=r.get("error"))  # type: ignore[valid-type]
    latency = float(r.get("latency_s", time.perf_counter() - t0))
    res: MindResult[T] = MindResult[schema](  # type: ignore[valid-type]
        kind=kind, status=r["status"], value=r.get("value"), latency_s=round(latency, 3), stop_reason=r.get("stop_reason"),
        error=r.get("error"), served_by="fake",
    )
    ledger.record(ledger.CallRecord(
        kind=kind, draft_id=draft_id, effort=effort, latency_ms=int(latency * 1000), stop_reason=res.stop_reason,
        served_by="fake", ok=res.status == "ok",
    ))
    return res


def call_meta(r: MindResult[Any], effort: str | None = None) -> dict[str, Any]:
    """The `meta.build.model_calls[]` entry (ModelCallMeta) for one finished call."""
    return {
        "kind": r.kind, "effort": effort or CALLS[r.kind].effort, "latency_ms": int(r.latency_s * 1000),
        "in_tok": r.in_tok, "out_tok": r.out_tok, "cost_usd": r.cost_usd, "stop_reason": r.stop_reason,
        "fallback_used": r.fallback_used, "served_by": r.served_by, "cache_read_tok": r.cache_read_tok,
    }


def _finish(
    kind: str, schema: type[T], draft_id: str | None, effort: str, t0: float, *, status: Status, resp: Any = None,
    fast: bool = False, value: Any = None, error: str | None = None,
) -> MindResult[T]:
    latency = time.perf_counter() - t0
    usage = getattr(resp, "usage", None)
    iterations = getattr(usage, "iterations", None) or []
    fallback = any(getattr(i, "type", None) == "fallback_message" for i in iterations)
    r: MindResult[T] = MindResult[schema](  # type: ignore[valid-type]
        kind=kind, status=status, value=value, latency_s=round(latency, 3),
        cost_usd=round(cost_of(usage, fast), 5) if usage is not None else 0.0, fallback_used=fallback,
        stop_reason=getattr(resp, "stop_reason", None), error=error,
        in_tok=int(getattr(usage, "input_tokens", 0) or 0) + int(getattr(usage, "cache_creation_input_tokens", 0) or 0),
        out_tok=int(getattr(usage, "output_tokens", 0) or 0),
        cache_read_tok=int(getattr(usage, "cache_read_input_tokens", 0) or 0),
        served_by=getattr(resp, "model", None), request_id=getattr(resp, "_request_id", None),
    )
    ledger.record(ledger.CallRecord(
        kind=kind, draft_id=draft_id, effort=effort, latency_ms=int(latency * 1000), in_tok=r.in_tok, out_tok=r.out_tok,
        cache_read_tok=r.cache_read_tok, cost_usd=r.cost_usd, stop_reason=r.stop_reason, served_by=r.served_by,
        fallback_used=fallback, ok=status == "ok", request_id=r.request_id,
    ))
    if status != "ok":
        log.info("mind %s %s: %s", kind, status, error or r.stop_reason)
    return r
