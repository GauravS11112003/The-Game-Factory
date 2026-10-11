"""Model calls of the v7 art pipeline: kinds, flat output schemas, shared prompt blocks and a patient call wrapper.

Every call goes through app.mind.client.call (never raises). Art is quality-first (CONTRACTS_V7 §3): claude-opus-5-5
at high effort with generous max_tokens and timeouts, retried on transient failures, and never skipped for cost:
the kinds' budget estimates are registered as -inf so app.mind.budget.allow always lets them through, while the
ledger still records what each call really cost (ART_ESTIMATE_USD keeps the real per-call estimates for reference).
"""
from __future__ import annotations

import asyncio
import base64
import logging
import time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.mind import budget, client
from app.mind.client import CallSpec, MindResult

log = logging.getLogger("dal.v7.art")

ART_CALLS: dict[str, CallSpec] = {
    # v7-fast: speed-first settings (low/medium effort, tighter caps); the review loop is off (REVIEW_ROUNDS = 0)
    "studio_art_direction": CallSpec("low", 8000, 90),
    "studio_art_object": CallSpec("low", 16000, 120),
    "studio_art_review": CallSpec("medium", 24000, 150),
    "studio_art_terrain": CallSpec("low", 16000, 120),
    "studio_art_backdrop": CallSpec("low", 16000, 120),
    "studio_art_backdrop_review": CallSpec("medium", 24000, 150),
}
ART_ESTIMATE_USD = {"studio_art_direction": 0.25, "studio_art_object": 0.9, "studio_art_review": 1.0,
                    "studio_art_terrain": 1.0, "studio_art_backdrop": 1.0, "studio_art_backdrop_review": 1.6}
for _k, _spec in ART_CALLS.items():
    client.CALLS.setdefault(_k, _spec)
    budget.ESTIMATE_USD.setdefault(_k, float("-inf"))  # never blocked by the daily budget (see the module doc)

MAX_PARALLEL_CALLS = 12  # concurrent art calls in this process (API rate limits, not cost)
RETRY_WAITS_S = (4.0, 15.0)


# ---- shared prompt blocks -----------------------------------------------------------------------------------------


def craft_block() -> dict[str, Any]:
    return {"type": "text", "text": client.system_prompt("studio_art_craft"), "cache_control": {"type": "ephemeral"}}


def direction_text(direction: dict[str, Any]) -> str:
    kinds = direction.get("kinds") or {}
    lines = ["# ART DIRECTION (the game's style guide; every piece follows it)",
             f"The maker asked for: {direction.get('prompt') or '(nothing specific: the game itself sets the look)'}",
             f"Summary: {direction.get('summary') or ''}",
             "Palette: " + (", ".join(direction.get("palette") or []) or "(see the guide)"),
             "", str(direction.get("guide") or "").strip(), "", "WHAT EACH KIND OF OBJECT BECOMES IN THIS WORLD:"]
    lines += [f"- {k}: {v}" for k, v in kinds.items()] or ["- (no kinds listed: draw what the drawing shows)"]
    return "\n".join(lines)


def direction_block(direction: dict[str, Any]) -> dict[str, Any]:
    return {"type": "text", "text": direction_text(direction), "cache_control": {"type": "ephemeral"}}


def text(t: str) -> dict[str, Any]:
    return {"type": "text", "text": t}


def image(png: bytes) -> dict[str, Any]:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                        "data": base64.standard_b64encode(png).decode()}}


# ---- model-facing schemas (flat; validated server side) -----------------------------------------------------------


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ThemeLite(_M):
    preset: str = Field(description="a theme preset id when one fits the new look well, else empty")
    name: str
    bg: str
    ink: str
    accent: str
    accent2: str
    text: str
    danger: str
    good: str
    background: Literal["paper", "solid", "gradient", "stars", "grid", "city", "hills", "clouds", "neon_grid",
                        "halftone", "waves", "dunes", "forest", "space"]
    background_colors: list[str]
    stroke: Literal["ink", "marker", "neon", "pixel", "chalk", "comic", "crayon", "watercolor"]
    outline: str = Field(description="#rrggbb outline behind strokes, or empty")
    glow: bool
    particles: Literal["none", "dust", "sparks", "stars", "bubbles", "confetti", "embers", "snow"]
    font: Literal["hand", "comic", "pixel", "clean", "serif"]
    music: Literal["none", "calm", "upbeat", "spooky", "heroic", "chiptune", "racing"]


class KindLook(_M):
    kind: str
    looks: str


class DirectionFlat(_M):
    summary: str
    guide: str
    palette: list[str]
    kinds: list[KindLook]
    theme: ThemeLite


class ObjectArtFlat(_M):
    note: str
    svg: str


class ReviewFlat(_M):
    score: int = Field(description="1-10 for the current render")
    problems: list[str]
    verdict: Literal["keep", "fix"]
    svg: str = Field(description="the full corrected SVG when the verdict is fix, else empty")
    note: str = Field(description="an updated one-line note when the object changed meaningfully, else empty")


class DecorFlat(_M):
    name: str
    w: float
    h: float
    svg: str


class TerrainFlat(_M):
    note: str
    fill: list[str]
    surface: str
    surface_width: float
    surface_svg: str
    texture_svg: str
    decor: list[DecorFlat]
    decor_every: float


class TerrainReviewFlat(_M):
    score: int
    problems: list[str]
    verdict: Literal["keep", "fix"]
    fixed: list[TerrainFlat] = Field(description="exactly one complete corrected skin when the verdict is fix, "
                                                 "else empty")


class LayerFlat(_M):
    note: str
    sky: list[str]
    svg: str


class LayerFix(_M):
    layer: Literal["far", "mid", "near"]
    svg: str


class BackdropReviewFlat(_M):
    score: int
    problems: list[str]
    verdict: Literal["keep", "fix"]
    sky: list[str]
    fixes: list[LayerFix]


# ---- the call wrapper ---------------------------------------------------------------------------------------------

_sem: asyncio.Semaphore | None = None
_sem_loop: asyncio.AbstractEventLoop | None = None


def _semaphore() -> asyncio.Semaphore:
    global _sem, _sem_loop
    loop = asyncio.get_running_loop()
    if _sem is None or _sem_loop is not loop:
        _sem, _sem_loop = asyncio.Semaphore(MAX_PARALLEL_CALLS), loop
    return _sem


def _transient(r: MindResult[Any]) -> bool:
    if r.status != "failed":
        return False
    e = (r.error or "").lower()
    return any(s in e for s in ("timeout", "http 429", "http 500", "http 502", "http 503", "http 504", "http 529",
                                "overloaded", "connection", "no_parse", "deadline before retry"))


async def call(kind: str, schema: type[BaseModel], content: list[dict[str, Any]], *,
               attempts: int = 3) -> MindResult[Any]:
    """One art call, retried on transient failures (and once more, asking for compactness, when truncated)."""
    spec = client.CALLS[kind]
    r: MindResult[Any] = MindResult[schema](kind=kind, status="failed", error="not run")  # type: ignore[valid-type]
    truncated_once = False
    for i in range(attempts):
        body = content
        if truncated_once:
            body = content + [text("Your previous answer ran out of room. Keep the same design but write a more "
                                   "compact SVG: fewer, simpler paths, integer coordinates, <use> for repeats.")]
        async with _semaphore():
            try:
                r = await client.call(kind, schema, body, draft_id=None,
                                      deadline=time.monotonic() + spec.timeout_s + 5)
            except Exception as e:  # noqa: BLE001 - call() never raises; belt and braces
                r = MindResult[schema](kind=kind, status="failed", error=type(e).__name__)  # type: ignore[valid-type]
        if r.ok or r.status in ("refused", "skipped"):
            return r
        if r.status == "truncated" and not truncated_once:
            truncated_once = True
            continue
        if not _transient(r) or i == attempts - 1:
            return r
        log.info("art %s: %s, retrying", kind, r.error)
        await asyncio.sleep(RETRY_WAITS_S[min(i, len(RETRY_WAITS_S) - 1)])
    return r


def error_key(r: MindResult[Any] | None) -> str:
    """timeout | failed | budget | off | blocked: why a call gave nothing."""
    if r is None:
        return "failed"
    if r.status == "skipped":
        return "budget" if r.error == "budget" else "off"
    if r.status == "refused":
        return "blocked"
    if (r.error or "").lower().startswith("timeout"):
        return "timeout"
    return "failed"
