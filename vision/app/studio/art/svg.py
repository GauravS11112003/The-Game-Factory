"""SVG safety and plumbing for v7 art (docs/v7/CONTRACTS_V7.md §3.6).

    sanitize(text, view=(w, h), prefix="a1_")  → a safe standalone SVG string, or None
    fit(svg, w, h)                              → the same drawing re-framed into viewBox "0 0 w h"
    mirror_tile(svg, axes="x"|"xy")             → a seamless tile made from the drawing and its mirror image
    inner(svg)                                  → (children XML, (vw, vh)) for composing previews

The sanitizer is an allow-list REBUILD, never a blacklist pass: the model's text is parsed (DOCTYPE / ENTITY /
stylesheet PIs rejected before parsing) and a NEW tree is built from allowed elements and attributes only.

Dropped: script, style (element and attribute; an inline style="" is converted into presentation attributes from the
allow-list), text / tspan / textPath, foreignObject, image, feImage, a, animation, event handlers (on*), any
namespace other than SVG (xlink:href becomes href), every href that is not a local "#id", every url() that is not a
local "#id", javascript:/data: values. Every id is renamed with a per-drawing prefix (and every reference to it), so
two drawings can never collide when inlined into one page. The viewBox is forced to the size asked for: a drawing made
in another viewBox is scaled to fit, centred. Output larger than `max_chars` is compacted (numbers rounded); if it is
still too large, the drawing is refused.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Iterable

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
SVG_MAX = 300_000  # app.spec.studio._SVG_MAX: characters of one sanitized SVG
MAX_INPUT_CHARS = 900_000

SHAPES = {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon"}
FILTER_PRIMITIVES = {
    "feGaussianBlur", "feOffset", "feFlood", "feComposite", "feMerge", "feMergeNode", "feColorMatrix", "feBlend",
    "feDropShadow", "feTurbulence", "feDisplacementMap", "feMorphology", "feComponentTransfer", "feFuncA", "feFuncR",
    "feFuncG", "feFuncB",
}
ALLOWED_TAGS = SHAPES | FILTER_PRIMITIVES | {
    "svg", "g", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "use", "symbol",
    "filter",
}
GEOMETRY = {
    "d", "x", "y", "width", "height", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2", "points", "transform",
    "fx", "fy", "fr", "offset", "gradientUnits", "gradientTransform", "spreadMethod", "clipPathUnits", "maskUnits",
    "maskContentUnits", "patternUnits", "patternContentUnits", "patternTransform", "viewBox", "preserveAspectRatio",
    "pathLength",
}
PAINT = {
    "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
    "stroke-dashoffset", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule", "stop-color",
    "stop-opacity", "clip-path", "mask", "filter", "paint-order", "vector-effect", "shape-rendering", "color",
    "mix-blend-mode", "isolation", "display", "visibility",
}
FILTER_ATTRS = {
    "filterUnits", "primitiveUnits", "in", "in2", "result", "stdDeviation", "dx", "dy", "flood-color", "flood-opacity",
    "operator", "k1", "k2", "k3", "k4", "values", "type", "mode", "baseFrequency", "numOctaves", "seed", "stitchTiles",
    "scale", "xChannelSelector", "yChannelSelector", "radius", "tableValues", "slope", "intercept", "amplitude",
    "exponent", "color-interpolation-filters", "edgeMode",
}
ALLOWED_ATTRS = GEOMETRY | PAINT | FILTER_ATTRS | {"id", "href"}
STYLE_PROPS = PAINT | {"flood-color", "flood-opacity", "color-interpolation-filters"}
LONG_ATTRS = {"d", "points", "values", "tableValues"}
REF_ATTRS = {"fill", "stroke", "clip-path", "mask", "filter"}

_BAD_VALUE = re.compile(r"javascript:|vbscript:|data:|expression\s*\(|@import|<|>|\\", re.I)
_URL_REF = re.compile(r"url\(\s*['\"]?#([A-Za-z_][\w.-]{0,63})['\"]?\s*\)", re.I)
_ANY_URL = re.compile(r"url\(", re.I)
_ID = re.compile(r"^[A-Za-z_][\w.-]{0,63}$")
_NUM = re.compile(r"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def _local(name: str) -> tuple[str | None, str]:
    if name.startswith("{"):
        ns, _, local = name[1:].partition("}")
        return ns, local
    return None, name


def _fmt(x: float) -> str:
    s = f"{x:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _clean_value(name: str, value: str, ids: dict[str, str]) -> str | None:
    v = (value or "").strip()
    limit = 120_000 if name in LONG_ATTRS else 400
    if not v or len(v) > limit:
        return None
    if name == "href":
        if not v.startswith("#") or v[1:] not in ids:
            return None
        return "#" + ids[v[1:]]
    if name == "id":
        return ids.get(v)
    if _BAD_VALUE.search(v):
        return None
    if _ANY_URL.search(v):
        if name not in REF_ATTRS:
            return None
        bad = False

        def repl(m: re.Match[str]) -> str:
            nonlocal bad
            target = ids.get(m.group(1))
            if target is None:
                bad = True
                return "none"
            return f"url(#{target})"

        out = _URL_REF.sub(repl, v)
        # any url( left that is not a local reference, or a reference to an id that does not exist
        if bad or len(_ANY_URL.findall(out)) != len(_URL_REF.findall(v)):
            return None if name in ("clip-path", "mask", "filter") else "none"
        return out
    return v


def _copy(src: ET.Element, parent: ET.Element | None, ids: dict[str, str], budget: list[int]) -> ET.Element | None:
    ns, tag = _local(src.tag)
    if ns not in (None, SVG_NS) or tag not in ALLOWED_TAGS or budget[0] <= 0:
        return None
    budget[0] -= 1
    el = ET.Element(f"{{{SVG_NS}}}{tag}") if parent is None else ET.SubElement(parent, f"{{{SVG_NS}}}{tag}")
    for k, v in src.attrib.items():
        ans, an = _local(k)
        if ans == XLINK_NS and an == "href":
            an, ans = "href", None
        if ans is not None or an.lower().startswith("on") or an not in ALLOWED_ATTRS:
            continue
        cv = _clean_value(an, v, ids)
        if cv is not None:
            el.set(an, cv)
    for decl in (src.attrib.get("style") or "").split(";")[:40]:
        prop, _, val = decl.partition(":")
        prop = prop.strip().lower()
        if prop in STYLE_PROPS and prop not in el.attrib:
            cv = _clean_value(prop, val, ids)
            if cv is not None:
                el.set(prop, cv)
    for child in list(src):
        _copy(child, el, ids, budget)
    return el


def _viewbox(root: ET.Element) -> tuple[float, float, float, float] | None:
    nums = [float(x) for x in _NUM.findall(root.get("viewBox") or "")]
    if len(nums) == 4 and nums[2] > 0 and nums[3] > 0:
        return nums[0], nums[1], nums[2], nums[3]
    w = [float(x) for x in _NUM.findall(root.get("width") or "")]
    h = [float(x) for x in _NUM.findall(root.get("height") or "")]
    if w and h and w[0] > 0 and h[0] > 0:
        return 0.0, 0.0, w[0], h[0]
    return None


def _parse(text: str) -> ET.Element | None:
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
        root = ET.fromstring(s)
    except ET.ParseError:
        return None
    return root if _local(root.tag)[1] == "svg" else None


def _tostring(root: ET.Element) -> str:
    ET.register_namespace("", SVG_NS)
    return ET.tostring(root, encoding="unicode", short_empty_elements=True)


def _round_numbers(root: ET.Element, digits: int) -> None:
    def rnd(m: re.Match[str]) -> str:
        return _fmt(round(float(m.group(0)), digits))

    for el in root.iter():
        for k in ("d", "points", "transform", "x", "y", "width", "height", "cx", "cy", "r", "rx", "ry", "x1", "y1",
                  "x2", "y2", "stroke-width", "gradientTransform", "patternTransform"):
            v = el.get(k)
            if v:
                el.set(k, _NUM.sub(rnd, v))


def _drawable(root: ET.Element) -> bool:
    return any(_local(e.tag)[1] in SHAPES | {"use"} for e in root.iter())


def sanitize(text: str | None, *, view: tuple[float, float] | None = None, prefix: str = "a_",
             max_chars: int = SVG_MAX, max_elements: int = 2500) -> str | None:
    """A safe standalone SVG with viewBox "0 0 view_w view_h" (the source's own viewBox when `view` is None), or None
    when nothing drawable remains, the text is not an SVG, or it cannot be made small enough."""
    if not isinstance(text, str) or not text or len(text) > MAX_INPUT_CHARS:
        return None
    src = _parse(text)
    if src is None:
        return None
    pre = re.sub(r"[^\w-]", "", prefix)[:16] or "a_"
    if not pre[0].isalpha() and pre[0] != "_":
        pre = "a" + pre
    ids: dict[str, str] = {}
    for el in src.iter():
        i = (el.get("id") or "").strip()
        if i and _ID.match(i) and i not in ids:
            ids[i] = f"{pre}{i}"[:64]
    root = _copy(src, None, ids, [max_elements])
    if root is None or not _drawable(root):
        return None
    vb = _viewbox(src)
    for k in ("width", "height", "x", "y", "viewBox", "preserveAspectRatio", "transform"):
        root.attrib.pop(k, None)
    if view is None:
        if vb is None:
            return None
        tw, th = vb[2], vb[3]
        if vb[0] or vb[1]:
            _wrap(root, f"translate({_fmt(-vb[0])} {_fmt(-vb[1])})")
    else:
        tw, th = float(view[0]), float(view[1])
        if tw <= 0 or th <= 0:
            return None
        src_vb = vb or (0.0, 0.0, tw, th)
        tr = _fit_transform(src_vb, tw, th)
        if tr:
            _wrap(root, tr)
    root.set("viewBox", f"0 0 {_fmt(tw)} {_fmt(th)}")
    root.set("width", _fmt(tw))
    root.set("height", _fmt(th))
    out = _tostring(root)
    for digits in (2, 1, 0):
        if len(out) <= max_chars:
            break
        _round_numbers(root, digits)
        out = _tostring(root)
    return out if len(out) <= max_chars else None


def _fit_transform(vb: tuple[float, float, float, float], tw: float, th: float) -> str:
    """The transform drawing `vb` into "0 0 tw th", uniformly scaled and centred (empty when it already matches)."""
    x, y, w, h = vb
    if abs(x) < 1e-6 and abs(y) < 1e-6 and abs(w - tw) <= tw * 0.004 and abs(h - th) <= th * 0.004:
        return ""
    s = min(tw / w, th / h)
    ox, oy = (tw - w * s) / 2 - x * s, (th - h * s) / 2 - y * s
    return f"translate({_fmt(ox)} {_fmt(oy)}) scale({_fmt(s)})"


def _wrap(root: ET.Element, transform: str) -> None:
    """Move every drawing child of root into a <g transform>; defs stay at the top."""
    g = ET.Element(f"{{{SVG_NS}}}g", {"transform": transform})
    defs = []
    for child in list(root):
        root.remove(child)
        if _local(child.tag)[1] == "defs":
            defs.append(child)
        else:
            g.append(child)
    for d in defs:
        root.append(d)
    root.append(g)


def fit(svg: str, w: float, h: float, *, stretch: bool = True) -> str | None:
    """Re-frame a sanitized SVG into viewBox "0 0 w h". `stretch` maps the source box onto the target exactly (used
    when the source was drawn at the target's aspect in friendlier units); otherwise it is fitted and centred."""
    root = _parse(svg)
    if root is None:
        return None
    vb = _viewbox(root) or (0.0, 0.0, w, h)
    for k in ("width", "height", "viewBox"):
        root.attrib.pop(k, None)
    if stretch:
        sx, sy = w / vb[2], h / vb[3]
        tr = f"scale({sx:.6g} {sy:.6g})" + (f" translate({_fmt(-vb[0])} {_fmt(-vb[1])})" if vb[0] or vb[1] else "")
    else:
        tr = _fit_transform(vb, w, h)
    if tr:
        _wrap(root, tr)
    root.set("viewBox", f"0 0 {_fmt(w)} {_fmt(h)}")
    root.set("width", _fmt(w))
    root.set("height", _fmt(h))
    return _tostring(root)


def mirror_tile(svg: str, axes: str = "x") -> tuple[str, float, float] | None:
    """A tile twice as wide (and twice as tall for "xy") made of the drawing and its mirror image(s), so opposite
    edges always match: the fallback when a "tileable" drawing has a visible seam. Returns (svg, w, h)."""
    root = _parse(svg)
    if root is None:
        return None
    vb = _viewbox(root)
    if vb is None:
        return None
    w, h = vb[2], vb[3]
    pre = "m" + str(abs(hash(svg)) % 100000) + "_"
    defs = [c for c in list(root) if _local(c.tag)[1] == "defs"]
    body = ET.Element(f"{{{SVG_NS}}}g", {"id": f"{pre}tile"})
    for c in list(root):
        root.remove(c)
        if _local(c.tag)[1] != "defs":
            body.append(c)
    out = ET.Element(f"{{{SVG_NS}}}svg")
    d = ET.SubElement(out, f"{{{SVG_NS}}}defs")
    for dd in defs:
        for c in list(dd):
            d.append(c)
    d.append(body)
    tw, th = (2 * w, 2 * h) if axes == "xy" else (2 * w, h)
    ET.SubElement(out, f"{{{SVG_NS}}}use", {"href": f"#{pre}tile"})
    ET.SubElement(out, f"{{{SVG_NS}}}use", {"href": f"#{pre}tile", "transform": f"matrix(-1 0 0 1 {_fmt(2 * w)} 0)"})
    if axes == "xy":
        ET.SubElement(out, f"{{{SVG_NS}}}use", {"href": f"#{pre}tile",
                                                 "transform": f"matrix(1 0 0 -1 0 {_fmt(2 * h)})"})
        ET.SubElement(out, f"{{{SVG_NS}}}use", {"href": f"#{pre}tile",
                                                 "transform": f"matrix(-1 0 0 -1 {_fmt(2 * w)} {_fmt(2 * h)})"})
    out.set("viewBox", f"0 0 {_fmt(tw)} {_fmt(th)}")
    out.set("width", _fmt(tw))
    out.set("height", _fmt(th))
    return _tostring(out), tw, th


def size_of(svg: str) -> tuple[float, float] | None:
    root = _parse(svg)
    vb = _viewbox(root) if root is not None else None
    return (vb[2], vb[3]) if vb else None


def inner(svg: str) -> tuple[str, tuple[float, float]] | None:
    """The children of a sanitized SVG as XML text (defs included) and its viewBox size, for inlining into a
    composed preview. The ids are already prefixed, so several drawings can share one page."""
    root = _parse(svg)
    if root is None:
        return None
    vb = _viewbox(root)
    if vb is None:
        return None
    ET.register_namespace("", SVG_NS)
    parts = [ET.tostring(c, encoding="unicode") for c in root]
    xml = "".join(parts).replace(f' xmlns="{SVG_NS}"', "")
    return xml, (vb[2], vb[3])


def element_count(svg: str) -> int:
    root = _parse(svg)
    return sum(1 for _ in root.iter()) if root is not None else 0


def colours_in(svg: str) -> list[str]:
    return list(dict.fromkeys(m.lower() for m in re.findall(r"#[0-9a-fA-F]{6}\b", svg or "")))


def ids_of(svgs: Iterable[str]) -> set[str]:
    out: set[str] = set()
    for s in svgs:
        out.update(re.findall(r'\bid="([^"]+)"', s or ""))
    return out
