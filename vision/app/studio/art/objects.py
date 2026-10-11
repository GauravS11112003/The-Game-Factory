"""Object art (CONTRACTS_V7 §3.2-3.3): Claude redraws one object from the maker's sketch, then looks at a real render
of its SVG next to the sketch and fixes it, up to 2 review rounds, keeping the best.

    draw_variants(doc, scene, obj, direction, n, rev, client_png, on_status) → (variants, error_key | None)

Each variant takes a different angle (faithful, in-world, bold, alternative) on the same object and guide; variants
run concurrently. Claude draws in friendly units (long side 512) at the box's aspect; the result is re-framed into
viewBox "0 0 w h" where w, h = the drawing's box, so it lines up with the physics shape made from the strokes.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from app.mind import moderate, sanitize
from app.studio.art import brief, render, svg as svgmod
from app.studio.art.calls import ObjectArtFlat, ReviewFlat, call, craft_block, direction_block, error_key, image, text

log = logging.getLogger("dal.v7.art")

LONG_SIDE = 512
REVIEW_ROUNDS = 0  # v7-fast: draw once
NOTE_CHARS = 200
TAKES: tuple[tuple[str, str], ...] = (
    ("faithful", "Stay closest to the maker's drawing: the same silhouette, parts, pose and colour idea, upgraded into "
                 "polished game art in the art direction's style. The maker should instantly see their own drawing."),
    ("in-world", "Make it the art direction's version of this kind (WHAT EACH KIND OF OBJECT BECOMES): fully "
                 "reimagined materials and details for this world, while keeping the drawing's silhouette, "
                 "proportions, pose and footprint."),
    ("bold", "The most striking, characterful take: push its personality and signature features further, richer "
             "materials and lighting, a hero piece worthy of the game's poster, still the same footprint and pose."),
    ("alternative", "A different, equally strong design choice inside the art direction: another arrangement of "
                    "the palette and different material details, same footprint and pose."),
)

Status = Callable[[str], Awaitable[None] | None]


@dataclass
class Candidate:
    svg: str  # sanitized, in model units (view_w x view_h)
    note: str
    parent: int | None = None
    score: float | None = None
    problems: list[str] = field(default_factory=list)
    measure: render.Measure | None = None
    large: bytes | None = None

    @property
    def ok(self) -> bool:
        return self.measure is None or (not self.measure.empty and self.measure.coverage >= 0.02)


@dataclass
class Ctx:
    doc: dict[str, Any]
    scene: dict[str, Any]
    obj: dict[str, Any]
    direction: dict[str, Any]
    w: float
    h: float
    view_w: int
    view_h: int
    units_per_px: float
    brief: str
    sketch_png: bytes | None
    client_png: bytes | None
    overlay_png: bytes | None = None


def make_ctx(doc: dict[str, Any], scene: dict[str, Any], obj: dict[str, Any], direction: dict[str, Any],
             client_png: bytes | None) -> Ctx:
    w, h = render.box_of(obj)
    vw, vh = render.fit_px(w, h, LONG_SIDE)
    sc = float(obj.get("scale", 1) or 1)
    upp = vw / max(w * sc, 1.0)
    ctx = Ctx(doc, scene, obj, direction, w, h, vw, vh, upp, brief.object_brief(doc, scene, obj, vw, vh, upp),
              None, client_png)
    if render.available():
        mine, _ = brief.attachments(scene, obj)
        neigh = [((o.get("drawing") or {}).get("strokes") or [], brief.local_of(obj, o)) for o in mine]
        s, sw, sh = render.sketch_svg(obj, neighbours=neigh)
        ctx.sketch_png = render.png(s, width=render.fit_px(sw, sh, 768)[0])
        red, _, _ = render.sketch_svg(obj, guides=False, red=True)
        ctx.overlay_png = render.png(red, width=render.fit_px(w, h, 640)[0])
    return ctx


def _sketch_blocks(ctx: Ctx) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if ctx.sketch_png:
        out += [text("The maker's drawing (dashed rectangle = the box = your viewBox; faint lines = quarters; grey = "
                     "attached objects drawn separately):"), image(ctx.sketch_png)]
    if ctx.client_png:
        out += [text("The same drawing as the maker sees it in the editor:" if ctx.sketch_png else
                     "The maker's drawing (its box is your viewBox):"), image(ctx.client_png)]
    return out


def _sanitize(s: str, ctx: Ctx, tag: str) -> str | None:
    return svgmod.sanitize(s, view=(ctx.view_w, ctx.view_h), prefix=tag, max_chars=svgmod.SVG_MAX - 600)


def _measure(c: Candidate, ctx: Ctx) -> None:
    if not render.available():
        return
    c.large = render.png(c.svg, width=render.fit_px(ctx.view_w, ctx.view_h, 640)[0])
    c.measure = render.measure(c.large)


def _metrics_text(c: Candidate, ctx: Ctx) -> str:
    m = c.measure
    if m is None:
        return "Measurements: (render unavailable)"
    hull = render.hull_coverage(ctx.obj)
    sides = ("left", "top", "right", "bottom")
    lines = [f"Measurements: the art covers {m.coverage:.0%} of the box (the convex hull of the maker's strokes covers "
             f"{hull:.0%}); empty margins: " + ", ".join(f"{s} {v:.0%}" for s, v in zip(sides, m.margins))
             + "; touches the edges: " + (", ".join(s for s, t in zip(sides, m.touches) if t) or "none")
             + f"; about {m.colours} distinct colour tones."]
    for s, v in zip(sides, m.margins):
        if v > 0.12:
            lines.append(f"Warning: {v:.0%} of the box is empty on the {s}: the physics body reaches there, so the art "
                         f"may look like it floats or is too small (unless the drawing is also empty there).")
    if m.coverage < 0.05:
        lines.append("Warning: the art is almost empty.")
    return "\n".join(lines)


def _game_size_sheet(c: Candidate, ctx: Ctx) -> bytes | None:
    sc = float(ctx.obj.get("scale", 1) or 1)
    long_px = max(32, min(480, round(max(ctx.w, ctx.h) * sc)))
    gw = render.fit_px(ctx.view_w, ctx.view_h, long_px)[0]
    game = render.png(c.svg, width=gw)
    thumb = render.png(c.svg, height=48) if ctx.view_h >= ctx.view_w else render.png(
        c.svg, width=render.fit_px(ctx.view_w, ctx.view_h, 48)[0])
    if not game or not thumb:
        return None
    sky = ((ctx.doc.get("backdrop") or {}).get("sky") or [None])[-1] or (ctx.doc.get("theme") or {}).get(
        "palette", {}).get("bg") or "#dfe6ee"
    return render.side_by_side([(game, sky), (game, "#dfe6ee"), (game, "#232838"), (thumb, "#dfe6ee"),
                                (thumb, "#232838")])


async def _set(on_status: Status | None, s: str) -> None:
    if on_status is None:
        return
    r = on_status(s)
    if asyncio.iscoroutine(r):
        await r


async def _review(c: Candidate, ctx: Ctx) -> ReviewFlat | None:
    content = await asyncio.to_thread(_review_content, c, ctx)
    r = await call("studio_art_review", ReviewFlat, content, attempts=2)
    return r.value if r.ok else None


def _review_content(c: Candidate, ctx: Ctx) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [craft_block(), direction_block(ctx.direction), text(ctx.brief)]
    content += _sketch_blocks(ctx)
    if c.large:
        content += [text("1. LARGE render of the current SVG (checkerboard = transparent):"),
                    image(render.checker(c.large))]
        if ctx.overlay_png:
            content += [text("2. OVERLAY: the render with the maker's strokes on top in thin red:"),
                        image(render.overlay(render.on_colour(c.large, "#ffffff"), ctx.overlay_png))]
    sheet = _game_size_sheet(c, ctx)
    if sheet:
        content += [text("3. GAME SIZE: at its real on-screen size over the game's sky, a light and a dark "
                         "background, then as a 48 px thumbnail on light and dark:"), image(sheet)]
    content.append(text(_metrics_text(c, ctx) + f'\n\nThe current SVG (keep viewBox="0 0 {ctx.view_w} {ctx.view_h}"):'
                        f"\n{c.svg}\n\nReview it and fix it if it is not excellent."))
    return content


def pick(cands: list[Candidate]) -> Candidate | None:
    """The best candidate: a fix replaces what it fixed unless the reviewer scored it lower."""
    best: Candidate | None = None
    for c in cands:
        if not c.ok:
            continue
        if best is None:
            best = c
            continue
        if c.score is not None and best.score is not None and c.score < best.score:
            continue
        best = c
    return best


def effective_score(c: Candidate, cands: list[Candidate]) -> float:
    if c.score is not None:
        return c.score
    if c.parent is not None and cands[c.parent].score is not None:
        return min(9.5, float(cands[c.parent].score or 0) + 0.5)  # an unscored fix of a scored piece
    return 0.0


async def draw_one(ctx: Ctx, take: int, on_status: Status | None = None) -> tuple[Candidate | None, float, str | None]:
    """(the chosen candidate, its score, error key when nothing came out)."""
    name, desc = TAKES[take % len(TAKES)]
    content: list[dict[str, Any]] = [craft_block(), direction_block(ctx.direction), text(ctx.brief)]
    content += _sketch_blocks(ctx)
    content.append(text(f"YOUR TAKE ({name}): {desc}\n\nDraw it now: the note and the complete SVG with "
                        f'viewBox="0 0 {ctx.view_w} {ctx.view_h}".'))
    r = await call("studio_art_object", ObjectArtFlat, content)
    if not r.ok or r.value is None:
        return None, 0.0, error_key(r)
    tag = f"t{take}{secrets.token_hex(2)}_"
    s = _sanitize(r.value.svg, ctx, tag + "0")
    if s is None:
        log.info("art object %s take %s: the SVG did not survive sanitizing", ctx.obj.get("id"), name)
        return None, 0.0, "failed"
    cands = [Candidate(s, _note(r.value.note))]
    await asyncio.to_thread(_measure, cands[0], ctx)
    if render.available():
        await _set(on_status, "reviewing")
        for rnd in range(REVIEW_ROUNDS):
            cur = cands[-1]
            v = await _review(cur, ctx)
            if v is None:
                break
            cur.score = float(max(1, min(10, v.score)))
            cur.problems = [sanitize.text(p, 200) for p in v.problems[:8]]
            if v.verdict == "keep" or not v.svg.strip():
                break
            fixed = _sanitize(v.svg, ctx, f"{tag}{rnd + 1}")
            if fixed is None:
                break
            nc = Candidate(fixed, _note(v.note) or cur.note, parent=len(cands) - 1)
            await asyncio.to_thread(_measure, nc, ctx)
            cands.append(nc)
            if not nc.ok:
                break
    best = pick(cands)
    if best is None:
        return None, 0.0, "failed"
    log.info("art object %s take %s: rounds %d, scores %s, chose #%d", ctx.obj.get("id"), name, len(cands) - 1,
             [c.score for c in cands], cands.index(best))
    return best, effective_score(best, cands), None


def _note(s: Any) -> str:
    t = sanitize.text(s, NOTE_CHARS)
    return "" if not t or moderate.blocklist_hit([t]) else t


def to_variant(c: Candidate, ctx: Ctx, rev: int, k: int) -> dict[str, Any] | None:
    out = svgmod.fit(c.svg, ctx.w, ctx.h, stretch=True)
    if out is None or len(out) > svgmod.SVG_MAX:
        return None
    return {"id": f"v{rev}_{secrets.token_hex(3)}_{k}", "svg": out, "w": round(ctx.w, 2), "h": round(ctx.h, 2),
            "rev": rev, "note": c.note or None}


async def draw_variants(doc: dict[str, Any], scene: dict[str, Any], obj: dict[str, Any], direction: dict[str, Any],
                        n: int, rev: int, client_png: bytes | None = None,
                        on_status: Status | None = None) -> tuple[list[dict[str, Any]], str | None]:
    """Up to `n` variants, best first, or ([], error key)."""
    ctx = await asyncio.to_thread(make_ctx, doc, scene, obj, direction, client_png)
    await _set(on_status, "drawing")
    results = await asyncio.gather(*(draw_one(ctx, k, on_status) for k in range(max(1, min(4, n)))))
    good = sorted(((c, s) for c, s, _ in results if c is not None), key=lambda cs: -cs[1])
    variants = [v for i, (c, _) in enumerate(good) if (v := to_variant(c, ctx, rev, i)) is not None]
    if variants:
        return variants, None
    errs = [e for _, _, e in results if e]
    return [], (errs[0] if errs else "failed")
