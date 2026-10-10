"""Images the model sees (PLAN_V2 §3.10): annotated PERCEIVE tiles, DESIGN drawings and the MODERATE render.

The annotated tile follows the probe-validated style [M A] (docs/v2/diagnosis/model/inputs/*/annotated.jpg):
white paper, the kid's ink in marker colours, a thin magenta box around every component with its id in magenta at
the box's top-left, and magenta cell rulers along the top and left edges (a label every 4 cells, a tick every
cell). Taps (dots) are drawn and labelled like every other component [B F17]. A 2-cell strip of each neighbouring
tile is drawn faded for context, outside a dashed tile boundary.

Lane C's `app.cv.annotate.render_annotated` is preferred when it exists (paper tiles can overlay the rectified
photo); this module is the always-available renderer and the fallback. Pure Pillow, no OpenCV.
"""
from __future__ import annotations

import io
import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable

from PIL import Image, ImageDraw, ImageFont

WORLD_H = 27
MAGENTA = (230, 0, 230)
PAPER = (255, 255, 255)
INK_RGB: dict[str, tuple[int, int, int]] = {
    "black": (25, 25, 25), "red": (225, 50, 50), "green": (40, 150, 60), "blue": (35, 120, 225),
    "pencil": (120, 110, 150), "draft": (110, 160, 230),
}
RULER_PX = 34


@dataclass(frozen=True)
class Tile:
    """A PERCEIVE tile: one paper sheet or one 2-screen canvas span (cells, half-open [x0, x1))."""

    id: str
    x0: float
    x1: float
    sheet: int | None = None


@lru_cache(maxsize=8)
def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size=size)
    except Exception:  # noqa: BLE001 - very old Pillow / no FreeType
        return ImageFont.load_default()


def _blend(rgb: tuple[int, int, int], alpha: float) -> tuple[int, int, int]:
    return tuple(int(round(255 - (255 - c) * alpha)) for c in rgb)  # type: ignore[return-value]


def _stroke_width_px(stroke: dict[str, Any], ppc: float) -> int:
    ws = [float(w) for w in stroke.get("w") or [0.4] if w is not None]
    ws.sort()
    med = ws[len(ws) // 2] if ws else 0.4
    return max(2, int(round(med * ppc)))


def _draw_stroke(d: ImageDraw.ImageDraw, s: dict[str, Any], to_px: Any, ppc: float, alpha: float = 1.0) -> None:
    color = _blend(INK_RGB.get(s.get("color", "black"), INK_RGB["black"]), alpha)
    pts = [to_px(float(p[0]), float(p[1])) for p in s.get("pts") or []]
    if not pts:
        return
    kind = s.get("kind", "line")
    if kind == "dot":
        diam = max(6.0, float((s.get("w") or [0.875])[0]) * ppc)
        x, y = pts[0]
        r = diam / 2
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)
        return
    if kind == "blob" and len(pts) >= 3:
        d.polygon(pts, fill=color, outline=color)
        return
    w = _stroke_width_px(s, ppc)
    if len(pts) == 1:
        x, y = pts[0]
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=color)
        return
    if s.get("closed") and len(pts) >= 3:
        pts = pts + [pts[0]]
    d.line(pts, fill=color, width=w, joint="curve")
    r = w / 2
    for x, y in (pts[0], pts[-1]):  # round caps
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def _in_span(bbox: Iterable[float], x0: float, x1: float) -> bool:
    b = list(bbox)
    return b[2] > x0 and b[0] < x1


def _stroke_bbox(s: dict[str, Any]) -> tuple[float, float, float, float]:
    xs = [float(p[0]) for p in s.get("pts") or []] or [0.0]
    ys = [float(p[1]) for p in s.get("pts") or []] or [0.0]
    pad = max([float(w) for w in s.get("w") or [0.4]] or [0.4]) / 2
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


def _encode(img: Image.Image, fmt: str, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    if fmt == "png":
        img.save(buf, format="PNG", optimize=True)
    else:
        img.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def render_annotated_tile(ink: dict[str, Any], tile: Tile, px_per_cell: int = 24, context_cells: float = 2.0,
                          label_ids: set[int] | None = None) -> bytes:
    """JPEG of one tile: ink, magenta component ids and boxes, cell rulers, faded neighbour context strips.
    `label_ids` limits the boxes to those components (default: every component in the tile)."""
    ppc = float(px_per_cell)
    world_w = float((ink.get("world") or {}).get("w", 48))
    vx0 = max(0.0, tile.x0 - context_cells)
    vx1 = min(world_w, tile.x1 + context_cells)
    width = int(math.ceil((vx1 - vx0) * ppc)) + RULER_PX + 8
    height = int(math.ceil(WORLD_H * ppc)) + RULER_PX + 8
    img = Image.new("RGB", (width, height), PAPER)
    d = ImageDraw.Draw(img)

    def to_px(x: float, y: float) -> tuple[float, float]:
        return RULER_PX + (x - vx0) * ppc, RULER_PX + y * ppc

    comps = ink.get("components") or []
    strokes = ink.get("strokes") or []
    sheet_of_stroke = {s["id"]: s.get("sheet", 0) for s in strokes}
    in_tile_strokes: set[str] = set()
    for c in comps:
        bb = c.get("bbox") or [0, 0, 0, 0]
        cx = (bb[0] + bb[2]) / 2
        if tile.sheet is not None:
            ok = any(sheet_of_stroke.get(sid) == tile.sheet for sid in c.get("stroke_ids") or [])
        else:
            ok = tile.x0 <= cx < tile.x1
        if ok:
            in_tile_strokes.update(c.get("stroke_ids") or [])

    # faded context first, tile ink on top
    for s in strokes:
        bb = _stroke_bbox(s)
        if not _in_span(bb, vx0, vx1):
            continue
        if s["id"] not in in_tile_strokes:
            _draw_stroke(d, s, to_px, ppc, alpha=0.35)
    for s in strokes:
        if s["id"] in in_tile_strokes:
            _draw_stroke(d, s, to_px, ppc)

    # tile boundary (dashed) when there is context
    for bx in (tile.x0, tile.x1):
        if vx0 < bx < vx1:
            x, _ = to_px(bx, 0)
            for y in range(RULER_PX, height - 8, 12):
                d.line([(x, y), (x, min(y + 6, height - 8))], fill=(170, 170, 170), width=1)

    # rulers
    font = _font(max(11, int(ppc * 0.5)))
    d.line([(RULER_PX, RULER_PX), (width - 8, RULER_PX)], fill=MAGENTA, width=1)
    d.line([(RULER_PX, RULER_PX), (RULER_PX, height - 8)], fill=MAGENTA, width=1)
    for cx in range(int(math.ceil(vx0)), int(math.floor(vx1)) + 1):
        x, _ = to_px(cx, 0)
        major = cx % 4 == 0
        d.line([(x, RULER_PX - (9 if major else 4)), (x, RULER_PX)], fill=MAGENTA, width=1)
        if major:
            d.text((x + 2, 4), str(cx), fill=MAGENTA, font=font)
    for cy in range(0, WORLD_H + 1):
        _, y = to_px(vx0, cy)
        major = cy % 4 == 0
        d.line([(RULER_PX - (9 if major else 4), y), (RULER_PX, y)], fill=MAGENTA, width=1)
        if major:
            d.text((3, y + 1), str(cy), fill=MAGENTA, font=font)

    # component boxes and ids
    id_font = _font(max(13, int(ppc * 0.7)))
    for c in comps:
        cid = int(c.get("id", 0))
        if label_ids is not None and cid not in label_ids:
            continue
        if not set(c.get("stroke_ids") or []) & in_tile_strokes:
            continue
        bb = c.get("bbox") or [0, 0, 0, 0]
        x0, y0 = to_px(max(vx0, bb[0]) - 0.15, bb[1] - 0.15)
        x1, y1 = to_px(min(vx1, bb[2]) + 0.15, bb[3] + 0.15)
        d.rectangle([x0, y0, x1, y1], outline=MAGENTA, width=1)
        label = str(cid)
        tw = d.textlength(label, font=id_font)
        ty = max(RULER_PX + 1, y0 - id_font.size - 2) if hasattr(id_font, "size") else max(RULER_PX + 1, y0 - 15)
        d.rectangle([x0, ty, x0 + tw + 3, ty + (getattr(id_font, "size", 13) + 1)], fill=PAPER)
        d.text((x0 + 1, ty), label, fill=MAGENTA, font=id_font)
    return _encode(img, "jpeg")


def render_drawing(ink: dict[str, Any], x0: float, x1: float, px_per_cell: int = 24, fmt: str = "jpeg") -> bytes:
    """The drawing alone (no annotations) for cells [x0, x1): the DESIGN image (≤ 2 screens, ≤ 2576 px)."""
    ppc = float(px_per_cell)
    width = max(1, int(math.ceil((x1 - x0) * ppc)))
    height = int(math.ceil(WORLD_H * ppc))
    img = Image.new("RGB", (width, height), PAPER)
    d = ImageDraw.Draw(img)

    def to_px(x: float, y: float) -> tuple[float, float]:
        return (x - x0) * ppc, y * ppc

    for s in ink.get("strokes") or []:
        if _in_span(_stroke_bbox(s), x0, x1):
            _draw_stroke(d, s, to_px, ppc)
    # faint screen seams so the model can read "screen 2"
    for sx in range(int(math.ceil(x0 / 48.0)) * 48, int(x1), 48):
        if x0 < sx < x1:
            xx, _ = to_px(sx, 0)
            d.line([(xx, 0), (xx, height)], fill=(220, 220, 220), width=1)
    return _encode(img, fmt)


def drawing_images(ink: dict[str, Any], max_long_edge: int = 2576, screens_per_image: int = 2) -> list[bytes]:
    """One image per 2 screens (§3.10 DESIGN input), scaled so the long edge is ≤ 2576 px."""
    world = ink.get("world") or {}
    w = float(world.get("w", 48))
    span = 48.0 * screens_per_image
    ppc = max(8, min(24, int(max_long_edge // span)))
    out = []
    x = 0.0
    while x < w:
        out.append(render_drawing(ink, x, min(w, x + span), ppc))
        x += span
    return out


def moderation_image(ink: dict[str, Any], long_edge: int = 1024) -> bytes:
    """PNG of the whole level drawing with the long edge ≤ 1024 px (MODERATE at publish)."""
    w = float((ink.get("world") or {}).get("w", 48))
    ppc = max(3, int(long_edge // max(w, WORLD_H)))
    return render_drawing(ink, 0, w, ppc, fmt="png")


def resize_photo(data: bytes, long_edge: int = 2576, quality: int = 82) -> bytes:
    """A sheet photo for the DESIGN input: JPEG with the long edge ≤ `long_edge`."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:  # noqa: BLE001
        return data
    img = img.convert("RGB")
    scale = long_edge / max(img.size)
    if scale < 1:
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
    return _encode(img, "jpeg", quality)


def media_type(data: bytes) -> str:
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data[:3] == b"GIF":
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"
