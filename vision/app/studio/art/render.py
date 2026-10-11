"""Server-side pictures for the art pipeline: rasterize SVGs (resvg-py), draw the maker's strokes, measure renders.

    available()                         → resvg can be used (else the look → fix loop is skipped)
    png(svg, width=, height=)           → PNG bytes or None (never raises)
    sketch_svg(obj, ...)                → the maker's strokes as an SVG framed exactly on the object's art box
    scene_svg(doc, scene)               → the whole scene's strokes (layout and mood for directions and backdrops)
    measure(png)                        → coverage, opaque box margins, … of a render
    seam(png, axis)                     → how visible the wrap-around seam of a tile is (0 = invisible)
    on_colour(png, hex), side_by_side   → simple compositing for the review images (Pillow)

Strokes are in object-local pixels with (0, 0) at the drawing's centre and `drawing.w × drawing.h` its box
(web/src/studio/model/doc.ts recentre), so the art box is [-w/2, w/2] × [-h/2, h/2] in local coordinates.
"""
from __future__ import annotations

import io
import logging
import math
from dataclasses import dataclass
from typing import Any, Iterable

log = logging.getLogger("dal.v7.art")

try:  # pragma: no cover - import guard
    import resvg_py as _resvg
except Exception:  # noqa: BLE001
    _resvg = None

MAX_RENDER_PX = 2400


def available() -> bool:
    return _resvg is not None


def png(svg: str, *, width: int | None = None, height: int | None = None,
        background: str | None = None) -> bytes | None:
    """Rasterize. `width` or `height` scales the drawing (aspect kept). None when resvg is missing or fails."""
    if _resvg is None or not svg:
        return None
    kw: dict[str, Any] = {"svg_string": svg, "skip_system_fonts": True}
    if width:
        kw["width"] = max(1, min(MAX_RENDER_PX, int(width)))
    elif height:
        kw["height"] = max(1, min(MAX_RENDER_PX, int(height)))
    if background:
        kw["background"] = background
    try:
        return bytes(_resvg.svg_to_bytes(**kw))
    except Exception as e:  # noqa: BLE001 - a broken drawing is just "no render"
        log.info("resvg failed: %s", str(e)[:200])
        return None


# ---- the maker's strokes ------------------------------------------------------------------------------------------


def _f(x: float) -> str:
    s = f"{x:.1f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _hex(c: Any, default: str = "#1f1b18") -> str:
    s = str(c or "")
    return s if len(s) == 7 and s.startswith("#") else default


def stroke_paths(strokes: Iterable[dict[str, Any]], *, colour: str | None = None, width_scale: float = 1.0,
                 opacity: float = 1.0, fills: bool = True) -> str:
    out = []
    for s in strokes:
        pts = [p for p in s.get("points") or [] if isinstance(p, (list, tuple)) and len(p) >= 2]
        if not pts:
            continue
        w = max(0.5, float(s.get("width") or 6) * width_scale)
        col = colour or _hex(s.get("color"))
        if len(pts) == 1:
            out.append(f'<circle cx="{_f(pts[0][0])}" cy="{_f(pts[0][1])}" r="{_f(w / 2)}" fill="{col}" '
                       f'opacity="{opacity}"/>')
            continue
        d = "M" + " L".join(f"{_f(p[0])} {_f(p[1])}" for p in pts) + (" Z" if s.get("closed") else "")
        fill = _hex(s.get("fill"), "") if fills and s.get("fill") and colour is None else ""
        out.append(f'<path d="{d}" fill="{fill or "none"}" stroke="{col}" stroke-width="{_f(w)}" '
                   f'stroke-linecap="round" stroke-linejoin="round" opacity="{opacity}"/>')
    return "".join(out)


def box_of(obj: dict[str, Any]) -> tuple[float, float]:
    d = obj.get("drawing") or {}
    w, h = float(d.get("w") or 0), float(d.get("h") or 0)
    if (w <= 0 or h <= 0) and d.get("strokes"):
        xs = [float(p[0]) for s in d["strokes"] for p in s.get("points") or []]
        ys = [float(p[1]) for s in d["strokes"] for p in s.get("points") or []]
        if xs:
            w, h = max(xs) - min(xs), max(ys) - min(ys)
    max_sw = max([float(s.get("width") or 6) for s in d.get("strokes") or []] or [6])
    # a dot or a perfectly straight stroke still has the pen's thickness
    return max(w, max_sw, 1.0), max(h, max_sw, 1.0)


def sketch_svg(obj: dict[str, Any], *, neighbours: list[tuple[list[dict[str, Any]], tuple[float, float, float, float]]]
               | None = None, guides: bool = True, red: bool = False, pad_frac: float = 0.08) -> tuple[str, float, float]:
    """The object's strokes in an SVG whose inner frame is exactly its art box. With `guides`, a white sheet with a
    dashed box outline and faint quarter lines (pad around the box so wide pen strokes are not clipped); without, a
    transparent picture of exactly the box (for overlays). `neighbours` are other objects' strokes in this object's
    local frame: (strokes, (dx, dy, rotation, scale)), drawn light grey. Returns (svg, view_w, view_h)."""
    w, h = box_of(obj)
    strokes = (obj.get("drawing") or {}).get("strokes") or []
    pad = max(w, h) * pad_frac if guides else 0.0
    vx, vy, vw, vh = -w / 2 - pad, -h / 2 - pad, w + 2 * pad, h + 2 * pad
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{_f(vx)} {_f(vy)} {_f(vw)} {_f(vh)}" '
             f'width="{_f(vw)}" height="{_f(vh)}">']
    if guides:
        lw = max(vw, vh) / 400
        parts.append(f'<rect x="{_f(vx)}" y="{_f(vy)}" width="{_f(vw)}" height="{_f(vh)}" fill="#ffffff"/>')
        for k in (1, 2, 3):
            gx, gy = -w / 2 + w * k / 4, -h / 2 + h * k / 4
            parts.append(f'<line x1="{_f(gx)}" y1="{_f(-h / 2)}" x2="{_f(gx)}" y2="{_f(h / 2)}" stroke="#e3e7ee" '
                         f'stroke-width="{_f(lw)}"/>')
            parts.append(f'<line x1="{_f(-w / 2)}" y1="{_f(gy)}" x2="{_f(w / 2)}" y2="{_f(gy)}" stroke="#e3e7ee" '
                         f'stroke-width="{_f(lw)}"/>')
        parts.append(f'<rect x="{_f(-w / 2)}" y="{_f(-h / 2)}" width="{_f(w)}" height="{_f(h)}" fill="none" '
                     f'stroke="#9aa5b4" stroke-width="{_f(lw * 1.5)}" stroke-dasharray="{_f(lw * 6)} {_f(lw * 4)}"/>')
    for nstrokes, (dx, dy, rot, sc) in neighbours or []:
        parts.append(f'<g transform="translate({_f(dx)} {_f(dy)}) rotate({_f(rot)}) scale({sc:.4f})">'
                     + stroke_paths(nstrokes, colour="#b9c3cf") + "</g>")
    parts.append(stroke_paths(strokes, colour="#ff2d55" if red else None, width_scale=0.6 if red else 1.0,
                              opacity=0.85 if red else 1.0))
    parts.append("</svg>")
    return "".join(parts), vw, vh


def world_strokes(obj: dict[str, Any]) -> str:
    """One object's strokes placed in world coordinates (x, y, rotation, scale)."""
    strokes = (obj.get("drawing") or {}).get("strokes") or []
    if not strokes:
        return ""
    return (f'<g transform="translate({_f(float(obj.get("x", 0)))} {_f(float(obj.get("y", 0)))}) '
            f'rotate({_f(float(obj.get("rotation", 0)))}) scale({float(obj.get("scale", 1) or 1):.4f})">'
            + stroke_paths(strokes) + "</g>")


def scene_svg(doc: dict[str, Any], scene: dict[str, Any], *, highlight: str | None = None) -> tuple[str, float, float]:
    """Every placed object's strokes on a pale sheet of the world's size (templates and hidden objects too, faint)."""
    world = scene.get("world") or {}
    W, H = float(world.get("width") or 1600), float(world.get("height") or 900)
    objs = scene.get("objects") or []
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_f(W)} {_f(H)}" width="{_f(W)}" '
             f'height="{_f(H)}"><rect width="{_f(W)}" height="{_f(H)}" fill="#fbfaf7"/>']
    for o in sorted(objs, key=lambda o: int(o.get("layer") or 0)):
        g = world_strokes(o)
        if not g:
            continue
        faint = o.get("template") or o.get("hidden")
        if highlight and o.get("id") == highlight:
            parts.append(f'<g opacity="1">{g}</g>')
        else:
            parts.append(f'<g opacity="{0.35 if faint else (0.55 if highlight else 1)}">{g}</g>')
    parts.append("</svg>")
    return "".join(parts), W, H


# ---- measuring renders --------------------------------------------------------------------------------------------


@dataclass
class Measure:
    coverage: float  # share of the canvas with visible (alpha > 25%) pixels
    margins: tuple[float, float, float, float]  # empty share at left, top, right, bottom (0..1); 1s when empty
    touches: tuple[bool, bool, bool, bool]  # opaque pixels on the left / top / right / bottom edge
    colours: int  # distinct colour buckets among visible pixels

    @property
    def empty(self) -> bool:
        return self.coverage < 0.003


def _image(data: bytes):  # noqa: ANN202 - PIL type
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    img.load()
    return img.convert("RGBA")


def measure(data: bytes | None) -> Measure | None:
    if not data:
        return None
    try:
        import numpy as np

        a = np.asarray(_image(data))
    except Exception:  # noqa: BLE001
        return None
    alpha = a[:, :, 3] > 64
    h, w = alpha.shape
    if not alpha.any():
        return Measure(0.0, (1, 1, 1, 1), (False, False, False, False), 0)
    rows, cols = np.where(alpha.any(axis=1))[0], np.where(alpha.any(axis=0))[0]
    margins = (cols[0] / w, rows[0] / h, (w - 1 - cols[-1]) / w, (h - 1 - rows[-1]) / h)
    touches = (bool(alpha[:, 0].any()), bool(alpha[0, :].any()), bool(alpha[:, -1].any()), bool(alpha[-1, :].any()))
    vis = a[alpha][:, :3] // 32
    buckets = len({tuple(x) for x in vis[:: max(1, len(vis) // 4000)].tolist()})
    return Measure(float(alpha.mean()), tuple(round(float(m), 3) for m in margins), touches, buckets)  # type: ignore[arg-type]


def hull_coverage(obj: dict[str, Any]) -> float:
    """Share of the art box covered by the convex hull of the maker's stroke points (the sketch's footprint)."""
    w, h = box_of(obj)
    pts = [(float(p[0]), float(p[1])) for s in (obj.get("drawing") or {}).get("strokes") or []
           for p in s.get("points") or [] if isinstance(p, (list, tuple)) and len(p) >= 2]
    if len(pts) < 3:
        return 0.0
    pts = sorted(set(pts))

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    area = 0.0
    for i in range(len(hull)):
        x0, y0 = hull[i]
        x1, y1 = hull[(i + 1) % len(hull)]
        area += x0 * y1 - x1 * y0
    return min(1.0, abs(area) / 2 / max(w * h, 1.0))


def seam(data: bytes | None, axis: str = "x") -> float | None:
    """How visible the wrap-around seam of a tile is: the colour jump between the last and first pixel column (or
    row), relative to the typical jump between neighbouring columns inside the tile. ≈ 1 is seamless; ≫ 2 shows."""
    if not data:
        return None
    try:
        import numpy as np

        a = np.asarray(_image(data)).astype(np.float32)
    except Exception:  # noqa: BLE001
        return None
    if axis == "y":
        a = a.transpose(1, 0, 2)
    rgb = a[:, :, :3] * (a[:, :, 3:4] / 255.0)
    al = a[:, :, 3:4]
    px = np.concatenate([rgb, al], axis=2)
    if px.shape[1] < 8:
        return None
    edge = float(np.abs(px[:, -1] - px[:, 0]).mean())
    inner = float(np.abs(px[:, 1:] - px[:, :-1]).mean())
    return round((edge + 0.5) / (inner + 0.5), 2)


def on_colour(data: bytes, colour: str, *, pad: int = 0, size: tuple[int, int] | None = None) -> bytes:
    """The render over a solid colour (optionally centred on a canvas of `size`)."""
    from PIL import Image

    img = _image(data)
    W, H = size or (img.width + 2 * pad, img.height + 2 * pad)
    bg = Image.new("RGBA", (W, H), colour)
    bg.alpha_composite(img, ((W - img.width) // 2, (H - img.height) // 2))
    buf = io.BytesIO()
    bg.convert("RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def overlay(base: bytes, top: bytes) -> bytes:
    """`top` alpha-composited over `base` (resized to match)."""
    from PIL import Image

    b, t = _image(base), _image(top)
    if t.size != b.size:
        t = t.resize(b.size, Image.Resampling.LANCZOS)
    b.alpha_composite(t)
    buf = io.BytesIO()
    b.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def side_by_side(images: list[tuple[bytes, str]], *, gap: int = 16, pad: int = 16, colour: str = "#ffffff") -> bytes:
    """Renders placed left to right, each on its own background colour panel, bottoms aligned."""
    from PIL import Image

    imgs = [(_image(d), c) for d, c in images]
    H = max(i.height for i, _ in imgs) + 2 * pad
    W = sum(i.width + 2 * pad for i, _ in imgs) + gap * (len(imgs) - 1)
    out = Image.new("RGBA", (W, H), colour)
    x = 0
    for img, c in imgs:
        panel = Image.new("RGBA", (img.width + 2 * pad, H), c)
        panel.alpha_composite(img, (pad, H - pad - img.height))
        out.alpha_composite(panel, (x, 0))
        x += panel.width + gap
    buf = io.BytesIO()
    out.convert("RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def checker(data: bytes, *, cell: int = 12) -> bytes:
    """The render over a light checkerboard, so transparent areas read as transparent."""
    from PIL import Image, ImageDraw

    img = _image(data)
    bg = Image.new("RGBA", img.size, "#f2f3f6")
    d = ImageDraw.Draw(bg)
    for y in range(0, img.height, cell):
        for x in range((y // cell) % 2 * cell, img.width, cell * 2):
            d.rectangle([x, y, x + cell - 1, y + cell - 1], fill="#e2e5ea")
    bg.alpha_composite(img)
    buf = io.BytesIO()
    bg.convert("RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def fit_px(w: float, h: float, long_side: int) -> tuple[int, int]:
    k = long_side / max(w, h, 1e-6)
    return max(1, round(w * k)), max(1, round(h * k))


def lum(hex_: str) -> float:
    try:
        r, g, b = (int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5))
    except (ValueError, IndexError, TypeError):
        return 0.5
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def angle_deg(dx: float, dy: float) -> float:
    return math.degrees(math.atan2(dy, dx))
