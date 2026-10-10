"""PERCEIVE (PLAN_V2 §3.3, §3.10): what each piece of ink IS and what the child MEANT, one call per paper sheet or
2-screen canvas tile, all tiles in parallel, effort low, thinking omitted (adaptive), 20 s timeout.

The call runs on every build that has at least one unpinned component or any typed rule; a tile whose components
are all pinned by stamps or kid chips (and that no typed rule mentions) is skipped at $0 [J].

Input per tile (§3.10 table):
- the annotated tile JPEG (24 px/cell, magenta component ids, cell rulers, taps included [B F17], a faded 2-cell
  context strip of each neighbouring tile);
- the compact component table (id, colour, bbox, features) of the unpinned components: the model returns one node
  per row and invents none;
- the pinned components ("already known"), so relations may point at them;
- typed rules with their target ids, the library's names and letters, and the parent level's objects (remix).

The answer is the flat-binding `PerceptionFlat` (the API rejected the 10-variant union, docs/v2/latency.md); the
sanitizer turns it into the `PerceptionJson` wire form and drops what does not belong to this tile.
"""
from __future__ import annotations

import base64
import json
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any

from app.mind import client, render, sanitize
from app.mind import schemas as ms
from app.mind.client import MindResult
from app.mind.render import Tile

log = logging.getLogger("dal.v2.mind.perceive")

SCREEN_W = 48
TILE_SCREENS = 2  # canvas: one PERCEIVE call per 2-screen tile
PX_PER_CELL = 24
CONTEXT_CELLS = 2.0


@dataclass
class PerceiveCtx:
    draft_id: str | None
    deadline: float  # time.monotonic() instant
    library: list[dict[str, Any]] = field(default_factory=list)
    parent: dict[str, Any] | None = None  # parent LevelV2 (remix)
    image: bytes | None = None  # a pre-rendered annotated tile (lane C's renderer); rendered here when None
    library_strip: bytes | None = None


@dataclass
class TilePlan:
    tile: Tile
    node_ids: list[int]  # unpinned components the model must label
    pinned: list[dict[str, Any]]  # [{id, role}] already known
    rules: list[dict[str, Any]]  # typed rules relevant to the tile
    c_tile: Any = None  # lane C's annotate.Tile, when lane C planned the tiles
    c_tiles: Any = None  # all of lane C's tiles (seam-crossing components are labelled once)
    rows: list[dict[str, Any]] | None = None  # lane C's component rows for node_ids


def _lane_c() -> tuple[Any, Any]:
    """lane C's annotate module and the InkDoc model, or (None, None) when unavailable."""
    try:
        from app.cv import annotate as ca  # type: ignore[import-not-found]
        from app.spec.ink import InkDoc

        return ca, InkDoc
    except Exception:  # noqa: BLE001
        return None, None


# ---- tiles -------------------------------------------------------------------------------------------


def _component_sheet(c: dict[str, Any], sheet_of: dict[str, int]) -> int:
    sheets = [sheet_of.get(sid, 0) for sid in c.get("stroke_ids") or []]
    return max(set(sheets), key=sheets.count) if sheets else 0


def tiles_for(ink: dict[str, Any]) -> list[Tile]:
    """Paper: one tile per sheet (sheet i spans screen i). Canvas, prompt and migrated: 2-screen spans."""
    world = ink.get("world") or {}
    w = float(world.get("w", SCREEN_W))
    if ink.get("source") == "paper":
        sheets = sorted({int(s.get("sheet", 0)) for s in ink.get("strokes") or []}) or [0]
        return [Tile(id=f"s{i}", x0=i * SCREEN_W, x1=min(w, (i + 1) * SCREEN_W), sheet=i) for i in sheets]
    n = max(1, math.ceil(w / (SCREEN_W * TILE_SCREENS)))
    return [Tile(id=f"t{i}", x0=i * SCREEN_W * TILE_SCREENS, x1=min(w, (i + 1) * SCREEN_W * TILE_SCREENS))
            for i in range(n)]


def _pinned_role(strokes: list[dict[str, Any]]) -> str | None:
    """A component is pinned when every stroke carries a kid chip (label) or a stamp."""
    if not strokes:
        return None
    roles = []
    for s in strokes:
        if s.get("label"):
            roles.append(s["label"])
        elif s.get("stamp"):
            roles.append(f"stamp:{s['stamp']}")
        else:
            return None
    return roles[0]


def _assignment(ink: dict[str, Any]) -> tuple[list[tuple[Tile, list[int], Any]], Any, Any]:
    """[(tile, component ids, lane C tile)], lane C's tiles, lane C's InkDoc. Lane C assigns a seam-crossing
    component to the tile holding most of its ink, so every component is labelled exactly once; without lane C,
    the bbox centre (canvas) or the strokes' majority sheet (paper) decides."""
    ca, InkDoc = _lane_c()
    if ca is not None:
        try:
            doc = InkDoc.model_validate(ink)
            ctiles = ca.tiles_for(doc)
            assign = ca.assign_components(doc, ctiles)
            return ([(Tile(id=t.id, x0=float(t.x0), x1=float(t.x1), sheet=t.sheet), list(assign.get(t.id, [])), t)
                     for t in ctiles], ctiles, doc)
        except Exception as e:  # noqa: BLE001
            log.debug("lane C tiles unavailable (%s); planning tiles here", type(e).__name__)
    strokes = {s["id"]: s for s in ink.get("strokes") or []}
    sheet_of = {sid: int(s.get("sheet", 0)) for sid, s in strokes.items()}
    comps = ink.get("components") or []
    out = []
    for tile in tiles_for(ink):
        ids = []
        for c in comps:
            bb = c.get("bbox") or [0, 0, 0, 0]
            inside = (_component_sheet(c, sheet_of) == tile.sheet) if tile.sheet is not None \
                else tile.x0 <= (bb[0] + bb[2]) / 2 < tile.x1
            if inside:
                ids.append(int(c["id"]))
        out.append((tile, ids, None))
    return out, None, None


def plan_tiles(ink: dict[str, Any]) -> list[TilePlan]:
    """Tiles that need a PERCEIVE call, each with its unpinned ids, pinned context and typed rules."""
    strokes = {s["id"]: s for s in ink.get("strokes") or []}
    comps = {int(c["id"]): c for c in ink.get("components") or []}
    rules = ink.get("typed_rules") or []
    assigned, ctiles, doc = _assignment(ink)
    ca, _ = _lane_c()
    out: list[TilePlan] = []
    for tile, ids, ct in assigned:
        node_ids: list[int] = []
        pinned: list[dict[str, Any]] = []
        for cid in ids:
            c = comps.get(cid)
            if c is None:
                continue
            cs = [strokes[s] for s in c.get("stroke_ids") or [] if s in strokes]
            if cs and all(s.get("origin") == "parent" for s in cs):
                # a remix's inherited ink: the core restores the parent's roles and ids (remixDiff), so the model
                # has nothing to read there; a screen of only parent ink costs no call (C-5 §4)
                continue
            role = _pinned_role(cs)
            if role is None:
                node_ids.append(cid)
            else:
                pinned.append({"id": cid, "role": role})
        tile_rules = [r for r in rules if r.get("target") is None or r.get("target") in ids]
        if not (node_ids or tile_rules):
            continue
        rows = None
        if ct is not None and doc is not None and ca is not None:
            try:
                wanted = set(node_ids)
                rows = [r for r in ca.component_rows(doc, ct, ctiles) if int(r.get("id", -1)) in wanted]
            except Exception:  # noqa: BLE001
                rows = None
        out.append(TilePlan(tile=tile, node_ids=node_ids, pinned=pinned, rules=tile_rules, c_tile=ct, c_tiles=ctiles,
                            rows=rows))
    return out


# ---- content -----------------------------------------------------------------------------------------


def _r(x: Any) -> Any:
    if isinstance(x, float):
        return round(x, 2)
    if isinstance(x, list):
        return [_r(v) for v in x]
    if isinstance(x, dict):
        return {k: _r(v) for k, v in x.items()}
    return x


_FEATURES = ("fill", "circ", "straight", "zigN", "zigAmp", "aspect", "holes", "w", "corners", "spokes", "bumps", "is_dot")


def component_rows(ink: dict[str, Any], ids: list[int]) -> str:
    by_id = {int(c["id"]): c for c in ink.get("components") or []}
    rows = []
    for cid in ids:
        c = by_id.get(cid)
        if c is None:
            continue
        f = c.get("f") or {}
        row = {"id": cid, "color": c.get("color"), "bbox": _r(c.get("bbox")), "area": _r(c.get("area")),
               "f": {k: _r(f[k]) for k in _FEATURES if k in f}}
        rows.append(json.dumps(row, separators=(",", ":")))
    return "\n".join(rows)


def _rows_text(ink: dict[str, Any], plan: TilePlan) -> str:
    if plan.rows:
        return "\n".join(json.dumps(r, separators=(",", ":"), ensure_ascii=False) for r in plan.rows)
    return component_rows(ink, plan.node_ids)


def _parent_summary(parent: dict[str, Any] | None, limit: int = 40) -> str:
    if not parent:
        return "none"
    rows = []
    for o in (parent.get("objects") or [])[:limit]:
        shape = o.get("shape") or {}
        where = ""
        if shape.get("k") == "surface" and shape.get("segs"):
            xs = [p for s in shape["segs"] for p in (s["a"][0], s["b"][0])]
            where = f" x{round(min(xs))}-{round(max(xs))} r{round(shape['segs'][0]['a'][1])}"
        elif shape.get("k") == "body":
            b = shape.get("bbox") or [0, 0, 0, 0]
            where = f" x{round(b[0])}-{round(b[2])} r{round(b[1])}"
        elif shape.get("k") == "point":
            p = shape.get("p") or [0, 0]
            where = f" at {round(p[0])},{round(p[1])}"
        beh = (o.get("behavior") or {}).get("kind")
        rows.append(f"{o.get('id')} {o.get('role')}{where}{' (' + beh + ')' if beh and beh != 'static' else ''}")
    return " | ".join(rows) or "none"


def _library_summary(library: list[dict[str, Any]]) -> str:
    if not library:
        return "empty"
    return "; ".join(f"{t.get('name')} (circled letter {t.get('letter')}, {t.get('kind')})" for t in library[:24])


def build_content(ink: dict[str, Any], plan: TilePlan, ctx: PerceiveCtx, image: bytes) -> list[dict[str, Any]]:
    world = ink.get("world") or {}
    t = plan.tile
    span_screens = max(1, round((t.x1 - t.x0) / SCREEN_W))
    where = (f"paper sheet {t.sheet + 1} (cells x {t.x0:g}-{t.x1:g} of the level)" if t.sheet is not None
             else f"canvas tile x {t.x0:g}-{t.x1:g} ({span_screens} screen{'s' if span_screens > 1 else ''})")
    rules = []
    for r in plan.rules:
        tgt = r.get("target")
        rules.append(f"- \"{sanitize.text(r.get('text', ''), 200)}\"" + (f" (typed with component {tgt} selected)" if tgt is not None else ""))
    pinned = ", ".join(f"{p['id']}: {p['role']}" for p in plan.pinned) or "none"
    text = (
        f"Tile {t.id}: {where}. The whole level is {world.get('screens', 1)} screen(s), {world.get('w', 48)} x 27 cells; "
        f"{ink.get('source', 'canvas')} drawing. Faded ink outside the dashed lines belongs to neighbouring tiles "
        "and is shown for context only.\n\n"
        "COMPONENTS TO LABEL (return exactly one node for each id below; bbox = [x0, y0, x1, y1] in cells):\n"
        f"{_rows_text(ink, plan) or '(none)'}\n\n"
        f"ALREADY KNOWN (pinned by the child's stamps or chips; return no node for these, but relations may point at "
        f"them): {pinned}\n\n"
        f"TYPED RULES:\n{chr(10).join(rules) if rules else 'none'}\n\n"
        f"LIBRARY: {_library_summary(ctx.library)}\n"
        f"PARENT LEVEL (remix; what the original had): {_parent_summary(ctx.parent)}\n\n"
        "Return the perception for this tile."
    )
    content: list[dict[str, Any]] = [{
        "type": "image",
        "source": {"type": "base64", "media_type": render.media_type(image), "data": base64.standard_b64encode(image).decode()},
    }]
    if ctx.library_strip:
        content.append({"type": "image", "source": {"type": "base64", "media_type": render.media_type(ctx.library_strip),
                                                    "data": base64.standard_b64encode(ctx.library_strip).decode()}})
    content.append({"type": "text", "text": text})
    return content


def annotated_image(ink: dict[str, Any], plan: TilePlan) -> bytes:
    """Lane C's renderer when it planned the tile (rules-box strip on paper, label placement that avoids ink),
    else ours. Never raises."""
    ca, InkDoc = _lane_c()
    if ca is not None and plan.c_tile is not None:
        try:
            img = ca.render_annotated(InkDoc.model_validate(ink), plan.c_tile, PX_PER_CELL, tiles=plan.c_tiles)
            if isinstance(img, (bytes, bytearray)) and img:
                return bytes(img)
        except Exception as e:  # noqa: BLE001
            log.info("lane C render_annotated failed (%s); using app.mind.render", type(e).__name__)
    return render.render_annotated_tile(ink, plan.tile, PX_PER_CELL, CONTEXT_CELLS,
                                        label_ids={c for c in plan.node_ids} | {p["id"] for p in plan.pinned})


# ---- the call ----------------------------------------------------------------------------------------


@dataclass
class PerceiveOut:
    """One tile's outcome: the MindResult (status, cost, latency) plus the sanitizer's verdict."""

    result: MindResult[Any]
    tile: str
    value: dict[str, Any] | None = None  # PerceptionJson
    dropped: list[str] = field(default_factory=list)
    discarded: bool = False
    image: bytes | None = None


async def perceive(ink: dict[str, Any], tile: TilePlan, ctx: PerceiveCtx) -> PerceiveOut:
    """§11.3d `perceive`: never raises."""
    t0 = time.perf_counter()
    try:
        image = ctx.image or annotated_image(ink, tile)
        content = build_content(ink, tile, ctx, image)
    except Exception as e:  # noqa: BLE001
        r = MindResult[ms.PerceptionFlat](kind="perceive", status="failed", error=f"content: {type(e).__name__}: {e}"[:300],
                                          latency_s=round(time.perf_counter() - t0, 3))
        return PerceiveOut(result=r, tile=tile.tile.id)
    r = await client.call("perceive", ms.PerceptionFlat, content, draft_id=ctx.draft_id, deadline=ctx.deadline)
    out = PerceiveOut(result=r, tile=tile.tile.id, image=image)
    if not r.ok or r.value is None:
        return out
    known = [int(c["id"]) for c in ink.get("components") or []]
    try:
        s = sanitize.sanitize_perception(r.value, tile.tile.id, tile.node_ids, known)
    except Exception as e:  # noqa: BLE001
        out.result = r.model_copy(update={"status": "failed", "error": f"sanitize: {type(e).__name__}: {e}"[:300]})
        return out
    out.value, out.dropped, out.discarded = s.value, s.dropped, s.discarded
    if s.discarded:
        log.info("perceive %s discarded: %.0f%% invalid nodes", tile.tile.id, s.invalid_frac * 100)
    return out
