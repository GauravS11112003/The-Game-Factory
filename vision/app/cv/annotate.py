"""Annotated tiles for PERCEIVE (PLAN_V2 §3.10, §6.4). Lane C.

    render_annotated(ink, tile, px_per_cell=24) -> JPEG bytes

The tile is re-drawn **from the InkDoc vectors** (canvas and paper look the same to the model, and every tap is
drawn: dots get at least 8 px, [B F17]). On top of the ink:
- a thin magenta box and a magenta id label per component of this tile, placed where it covers the least ink and no
  other label (with a leader line when it had to move away);
- cell rulers on all four edges (ticks every cell; world x numbers every 4 cells, rows every 3);
- a 2-cell context strip from each neighbouring tile, faded and without ids (a seam-crossing component takes the id
  of the tile that holds most of its ink, so every component is labelled exactly once across tiles);
- on paper sheet 1, the rules box strip under the drawing area, with the child's handwritten rules (not labelled:
  rules-box ink is not part of the level).

Tiles: one per paper sheet (`sheet<n>`), or one per 2 canvas screens (`t<j>`), see `tiles_for`.
`component_rows(ink, tile)` gives the compact component table that goes with the image.

    render_library_strip(types) -> JPEG bytes

The game's library as one image for PERCEIVE (§8.1 "Paper circled letter or written name"): one card per type with
its art in its own inks, its circled letter, its name, what it does and its paper symbol, so the model can tie a
circled "G", a written "Grumpo" or a drawn symbol on the level to the right type.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any, Sequence

import cv2
import numpy as np
from PIL import Image, ImageDraw

from app.cv.features import densify, draw_stroke
from app.spec.ink import InkComponent, InkDoc, InkStroke
from app.template import spec_v2
from app.template.generate_v2 import behavior_words, draw_strokes_fit, font

INK_HEX = {
    "black": "#1A1A1A",
    "red": "#E53935",
    "green": "#43A047",
    "blue": "#1E88E5",
    "pencil": "#6A5ACD",
    "draft": "#7FA9DD",
}
GRID_GRAY = 205
BORDER_GRAY = 190


@dataclass(frozen=True)
class Tile:
    """A horizontal slice of the world that one PERCEIVE call looks at (cells, half-open [x0, x1))."""

    id: str
    x0: float
    x1: float
    sheet: int | None = None  # 0-based paper sheet index for sheet tiles
    context_c: float = 2.0
    include_rules: bool = True


def tiles_for(ink: InkDoc) -> list[Tile]:
    """Paper: one tile per scanned sheet. Canvas, prompt and migrated: one tile per 2 screens."""
    ctx = float(spec_v2.annotate_params().get("context_strip_c", 2))
    W = float(ink.world.w)
    if ink.source == "paper":
        idx = sorted({s.index for s in ink.sheets}) or [0]
        return [Tile(id=f"sheet{i + 1}", x0=48.0 * i, x1=min(W, 48.0 * (i + 1)), sheet=i, context_c=ctx) for i in idx]
    per = max(1, int(spec_v2.annotate_params().get("canvas_tile_screens", 2)))
    n = max(1, math.ceil(ink.world.screens / per))
    span = 48.0 * per
    return [Tile(id=f"t{j}", x0=span * j, x1=min(W, span * (j + 1)), context_c=ctx) for j in range(n)]


# ------------------------------------------------------------------------------------------------------
# which components belong to which tile
# ------------------------------------------------------------------------------------------------------


def _stroke_samples(s: InkStroke) -> tuple[np.ndarray, np.ndarray]:
    """Sample x positions along a stroke with ink-mass weights (length × width)."""
    pts = np.asarray(s.pts, dtype=np.float64).reshape(-1, 2)
    if s.kind == "dot" or len(pts) == 1:
        d = float(s.w[0])
        return pts[:, 0], np.array([max(d * d, 1e-4)])
    dense = densify(pts, 0.25, s.closed or s.kind == "blob")
    w = float(np.median(s.w)) if s.w else 0.5
    return dense[:, 0], np.full(len(dense), max(w, 0.05))


def assign_components(ink: InkDoc, tiles: Sequence[Tile]) -> dict[str, list[int]]:
    """Tile id -> component ids: each component goes to the tile holding most of its ink (ties: the left tile)."""
    by_id = {s.id: s for s in ink.strokes}
    out: dict[str, list[int]] = {t.id: [] for t in tiles}
    if not tiles:
        return out
    for c in ink.components:
        xs_l, ws_l = [], []
        for sid in c.stroke_ids:
            s = by_id.get(sid)
            if s is None:
                continue
            xs, ws = _stroke_samples(s)
            xs_l.append(xs)
            ws_l.append(ws)
        if xs_l:
            xs, ws = np.concatenate(xs_l), np.concatenate(ws_l)
        else:
            xs, ws = np.array([(c.bbox[0] + c.bbox[2]) / 2.0]), np.array([1.0])
        best, best_m = tiles[0].id, -1.0
        for t in tiles:
            m = float(ws[(xs >= t.x0) & (xs < t.x1)].sum())
            if m > best_m:
                best, best_m = t.id, m
        if best_m <= 0:  # entirely outside every tile: the nearest tile by centre
            cx = (c.bbox[0] + c.bbox[2]) / 2.0
            best = min(tiles, key=lambda t: 0.0 if t.x0 <= cx < t.x1 else min(abs(cx - t.x0), abs(cx - t.x1))).id
        out[best].append(c.id)
    return out


def tile_components(ink: InkDoc, tile: Tile, tiles: Sequence[Tile] | None = None) -> list[InkComponent]:
    tiles = list(tiles) if tiles is not None else tiles_for(ink)
    if all(t.id != tile.id for t in tiles):
        tiles.append(tile)
    ids = set(assign_components(ink, tiles).get(tile.id, []))
    return [c for c in ink.components if c.id in ids]


def component_rows(ink: InkDoc, tile: Tile, tiles: Sequence[Tile] | None = None) -> list[dict[str, Any]]:
    """The compact component table for the PERCEIVE prompt (id, colour, bbox, area, features, pins)."""
    by_id = {s.id: s for s in ink.strokes}
    rows: list[dict[str, Any]] = []
    for c in tile_components(ink, tile, tiles):
        strokes = [by_id[s] for s in c.stroke_ids if s in by_id]
        kinds: dict[str, int] = {}
        for s in strokes:
            kinds[s.kind] = kinds.get(s.kind, 0) + 1
        f = c.f.model_dump()
        row: dict[str, Any] = {
            "id": c.id,
            "color": c.color,
            "bbox": [round(v, 2) for v in c.bbox],
            "area": round(c.area, 2),
            "kinds": kinds,
            "f": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in f.items()},
        }
        stamps = sorted({s.stamp for s in strokes if s.stamp})
        labels = sorted({s.label for s in strokes if s.label})
        if stamps:
            row["stamp"] = stamps[0] if len(stamps) == 1 else stamps
        if labels:
            row["label"] = labels[0] if len(labels) == 1 else labels
        rows.append(row)
    return rows


def component_table(rows: Sequence[dict[str, Any]]) -> str:
    """One compact JSON object per line."""
    return "\n".join(json.dumps(r, separators=(",", ":"), ensure_ascii=False) for r in rows)


# ------------------------------------------------------------------------------------------------------
# rendering
# ------------------------------------------------------------------------------------------------------


def _bgr(hex_str: str) -> tuple[int, int, int]:
    return spec_v2.hex_to_bgr(hex_str)


def _blend_white(img: np.ndarray, x0: int, x1: int, y0: int, y1: int, a: float) -> None:
    x0, x1 = max(0, x0), min(img.shape[1], x1)
    y0, y1 = max(0, y0), min(img.shape[0], y1)
    if x1 <= x0 or y1 <= y0:
        return
    region = img[y0:y1, x0:x1].astype(np.float32)
    img[y0:y1, x0:x1] = (region * (1 - a) + 255.0 * a).astype(np.uint8)


def _dashed_v(img: np.ndarray, x: int, y0: int, y1: int, color: tuple[int, int, int], dash: int = 6) -> None:
    y = y0
    while y < y1:
        cv2.line(img, (x, y), (x, min(y1, y + dash)), color, 1, cv2.LINE_AA)
        y += 2 * dash


def _dashed_h(img: np.ndarray, y: int, x0: int, x1: int, color: tuple[int, int, int], dash: int = 6) -> None:
    x = x0
    while x < x1:
        cv2.line(img, (x, y), (min(x1, x + dash), y), color, 1, cv2.LINE_AA)
        x += 2 * dash


def _rect_sum(integral: np.ndarray, x0: int, y0: int, x1: int, y1: int) -> int:
    H, W = integral.shape[0] - 1, integral.shape[1] - 1
    x0, x1 = max(0, min(W, x0)), max(0, min(W, x1))
    y0, y1 = max(0, min(H, y0)), max(0, min(H, y1))
    if x1 <= x0 or y1 <= y0:
        return 0
    return int(integral[y1, x1] - integral[y0, x1] - integral[y1, x0] + integral[y0, x0])


def _overlap(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> int:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return max(0, w) * max(0, h)


def render_annotated(
    ink: InkDoc,
    tile: Tile,
    px_per_cell: int = 24,
    *,
    labels: bool = True,
    tiles: Sequence[Tile] | None = None,
    quality: int | None = None,
) -> bytes:
    """JPEG of one tile: ink from the vectors, magenta component ids, rulers, taps included.

    `labels=False` gives the plain drawing with rulers (the DESIGN call's image).
    """
    ap = spec_v2.annotate_params()
    ppc = float(px_per_cell)
    L, T, R, B = (int(v) for v in ap.get("margin_px", [44, 30, 44, 30]))
    min_dot = float(ap.get("min_dot_px", 8)) * ppc / 24.0
    fade = float(ap.get("context_fade", 0.62))
    q = int(quality or ap.get("jpeg_quality", 85))
    Wc = float(ink.world.w)
    vx0 = max(0.0, tile.x0 - tile.context_c)
    vx1 = min(Wc, tile.x1 + tile.context_c)
    world_h = float(ink.world.h)

    rules_ids = set(ink.rules_ink)
    rules = [s for s in ink.strokes if s.id in rules_ids and (tile.sheet is None or s.sheet == tile.sheet)]
    rules = rules if (tile.include_rules and ink.source == "paper") else []
    content_h = world_h
    if rules:
        _, _, _, ry1 = spec_v2.rules_box_drawing_cells(inset=False)
        content_h = max(world_h, max(ry1, max(p[1] for s in rules for p in s.pts) + 0.4) + 0.3)

    Wpx = L + int(round((vx1 - vx0) * ppc)) + R
    Hpx = T + int(round(content_h * ppc)) + B
    img = np.full((Hpx, Wpx, 3), 255, dtype=np.uint8)
    org = (vx0 - L / ppc, -T / ppc)

    def px(xc: float) -> int:
        return int(round(L + (xc - vx0) * ppc))

    def py(yc: float) -> int:
        return int(round(T + yc * ppc))

    # paper dot grid and the drawing-area border
    xs = np.array([px(c) for c in range(int(math.ceil(vx0)), int(math.floor(vx1)) + 1)], dtype=np.int64)
    ys = np.array([py(r) for r in range(0, int(world_h) + 1)], dtype=np.int64)
    xs, ys = xs[(xs >= 0) & (xs < Wpx)], ys[(ys >= 0) & (ys < Hpx)]
    if xs.size and ys.size:
        img[ys[:, None], xs[None, :]] = GRID_GRAY
    cv2.rectangle(img, (px(vx0), py(0)), (px(vx1) - 1, py(world_h)), (BORDER_GRAY,) * 3, 1)

    # ink: blobs, then lines, then dots on top (taps stay visible)
    order = {"blob": 0, "line": 1, "dot": 2}
    for s in sorted((s for s in ink.strokes if s.id not in rules_ids), key=lambda s: order.get(s.kind, 1)):
        sx = [p[0] for p in s.pts]
        if max(sx) < vx0 - 1 or min(sx) > vx1 + 1:
            continue
        draw_stroke(
            img, s.kind, s.pts, s.w, s.closed, ppc=ppc, origin_cells=org,
            color=_bgr(INK_HEX.get(s.color, "#1A1A1A")), aa=True, min_px=2.0, min_dot_px=min_dot,
        )
    # neighbouring context: faded, bounded by dashed seams
    if tile.x0 > vx0:
        _blend_white(img, px(vx0), px(tile.x0), py(0), py(world_h) + 1, fade)
        _dashed_v(img, px(tile.x0), py(0), py(world_h), (150, 150, 150))
    if tile.x1 < vx1:
        _blend_white(img, px(tile.x1), px(vx1) + 1, py(0), py(world_h) + 1, fade)
        _dashed_v(img, px(tile.x1), py(0), py(world_h), (150, 150, 150))
    # the rules box strip (paper sheet 1)
    if rules:
        _dashed_h(img, py(world_h) + 2, px(vx0), px(vx1), (150, 150, 150))
        for s in rules:
            draw_stroke(
                img, s.kind, s.pts, s.w, s.closed, ppc=ppc, origin_cells=org,
                color=_bgr(INK_HEX.get(s.color, "#1A1A1A")), aa=True, min_px=2.0, min_dot_px=min_dot,
            )

    occ = (img.min(axis=2) < 200).astype(np.uint8)
    integral = cv2.integral(occ)
    pil = Image.fromarray(img[:, :, ::-1].copy())
    draw = ImageDraw.Draw(pil)
    magenta = spec_v2.hex_to_rgb(str(ap.get("id_color", "#FF00FF")))
    ruler_font = font(max(9, int(round(0.46 * ppc))), bold=False)

    if rules:
        draw.text((px(vx0) + 4, py(world_h) + 6), "RULES BOX: the child's handwritten rules (not part of the level)",
                  fill=(120, 120, 120), font=font(max(9, int(round(0.42 * ppc)))))

    # rulers: ticks every cell, world x numbers every 4 cells, rows every 3
    x_every = int(ap.get("x_number_every_c", 4))
    y_every = int(ap.get("y_number_every_c", 3))
    bottom = py(content_h)
    for c in range(int(math.ceil(vx0)), int(math.floor(vx1)) + 1):
        x = px(c)
        long = c % x_every == 0
        tl = 7 if long else 3
        draw.line([(x, T - tl), (x, T - 1)], fill=magenta, width=1)
        draw.line([(x, bottom + 1), (x, bottom + tl)], fill=magenta, width=1)
        if long:
            draw.text((x, T - tl - 1), str(c), fill=magenta, font=ruler_font, anchor="mb")
            draw.text((x, bottom + tl + 1), str(c), fill=magenta, font=ruler_font, anchor="mt")
    xr = px(vx1)
    for r in range(0, int(world_h) + 1):
        y = py(r)
        long = r % y_every == 0
        tl = 7 if long else 3
        draw.line([(L - tl, y), (L - 1, y)], fill=magenta, width=1)
        draw.line([(xr + 1, y), (xr + tl, y)], fill=magenta, width=1)
        if long:
            draw.text((L - tl - 2, y), str(r), fill=magenta, font=ruler_font, anchor="rm")
            draw.text((xr + tl + 2, y), str(r), fill=magenta, font=ruler_font, anchor="lm")

    if labels:
        _draw_labels(draw, ink, tile, tiles, integral, px, py, ppc, magenta, (Wpx, Hpx))

    out = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, q])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return buf.tobytes()


def _draw_labels(
    draw: ImageDraw.ImageDraw,
    ink: InkDoc,
    tile: Tile,
    tiles: Sequence[Tile] | None,
    integral: np.ndarray,
    px: Any,
    py: Any,
    ppc: float,
    magenta: tuple[int, int, int],
    size: tuple[int, int],
) -> None:
    Wpx, Hpx = size
    lf = font(max(10, int(round(0.58 * ppc))), bold=True)
    placed: list[tuple[int, int, int, int]] = []
    comps = sorted(tile_components(ink, tile, tiles), key=lambda c: (c.bbox[2] - c.bbox[0]) * (c.bbox[3] - c.bbox[1]))
    boxes = []
    for c in comps:
        x0, y0, x1, y1 = c.bbox
        bx0, by0, bx1, by1 = px(x0) - 1, py(y0) - 1, px(x1) + 1, py(y1) + 1
        if bx1 - bx0 < 6:
            bx0, bx1 = (bx0 + bx1) // 2 - 3, (bx0 + bx1) // 2 + 3
        if by1 - by0 < 6:
            by0, by1 = (by0 + by1) // 2 - 3, (by0 + by1) // 2 + 3
        boxes.append((c, (bx0, by0, bx1, by1)))
        draw.rectangle([bx0, by0, bx1, by1], outline=magenta, width=1)
    for c, (bx0, by0, bx1, by1) in boxes:
        text = str(c.id)
        tw = int(math.ceil(lf.getlength(text)))
        lw, lh = tw + 6, lf.size + 4
        g = 2
        cands = [
            (bx0, by0 - lh - g), (bx1 - lw, by0 - lh - g), (bx0 - lw - g, by0), (bx1 + g, by0),
            (bx0, by1 + g), (bx1 - lw, by1 + g), (bx0 - lw - g, by1 - lh), (bx1 + g, by1 - lh),
            (bx0 + 1, by0 + 1),
            (bx0, by0 - 2 * lh - 2 * g), (bx0 - lw - g, by0 - lh - g), (bx1 + g, by0 - lh - g),
            (bx0, by1 + lh + 2 * g), (bx0 - 2 * lw, by0), (bx1 + lw, by0),
        ]
        best, best_score = None, None
        for k, (lx, ly) in enumerate(cands):
            r = (int(lx), int(ly), int(lx) + lw, int(ly) + lh)
            out = r[0] < 0 or r[1] < 0 or r[2] > Wpx or r[3] > Hpx
            score = (
                sum(_overlap(r, p) for p in placed) * 1000
                + _rect_sum(integral, *r) * 3
                + (100000 if out else 0)
                + k * 2
            )
            if best_score is None or score < best_score:
                best, best_score = r, score
        assert best is not None
        rx0, ry0, rx1, ry1 = best
        placed.append(best)
        far = rx1 < bx0 - 3 or rx0 > bx1 + 3 or ry1 < by0 - 3 or ry0 > by1 + 3
        if far:
            lx = min(max(bx0, (rx0 + rx1) // 2), bx1)
            ly = min(max(by0, (ry0 + ry1) // 2), by1)
            draw.line([((rx0 + rx1) // 2, (ry0 + ry1) // 2), (lx, ly)], fill=magenta, width=1)
        draw.rectangle([rx0, ry0, rx1, ry1], fill=(255, 255, 255), outline=magenta, width=1)
        draw.text(((rx0 + rx1) / 2, (ry0 + ry1) / 2), text, fill=magenta, font=lf, anchor="mm")


# ------------------------------------------------------------------------------------------------------
# the library strip (PERCEIVE context, §8.1)
# ------------------------------------------------------------------------------------------------------


def _type_dict(t: Any) -> dict[str, Any]:
    if hasattr(t, "model_dump"):
        return t.model_dump(mode="json")
    return dict(t) if isinstance(t, dict) else {}


def render_library_strip(
    types: Sequence[Any], *, cell_px: int = 160, per_row: int = 8, max_types: int = 24, quality: int | None = None
) -> bytes:
    """The game's library types (LibraryType models or their dicts) as one JPEG of cards, newest version of each.
    Empty bytes when there is nothing to show."""
    items = [d for d in (_type_dict(t) for t in types) if d][:max_types]
    if not items:
        return b""
    q = int(quality or spec_v2.annotate_params().get("jpeg_quality", 85))
    cols = max(1, min(per_row, len(items)))
    rows = math.ceil(len(items) / cols)
    head, gap, card_h = 36, 10, cell_px + 58
    Wpx = gap + cols * (cell_px + gap)
    Hpx = head + rows * (card_h + gap) + gap
    arr = np.full((Hpx, Wpx, 3), 255, dtype=np.uint8)
    cells: list[tuple[dict[str, Any], int, int]] = []
    for i, t in enumerate(items):
        cx = gap + (i % cols) * (cell_px + gap)
        cy = head + (i // cols) * (card_h + gap)
        cells.append((t, cx, cy))
        art = (t.get("art") or {}).get("strokes") or []
        draw_strokes_fit(arr, art, (cx + 6, cy + 30, cell_px - 12, cell_px - 34), bgr=False, max_ppc=60.0)
        samples = (t.get("symbol") or {}).get("samples") or []
        if samples:
            draw_strokes_fit(arr, samples[0], (cx + cell_px - 44, cy + 4, 40, 40), bgr=False, pad=3)
    pil = Image.fromarray(arr)
    draw = ImageDraw.Draw(pil)
    hf, lf, nf, wf, sf = font(17, bold=True), font(16, bold=True), font(17, bold=True), font(13), font(10)
    draw.text((gap, 9), "GAME LIBRARY: a circled letter, a written name or a drawn symbol on the level means that type",
              fill=(60, 60, 60), font=hf)
    for t, cx, cy in cells:
        draw.rounded_rectangle([cx, cy, cx + cell_px, cy + card_h], radius=8, outline=(185, 185, 185), width=2)
        r = 13
        lx, ly = cx + 6 + r, cy + 6 + r
        draw.ellipse([lx - r, ly - r, lx + r, ly + r], outline=(30, 30, 30), width=3)
        draw.text((lx, ly), str(t.get("letter") or "?"), fill=(30, 30, 30), font=lf, anchor="mm")
        if t.get("symbol"):
            draw.rectangle([cx + cell_px - 45, cy + 3, cx + cell_px - 3, cy + 45], outline=(205, 205, 205), width=1)
            draw.text((cx + cell_px - 24, cy + 47), "symbol", fill=(140, 140, 140), font=sf, anchor="mt")
        name = str(t.get("name") or "?")
        v = t.get("version")
        draw.text((cx + cell_px / 2, cy + cell_px + 6), name, fill=(20, 20, 20), font=nf, anchor="mt")
        words = behavior_words(t.get("behavior"), bool(t.get("spiky")))
        kind = str(t.get("kind") or "")
        meta = " · ".join(x for x in (kind, words, f"v{v}" if v else "") if x)
        draw.text((cx + cell_px / 2, cy + cell_px + 30), meta, fill=(110, 110, 110), font=wf, anchor="mt")
    out = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, q])
    return buf.tobytes() if ok else b""
