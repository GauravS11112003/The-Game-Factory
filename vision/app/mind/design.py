"""DESIGN (PLAN_V2 §3.8, §3.10): pick the few strong moves per tier from a menu of pre-verified candidates.

The model sees the drawing (≤ 2 screens per image, ≤ 2576 px long edge) and digests, never raw geometry. It
answers a `DesignPlan` (picks per tier, at most one per alts group, repair choices, vetoes of cosmetic
normalizations, ≤ 3 novel ops into bot slots, asks, a designer note, ≤ 3 critique lines, a title); the sanitizer
turns it into the `DesignPlanJson` the core's `applyPlan` validates pick by pick.

Effort and timeout come from `client.CALLS["design"]` (the P0 bakeoff moved DESIGN to medium / 45 s on the async
suggestions path, docs/v2/latency.md).
"""
from __future__ import annotations

import base64
import time
from dataclasses import dataclass, field
from typing import Any

from app.mind import client, digest, render, sanitize
from app.mind import schemas as ms
from app.mind.client import MindResult
from app.mind.digest import DesignDigest


@dataclass
class DesignCtx:
    draft_id: str | None
    deadline: float  # time.monotonic() instant
    dial: dict[str, Any] = field(default_factory=dict)  # params DIAL
    design: dict[str, Any] = field(default_factory=dict)  # params DESIGN
    note: str = ""  # extra context line, e.g. "speculative: the drawing may still be re-read"


@dataclass
class PlanOut:
    result: MindResult[Any]
    plan: dict[str, Any] | None = None  # DesignPlanJson
    dropped: list[str] = field(default_factory=list)


def image_blocks(images: list[bytes]) -> list[dict[str, Any]]:
    return [{"type": "image", "source": {"type": "base64", "media_type": render.media_type(b),
                                         "data": base64.standard_b64encode(b).decode()}} for b in images]


def design_text(dig: DesignDigest, ctx: DesignCtx) -> str:
    return (
        f"GRAPH DIGEST\n{dig.graph_digest}\n\nLEVEL DIGEST (the faithful build, measured by the bot)\n{dig.level_digest}\n\n"
        f"ALTS GROUPS (pick at most one per group)\n{dig.alts_text()}\n\n"
        f"MENU (cid · summary · tiers · dC · dT · cost · fixes)\n{dig.menu_rows or '(empty)'}\n\n"
        f"NON-REQUIRED COSMETIC NORMALIZATIONS (edit ids you may veto): {digest.cosmetic_text(dig)}\n"
        f"SLOTS for novel ops: {digest.slots_text(dig)}\n"
        f"SETPIECES: {digest.setpiece_text(dig)}\n"
        f"MEASURED: {digest.measured_text(dig, ctx.dial)}\n"
        f"TIER TARGETS: {digest.tier_targets_text(dig, ctx.dial)}\n"
        f"BUDGETS: {digest.budgets_text(dig, ctx.design)}\n"
        + (f"NOTE: {ctx.note}\n" if ctx.note else "")
        + "Return the design plan."
    )


async def design(dig: DesignDigest, images: list[bytes], ctx: DesignCtx) -> PlanOut:
    """§11.3d `design`: never raises."""
    t0 = time.perf_counter()
    try:
        content = image_blocks(images) + [{"type": "text", "text": design_text(dig, ctx)}]
    except Exception as e:  # noqa: BLE001
        return PlanOut(MindResult[ms.DesignPlan](kind="design", status="failed", error=f"content: {e}"[:300],
                                                 latency_s=round(time.perf_counter() - t0, 3)))
    r = await client.call("design", ms.DesignPlan, content, draft_id=ctx.draft_id, deadline=ctx.deadline)
    return _finish(r, dig)


def _finish(r: MindResult[Any], dig: DesignDigest, *, picks_only: bool = False) -> PlanOut:
    out = PlanOut(result=r)
    if not r.ok or r.value is None:
        return out
    try:
        out.plan, out.dropped = sanitize.sanitize_plan(r.value, dig.index, picks_only=picks_only)
    except Exception as e:  # noqa: BLE001
        out.result = r.model_copy(update={"status": "failed", "error": f"sanitize: {type(e).__name__}: {e}"[:300]})
    return out


def refine_text(dig: DesignDigest, prev: dict[str, Any], deltas: str, ctx: DesignCtx) -> str:
    picks = ", ".join(f"{p['cid']} ({digest.TIER_LABEL.get(p['tier'], p['tier'])})" for p in prev.get("picks", [])) or "none"
    return (
        f"PREVIOUS PICKS: {picks}\n{deltas}\n\nMEASURED NOW: {digest.measured_text(dig, ctx.dial)}\n"
        f"TIER TARGETS: {digest.tier_targets_text(dig, ctx.dial)}\n\n"
        f"ALTS GROUPS (pick at most one per group)\n{dig.alts_text()}\n\n"
        f"FRESH MENU (cid · summary · tiers · dC · dT · cost · fixes)\n{dig.menu_rows or '(empty)'}\n\n"
        f"SLOTS for novel ops: {digest.slots_text(dig)}\nSETPIECES: {digest.setpiece_text(dig)}\n"
        f"BUDGETS: {digest.budgets_text(dig, ctx.design)}\n"
        "Return only new picks (and novel ops if useful) for the tiers that missed."
    )


async def refine(dig: DesignDigest, prev: dict[str, Any], deltas: str, ctx: DesignCtx,
                 rejected: set[str] | frozenset[str] = frozenset()) -> PlanOut:
    """§11.3d `refine`: ≤ 1 round, picks and novel ops only; a cid rejected last round is never re-picked.
    Never raises."""
    try:
        content = [{"type": "text", "text": refine_text(dig, prev, deltas, ctx)}]
    except Exception as e:  # noqa: BLE001
        return PlanOut(MindResult[ms.DesignPlan](kind="refine", status="failed", error=f"content: {e}"[:300]))
    r = await client.call("refine", ms.DesignPlan, content, draft_id=ctx.draft_id, deadline=ctx.deadline)
    out = _finish(r, dig, picks_only=True)
    if out.plan is not None and rejected:
        out.plan["picks"] = [p for p in out.plan["picks"] if p["cid"] not in rejected]
    return out


def deltas_text(prev: dict[str, Any], applied: dict[str, Any]) -> str:
    """'applied k03,k07; rejected k11: unsolvable' (§3.8 REFINE input), from an apply_plan result."""
    rejected = {r.get("cid"): r.get("why", "") for r in applied.get("rejected") or [] if r.get("cid")}
    ok = [p["cid"] for p in prev.get("picks", []) if p["cid"] not in rejected]
    lines = [f"applied {', '.join(ok) or 'none'}"]
    lines += [f"rejected {cid}: {why}" for cid, why in rejected.items()]
    return "\n".join(lines)
