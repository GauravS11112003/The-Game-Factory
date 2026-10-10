"""The claude-svg provider: Claude redraws the kid's object as a clean, flat-colour, side-view sprite SVG whose viewBox
matches the drawing's aspect (so the renderer can lay it exactly over the strokes), and paints wide SVG backdrops.

    sprite(crop, hint, style_text, aspect)   → Outcome(svg, label, cost_usd, error_key)
    backdrop(theme, style_text, screens)     → Outcome
    sanitize_svg(text)                       → a safe SVG string or None

The sanitizer is an allow-list rebuild, never a blacklist pass: the model's SVG is parsed (DOCTYPE/ENTITY rejected
before parsing), and a NEW tree is built from allowed elements and attributes only. Scripts, style elements and
attributes, foreignObject, image, a, text, animation, event handlers (on*), external or data: URLs, and any href that
is not a local "#id" are dropped. The output gets explicit width/height from its viewBox (image loaders need a size).
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any

from app.mind import art_prompt, sanitize
from app.mind.client import MindResult

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
SPRITE_LONG_SIDE = 256
BACKDROP_SCREEN = (1600, 900)  # one 16:9 screen in backdrop SVG units
MAX_INPUT_CHARS = 300_000
MAX_ELEMENTS = 600

ALLOWED_TAGS = {
    "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient",
    "radialGradient", "stop", "clipPath", "use", "title", "desc",
}
GEOMETRY = {"d", "x", "y", "width", "height", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2", "points",
            "transform", "fx", "fy", "offset", "gradientUnits", "gradientTransform", "spreadMethod", "clipPathUnits"}
PAINT = {"fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
         "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule", "stop-color", "stop-opacity",
         "clip-path", "id", "viewBox", "preserveAspectRatio", "vector-effect"}
ALLOWED_ATTRS = GEOMETRY | PAINT | {"href"}
STYLE_PROPS = PAINT - {"id", "viewBox", "preserveAspectRatio", "clip-path"}
LONG_ATTRS = {"d", "points"}
_BAD_VALUE = re.compile(r"javascript:|vbscript:|data:|expression\s*\(|@import|<|>", re.I)
_URL_REF = re.compile(r"url\(\s*([^)]*)\)", re.I)
_LOCAL_URL = re.compile(r"^['\"]?#[A-Za-z_][\w.-]*['\"]?$")
_ID = re.compile(r"^[A-Za-z_][\w.-]{0,63}$")
_NUM = re.compile(r"-?\d+(?:\.\d+)?")


@dataclass
class Outcome:
    svg: str | None
    label: str
    cost_usd: float
    error_key: str | None
    result: MindResult[Any] | None = None


def viewbox_for(aspect: float | None) -> tuple[int, int]:
    a = aspect if aspect and aspect > 0 else 1.0
    a = max(0.2, min(5.0, a))
    if a >= 1:
        return SPRITE_LONG_SIDE, max(32, round(SPRITE_LONG_SIDE / a))
    return max(32, round(SPRITE_LONG_SIDE * a)), SPRITE_LONG_SIDE


def _local(name: str) -> tuple[str | None, str]:
    if name.startswith("{"):
        ns, _, local = name[1:].partition("}")
        return ns, local
    return None, name


def _clean_value(name: str, value: str) -> str | None:
    v = (value or "").strip()
    limit = 40_000 if name in LONG_ATTRS else 300
    if not v or len(v) > limit:
        return None
    if name == "href":
        return v if _ID.match(v[1:]) and v.startswith("#") else None
    if name == "id":
        return v if _ID.match(v) else None
    if _BAD_VALUE.search(v):
        return None
    for m in _URL_REF.finditer(v):
        if not _LOCAL_URL.match(m.group(1).strip()):
            return None
    return v


def _copy(src: ET.Element, dst_parent: ET.Element | None, budget: list[int]) -> ET.Element | None:
    ns, tag = _local(src.tag)
    if ns not in (None, SVG_NS) or tag not in ALLOWED_TAGS or budget[0] <= 0:
        return None
    budget[0] -= 1
    el = ET.Element(f"{{{SVG_NS}}}{tag}") if dst_parent is None else ET.SubElement(dst_parent, f"{{{SVG_NS}}}{tag}")
    for k, v in src.attrib.items():
        ans, an = _local(k)
        if ans == XLINK_NS and an == "href":
            an, ans = "href", None
        if ans is not None or an.lower().startswith("on") or an not in ALLOWED_ATTRS:
            continue
        cv = _clean_value(an, v)
        if cv is not None:
            el.set(an, cv)
    # an inline style="fill:#f00;stroke-width:3" becomes presentation attributes (the style attribute itself never
    # survives); attributes already set win
    for decl in (src.attrib.get("style") or "").split(";")[:30]:
        prop, _, val = decl.partition(":")
        prop = prop.strip().lower()
        if prop in STYLE_PROPS and prop not in el.attrib:
            cv = _clean_value(prop, val)
            if cv is not None:
                el.set(prop, cv)
    if tag in ("title", "desc") and src.text:
        el.text = src.text[:200]
    for child in list(src):
        _copy(child, el, budget)
    return el


def _viewbox(root: ET.Element) -> tuple[float, float, float, float] | None:
    vb = root.get("viewBox")
    nums = [float(x) for x in _NUM.findall(vb or "")]
    if len(nums) == 4 and nums[2] > 0 and nums[3] > 0:
        return nums[0], nums[1], nums[2], nums[3]
    w = [float(x) for x in _NUM.findall(root.get("width") or "")]
    h = [float(x) for x in _NUM.findall(root.get("height") or "")]
    if w and h and w[0] > 0 and h[0] > 0:
        return 0.0, 0.0, w[0], h[0]
    return None


def _fmt(x: float) -> str:
    return f"{x:.2f}".rstrip("0").rstrip(".")


def sanitize_svg(text: str, *, view: tuple[int, int] | None = None) -> str | None:
    """A safe, standalone SVG built from the allow-list, or None when nothing usable remains."""
    if not isinstance(text, str) or not text or len(text) > MAX_INPUT_CHARS:
        return None
    s = text.strip()
    s = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", s)
    start, end = s.find("<svg"), s.rfind("</svg>")
    if start < 0 or end < 0:
        return None
    s = s[start:end + len("</svg>")]
    low = s.lower()
    if "<!doctype" in low or "<!entity" in low or "<?xml-stylesheet" in low:
        return None
    head = s[: s.find(">") + 1]
    if "xmlns=" not in head:
        s = s.replace("<svg", f'<svg xmlns="{SVG_NS}"', 1)
    if "xlink:" in s and "xmlns:xlink" not in head:
        s = s.replace("<svg", f'<svg xmlns:xlink="{XLINK_NS}"', 1)
    try:
        src = ET.fromstring(s)
    except ET.ParseError:
        return None
    if _local(src.tag)[1] != "svg":
        return None
    root = _copy(src, None, [MAX_ELEMENTS])
    if root is None:
        return None
    vb = _viewbox(src)
    if vb is None:
        if view is None:
            return None
        vb = (0.0, 0.0, float(view[0]), float(view[1]))
    for k in ("width", "height", "x", "y"):
        root.attrib.pop(k, None)
    root.set("viewBox", " ".join(_fmt(v) for v in vb))
    root.set("width", _fmt(vb[2]))
    root.set("height", _fmt(vb[3]))
    drawable = {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "use"}
    if not any(_local(e.tag)[1] in drawable for e in root.iter()):
        return None
    ET.register_namespace("", SVG_NS)
    return ET.tostring(root, encoding="unicode")


def _error_key(r: MindResult[Any] | None) -> str:
    if r is None:
        return "creative.failed"
    if r.status == "skipped":
        return "creative.budget" if r.error == "budget" else "creative.off"
    if r.status == "refused":
        return "creative.blocked"
    if r.status == "failed" and (r.error or "").startswith("timeout"):
        return "creative.timeout"
    return "creative.failed"


async def sprite(crop_png: bytes, *, hint: str | None, style_text: str | None, aspect: float | None,
                 colors: list[str] | None = None, variation: str | None = None) -> Outcome:
    view = viewbox_for(aspect)
    r = await art_prompt.art_svg(crop_png, hint=hint, style_text=style_text, view_w=view[0], view_h=view[1],
                                 colors=colors, variation=variation)
    cost = float(r.cost_usd or 0.0)
    if not r.ok or r.value is None:
        return Outcome(None, "", cost, _error_key(r), r)
    svg = sanitize_svg(r.value.svg, view=view)
    label = sanitize.text(r.value.label, art_prompt.LABEL_CHARS)
    if svg is None:
        return Outcome(None, label, cost, "creative.failed", r)
    return Outcome(svg, label, cost, None, r)


async def backdrop(*, theme: str | None, style_text: str | None, screens: int) -> Outcome:
    n = max(1, min(6, int(screens or 1)))
    view = (BACKDROP_SCREEN[0] * n, BACKDROP_SCREEN[1])
    r = await art_prompt.art_backdrop(theme=theme, style_text=style_text, view_w=view[0], view_h=view[1], screens=n)
    cost = float(r.cost_usd or 0.0)
    if not r.ok or r.value is None:
        return Outcome(None, "", cost, _error_key(r), r)
    svg = sanitize_svg(r.value.svg, view=view)
    label = sanitize.text(r.value.label, art_prompt.LABEL_CHARS)
    return Outcome(svg, label, cost, None if svg else "creative.failed", r)
