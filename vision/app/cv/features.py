"""InkComponent features and InkDoc assembly (PLAN_V2 §3.2, §3.3). Lane C.

Feature definitions are **lane B's** (web/src/core/ink/features.ts `computeGeo` / `featuresOf`, normative for the canvas
path). This module is a line-by-line Python port of them, so a paper component and the same ink drawn on the canvas
get the same `f`, `bbox` and `area`, and the grammar H1-H22 (calibrated on those numbers) reads both alike:

    fill     ink area / bbox area                  circ     4πA/P² of the largest closed outline (dot 1, open 0)
    straight chord / path length of the longest    zigN     perpendicular reversals (hysteresis 0.12) per cell
    zigAmp   median reversal amplitude             aspect   (major + w) / max(minor + w, w) along the PCA axes
    holes    outlined (not filled) closed loops    w        median pen width
    corners  turns > 45° on RDP(max(0.08, 0.35w))  spokes   open strokes pointing radially out of the loop
    bumps    radius maxima (≥ 6% of the mean radius) around the outline                is_dot  a dot, or ≤ 0.9 / fill ≥ 0.5

What differs from the canvas is only how strokes are *grouped*: paper components are the connected blobs of the
classified ink mask (vectorize.py), the canvas unions strokes that touch. `components_from_strokes` ports the canvas
union-find for strokes that skipped the vectorizer (stitched sheets, migrated levels).
Rounding follows JS `Math.round` (half up), not Python's banker's rounding.
"""
from __future__ import annotations

import math
from typing import Iterable, Protocol, Sequence

import cv2
import numpy as np

from app.cv.vectorize import RawComponent, RawStroke, polyline_length
from app.spec.ink import ComponentFeatures, InkComponent, InkStroke

P = tuple[float, float]
Rect = tuple[float, float, float, float]
EPS = 1e-9


class StrokeLike(Protocol):
    kind: str
    pts: Sequence[Sequence[float]]
    w: Sequence[float]
    closed: bool


def js_round(x: float, k: int = 1000) -> float:
    """Math.round(x * k) / k (half rounds toward +inf)."""
    return math.floor(x * k + 0.5) / k


def q16(x: float) -> float:
    return js_round(x, 16)


def q64(x: float) -> float:
    return js_round(x, 64)


# ------------------------------------------------------------------------------------------------------
# geometry (port of web/src/core/util/geom.ts)
# ------------------------------------------------------------------------------------------------------


def _dist(a: Sequence[float], b: Sequence[float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _poly_length(pts: Sequence[Sequence[float]]) -> float:
    return sum(_dist(pts[i - 1], pts[i]) for i in range(1, len(pts)))


def _bbox_of(pts: Sequence[Sequence[float]], pad: float = 0.0) -> Rect:
    if not pts:
        return (0.0, 0.0, 0.0, 0.0)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)


def _rect_union(a: Rect, b: Rect) -> Rect:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def _rect_gap(a: Rect, b: Rect) -> float:
    dx = max(0.0, a[0] - b[2], b[0] - a[2])
    dy = max(0.0, a[1] - b[3], b[1] - a[3])
    return math.hypot(dx, dy)


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _dist_pt_seg(p: Sequence[float], a: Sequence[float], b: Sequence[float]) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 if l2 > EPS else 0.0
    t = _clamp(t, 0.0, 1.0)
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _orient(a: Sequence[float], b: Sequence[float], c: Sequence[float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segs_intersect(a: P, b: P, c: P, d: P) -> bool:
    o1, o2, o3, o4 = _orient(a, b, c), _orient(a, b, d), _orient(c, d, a), _orient(c, d, b)
    return o1 * o2 < 0 and o3 * o4 < 0


def _dist_seg_seg(a: P, b: P, c: P, d: P) -> float:
    if _segs_intersect(a, b, c, d):
        return 0.0
    return min(_dist_pt_seg(a, c, d), _dist_pt_seg(b, c, d), _dist_pt_seg(c, a, b), _dist_pt_seg(d, a, b))


def _dist_poly_poly(A: Sequence[P], B: Sequence[P]) -> float:
    if not A or not B:
        return math.inf
    best = math.inf
    na, nb = max(1, len(A) - 1), max(1, len(B) - 1)
    for i in range(na):
        a0, a1 = A[i], A[min(i + 1, len(A) - 1)]
        for j in range(nb):
            d = _dist_seg_seg(a0, a1, B[j], B[min(j + 1, len(B) - 1)])
            if d < best:
                best = d
                if best == 0:
                    return 0.0
    return best


def _rdp(pts: Sequence[P], eps: float) -> list[P]:
    n = len(pts)
    if n <= 2:
        return [(p[0], p[1]) for p in pts]
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i0, i1 = stack.pop()
        dmax, idx = 0.0, -1
        for i in range(i0 + 1, i1):
            d = _dist_pt_seg(pts[i], pts[i0], pts[i1])
            if d > dmax:
                dmax, idx = d, i
        if idx >= 0 and dmax > eps:
            keep[idx] = True
            stack.append((i0, idx))
            stack.append((idx, i1))
    return [(pts[i][0], pts[i][1]) for i in range(n) if keep[i]]


def _resample(pts: Sequence[P], step: float) -> list[P]:
    if len(pts) < 2:
        return [(p[0], p[1]) for p in pts]
    out: list[P] = [(pts[0][0], pts[0][1])]
    carry = 0.0
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        L = _dist(a, b)
        if L < EPS:
            continue
        t = step - carry
        while t <= L:
            out.append((a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L))
            t += step
        carry = L - (t - step)
    last, tail = pts[-1], out[-1]
    if _dist(tail, last) > step * 0.25:
        out.append((last[0], last[1]))
    return out


def _poly_area(poly: Sequence[P]) -> float:
    s = 0.0
    j = len(poly) - 1
    for i in range(len(poly)):
        s += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1])
        j = i
    return abs(s) / 2.0


def _poly_perimeter(poly: Sequence[P]) -> float:
    if len(poly) < 2:
        return 0.0
    return _poly_length(poly) + _dist(poly[-1], poly[0])


def _poly_centroid(poly: Sequence[P]) -> P:
    a = cx = cy = 0.0
    j = len(poly) - 1
    for i in range(len(poly)):
        f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
        a += f
        cx += (poly[j][0] + poly[i][0]) * f
        cy += (poly[j][1] + poly[i][1]) * f
        j = i
    if abs(a) < EPS:
        n = max(1, len(poly))
        return (sum(p[0] for p in poly) / n, sum(p[1] for p in poly) / n)
    return (cx / (3 * a), cy / (3 * a))


def _pca(pts: Sequence[P]) -> dict[str, float]:
    n = len(pts)
    if not n:
        return {"cx": 0.0, "cy": 0.0, "angle": 0.0, "ux": 1.0, "uy": 0.0, "major": 0.0, "minor": 0.0}
    cx = sum(p[0] for p in pts) / n
    cy = sum(p[1] for p in pts) / n
    sxx = syy = sxy = 0.0
    for p in pts:
        dx, dy = p[0] - cx, p[1] - cy
        sxx += dx * dx
        syy += dy * dy
        sxy += dx * dy
    th = 0.5 * math.atan2(2 * sxy, sxx - syy)
    ux, uy = math.cos(th), math.sin(th)
    if ux < 0 or (abs(ux) < EPS and uy > 0):
        ux, uy = -ux, -uy
    lo = plo = math.inf
    hi = phi = -math.inf
    for p in pts:
        dx, dy = p[0] - cx, p[1] - cy
        u = dx * ux + dy * uy
        v = -dx * uy + dy * ux
        lo, hi, plo, phi = min(lo, u), max(hi, u), min(plo, v), max(phi, v)
    angle = -math.atan2(uy, ux) * 180 / math.pi
    if angle <= -90:
        angle += 180
    if angle > 90:
        angle -= 180
    return {"cx": cx, "cy": cy, "angle": angle, "ux": ux, "uy": uy, "major": hi - lo, "minor": phi - plo}


def _turn_angle(a: P, b: P, c: P) -> float:
    ux, uy = b[0] - a[0], b[1] - a[1]
    vx, vy = c[0] - b[0], c[1] - b[1]
    lu, lv = math.hypot(ux, uy), math.hypot(vx, vy)
    if lu < EPS or lv < EPS:
        return 0.0
    cos = _clamp((ux * vx + uy * vy) / (lu * lv), -1.0, 1.0)
    return math.acos(cos) * 180 / math.pi


def _mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


# ------------------------------------------------------------------------------------------------------
# per stroke (port of web/src/core/ink/stroke.ts)
# ------------------------------------------------------------------------------------------------------


def stroke_pts(s: StrokeLike) -> list[P]:
    return [(float(p[0]), float(p[1])) for p in s.pts]


def stroke_widths(s: StrokeLike) -> list[float]:
    n = len(s.pts)
    w = [float(v) for v in s.w]
    if not w:
        return [0.5] * n
    if len(w) >= n:
        return w[:n]
    return [w[min(i, len(w) - 1)] for i in range(n)]


def stroke_median_w(s: StrokeLike) -> float:
    w = sorted(stroke_widths(s))
    return w[len(w) >> 1] if w else 0.5


def stroke_bbox(s: StrokeLike) -> Rect:
    if s.kind == "dot":
        r = (float(s.w[0]) if s.w else 0.875) / 2
        x, y = s.pts[0][0], s.pts[0][1]
        return (x - r, y - r, x + r, y + r)
    if s.kind == "blob":
        return _bbox_of(stroke_pts(s), 0)
    w = stroke_widths(s)
    x0 = y0 = math.inf
    x1 = y1 = -math.inf
    for (x, y), wi in zip(stroke_pts(s), w):
        r = wi / 2
        x0, y0, x1, y1 = min(x0, x - r), min(y0, y - r), max(x1, x + r), max(y1, y + r)
    return (0.0, 0.0, 0.0, 0.0) if x0 == math.inf else (x0, y0, x1, y1)


def stroke_length(s: StrokeLike) -> float:
    if s.kind == "dot":
        return 0.0
    pts = stroke_pts(s)
    if s.kind == "blob" or s.closed:
        return _poly_length(pts) + (_dist(pts[-1], pts[0]) if len(pts) > 1 else 0.0)
    return _poly_length(pts)


def is_closed_stroke(s: StrokeLike) -> bool:
    if s.kind == "dot":
        return False
    if s.kind == "blob" or s.closed:
        return len(s.pts) >= 3
    if len(s.pts) < 4:
        return False
    w = stroke_median_w(s)
    gap = _dist(s.pts[0], s.pts[-1])
    L = _poly_length(stroke_pts(s))
    return gap <= max(0.5, 1.5 * w) and L >= 3 * max(gap, 0.5) and L >= 1.2


def stroke_ink_area(s: StrokeLike) -> float:
    if s.kind == "dot":
        r = (float(s.w[0]) if s.w else 0.875) / 2
        return math.pi * r * r
    if s.kind == "blob":
        return _poly_area(stroke_pts(s))
    w = stroke_widths(s)
    pts = stroke_pts(s)
    a = sum(_dist(pts[i - 1], pts[i]) * ((w[i - 1] + w[i]) / 2) for i in range(1, len(pts)))
    r = (w[0] if w else 0.5) / 2
    return a + math.pi * r * r


def stroke_centrelines(s: StrokeLike) -> list[P]:
    pts = stroke_pts(s)
    if s.kind == "blob" or (s.closed and len(pts) > 2):
        return pts + [pts[0]]
    return pts


# ------------------------------------------------------------------------------------------------------
# features (port of web/src/core/ink/features.ts)
# ------------------------------------------------------------------------------------------------------

_ZIG_H = 0.12


def _zigzag(seq: Sequence[P], ux: float, uy: float) -> tuple[int, list[float]]:
    if len(seq) < 3:
        return 0, []
    v = [-p[0] * uy + p[1] * ux for p in seq]
    direction = 0
    ext = last_extreme = lo = hi = v[0]
    reversals = 0
    amps: list[float] = []
    for x in v[1:]:
        if direction == 0:
            hi, lo = max(hi, x), min(lo, x)
            if hi - v[0] > _ZIG_H:
                direction, ext = 1, hi
            elif v[0] - lo > _ZIG_H:
                direction, ext = -1, lo
            continue
        if direction > 0:
            if x > ext:
                ext = x
            elif ext - x > _ZIG_H:
                reversals += 1
                amps.append(abs(ext - last_extreme))
                last_extreme, direction, ext = ext, -1, x
        else:
            if x < ext:
                ext = x
            elif x - ext > _ZIG_H:
                reversals += 1
                amps.append(abs(ext - last_extreme))
                last_extreme, direction, ext = ext, 1, x
    amps.append(abs(ext - last_extreme))
    return reversals, amps[1:]


def _axis_sequence(strokes: Sequence[StrokeLike], ux: float, uy: float) -> list[P]:
    parts: list[tuple[float, int, list[P]]] = []
    for k, s in enumerate(strokes):
        if s.kind == "dot":
            continue
        pts = stroke_pts(s)
        u0 = pts[0][0] * ux + pts[0][1] * uy
        u1 = pts[-1][0] * ux + pts[-1][1] * uy
        if u1 < u0:
            pts = pts[::-1]
        parts.append((min(u0, u1), k, _resample(pts, 0.1)))
    parts.sort(key=lambda t: (t[0], t[1]))  # JS Array.sort is stable
    out: list[P] = []
    for _, _, p in parts:
        out.extend(p)
    return out


def _count_corners(s: StrokeLike) -> int:
    if s.kind == "dot" or len(s.pts) < 3:
        return 0
    w = stroke_median_w(s)
    closed = is_closed_stroke(s)
    simp = _rdp(stroke_pts(s), max(0.08, 0.35 * w))
    m = len(simp)
    n = 0
    if closed and m >= 4:
        ring = simp[: m - 1] if _dist(simp[0], simp[m - 1]) < 0.3 else simp
        L = len(ring)
        for i in range(L):
            if _turn_angle(ring[(i + L - 1) % L], ring[i], ring[(i + 1) % L]) > 45:
                n += 1
        return n
    for i in range(1, m - 1):
        if _turn_angle(simp[i - 1], simp[i], simp[i + 1]) > 45:
            n += 1
    return n


def _count_bumps(outline: Sequence[P]) -> int:
    perim = _poly_perimeter(outline)
    if perim < 1:
        return 0
    ring = _resample(list(outline) + [outline[0]], perim / 96)
    if len(ring) > 3 and _dist(ring[0], ring[-1]) < perim / 200:
        ring.pop()
    c = _poly_centroid(outline)
    raw = [_dist(p, c) for p in ring]
    n = len(raw)
    if n < 12:
        return 0
    r = [(raw[(i - 2) % n] + raw[(i - 1) % n] + raw[i] + raw[(i + 1) % n] + raw[(i + 2) % n]) / 5 for i in range(n)]
    rm = _mean(r)
    bumps = 0
    i = 0
    while i < n:
        is_max = True
        lo = math.inf
        for k in range(-8, 9):
            if k == 0:
                continue
            rk = r[(i + k) % n]
            if abs(k) <= 4 and rk > r[i]:
                is_max = False
            lo = min(lo, rk)
        if is_max and r[i] - lo >= 0.06 * rm:
            bumps += 1
            i += 3  # a plateau counts once
        i += 1
    return bumps


def _count_spokes(strokes: Sequence[StrokeLike], outline: Sequence[P] | None, outline_stroke: StrokeLike | None) -> int:
    if not outline:
        return 0
    c = _poly_centroid(outline)
    r_mean = _mean([_dist(p, c) for p in outline])
    n = 0
    for s in strokes:
        if s is outline_stroke or s.kind == "dot" or is_closed_stroke(s):
            continue
        L = stroke_length(s)
        if L < 0.3 * r_mean:
            continue
        a, b = s.pts[0], s.pts[-1]
        near, far = (a, b) if _dist(a, c) <= _dist(b, c) else (b, a)
        dn, df = _dist(near, c), _dist(far, c)
        if dn > r_mean * 1.35 + 0.3 or df < dn + 0.25 * r_mean:
            continue
        rx, ry = near[0] - c[0], near[1] - c[1]
        sx, sy = far[0] - near[0], far[1] - near[1]
        cos = (rx * sx + ry * sy) / (math.hypot(rx, ry) * math.hypot(sx, sy) + 1e-9)
        if cos > math.cos(35 * math.pi / 180):
            n += 1
    return n


def component_geo(strokes: Sequence[StrokeLike]) -> dict[str, float | int | bool | Rect]:
    """Port of computeGeo: the numbers behind `f`, plus bbox (ink extents) and ink area."""
    lst = list(strokes)
    bbox = stroke_bbox(lst[0])
    for s in lst[1:]:
        bbox = _rect_union(bbox, stroke_bbox(s))
    pts: list[P] = [(float(p[0]), float(p[1])) for s in lst for p in s.pts]
    widths = sorted(stroke_median_w(s) for s in lst)
    w = widths[len(widths) >> 1] if widths else 0.5
    area = sum(stroke_ink_area(s) for s in lst)
    outline: list[P] | None = None
    outline_stroke: StrokeLike | None = None
    enclosed = 0.0
    holes = 0
    for s in lst:
        if not is_closed_stroke(s):
            continue
        if s.kind == "line":
            holes += 1
        a = _poly_area(stroke_pts(s))
        if a > enclosed:
            enclosed, outline, outline_stroke = a, stroke_pts(s), s
    longest = lst[0]
    for s in lst[1:]:
        if stroke_length(s) > stroke_length(longest):
            longest = s
    bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    diam = max(bw, bh)
    p = _pca(pts if pts else [(bbox[0], bbox[1])])
    is_dot = all(s.kind == "dot" for s in lst) or (diam <= 0.9 and area / max(1e-6, bw * bh) >= 0.5)
    lpts = stroke_pts(longest)
    l_len = _poly_length(lpts)
    if longest.kind == "dot":
        straight = 0.0
    else:
        straight = min(1.0, _dist(lpts[0], lpts[-1]) / l_len) if l_len > 1e-6 else 1.0
    seq = _axis_sequence(lst, p["ux"], p["uy"])
    reversals, amps = _zigzag(seq, p["ux"], p["uy"])
    extent = max(p["major"], 1e-6)
    amps_sorted = sorted(amps)
    zig_amp = amps_sorted[len(amps_sorted) >> 1] if amps_sorted else 0.0
    corners = sum(_count_corners(s) for s in lst)
    fill = min(1.0, area / max(1e-6, bw * bh))
    circ = 0.0
    if is_dot:
        circ = 1.0
    elif outline:
        p2 = _poly_perimeter(outline)
        circ = min(1.0, (4 * math.pi * enclosed) / (p2 * p2)) if p2 > 1e-6 else 0.0
    minor = max(p["minor"] + w, w, 1e-3)
    aspect = (p["major"] + w) / minor
    return {
        "bbox": bbox, "area": area, "fill": fill, "circ": circ, "straight": straight, "zigN": reversals / extent,
        "zigAmp": zig_amp, "aspect": aspect, "holes": holes, "w": w, "corners": corners,
        "spokes": _count_spokes(lst, outline, outline_stroke), "bumps": _count_bumps(outline) if outline else 0,
        "is_dot": is_dot,
    }


def features_of(g: dict[str, float | int | bool | Rect]) -> ComponentFeatures:
    r3 = js_round
    return ComponentFeatures(
        fill=r3(float(g["fill"])), circ=r3(float(g["circ"])), straight=r3(float(g["straight"])),
        zigN=r3(float(g["zigN"])), zigAmp=r3(float(g["zigAmp"])), aspect=r3(float(g["aspect"])),
        holes=int(g["holes"]), w=r3(float(g["w"])), corners=int(g["corners"]), spokes=int(g["spokes"]),
        bumps=int(g["bumps"]), is_dot=bool(g["is_dot"]),
    )


def make_component(cid: int, color: str, strokes: Sequence[InkStroke]) -> InkComponent:
    g = component_geo(strokes)
    bx = g["bbox"]
    assert isinstance(bx, tuple)
    return InkComponent(
        id=cid,
        color=color,  # type: ignore[arg-type]
        stroke_ids=[s.id for s in strokes],
        bbox=(q16(bx[0]), q16(bx[1]), q16(bx[2]), q16(bx[3])),
        area=js_round(float(g["area"])),
        f=features_of(g),
    )


# ------------------------------------------------------------------------------------------------------
# assembly
# ------------------------------------------------------------------------------------------------------


def densify(pts: np.ndarray, step: float, closed: bool = False) -> np.ndarray:
    """Resample a polyline so consecutive points are at most `step` apart (original vertices kept)."""
    if len(pts) < 2:
        return pts.copy()
    p = np.vstack([pts, pts[:1]]) if closed else pts
    out = [p[:1]]
    for a, b in zip(p[:-1], p[1:]):
        L = float(np.hypot(*(b - a)))
        n = max(1, int(math.ceil(L / step)))
        t = (np.arange(1, n + 1) / n)[:, None]
        out.append(a + (b - a) * t)
    res = np.vstack(out)
    return res[:-1] if closed else res


def route_order_key(bbox: Sequence[float], sheet: int = 0) -> tuple[float, ...]:
    """Component ids follow the route: left to right in 2-cell columns, then top to bottom."""
    x0, y0 = float(bbox[0]), float(bbox[1])
    return (sheet, math.floor(x0 / 2.0), y0, x0)


def to_ink_stroke(s: RawStroke, sid: str, color: str, sheet: int, origin: str) -> InkStroke:
    w = s.w if s.kind == "line" else s.w[:1]
    return InkStroke(
        id=sid,
        color=color,  # type: ignore[arg-type]
        kind=s.kind,
        pts=[(float(x), float(y)) for x, y in s.pts],
        w=[float(v) for v in w],
        closed=bool(s.closed),
        sheet=int(sheet),
        origin=origin,  # type: ignore[arg-type]
    )


def assemble(
    raws: Sequence[RawComponent], *, stroke_prefix: str = "s", first_stroke: int = 1, first_component: int = 1
) -> tuple[list[InkStroke], list[InkComponent]]:
    """Vectorized components -> (InkStrokes, InkComponents), both numbered in route order."""
    ordered = sorted(raws, key=lambda rc: route_order_key(rc.bbox, rc.sheet))
    strokes: list[InkStroke] = []
    comps: list[InkComponent] = []
    k = first_stroke - 1
    for cid, rc in enumerate(ordered, start=first_component):
        mine: list[InkStroke] = []
        for s in sorted(rc.strokes, key=lambda t: (min(p[0] for p in t.pts), min(p[1] for p in t.pts))):
            k += 1
            mine.append(to_ink_stroke(s, f"{stroke_prefix}{k}", rc.color, rc.sheet, rc.origin))
        strokes.extend(mine)
        comps.append(make_component(cid, rc.color, mine))
    return strokes, comps


def strokes_to_raw(strokes: Iterable[InkStroke]) -> list[RawStroke]:
    out: list[RawStroke] = []
    for s in strokes:
        pts = [(float(x), float(y)) for x, y in s.pts]
        arr = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        length = 0.0 if s.kind == "dot" else polyline_length(arr, s.closed or s.kind == "blob")
        out.append(RawStroke(kind=s.kind, pts=pts, w=list(s.w), closed=s.closed, length=length))
    return out


def components_from_strokes(strokes: Sequence[InkStroke], *, first_component: int = 1) -> list[InkComponent]:
    """Port of computeComponents: same-colour strokes that touch (gap <= 0.5·w) form a component; a stamped stroke
    is always its own. Ids in order of first stroke. For strokes that skipped the vectorizer (stitching, migration)."""
    n = len(strokes)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def unite(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    boxes = [stroke_bbox(s) for s in strokes]
    lines = [stroke_centrelines(s) for s in strokes]
    widths = [stroke_median_w(s) for s in strokes]
    for i in range(n):
        a = strokes[i]
        if a.stamp:
            continue
        for j in range(i + 1, n):
            b = strokes[j]
            if b.stamp or a.color != b.color:
                continue
            tol = 0.5 * max(widths[i], widths[j])
            if _rect_gap(boxes[i], boxes[j]) > tol:
                continue
            d = _dist_poly_poly(lines[i], lines[j]) - (widths[i] + widths[j]) / 2
            if d <= tol:
                unite(i, j)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    out: list[InkComponent] = []
    for k, root in enumerate(sorted(groups), start=first_component):
        ss = [strokes[i] for i in groups[root]]
        out.append(make_component(k, ss[0].color, ss))
    return out


# ------------------------------------------------------------------------------------------------------
# drawing strokes into images (annotated tiles, template remix ink)
# ------------------------------------------------------------------------------------------------------

_SHIFT = 4
_ONE = 1 << _SHIFT


def _fx(v: float) -> int:
    return int(round(v * _ONE))


def draw_stroke(
    img: np.ndarray,
    kind: str,
    pts: Sequence[Sequence[float]],
    w: Sequence[float],
    closed: bool,
    *,
    ppc: float,
    origin_cells: tuple[float, float],
    color: int | tuple[int, int, int],
    aa: bool = False,
    min_px: float = 1.0,
    min_dot_px: float = 2.0,
) -> None:
    """Draw one stroke (cells) into `img` at `ppc`, with `origin_cells` at pixel (0, 0). Round caps and joins."""
    ox, oy = origin_cells
    line_type = cv2.LINE_AA if aa else cv2.LINE_8
    Q = [((float(x) - ox) * ppc, (float(y) - oy) * ppc) for x, y in pts]
    if not Q:
        return
    if kind == "dot":
        r = max(min_dot_px / 2.0, float(w[0]) * ppc / 2.0) if w else min_dot_px / 2.0
        cv2.circle(img, (_fx(Q[0][0]), _fx(Q[0][1])), max(1, _fx(r)), color, -1, line_type, _SHIFT)
        return
    if kind == "blob":
        poly = np.array([[_fx(x), _fx(y)] for x, y in Q], dtype=np.int32).reshape(-1, 1, 2)
        cv2.fillPoly(img, [poly], color, line_type, _SHIFT)
        cv2.polylines(img, [poly], True, color, max(1, int(round(min_px))), line_type, _SHIFT)
        return
    widths = list(w) if len(w) == len(Q) else [float(w[0]) if w else 0.5] * len(Q)
    n = len(Q)
    if n == 1:
        r = max(min_dot_px, widths[0] * ppc) / 2.0
        cv2.circle(img, (_fx(Q[0][0]), _fx(Q[0][1])), max(1, _fx(r)), color, -1, line_type, _SHIFT)
        return
    seg_count = n if closed and n > 2 else n - 1
    for i in range(seg_count):
        a, b = Q[i], Q[(i + 1) % n]
        t = max(min_px, (widths[i] + widths[(i + 1) % n]) / 2.0 * ppc)
        cv2.line(img, (_fx(a[0]), _fx(a[1])), (_fx(b[0]), _fx(b[1])), color, max(1, int(round(t))), line_type, _SHIFT)
    for (x, y), wi in zip(Q, widths):
        r = max(min_px, wi * ppc) / 2.0
        if r >= 1.0:
            cv2.circle(img, (_fx(x), _fx(y)), _fx(r), color, -1, line_type, _SHIFT)
