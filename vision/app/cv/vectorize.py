"""Ink pixels -> vector strokes (PLAN_V2 §3.2 "Paper", steps 1-8). Lane C.

Input is a set of per-colour binary masks of one drawing area (paper sheet after rectify + Lab classify, or a raster
drawing for ingest) at `ppc` pixels per cell. Output is a list of `RawComponent`s: one per connected ink blob of one
colour, each holding its strokes in world cells. `features.py` turns them into InkDoc strokes and components.

Per connected component (8-connectivity, **no** cell/4 dilation [B F4]):
1. Marks under 0.03 cell² are counted as noise (never silently dropped: InkDoc.noise.count).
2. **Dot**: max side <= 0.9 cell and fill >= 0.5; also a round filled mark up to 1.3 cells (fill >= 0.6, circularity
   >= 0.7, no hole), so canvas taps of 6-20 px (0.375-1.25 cell) all become dots [B F7]. Both need a bbox aspect
   <= 2, so a short straight dash (which fills its bbox) stays a line.
3. **Blob**: the distance transform exceeds 0.45 cell on >= 30% of the skeleton pixels (and no hole bigger than
   0.5 cell², else a thick ring would lose its hole): one closed contour (approxPolyDP 0.08 cell).
   A mostly-thin component with a filled core >= 1 cell² is split: the core becomes a blob, the rest lines.
4. Otherwise Zhang-Suen thinning (`cv2.ximgproc.thinning`).
5. Skeleton graph: junctions by crossing number >= 3, junction pixels within 3 px merged into one node, short
   bridges between two nodes contracted, spurs shorter than max(0.4 cell, 1.5·w) pruned, unless they protrude
   >= 0.25 cell beyond the host stroke's edge (arrow barbs, letter strokes: the model reads the rendered vectors).
6. At each junction the edges are paired by the straightest continuation (turn < 35°), so a pole standing on a floor
   stays its own stroke and the floor stays one stroke.
7. Free ends are extended along their tangent to the real end of the ink (the skeleton stops w/2 short).
8. RDP ε 0.06 cell; width per point = 2·DT − 1 px along the skeleton (running median of 7), in cells.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Literal

import cv2
import numpy as np

from app.template import spec_v2

Centers = dict[str, np.ndarray]  # class name -> float32 Lab, ordered like spec_v2.CLASS_ORDER
StrokeKind = Literal["line", "dot", "blob"]

QUANT = 64  # ink points and widths: 1/64 cell


# ======================================================================================================
# Colour classification (the v1 Lab nearest-swatch approach, kept [M "Model vs deterministic"])
# ======================================================================================================


def bgr_to_lab(image_bgr: np.ndarray) -> np.ndarray:
    """uint8 BGR -> float32 Lab with L in 0..100 and a, b roughly -128..127."""
    return cv2.cvtColor(image_bgr.astype(np.float32) / 255.0, cv2.COLOR_BGR2LAB)


def lab_of_hex(hex_str: str) -> np.ndarray:
    b, g, r = spec_v2.hex_to_bgr(hex_str)
    return bgr_to_lab(np.array([[[b, g, r]]], dtype=np.uint8))[0, 0].astype(np.float32)


def ideal_centers() -> Centers:
    """Class centres straight from the spec hexes (canvas renders, or the fallback for a bad photo)."""
    palette = spec_v2.colors()
    return {name: lab_of_hex(palette[name]) for name in spec_v2.CLASS_ORDER}


def _class_lut(centers: Centers, margin: float, bits: int) -> np.ndarray:
    """Class index for every quantized BGR colour (q³ entries, q = 2**bits)."""
    q = 1 << bits
    step = 256.0 / q
    levels = ((np.arange(q, dtype=np.float32) + 0.5) * step).clip(0, 255).astype(np.uint8)
    b, g, r = np.meshgrid(levels, levels, levels, indexing="ij")  # index = (b << 2bits) | (g << bits) | r
    grid = np.stack([b.ravel(), g.ravel(), r.ravel()], axis=1).reshape(-1, 1, 3)
    lab = bgr_to_lab(grid).reshape(-1, 3)
    stack = np.stack([centers[name] for name in spec_v2.CLASS_ORDER]).astype(np.float32)  # (6, 3)
    dist = np.linalg.norm(lab[:, None, :] - stack[None, :, :], axis=2)  # (q³, 6)
    nearest = np.argmin(dist, axis=1).astype(np.uint8)
    d_nearest = dist[np.arange(dist.shape[0]), nearest]
    gray_i = spec_v2.CLASS_ORDER.index("gray")
    paper_i = spec_v2.CLASS_ORDER.index("paper")
    d_background = np.minimum(dist[:, gray_i], dist[:, paper_i])
    # An ink-nearest colour that is nearly as close to a background class is a shadow or an anti-aliased edge.
    ambiguous = (nearest < len(spec_v2.INK_CLASSES)) & ((d_background - d_nearest) < margin)
    nearest[ambiguous] = paper_i
    return nearest


def classify_labels(image_bgr: np.ndarray, centers: Centers, margin: float | None = None) -> np.ndarray:
    """Per-pixel class index into spec_v2.CLASS_ORDER (uint8), through a quantized-colour lookup table."""
    p = spec_v2.classify_params()
    margin = float(p["confidence_margin_lab"]) if margin is None else margin
    bits = int(p.get("lut_bits", 5))
    lut = _class_lut(centers, margin, bits)
    shift = 8 - bits
    img = np.ascontiguousarray(image_bgr, dtype=np.uint8)
    b = (img[..., 0] >> shift).astype(np.int32)
    g = (img[..., 1] >> shift).astype(np.int32)
    r = (img[..., 2] >> shift).astype(np.int32)
    return lut[(b << (2 * bits)) | (g << bits) | r]


def _ellipse(diameter: int) -> np.ndarray:
    d = max(1, int(diameter))
    if d % 2 == 0:
        d += 1
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d))


def clean_mask(raw: np.ndarray, ppc: float) -> np.ndarray:
    """Median 3 (salt noise, JPEG speckle) then a small close (pen skips <= 0.08 cell). No dilation, no opening."""
    m = cv2.medianBlur(np.ascontiguousarray(raw, dtype=np.uint8), 3)
    k = max(3, int(round(float(spec_v2.vectorize_params()["close_kernel_c"]) * ppc)))
    return cv2.morphologyEx(m, cv2.MORPH_CLOSE, _ellipse(k))


def ink_masks(labels: np.ndarray, ppc: float, classes: tuple[str, ...] = spec_v2.INK_CLASSES) -> dict[str, np.ndarray]:
    """Cleaned binary masks (uint8 0/255) per ink class from a label map."""
    out: dict[str, np.ndarray] = {}
    for name in classes:
        i = spec_v2.CLASS_ORDER.index(name)
        out[name] = clean_mask((labels == i).astype(np.uint8) * 255, ppc)
    return out


# ======================================================================================================
# Data
# ======================================================================================================


@dataclass(frozen=True)
class VecParams:
    ppc: float
    dot_max_side_c: float = 0.9
    dot_min_fill: float = 0.5
    dot_max_aspect: float = 2.0
    tap_dot_max_side_c: float = 1.3
    tap_dot_min_fill: float = 0.6
    tap_dot_min_circ: float = 0.7
    blob_dt_c: float = 0.45
    blob_skeleton_frac: float = 0.3
    blob_core_min_c2: float = 1.0
    blob_hole_max_c2: float = 0.5
    blob_approx_eps_c: float = 0.08
    junction_merge_px: float = 3.0
    spur_min_c: float = 0.4
    spur_min_w: float = 1.5
    spur_keep_protrusion_c: float = 0.25
    turn_deg: float = 35.0
    rdp_eps_c: float = 0.06
    min_mark_area_c2: float = 0.03
    closed_gap_c: float = 0.4
    closed_gap_w: float = 2.0
    end_extend_max_dt: float = 1.5
    width_median_window: int = 7
    hole_min_c2: float = 0.05

    @classmethod
    def from_spec(cls, ppc: float) -> "VecParams":
        v = spec_v2.vectorize_params()
        f = spec_v2.feature_params()
        names = set(cls.__dataclass_fields__) - {"ppc", "hole_min_c2"}
        kw = {k: v[k] for k in names if k in v}
        return cls(ppc=float(ppc), hole_min_c2=float(f.get("hole_min_c2", 0.05)), **kw)


@dataclass
class RawStroke:
    kind: StrokeKind
    pts: list[tuple[float, float]]  # world cells. line: centreline; blob: closed contour; dot: [centre]
    w: list[float]  # cells; per point for lines, one value for dots (diameter) and blobs
    closed: bool
    length: float = 0.0  # cells (centreline or contour length; 0 for dots)


@dataclass
class ContourInfo:
    outer: np.ndarray | None  # (N, 2) float32 px, the largest outer contour, lightly simplified
    outer_area_px: float  # polygon area of the outer contour (holes filled)
    perimeter_px: float
    holes_area_c2: list[float]  # every hole >= hole_min_c2

    @property
    def circ(self) -> float:
        if self.perimeter_px <= 0:
            return 0.0
        return float(min(1.0, 4.0 * math.pi * self.outer_area_px / (self.perimeter_px**2)))


@dataclass
class RawComponent:
    color: str
    strokes: list[RawStroke]
    bbox: tuple[float, float, float, float]  # world cells [x0, y0, x1, y1] of the ink (width included)
    area: float  # ink area, cells²
    mask: np.ndarray  # uint8 0/255 crop of this component only (2 px zero border)
    crop_origin_cells: tuple[float, float]  # world cells of the crop's pixel (0, 0) top-left corner
    ppc: float
    sheet: int
    width_c: float  # median stroke width over the skeleton, cells (dots: diameter)
    contour: ContourInfo
    skeleton_px: int = 0
    origin: str = "kid"

    def px_to_cells(self, x: float, y: float) -> tuple[float, float]:
        ox, oy = self.crop_origin_cells
        return ox + (x + 0.5) / self.ppc, oy + (y + 0.5) / self.ppc


@dataclass
class VecResult:
    components: list[RawComponent] = field(default_factory=list)
    noise: int = 0  # marks < min_mark_area_c2 ("I ignored N tiny specks")


# ======================================================================================================
# Geometry helpers (also used by features.py)
# ======================================================================================================


def q64(v: float) -> float:
    return round(float(v) * QUANT) / QUANT


def polyline_length(pts: np.ndarray, closed: bool = False) -> float:
    if len(pts) < 2:
        return 0.0
    d = np.diff(pts, axis=0)
    total = float(np.sum(np.hypot(d[:, 0], d[:, 1])))
    if closed:
        total += float(np.hypot(*(pts[0] - pts[-1])))
    return total


def rdp_indices(pts: np.ndarray, eps: float) -> np.ndarray:
    """Ramer-Douglas-Peucker on an open polyline; returns the kept indices (first and last always kept)."""
    n = len(pts)
    if n <= 2:
        return np.arange(n)
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        pa, pb = pts[a], pts[b]
        seg = pb - pa
        seg_len = float(np.hypot(seg[0], seg[1]))
        inner = pts[a + 1 : b]
        if seg_len < 1e-9:
            d = np.hypot(inner[:, 0] - pa[0], inner[:, 1] - pa[1])
        else:
            d = np.abs(seg[0] * (inner[:, 1] - pa[1]) - seg[1] * (inner[:, 0] - pa[0])) / seg_len
        i = int(np.argmax(d))
        if float(d[i]) > eps:
            m = a + 1 + i
            keep[m] = True
            stack.append((a, m))
            stack.append((m, b))
    return np.nonzero(keep)[0]


def contour_info(crop: np.ndarray, ppc: float, hole_min_c2: float) -> ContourInfo:
    """Outer contour (largest), its polygon area and perimeter, and the holes (contour hierarchy)."""
    contours, hier = cv2.findContours(crop, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if not contours or hier is None:
        return ContourInfo(None, 0.0, 0.0, [])
    hier = hier.reshape(-1, 4)
    outer_idx = [i for i in range(len(contours)) if hier[i, 3] < 0]
    if not outer_idx:
        return ContourInfo(None, 0.0, 0.0, [])
    best = max(outer_idx, key=lambda i: len(contours[i]))
    eps = max(0.7, 0.02 * ppc)
    poly = cv2.approxPolyDP(contours[best], eps, True)
    area = float(abs(cv2.contourArea(poly))) if len(poly) >= 3 else 0.0
    perim = float(cv2.arcLength(poly, True)) if len(poly) >= 2 else 0.0
    holes: list[float] = []
    min_px = hole_min_c2 * ppc * ppc
    for i in range(len(contours)):
        if hier[i, 3] >= 0:
            a = float(abs(cv2.contourArea(contours[i])))
            if a >= min_px:
                holes.append(a / (ppc * ppc))
    outer = poly.reshape(-1, 2).astype(np.float32)
    return ContourInfo(outer, area, perim, holes)


# ======================================================================================================
# Skeleton graph
# ======================================================================================================

_N4 = ((-1, 0), (1, 0), (0, -1), (0, 1))
_D4 = ((-1, -1), (-1, 1), (1, -1), (1, 1))
_N8 = _N4 + _D4
# circular order for the crossing number: N, NE, E, SE, S, SW, W, NW
_RING = ((-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1))


@dataclass
class _Edge:
    pix: np.ndarray  # (N, 2) int (y, x), ordered
    ends: list[int | None]  # node id at the start / end of `pix` (None = free end)
    cycle: bool = False
    alive: bool = True

    @property
    def length(self) -> float:
        if len(self.pix) < 2:
            return 0.0
        d = np.diff(self.pix.astype(np.float32), axis=0)
        return float(np.sum(np.hypot(d[:, 0], d[:, 1])))


def _crossing_number(S: np.ndarray) -> np.ndarray:
    P = np.pad(S, 1)
    H, W = S.shape
    ring = [P[1 + dy : 1 + dy + H, 1 + dx : 1 + dx + W] for dy, dx in _RING]
    trans = np.zeros(S.shape, dtype=np.uint8)
    for i in range(8):
        trans += ((ring[i] == 0) & (ring[(i + 1) % 8] == 1)).astype(np.uint8)
    return trans


def _walk_chain(pixels: set[tuple[int, int]]) -> list[list[tuple[int, int]]]:
    """Order the pixels of one 8-connected thin chain; returns one or more ordered runs (leftovers as extra runs)."""
    runs: list[list[tuple[int, int]]] = []
    remaining = set(pixels)

    def degree(p: tuple[int, int]) -> int:
        y, x = p
        return sum((y + dy, x + dx) in remaining for dy, dx in _N8)

    while remaining:
        ends = [p for p in remaining if degree(p) <= 1]
        start = min(ends) if ends else min(remaining)
        run = [start]
        remaining.discard(start)
        cur = start
        while True:
            y, x = cur
            nxt = None
            for dy, dx in _N4:
                q = (y + dy, x + dx)
                if q in remaining:
                    nxt = q
                    break
            if nxt is None:
                for dy, dx in _D4:
                    q = (y + dy, x + dx)
                    if q in remaining:
                        nxt = q
                        break
            if nxt is None:
                break
            run.append(nxt)
            remaining.discard(nxt)
            cur = nxt
        runs.append(run)
    return runs


class _Graph:
    """Skeleton graph of one component crop: nodes (junction clusters) and edges (ordered pixel chains)."""

    def __init__(self, skel: np.ndarray, merge_px: float) -> None:
        S = (skel > 0).astype(np.uint8)
        self.shape = S.shape
        trans = _crossing_number(S)
        junc = (S == 1) & (trans >= 3)
        if junc.any():
            jd = cv2.dilate(junc.astype(np.uint8), _ellipse(int(2 * round(merge_px) + 1)))
            node_region = ((S == 1) & (jd > 0)).astype(np.uint8)
        else:
            node_region = np.zeros_like(S)
        n_nodes, node_lab = cv2.connectedComponents(node_region, connectivity=8)
        self.node_lab = node_lab
        self.centers: dict[int, np.ndarray] = {}
        if n_nodes > 1:
            ys, xs = np.nonzero(junc)
            labs = node_lab[ys, xs]
            for nid in range(1, n_nodes):
                sel = labs == nid
                if np.any(sel):
                    self.centers[nid] = np.array([float(xs[sel].mean()), float(ys[sel].mean())], dtype=np.float32)
                else:  # cannot happen (every node holds a junction pixel); keep the region mean as a guard
                    ry, rx = np.nonzero(node_lab == nid)
                    self.centers[nid] = np.array([float(rx.mean()), float(ry.mean())], dtype=np.float32)
        self.parent: dict[int, int] = {nid: nid for nid in self.centers}

        edge_px = ((S == 1) & (node_region == 0)).astype(np.uint8)
        n_edges, edge_lab = cv2.connectedComponents(edge_px, connectivity=8)
        self.edges: list[_Edge] = []
        if n_edges > 1:
            ys, xs = np.nonzero(edge_lab)
            labs = edge_lab[ys, xs]
            order = np.argsort(labs, kind="stable")
            ys, xs, labs = ys[order], xs[order], labs[order]
            bounds = np.flatnonzero(np.diff(labs)) + 1
            for gy, gx in zip(np.split(ys, bounds), np.split(xs, bounds)):
                pixels = set(zip(gy.tolist(), gx.tolist()))
                runs = _walk_chain(pixels)
                main = max(runs, key=len)
                for run in runs:
                    if run is not main and len(run) < 3:
                        continue  # thinning debris next to a chain; its ink is covered by the chain's width
                    self._add_edge(run)

    # -- construction ------------------------------------------------------------------------------

    def _adjacent_node(self, p: tuple[int, int], exclude: int | None = None) -> int | None:
        y, x = p
        H, W = self.shape
        found: dict[int, int] = {}
        for dy, dx in _N8:
            yy, xx = y + dy, x + dx
            if 0 <= yy < H and 0 <= xx < W:
                nid = int(self.node_lab[yy, xx])
                if nid > 0 and nid != exclude:
                    found[nid] = found.get(nid, 0) + 1
        if not found:
            return None
        return max(found, key=lambda k: found[k])

    def _add_edge(self, run: list[tuple[int, int]]) -> None:
        pix = np.array(run, dtype=np.int32).reshape(-1, 2)
        a = self._adjacent_node(run[0])
        # A one-pixel run touching two nodes bridges them; touching one node it is a stub with a free end.
        b = self._adjacent_node(run[-1], exclude=a if len(run) == 1 else None)
        cycle = False
        if a is None and b is None and len(run) >= 4:
            (y0, x0), (y1, x1) = run[0], run[-1]
            cycle = max(abs(y0 - y1), abs(x0 - x1)) <= 1
        self.edges.append(_Edge(pix=pix, ends=[a, b], cycle=cycle))

    # -- node bookkeeping --------------------------------------------------------------------------

    def find(self, nid: int) -> int:
        while self.parent[nid] != nid:
            self.parent[nid] = self.parent[self.parent[nid]]
            nid = self.parent[nid]
        return nid

    def node_of(self, e: _Edge, end: int) -> int | None:
        nid = e.ends[end]
        return None if nid is None else self.find(nid)

    def center(self, nid: int) -> np.ndarray:
        return self.centers[self.find(nid)]

    def degrees(self) -> dict[int, int]:
        deg: dict[int, int] = {}
        for e in self.edges:
            if not e.alive:
                continue
            for end in (0, 1):
                nid = self.node_of(e, end)
                if nid is not None:
                    deg[nid] = deg.get(nid, 0) + 1
        return deg

    def end_length(self, e: _Edge) -> float:
        """Edge length plus the gaps to the node centres it attaches to."""
        L = e.length
        for end, idx in ((0, 0), (1, -1)):
            nid = self.node_of(e, end)
            if nid is not None:
                y, x = e.pix[idx]
                c = self.center(nid)
                L += float(math.hypot(c[0] - x, c[1] - y))
        return L

    # -- simplification ----------------------------------------------------------------------------

    def contract_bridges(self, max_len: float) -> None:
        """Short edges between two different nodes are junction artifacts of thick strokes: merge the nodes."""
        for e in self.edges:
            if not e.alive or e.cycle:
                continue
            a, b = self.node_of(e, 0), self.node_of(e, 1)
            if a is None or b is None:
                continue
            if a == b:  # a loop no longer than the stroke is wide: a pinhole in the ink, not a drawn loop
                if e.length <= max_len:
                    e.alive = False
                continue
            if self.end_length(e) <= max_len:
                ca, cb = self.centers[a], self.centers[b]
                self.parent[b] = a
                self.centers[a] = (ca + cb) / 2.0
                e.alive = False

    def prune_spurs(self, dt: np.ndarray, thr_px: float, keep_protrusion_px: float, rounds: int = 2) -> None:
        """Remove skeleton spurs: short edges from a junction to a free end that stay inside the host stroke.

        At a node where every edge is a spur (a tiny letter), the two longest stay so the mark keeps a stroke.
        """
        H, W = self.shape
        for _ in range(rounds):
            deg = self.degrees()
            spurs: dict[int, list[tuple[float, _Edge]]] = {}
            for e in self.edges:
                if not e.alive or e.cycle:
                    continue
                a, b = self.node_of(e, 0), self.node_of(e, 1)
                if (a is None) == (b is None):
                    continue  # isolated stroke or bridge: never a spur
                nid = a if a is not None else b
                assert nid is not None
                L = self.end_length(e)
                if L >= thr_px:
                    continue
                c = self.center(nid)
                cy, cx = int(round(float(c[1]))), int(round(float(c[0])))
                dt_node = float(dt[min(max(cy, 0), H - 1), min(max(cx, 0), W - 1)])
                if L - dt_node >= keep_protrusion_px:
                    continue  # a real short stroke (arrow barb, letter part), not a thickness artifact
                spurs.setdefault(nid, []).append((L, e))
            changed = False
            for nid, lst in spurs.items():
                d = deg.get(nid, 0)
                if d < 3:
                    continue
                lst.sort(key=lambda t: t[0])
                others = d - len(lst)
                kill = lst if others >= 1 else lst[: max(0, len(lst) - 2)]
                for _, e in kill:
                    e.alive = False
                    changed = True
            if not changed:
                break

    # -- pairing and chaining ----------------------------------------------------------------------

    def _half_dir(self, e: _Edge, end: int, nid: int, look_px: float) -> np.ndarray:
        """Unit direction leaving node `nid` along edge `e` from its `end`."""
        pix = e.pix if end == 0 else e.pix[::-1]
        pts = pix[:, ::-1].astype(np.float32)  # (x, y)
        c = self.center(nid)
        if len(pts) >= 2:
            d = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))
            cum = np.concatenate([[0.0], np.cumsum(d)])
            i = int(np.searchsorted(cum, min(look_px, float(cum[-1]))))
            target = pts[min(i, len(pts) - 1)]
        else:
            target = pts[0]
        v = target - c
        n = float(np.hypot(v[0], v[1]))
        if n < 1e-6:
            v = pts[-1] - c
            n = float(np.hypot(v[0], v[1]))
        return v / n if n > 1e-6 else np.array([1.0, 0.0], dtype=np.float32)

    def pairings(self, look_px: float, turn_deg: float) -> dict[tuple[int, int], tuple[int, int]]:
        """(edge index, end) -> (edge index, end) for half-edges continued through a node."""
        incident: dict[int, list[tuple[int, int]]] = {}
        for i, e in enumerate(self.edges):
            if not e.alive:
                continue
            for end in (0, 1):
                nid = self.node_of(e, end)
                if nid is not None:
                    incident.setdefault(nid, []).append((i, end))
        pair: dict[tuple[int, int], tuple[int, int]] = {}
        for nid, halves in incident.items():
            if len(halves) == 2:
                a, b = halves
                pair[a] = b
                pair[b] = a
                continue
            if len(halves) < 2:
                continue
            dirs = {h: self._half_dir(self.edges[h[0]], h[1], nid, look_px) for h in halves}
            options: list[tuple[float, tuple[int, int], tuple[int, int]]] = []
            for i in range(len(halves)):
                for j in range(i + 1, len(halves)):
                    ha, hb = halves[i], halves[j]
                    cosang = float(np.clip(np.dot(dirs[ha], dirs[hb]), -1.0, 1.0))
                    turn = 180.0 - math.degrees(math.acos(cosang))
                    if turn < turn_deg:
                        options.append((turn, ha, hb))
            options.sort(key=lambda t: t[0])
            used: set[tuple[int, int]] = set()
            for _, ha, hb in options:
                if ha in used or hb in used:
                    continue
                pair[ha] = hb
                pair[hb] = ha
                used.update((ha, hb))
        return pair

    def chains(self, look_px: float, turn_deg: float) -> list[tuple[list[tuple[int, int]], bool]]:
        """Maximal chains of (edge index, entry end) and whether each chain is closed."""
        pair = self.pairings(look_px, turn_deg)
        visited: set[int] = set()
        out: list[tuple[list[tuple[int, int]], bool]] = []

        def walk(i: int, enter: int) -> tuple[list[tuple[int, int]], bool]:
            seq: list[tuple[int, int]] = []
            cur, ent = i, enter
            closed = False
            while True:
                visited.add(cur)
                seq.append((cur, ent))
                nxt = pair.get((cur, 1 - ent))
                if nxt is None:
                    break
                j, end_j = nxt
                if j in visited:
                    closed = (j, end_j) == (seq[0][0], seq[0][1])
                    break
                cur, ent = j, end_j
            return seq, closed

        alive = [i for i, e in enumerate(self.edges) if e.alive]
        for i in alive:  # chains that start at a free end or an unpaired junction end
            if i in visited:
                continue
            for end in (0, 1):
                if i not in visited and (i, end) not in pair:
                    out.append(walk(i, end))
        for i in alive:  # what is left is closed
            if i in visited:
                continue
            e = self.edges[i]
            seq, closed = walk(i, 0)
            out.append((seq, closed or e.cycle))
        return out


# ======================================================================================================
# Component vectorization
# ======================================================================================================


def _running_median(v: np.ndarray, window: int) -> np.ndarray:
    n = len(v)
    if n < 3 or window < 3:
        return v
    h = window // 2
    padded = np.pad(v, h, mode="edge")
    idx = np.arange(n)[:, None] + np.arange(window)[None, :]
    return np.median(padded[idx], axis=1)


def _dot_from(crop: np.ndarray, to_cells: Callable[[float, float], tuple[float, float]], ppc: float) -> RawStroke:
    m = cv2.moments(crop, binaryImage=True)
    area = float(m["m00"])
    if area <= 0:
        ys, xs = np.nonzero(crop)
        cx, cy = float(xs.mean()), float(ys.mean())
        area = float(len(xs))
    else:
        cx, cy = float(m["m10"] / area), float(m["m01"] / area)
    d = 2.0 * math.sqrt(area / math.pi) / ppc
    x, y = to_cells(cx, cy)
    return RawStroke(kind="dot", pts=[(q64(x), q64(y))], w=[q64(max(d, 1.0 / QUANT))], closed=True, length=0.0)


def _blob_from(
    region: np.ndarray, dt: np.ndarray, to_cells: Callable[[float, float], tuple[float, float]], P: VecParams
) -> list[RawStroke]:
    out: list[RawStroke] = []
    contours, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    skel = cv2.ximgproc.thinning(region, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN) > 0
    vals = dt[skel & (region > 0)]
    w_px = max(1.0, 2.0 * float(np.median(vals)) - 1.0) if vals.size else max(1.0, 2.0 * float(dt[region > 0].max()) - 1.0)
    for c in contours:
        if len(c) < 3:
            continue
        approx = cv2.approxPolyDP(c, max(1.0, P.blob_approx_eps_c * P.ppc), True).reshape(-1, 2)
        if len(approx) < 3:
            box = cv2.boxPoints(cv2.minAreaRect(c))
            approx = box.reshape(-1, 2)
        pts = [to_cells(float(x), float(y)) for x, y in approx]
        pts_q = [(q64(x), q64(y)) for x, y in pts]
        arr = np.array(pts_q, dtype=np.float64)
        out.append(
            RawStroke(kind="blob", pts=pts_q, w=[q64(w_px / P.ppc)], closed=True, length=polyline_length(arr, True))
        )
    return out


def _extend_end(
    p: np.ndarray, toward_inside: np.ndarray, mask: np.ndarray, dt: np.ndarray, max_dt: float
) -> np.ndarray | None:
    """Walk from end point p (x, y) outward (away from `toward_inside`) while still on ink; None if < 1 px."""
    H, W = mask.shape
    v = p - toward_inside
    n = float(np.hypot(v[0], v[1]))
    if n < 1e-6:
        return None
    v = v / n
    y0, x0 = int(round(float(p[1]))), int(round(float(p[0])))
    if not (0 <= y0 < H and 0 <= x0 < W):
        return None
    limit = max(1.0, max_dt * float(dt[y0, x0]))
    best = None
    s = 0.5
    while s <= limit:
        q = p + v * s
        yy, xx = int(round(float(q[1]))), int(round(float(q[0])))
        if not (0 <= yy < H and 0 <= xx < W) or mask[yy, xx] == 0:
            break
        best = q
        s += 0.5
    if best is None or float(np.hypot(*(best - p))) < 1.0:
        return None
    return best


def _lines_from(
    thin: np.ndarray,
    full: np.ndarray,
    dt: np.ndarray,
    to_cells: Callable[[float, float], tuple[float, float]],
    P: VecParams,
) -> tuple[list[RawStroke], int, float]:
    """Skeleton strokes of `thin` (widths and end extension measured on `full`). Returns strokes, skeleton px, w_px."""
    skel = cv2.ximgproc.thinning(thin, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN)
    S = skel > 0
    n_sk = int(S.sum())
    if n_sk == 0:
        return [], 0, 1.0
    widths_all = np.maximum(1.0, 2.0 * dt[S] - 1.0)
    w_med = float(np.median(widths_all))
    g = _Graph(skel, merge_px=max(P.junction_merge_px, 0.25 * w_med))
    g.contract_bridges(max_len=max(2.0 * P.junction_merge_px, w_med))
    g.prune_spurs(
        dt,
        thr_px=max(P.spur_min_c * P.ppc, P.spur_min_w * w_med),
        keep_protrusion_px=P.spur_keep_protrusion_c * P.ppc,
    )
    look = max(2.0 * w_med, 0.5 * P.ppc)
    deg = g.degrees()  # a node left with one edge after pruning is a stroke end (the old fork point)
    H, W = dt.shape
    strokes: list[RawStroke] = []
    for seq, closed in g.chains(look_px=look, turn_deg=P.turn_deg):
        parts: list[np.ndarray] = []  # (x, y) px blocks
        flags: list[np.ndarray] = []  # True where the point is a junction centre
        first_e, first_ent = seq[0]
        start_node = g.node_of(g.edges[first_e], first_ent)
        if start_node is not None:  # a closed chain passes through it once, at the start
            parts.append(g.center(start_node).astype(np.float64).reshape(1, 2))
            flags.append(np.ones(1, dtype=bool))
        for k, (i, ent) in enumerate(seq):
            e = g.edges[i]
            pix = e.pix if ent == 0 else e.pix[::-1]
            parts.append(pix[:, ::-1].astype(np.float64))
            flags.append(np.zeros(len(pix), dtype=bool))
            exit_node = g.node_of(e, 1 - ent)
            last = k == len(seq) - 1
            if exit_node is not None and (not last or not closed):
                parts.append(g.center(exit_node).astype(np.float64).reshape(1, 2))
                flags.append(np.ones(1, dtype=bool))
        if not parts:
            continue
        arr = np.vstack(parts)
        is_node = np.concatenate(flags).tolist()
        # widths: 2·DT − 1 px at each skeleton pixel; node centres take their neighbours' widths
        yy = np.clip(np.rint(arr[:, 1]).astype(np.int64), 0, H - 1)
        xx = np.clip(np.rint(arr[:, 0]).astype(np.int64), 0, W - 1)
        wpx = np.maximum(1.0, 2.0 * dt[yy, xx].astype(np.float64) - 1.0)
        node_idx = [j for j, f in enumerate(is_node) if f]
        for j in node_idx:
            neigh = [wpx[k] for k in (j - 2, j - 1, j + 1, j + 2) if 0 <= k < len(arr) and not is_node[k]]
            if neigh:
                wpx[j] = min(neigh)
        wpx = _running_median(wpx, P.width_median_window)
        # free ends reach the real end of the ink (the skeleton stops about w/2 short)
        if not closed and len(arr) >= 2:
            back = min(len(arr) - 1, max(1, int(look)))
            if start_node is None or deg.get(start_node, 0) == 1:
                ext = _extend_end(arr[0], arr[back], full, dt, P.end_extend_max_dt)
                if ext is not None:
                    arr = np.vstack([ext[None, :], arr])
                    wpx = np.concatenate([[wpx[0]], wpx])
            last_e, last_ent = seq[-1]
            end_node = g.node_of(g.edges[last_e], 1 - last_ent)
            if end_node is None or deg.get(end_node, 0) == 1:
                ext = _extend_end(arr[-1], arr[-1 - back], full, dt, P.end_extend_max_dt)
                if ext is not None:
                    arr = np.vstack([arr, ext[None, :]])
                    wpx = np.concatenate([wpx, [wpx[-1]]])
        length_px = polyline_length(arr, closed)
        if len(arr) == 1 or length_px < 1.0:
            x, y = to_cells(float(arr[:, 0].mean()), float(arr[:, 1].mean()))
            strokes.append(
                RawStroke(kind="dot", pts=[(q64(x), q64(y))], w=[q64(float(wpx.max()) / P.ppc)], closed=True)
            )
            continue
        eps = P.rdp_eps_c * P.ppc
        if closed:
            loop = np.vstack([arr, arr[:1]])
            keep = rdp_indices(loop, eps)
            keep = keep[keep < len(arr)]
        else:
            keep = rdp_indices(arr, eps)
        sel = arr[keep]
        wsel = wpx[keep]
        w_c = float(np.median(wpx)) / P.ppc
        cells = np.array([to_cells(float(x), float(y)) for x, y in sel], dtype=np.float64)
        length_c = polyline_length(cells, closed)
        if not closed and len(cells) >= 3:
            gap = float(np.hypot(*(cells[0] - cells[-1])))
            if (
                length_c >= 1.0
                and gap <= max(P.closed_gap_c, P.closed_gap_w * w_c)
                and gap <= 0.35 * length_c
            ):
                closed = True
                if gap < 0.5 / QUANT * 8:  # the ends coincide: drop the duplicate
                    cells, wsel = cells[:-1], wsel[:-1]
                length_c = polyline_length(cells, True)
        if len(cells) < 2:
            x, y = cells[0]
            strokes.append(
                RawStroke(kind="dot", pts=[(q64(x), q64(y))], w=[q64(float(wsel.max()) / P.ppc)], closed=True)
            )
            continue
        strokes.append(
            RawStroke(
                kind="line",
                pts=[(q64(x), q64(y)) for x, y in cells],
                w=[q64(max(float(v) / P.ppc, 1.0 / QUANT)) for v in wsel],
                closed=closed,
                length=length_c,
            )
        )
    return strokes, n_sk, w_med


def vectorize_crop(crop: np.ndarray, P: VecParams, to_cells: Callable[[float, float], tuple[float, float]]) -> tuple[
    list[RawStroke], ContourInfo, float, int
]:
    """One component crop (uint8 0/255, zero border) -> strokes, contour info, median width (cells), skeleton px."""
    ppc = P.ppc
    ys, xs = np.nonzero(crop)
    area_px = float(len(xs))
    bw = float(xs.max() - xs.min() + 1)
    bh = float(ys.max() - ys.min() + 1)
    side_c = max(bw, bh) / ppc
    fill = area_px / (bw * bh)
    cinfo = contour_info(crop, ppc, P.hole_min_c2)
    no_hole = not cinfo.holes_area_c2
    roundish = max(bw, bh) / min(bw, bh) <= P.dot_max_aspect  # a short straight dash stays a line
    is_dot = roundish and (
        (side_c <= P.dot_max_side_c and fill >= P.dot_min_fill)
        or (side_c <= P.tap_dot_max_side_c and fill >= P.tap_dot_min_fill and cinfo.circ >= P.tap_dot_min_circ and no_hole)
    )
    if is_dot:
        d = _dot_from(crop, to_cells, ppc)
        return [d], cinfo, d.w[0], 0

    dt = cv2.distanceTransform(crop, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    skel = cv2.ximgproc.thinning(crop, thinningType=cv2.ximgproc.THINNING_ZHANGSUEN) > 0
    sk_vals = dt[skel]
    if sk_vals.size == 0:
        d = _dot_from(crop, to_cells, ppc)
        return [d], cinfo, d.w[0], 0
    r_px = P.blob_dt_c * ppc
    frac = float(np.mean(sk_vals > r_px))
    w_all = float(np.median(np.maximum(1.0, 2.0 * sk_vals - 1.0))) / ppc
    big_hole = any(a > P.blob_hole_max_c2 for a in cinfo.holes_area_c2)
    if frac >= P.blob_skeleton_frac and not big_hole:
        return _blob_from(crop, dt, to_cells, P), cinfo, w_all, int(skel.sum())

    strokes: list[RawStroke] = []
    thin = crop
    if float(dt.max()) > r_px:
        # A filled core inside a mostly thin component (a coloured-in hill with a line running on): blob + lines.
        core = cv2.morphologyEx(crop, cv2.MORPH_OPEN, _ellipse(int(2 * r_px + 1)))
        if float(np.count_nonzero(core)) / (ppc * ppc) >= P.blob_core_min_c2:
            n, lab, stats, _ = cv2.connectedComponentsWithStats(core, connectivity=8)
            keep = np.zeros_like(crop)
            for i in range(1, n):
                if float(stats[i, cv2.CC_STAT_AREA]) / (ppc * ppc) >= 0.5 * P.blob_core_min_c2:
                    keep[lab == i] = 255
            if keep.any():
                region = cv2.bitwise_and(crop, cv2.dilate(keep, _ellipse(int(2 * r_px + 3))))
                strokes.extend(_blob_from(region, dt, to_cells, P))
                thin = cv2.bitwise_and(crop, cv2.bitwise_not(region))
                n2, lab2, stats2, _ = cv2.connectedComponentsWithStats(thin, connectivity=8)
                kept = np.zeros_like(crop)
                for i in range(1, n2):
                    if float(stats2[i, cv2.CC_STAT_AREA]) / (ppc * ppc) >= P.min_mark_area_c2:
                        kept[lab2 == i] = 255  # slivers under that size sit inside the blob outline
                thin = kept
    lines, n_sk, _ = _lines_from(thin, crop, dt, to_cells, P) if thin.any() else ([], 0, 1.0)
    strokes.extend(lines)
    if not strokes:
        d = _dot_from(crop, to_cells, ppc)
        return [d], cinfo, d.w[0], 0
    return strokes, cinfo, w_all, max(n_sk, int(skel.sum()))


def vectorize_masks(
    masks: dict[str, np.ndarray],
    ppc: float,
    *,
    offset_cells: tuple[float, float] = (0.0, 0.0),
    sheet: int = 0,
    origin: str = "kid",
    params: VecParams | None = None,
) -> VecResult:
    """Every ink mask of one drawing area -> RawComponents in world cells (x + offset, y + offset)."""
    P = params or VecParams.from_spec(ppc)
    res = VecResult()
    min_px = P.min_mark_area_c2 * ppc * ppc
    pad = 2
    for color, mask in masks.items():
        if mask is None or not mask.any():
            continue
        m = np.ascontiguousarray(mask, dtype=np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8, ltype=cv2.CV_32S)
        for i in range(1, n):
            x, y = int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP])
            w, h = int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT])
            area = float(stats[i, cv2.CC_STAT_AREA])
            if area < min_px:
                res.noise += 1
                continue
            crop = np.zeros((h + 2 * pad, w + 2 * pad), dtype=np.uint8)
            crop[pad : pad + h, pad : pad + w] = (labels[y : y + h, x : x + w] == i).astype(np.uint8) * 255
            ox = offset_cells[0] + (x - pad) / ppc
            oy = offset_cells[1] + (y - pad) / ppc

            def to_cells(px: float, py: float, _ox: float = ox, _oy: float = oy) -> tuple[float, float]:
                return _ox + (px + 0.5) / ppc, _oy + (py + 0.5) / ppc

            strokes, cinfo, w_c, n_sk = vectorize_crop(crop, P, to_cells)
            bbox = (
                q64(offset_cells[0] + x / ppc),
                q64(offset_cells[1] + y / ppc),
                q64(offset_cells[0] + (x + w) / ppc),
                q64(offset_cells[1] + (y + h) / ppc),
            )
            res.components.append(
                RawComponent(
                    color=color,
                    strokes=strokes,
                    bbox=bbox,
                    area=area / (ppc * ppc),
                    mask=crop,
                    crop_origin_cells=(ox, oy),
                    ppc=ppc,
                    sheet=sheet,
                    width_c=w_c,
                    contour=cinfo,
                    skeleton_px=n_sk,
                    origin=origin,
                )
            )
    return res
