"""Multi-sheet stitching (PLAN_V2 §6.4 "Scanning" and "Seams", §6.5 remix and extend). Lane C.

A pack is printed as k sheets and photographed in any order (the scan screen's pack tray). This module decides
where every photo goes in the world, and assembles one InkDoc from the sheets (and, for a remix or an extension,
from the parent level's own strokes).

1. **Where each photo goes** (`place_sheets`).
   - The QR v2 code `dal2|p|<pack>|n/k` gives n. v1 `dal1|…` sheets are a 1-sheet pack.
   - When the QR cannot be read, the printed pack map is read instead (`read_pack_map`). Sheets 2..k print k boxes
     with box n filled, at `spec_v2.pack_map_boxes_px(k)`, so n and k come back without the QR. A sheet that shows
     the character and rules boxes is sheet 1 (`has_first_sheet_layout`).
   - Photos that are still unknown are placed by **seam continuity**: every way of putting them into the free slots
     is tried, and the one whose stroke ends meet the neighbours' ends best wins (same colour, |Δy| ≤ 3 cells; an
     unmatched end costs 1.5 cells). Ties keep the photo order.
   - Two photos of one sheet: the newest wins. Sheets beyond k are skipped with a warning.
   - A missing sheet becomes an empty screen with a warning, except in a remix: every sheet that was not scanned keeps
     the parent's screen unchanged ("scanning any subset of sheets changes only those screens").
2. **World x.** Sheet n covers world x ∈ [48·(n−1), 48·n). An *extend* sheet is one page whose two leftmost columns
   show the parent's last two columns in gray; its drawing area therefore starts at world x = 48·k_parent − 2 and it
   adds screen k_parent + 1 (the world's last two columns stay empty).
3. **Parent ink** (remix, extend). The parent prints in gray, which the classifier reads as paper, so it never comes
   back from the photo. The parent's own strokes are added with origin `parent` (ids p1..), in the parent's own
   components, the way the canvas remix loads them (web/src/app/screens/draw.ts). The core's N10 dedupe then keeps
   the parent's object over a kid's retrace, and an untouched remix sheet adds no object and no coin.
4. **Seams** (`seam_reports`). Stroke ends that meet across a seam (both within 0.75 cell of it, |Δy| ≤ 1 cell, same
   colour) are listed per seam; the core's N11 `join_seam` joins those surfaces as a visible, undoable edit. Unmatched
   ends stay real gaps. The ink itself is never merged here: every change to the drawing is an edit with a card.
"""
from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Sequence

import cv2
import numpy as np

from app.cv.features import assemble, components_from_strokes, make_component, route_order_key, to_ink_stroke
from app.spec.common import MessageRef
from app.spec.ink import CharacterInk, InkComponent, InkStroke, ParentRef, SheetInfo
from app.template import spec_v2

if TYPE_CHECKING:
    from app.cv.scan_v2 import PackInfo, SheetScan

W = spec_v2.SCREEN_W_CELLS
KNOWN_SOURCES = ("qr", "pack_map", "layout")


# ======================================================================================================
# Reading a sheet's place without its QR
# ======================================================================================================


@dataclass(frozen=True)
class PackMapRead:
    """The pack map on a sheet 2..k: k boxes, box n filled. `n` is None when no box is clearly the filled one."""

    n: int | None
    k: int
    score: float  # the weakest box edge found, 0..1


def _edge_strength(dil: np.ndarray, rect: tuple[int, int, int, int]) -> float:
    """Fraction of sample points on the weakest of the rectangle's 4 edges that lie on (dilated) dark ink."""
    x, y, w, h = rect
    H, Wd = dil.shape[:2]
    if w < 8 or h < 8 or x < 0 or y < 0 or x + w >= Wd or y + h >= H:
        return 0.0
    xs = np.linspace(x + 0.1 * w, x + 0.9 * w, 24).astype(int)
    ys = np.linspace(y + 0.1 * h, y + 0.9 * h, 16).astype(int)
    edges = (dil[y, xs], dil[y + h, xs], dil[ys, x], dil[ys, x + w])
    return float(min(float(e.mean()) for e in edges))


def _dark_dilated(gray: np.ndarray, region: tuple[int, int, int, int], below_paper: float, band_px: int) -> np.ndarray:
    x, y, w, h = region
    roi = gray[max(0, y) : y + h, max(0, x) : x + w]
    paper = float(np.percentile(roi, 90)) if roi.size else 240.0
    dark = (gray < paper - below_paper).astype(np.uint8)
    return cv2.dilate(dark, np.ones((2 * band_px + 1, 2 * band_px + 1), np.uint8))


def read_pack_map(sheet_bgr: np.ndarray) -> PackMapRead | None:
    """n and k from the printed pack map of a rectified sheet (the QR fallback), or None when there is no pack map.

    For every k the box outlines must all be there, and for the box sizes k = 2..4 share, the box after the last must
    be absent. The filled box is the one whose interior is clearly darker than every other box's.
    """
    p = spec_v2.pack_map_read_params()
    gray = cv2.cvtColor(sheet_bgr, cv2.COLOR_BGR2GRAY)
    mx, my, mw, mh = spec_v2.pack_map_px()
    band = max(3, spec_v2.mm_to_px(float(p.get("edge_band_mm", 0.7))))
    dil = _dark_dilated(gray, (mx, my, mw, mh), float(p.get("dark_below_paper", 35)), band)
    present, absent = float(p.get("edge_present", 0.7)), float(p.get("edge_absent", 0.3))
    best: tuple[float, int, int | None] | None = None
    for k in range(2, spec_v2.MAX_SHEETS + 1):
        boxes = spec_v2.pack_map_boxes_px(k)
        score = min(_edge_strength(dil, r) for r in boxes)
        if score < present:
            continue
        lx, ly, lw, lh = boxes[-1]
        step = boxes[1][0] - boxes[0][0]
        nxt = (lx + step, ly, lw, lh)
        if nxt[0] + lw <= mx + mw and _edge_strength(dil, nxt) > absent:
            continue  # a longer pack with the same box size
        meds = []
        for x, y, w, h in boxes:
            i = max(2, int(0.12 * min(w, h)))
            meds.append(float(np.median(gray[y + i : y + h - i, x + i : x + w - i])))
        order = sorted(range(k), key=lambda j: meds[j])
        margin = meds[order[1]] - meds[order[0]]
        n = order[0] + 1 if margin >= float(p.get("fill_margin", 8)) else None
        if best is None or score > best[0] + 1e-9:
            best = (score, k, n)
    if best is None:
        return None
    return PackMapRead(n=best[2], k=best[1], score=best[0])


def has_first_sheet_layout(sheet_bgr: np.ndarray) -> bool:
    """True when the character box and the rules box frames are printed (only sheet 1 has them)."""
    gray = cv2.cvtColor(sheet_bgr, cv2.COLOR_BGR2GRAY)
    band = max(3, spec_v2.mm_to_px(0.7))
    cb, rb = spec_v2.character_box_px(), spec_v2.rules_box_px()
    region = (cb[0], cb[1], rb[0] + rb[2] - cb[0], max(cb[3], rb[3]))
    dil = _dark_dilated(gray, region, 25.0, band)
    return min(_edge_strength(dil, cb), _edge_strength(dil, rb)) >= 0.7


# ======================================================================================================
# Moving a scanned sheet in the world
# ======================================================================================================


def shift_scan(s: "SheetScan", *, n: int, x0: float, screen: int) -> None:
    """Put a scanned sheet at sheet number n, drawing-area x0 (world cells) and 0-based screen index `screen`."""
    dx = float(x0) - float(s.x0)
    if dx:
        for rc in s.raws:
            bx0, by0, bx1, by1 = rc.bbox
            rc.bbox = (bx0 + dx, by0, bx1 + dx, by1)
            ox, oy = rc.crop_origin_cells
            rc.crop_origin_cells = (ox + dx, oy)
            for st in rc.strokes:
                st.pts = [(x + dx, y) for x, y in st.pts]
        for st, _ in s.rules:
            st.pts = [(x + dx, y) for x, y in st.pts]
    for rc in s.raws:
        rc.sheet = screen
    if n != s.n:
        for w in s.warnings:
            if "n" in w.args:
                w.args["n"] = n
    s.n, s.x0, s.screen = n, float(x0), screen


def drop_first_sheet_boxes(s: "SheetScan") -> None:
    """A photo placed at sheet 2+ has no character or rules box: whatever was read there was the pack map."""
    s.character = []
    s.rules = []
    s.files.pop("character", None)


# ======================================================================================================
# Seam continuity (placing photos without a QR)
# ======================================================================================================


def _edge_ends(s: "SheetScan", side: Literal["left", "right"]) -> list[tuple[float, str]]:
    """(y, colour) of every line end within edge_band_c of the sheet's left or right edge (sheet-local x)."""
    band = float(spec_v2.stitch_params().get("edge_band_c", 1.5))
    out: list[tuple[float, str]] = []
    for rc in s.raws:
        for st in rc.strokes:
            if st.kind != "line" or len(st.pts) < 2:
                continue
            for x, y in (st.pts[0], st.pts[-1]):
                lx = x - s.x0
                if (side == "left" and lx <= band) or (side == "right" and lx >= W - band):
                    out.append((float(y), rc.color))
    return out


def seam_cost(right_ends: Sequence[tuple[float, str]], left_ends: Sequence[tuple[float, str]]) -> float:
    """How badly sheet A's right edge (right_ends) meets sheet B's left edge (left_ends), in cells."""
    sp = spec_v2.stitch_params()
    max_dy, unmatched = float(sp.get("max_dy_c", 3.0)), float(sp.get("unmatched_cost", 1.5))
    cand = sorted(
        (abs(ya - yb), i, j)
        for i, (ya, ca) in enumerate(right_ends)
        for j, (yb, cb) in enumerate(left_ends)
        if ca == cb and abs(ya - yb) <= max_dy
    )
    ui: set[int] = set()
    uj: set[int] = set()
    cost = 0.0
    for d, i, j in cand:
        if i in ui or j in uj:
            continue
        ui.add(i)
        uj.add(j)
        cost += d
    return cost + unmatched * ((len(right_ends) - len(ui)) + (len(left_ends) - len(uj)))


def _assign_by_seams(
    unknown: Sequence["SheetScan"], free: Sequence[int], fixed: dict[int, "SheetScan"], k: int
) -> dict[int, "SheetScan"]:
    """The cheapest placement of the unknown photos into the free slots (≤ 6 of each: brute force)."""
    if not unknown or not free:
        return {}
    sp = spec_v2.stitch_params()
    not_first = float(sp.get("not_first_prior", 2.0))
    ends = {id(s): (_edge_ends(s, "left"), _edge_ends(s, "right")) for s in [*unknown, *fixed.values()]}
    m = min(len(unknown), len(free))
    best: tuple[float, tuple[int, ...], tuple[int, ...]] | None = None
    best_place: dict[int, "SheetScan"] = {}
    newest_first = sorted(unknown, key=lambda s: -s.photo_index)
    for subset in itertools.combinations(newest_first, m):
        for slots in itertools.permutations(free, m):
            place = dict(fixed)
            place.update(zip(slots, subset))
            moving = {id(s) for s in subset}
            cost = sum(not_first for s, n in zip(subset, slots) if n == 1 and k > 1)
            for n in range(1, k):
                a, b = place.get(n), place.get(n + 1)
                if a is None or b is None or (id(a) not in moving and id(b) not in moving):
                    continue
                cost += seam_cost(ends[id(a)][1], ends[id(b)][0])
            # ties: the newest photos, then slots in photo order
            order = tuple(n for _, n in sorted(zip([s.photo_index for s in subset], slots)))
            key = (round(cost, 6), tuple(-s.photo_index for s in subset), order)
            if best is None or key < best:
                best, best_place = key, dict(zip(slots, subset))
    return best_place


# ======================================================================================================
# Placement
# ======================================================================================================


@dataclass
class Placement:
    by_n: dict[int, "SheetScan"]  # sheet number (1-based, as printed) -> the photo used
    k: int  # sheets in the pack
    screens: int  # world screens
    inherited: list[int] = field(default_factory=list)  # 0-based screens that keep the parent's ink (remix, extend)
    missing: list[int] = field(default_factory=list)  # sheet numbers with no photo (new, game)
    unused: list["SheetScan"] = field(default_factory=list)  # photos that did not get a place
    warnings: list[MessageRef] = field(default_factory=list)
    kind: str = "new"

    @property
    def complete(self) -> bool:
        """Every sheet of the pack is there (publishing needs all k sheets, §6.4)."""
        return not self.missing

    @property
    def playable_screens(self) -> int:
        """Screens that form a contiguous run from sheet 1 (the level is playable as soon as there is one)."""
        have = {s.screen for s in self.by_n.values()} | set(self.inherited)
        n = 0
        while n in have:
            n += 1
        return n


def _parent_screens(parent: dict[str, Any] | None) -> int | None:
    if not parent:
        return None
    try:
        return max(1, min(spec_v2.MAX_SHEETS, int((parent.get("world") or {}).get("screens", 1))))
    except (TypeError, ValueError):
        return None


def place_sheets(scans: Sequence["SheetScan"], pack: "PackInfo | None", *, parent: dict[str, Any] | None) -> Placement:
    """Decide which photo is which sheet and where every sheet sits in the world (see the module docstring)."""
    warnings: list[MessageRef] = []
    kind = pack.kind if pack is not None else "new"
    kp = _parent_screens(parent) if kind in ("remix", "extend") else None
    if kind in ("remix", "extend") and kp is None:
        warnings.append(MessageRef(key="warning.parent_unavailable", args={}))
        kind = "new" if kind == "extend" else kind

    known = [s for s in scans if s.n_source in KNOWN_SOURCES]
    unknown = [s for s in scans if s.n_source not in KNOWN_SOURCES]
    if kind == "extend":
        k = 1
    elif pack is not None:
        k = int(pack.k)
    else:
        ks = [s.qr.k for s in known if s.qr is not None and s.qr.kind == "pack" and s.qr.legacy is None]
        ks += [s.k_hint for s in scans if s.k_hint]
        k = max(ks + [s.n for s in known] + [len({s.n for s in known}) + len(unknown), 1])
    k = max(1, min(spec_v2.MAX_SHEETS, k))

    by_n: dict[int, "SheetScan"] = {}
    unused: list["SheetScan"] = []
    for s in sorted(known, key=lambda s: s.photo_index):
        q = s.qr
        if (pack is not None and q is not None and q.legacy is None and not q.is_blank and pack.pack_id != "legacy"
                and q.id != pack.pack_id):
            warnings.append(MessageRef(key="warning.other_pack", args={"n": s.n}))
        if s.n > k:
            warnings.append(MessageRef(key="warning.sheet_out_of_pack", args={"n": s.n, "k": k}))
            unused.append(s)
            continue
        if s.n in by_n:
            warnings.append(MessageRef(key="warning.duplicate_sheet", args={"n": s.n}))
            unused.append(by_n[s.n])
        by_n[s.n] = s  # the newest photo of a sheet wins

    free = [n for n in range(1, k + 1) if n not in by_n]
    placed = _assign_by_seams(unknown, free, by_n, k)
    for n, s in placed.items():
        s.n_source = "seam" if len(unknown) > 1 or len(free) > 1 else "only"
        by_n[n] = s
        if n != s.n:
            shift_scan(s, n=n, x0=float(W * (n - 1)), screen=n - 1)
    chosen = {id(s) for s in placed.values()}
    for s in unknown:
        if id(s) not in chosen:
            warnings.append(MessageRef(key="warning.duplicate_sheet", args={"n": s.n}))
            unused.append(s)

    for n, s in by_n.items():
        if n != 1:
            drop_first_sheet_boxes(s)

    inherited: list[int] = []
    missing: list[int] = []
    if kind == "extend" and kp is not None:
        screens = min(spec_v2.MAX_SHEETS, kp + 1)
        overlap = float(spec_v2.seam_marks().get("extend_overlap_c", 2))
        s = by_n.get(1)
        if s is not None:
            shift_scan(s, n=1, x0=max(0.0, W * kp - overlap), screen=screens - 1)
        inherited = list(range(kp))
    elif kind == "remix" and kp is not None:
        screens = max(k, kp)
        inherited = [i for i in range(screens) if (i + 1) not in by_n]
        for n, s in by_n.items():
            s.screen = n - 1
    else:
        screens = k
        for n, s in by_n.items():
            s.screen = n - 1
        missing = [n for n in range(1, k + 1) if n not in by_n]
        for n in missing:
            warnings.append(MessageRef(key="warning.sheet_missing", args={"n": n, "k": k}))
    return Placement(by_n=by_n, k=k, screens=screens, inherited=inherited, missing=missing, unused=unused,
                     warnings=warnings, kind=kind)


# ======================================================================================================
# Parent ink (remix, extend)
# ======================================================================================================


def parent_ref(parent: dict[str, Any] | None) -> ParentRef | None:
    if not parent or not parent.get("id"):
        return None
    try:
        return ParentRef(level_id=str(parent["id"]), version=int(parent.get("version") or 1),
                         level_hash=str((parent.get("meta") or {}).get("level_hash") or ""))
    except (TypeError, ValueError):
        return None


def parent_ink(
    parent: dict[str, Any], screens: int, *, prefix: str = "p"
) -> tuple[list[InkStroke], list[InkComponent], CharacterInk | None, int]:
    """The parent level's strokes as origin-`parent` ink (rules-box handwriting left out), grouped in the parent's
    own components where they still fit, plus the parent's character. Returns (strokes, components, character,
    dropped) where `dropped` counts parent strokes that were not valid ink."""
    ink = parent.get("ink") or {}
    rules_ids = {str(i) for i in ink.get("rules_ink") or []}
    wmax = float(W * screens)
    strokes: list[InkStroke] = []
    idmap: dict[str, str] = {}
    dropped = 0
    for raw in ink.get("strokes") or []:
        if not isinstance(raw, dict) or str(raw.get("id")) in rules_ids:
            continue
        pts = raw.get("pts") or []
        try:
            x = float(pts[0][0])
        except (IndexError, TypeError, ValueError):
            dropped += 1
            continue
        new_id = f"{prefix}{len(strokes) + 1}"
        d = {key: v for key, v in raw.items() if key != "t"}
        d.update(id=new_id, origin="parent", sheet=max(0, min(screens - 1, int(math.floor(x / W)))))
        try:
            st = InkStroke.model_validate(d)
        except Exception:  # noqa: BLE001 - one bad parent stroke must not lose the scan
            dropped += 1
            continue
        if all(float(p[0]) >= wmax for p in st.pts):
            dropped += 1
            continue
        idmap[str(raw.get("id"))] = new_id
        strokes.append(st)
    by_id = {s.id: s for s in strokes}
    comps: list[InkComponent] = []
    grouped: set[str] = set()
    for c in ink.get("components") or []:
        if not isinstance(c, dict):
            continue
        ids = [idmap.get(str(sid)) for sid in c.get("stroke_ids") or []]
        if not ids or any(i is None or i in grouped for i in ids):
            continue
        members = [by_id[i] for i in ids if i is not None]
        if len({s.color for s in members}) != 1:
            continue
        comps.append(make_component(len(comps) + 1, members[0].color, members))
        grouped.update(s.id for s in members)
    rest = [s for s in strokes if s.id not in grouped]
    if rest:
        comps.extend(components_from_strokes(rest, first_component=len(comps) + 1))
    character = None
    ch = ink.get("character")
    if isinstance(ch, dict) and ch.get("strokes"):
        try:
            character = CharacterInk.model_validate(
                {"strokes": [{**s, "origin": "parent"} for s in ch["strokes"] if isinstance(s, dict)]}
            )
        except Exception:  # noqa: BLE001
            character = None
    return strokes, comps, character, dropped


def renumber_components(comps: Sequence[InkComponent], strokes: Sequence[InkStroke]) -> list[InkComponent]:
    """Component ids 1..M in route order (sheet, 2-cell column, top) across kid and parent ink."""
    sheet_of = {s.id: s.sheet for s in strokes}

    def key(c: InkComponent) -> tuple[float, ...]:
        sheet = min((sheet_of.get(sid, 0) for sid in c.stroke_ids), default=0)
        return (*route_order_key(c.bbox, sheet), c.id)

    return [c.model_copy(update={"id": i}) for i, c in enumerate(sorted(comps, key=key), start=1)]


# ======================================================================================================
# Seams
# ======================================================================================================


@dataclass(frozen=True)
class SeamPair:
    a: str  # stroke id on the left of the seam
    b: str  # stroke id on the right
    y: float  # the averaged seam point's y (cells)
    dy: float
    color: str


@dataclass
class SeamReport:
    """Stroke ends meeting at the seam x = seam_x (between screens left and left + 1): the N11 join candidates."""

    seam_x: float
    left: int  # 0-based screen on the left
    pairs: list[SeamPair] = field(default_factory=list)
    unmatched: list[tuple[str, float, str]] = field(default_factory=list)  # (stroke id, y, side) of black ends

    def as_dict(self) -> dict[str, Any]:
        return {"seam_x": self.seam_x, "left": self.left,
                "pairs": [p.__dict__ for p in self.pairs],
                "unmatched": [{"stroke": s, "y": y, "side": side} for s, y, side in self.unmatched]}


def seam_reports(strokes: Sequence[InkStroke], screens: int, *, skip: set[str] | None = None) -> list[SeamReport]:
    """For every seam: line ends within join_max_c of it on both sides, paired by colour and |Δy| ≤ join_max_dy_c."""
    sm = spec_v2.seam_marks()
    near, max_dy = float(sm.get("join_max_c", 0.75)), float(sm.get("join_max_dy_c", 1.0))
    skip = skip or set()
    out: list[SeamReport] = []
    for i in range(1, screens):
        sx = float(W * i)
        left: list[tuple[str, float, str]] = []
        right: list[tuple[str, float, str]] = []
        for s in strokes:
            if s.kind != "line" or len(s.pts) < 2 or s.id in skip:
                continue
            mean_x = sum(p[0] for p in s.pts) / len(s.pts)
            for x, y in (s.pts[0], s.pts[-1]):
                if abs(x - sx) > near:
                    continue
                if mean_x < sx:
                    left.append((s.id, float(y), s.color))
                elif mean_x > sx:
                    right.append((s.id, float(y), s.color))
        cand = sorted(
            (abs(ya - yb), ia, ib)
            for ia, (_, ya, ca) in enumerate(left)
            for ib, (_, yb, cb) in enumerate(right)
            if ca == cb and abs(ya - yb) <= max_dy
        )
        ul: set[int] = set()
        ur: set[int] = set()
        rep = SeamReport(seam_x=sx, left=i - 1)
        for d, ia, ib in cand:
            if ia in ul or ib in ur:
                continue
            ul.add(ia)
            ur.add(ib)
            (a, ya, c), (b, yb, _) = left[ia], right[ib]
            rep.pairs.append(SeamPair(a=a, b=b, y=round((ya + yb) / 2.0, 4), dy=round(d, 4), color=c))
        rep.unmatched = [(sid, y, "left") for j, (sid, y, c) in enumerate(left) if j not in ul and c == "black"]
        rep.unmatched += [(sid, y, "right") for j, (sid, y, c) in enumerate(right) if j not in ur and c == "black"]
        out.append(rep)
    return out


# ======================================================================================================
# Assembly
# ======================================================================================================


@dataclass
class Stitched:
    strokes: list[InkStroke]
    components: list[InkComponent]
    rules_ids: list[str]
    character: CharacterInk | None
    sheets: list[SheetInfo]
    screens: int
    seams: list[SeamReport]
    parent: ParentRef | None
    noise: int
    warnings: list[MessageRef] = field(default_factory=list)


def assemble_sheets(placement: Placement, *, parent: dict[str, Any] | None) -> Stitched:
    """The placed sheets (plus the parent's ink for a remix or an extension) as InkDoc parts."""
    used = sorted(placement.by_n.values(), key=lambda s: s.screen)
    warnings: list[MessageRef] = []
    raws = [rc for s in used for rc in s.raws]
    kid_strokes, kid_comps = assemble(raws, stroke_prefix="s")
    strokes: list[InkStroke] = list(kid_strokes)
    comps: list[InkComponent] = list(kid_comps)

    character: CharacterInk | None = None
    first = placement.by_n.get(1)
    if first is not None and first.character:
        character = CharacterInk(
            strokes=[to_ink_stroke(st, f"c{i}", c, 0, "kid") for i, (st, c) in enumerate(first.character, start=1)]
        )

    ref = None
    if parent is not None and placement.kind in ("remix", "extend"):
        p_strokes, p_comps, p_char, dropped = parent_ink(parent, placement.screens)
        strokes.extend(p_strokes)
        comps.extend(p_comps)
        if character is None:
            character = p_char
        if dropped:
            warnings.append(MessageRef(key="warning.parent_ink_skipped", args={"n": dropped}))
        ref = parent_ref(parent)
    comps = renumber_components(comps, strokes)

    rules_strokes: list[InkStroke] = []
    for s in used:
        for st, color in s.rules:
            rules_strokes.append(to_ink_stroke(st, f"r{len(rules_strokes) + 1}", color, s.screen, "kid"))

    sheets: list[SheetInfo] = []
    for s in used:
        sheets.append(SheetInfo(index=s.screen, photo_url=f"sheets/{s.screen + 1}.jpg" if "sheet" in s.files else None,
                                qr=s.payload, warnings=list(s.warnings)))
    for i in placement.inherited:
        sheets.append(SheetInfo(index=i, x_inherited=True))  # type: ignore[call-arg]  # x_* extension key
    sheets.sort(key=lambda si: si.index)

    seams = seam_reports(strokes, placement.screens)
    return Stitched(
        strokes=strokes + rules_strokes,
        components=comps,
        rules_ids=[s.id for s in rules_strokes],
        character=character,
        sheets=sheets,
        screens=placement.screens,
        seams=seams,
        parent=ref,
        noise=sum(s.noise for s in used),
        warnings=warnings,
    )


__all__ = [
    "PackMapRead", "Placement", "SeamPair", "SeamReport", "Stitched", "assemble_sheets", "drop_first_sheet_boxes",
    "has_first_sheet_layout", "parent_ink", "parent_ref", "place_sheets", "read_pack_map", "renumber_components",
    "seam_cost", "seam_reports", "shift_scan",
]
