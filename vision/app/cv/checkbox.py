"""Checkbox OMR: the game Rules Sheet and the Library Sheet (PLAN_V2 §8.1, §8.2, §11.3d). Lane C.

    read_rules_sheet(img) -> RulesSheetResult {patch, asks}            (+ x_game_id, x_values, x_story_*, x_warnings)
    read_rules_sheet_detail(img, work_dir=None) -> RulesSheetRead     (result, story crop JPEG, every row and box)
    read_library_sheet(img) -> list[LibraryDraft]
    read_library_sheet_detail(img, work_dir=None) -> LibrarySheetRead (drafts, name crops, every box)
    apply_rules_patch(rules, patch) -> GameRules dict (deep merge, validated)
    assign_letter(name, used) -> str;  draft_to_library_type(draft, ...) -> LibraryType

Both sheets are read **deterministically, with no model** (the plan's OMR):
1. The photo is rectified like a drawing sheet (the same four ArUco markers), its lighting flattened, its QR read
   (`dal2|rules|<game>` / `dal2|lib|<game>`). A sheet of the other kind is refused.
2. Every box sits at the mm position in `shared/template_spec_v2.json` (the printer draws from the same numbers) and is
   **registered on its printed outline**: a ring template is matched on the dark-ink mask within ±2 mm, so the up to
   ~1 mm a rectification leaves never pushes the outline into the measured interior.
3. Ink is any pixel whose Lab L is ≥ 15 below the local paper, or whose chroma is ≥ 20 above it, so pencil, every
   marker colour and highlighter count.
4. fill = the ink share of the interior (the registered box inset by 1.2 mm, 1.0 mm on the library sheet).
   **fill > 15% is a tick**; 6-15% is "unsure".
5. A single-choice row with two ticks becomes an ask and stays out of the patch (never "the darker one"). An unsure
   mark in a row with no tick becomes an ask too. An empty row keeps the game's current value.

The rules sheet's "My world is…" line and every library box's name line are handwriting: they are returned as
image crops for PERCEIVE (lane D). Offline a creature is "Creature N" and the kid types its name.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, Sequence

import cv2
import numpy as np

from app.config import SHARED_DIR
from app.cv.features import assemble, js_round, q16
from app.cv.scan_v2 import PreparedSheet, ScanV2Error, calibrate_v2, prepare_sheet
from app.cv.vectorize import Centers, VecParams, bgr_to_lab, classify_labels, ink_masks, vectorize_masks
from app.spec.behavior import Behavior
from app.spec.common import MessageRef, Spec
from app.spec.ink import InkStroke
from app.spec.library import LibraryArt, LibrarySymbol, LibraryType
from app.spec.rules import GameRules
from app.spec.api import RulesSheetResult
from app.template import spec_v2

JPEG_QUALITY = 85
CROP_MAX_W = 1600


# ======================================================================================================
# Box OMR
# ======================================================================================================


@dataclass(frozen=True)
class BoxRead:
    """One printed checkbox after registration: its ink fill and whether its outline was found."""

    id: str
    fill: float  # ink share of the interior, 0..1
    corr: float  # outline match, 0..1
    found: bool
    dx: int  # registration offset from the spec position, px
    dy: int
    ticked: bool
    unsure: bool


@dataclass(frozen=True)
class OmrParams:
    fill: float
    unsure: float
    dl: float
    dc: float
    outline_px: int
    inset_px: int
    search_px: int
    min_corr: float

    @classmethod
    def of(cls, section: dict[str, Any]) -> "OmrParams":
        return cls(
            fill=float(section.get("omr_fill", 0.15)),
            unsure=float(section.get("omr_unsure_fill", 0.06)),
            dl=float(section.get("ink_dl", 15.0)),
            dc=float(section.get("ink_dc", 20.0)),
            outline_px=max(1, spec_v2.mm_to_px(float(section.get("box_outline_mm", 0.5)))),
            inset_px=max(2, spec_v2.mm_to_px(float(section.get("interior_inset_mm", 1.2)))),
            search_px=max(2, spec_v2.mm_to_px(float(section.get("search_mm", 2.0)))),
            min_corr=float(section.get("found_min_corr", 0.45)),
        )


class Omr:
    """Ink masks and box reads over one rectified, lighting-flattened sheet."""

    def __init__(self, sheet_bgr: np.ndarray) -> None:
        lab = bgr_to_lab(sheet_bgr)
        self.L = lab[..., 0]
        self.C = np.hypot(lab[..., 1], lab[..., 2])
        self.H, self.W = self.L.shape

    def ink_mask(self, x0: int, y0: int, x1: int, y1: int, dl: float, dc: float) -> np.ndarray:
        """uint8 0/1 ink mask of the window [x0, x1) × [y0, y1), relative to the window's own paper."""
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(self.W, x1), min(self.H, y1)
        L = self.L[y0:y1, x0:x1]
        C = self.C[y0:y1, x0:x1]
        if L.size == 0:
            return np.zeros((max(0, y1 - y0), max(0, x1 - x0)), np.uint8)
        paper_l = float(np.percentile(L, 90))
        bright = C[L >= paper_l - 5.0]
        paper_c = float(np.median(bright)) if bright.size else 0.0
        m = ((paper_l - L) >= dl) | (((C - paper_c) >= dc) & ((paper_l - L) >= 2.0))
        return cv2.medianBlur(m.astype(np.uint8) * 255, 3) // 255

    def read_box(self, box_id: str, rect: spec_v2.RectPx, p: OmrParams) -> BoxRead:
        x, y, w, h = rect
        s = p.search_px
        pad = s + 2
        X0, Y0, X1, Y1 = x - pad, y - pad, x + w + 1 + pad, y + h + 1 + pad
        if X0 < 0 or Y0 < 0 or X1 > self.W or Y1 > self.H:
            return BoxRead(box_id, 0.0, 0.0, False, 0, 0, False, False)
        mask = self.ink_mask(X0, Y0, X1, Y1, p.dl, p.dc).astype(np.float32)
        ow = p.outline_px
        tmpl = np.zeros((h + 1, w + 1), np.float32)
        tmpl[:ow, :] = 1.0
        tmpl[-ow:, :] = 1.0
        tmpl[:, :ow] = 1.0
        tmpl[:, -ow:] = 1.0
        res = cv2.matchTemplate(mask, tmpl, cv2.TM_CCORR_NORMED)
        c0 = pad - s
        sub = res[c0 : c0 + 2 * s + 1, c0 : c0 + 2 * s + 1]
        if sub.size == 0 or not np.isfinite(sub).any():
            corr, dx, dy = 0.0, 0, 0
        else:
            sub = np.nan_to_num(sub, nan=0.0)
            iy, ix = np.unravel_index(int(np.argmax(sub)), sub.shape)
            corr, dx, dy = float(sub[iy, ix]), int(ix) - s, int(iy) - s
        found = corr >= p.min_corr
        if not found:
            dx = dy = 0
        i = p.inset_px
        ix0, iy0 = pad + dx + i, pad + dy + i
        ix1, iy1 = pad + dx + w + 1 - i, pad + dy + h + 1 - i
        interior = mask[iy0:iy1, ix0:ix1]
        fill = float(interior.mean()) if interior.size else 0.0
        return BoxRead(box_id, round(fill, 4), round(corr, 3), found, dx, dy, fill > p.fill, p.unsure < fill <= p.fill)


GroupStatus = Literal["one", "none", "many", "unsure"]


@dataclass
class GroupRead:
    """One single-choice row (or a multi-choice group) after OMR."""

    group: str
    label: str
    single: bool
    boxes: list[BoxRead]
    ticked: list[str]
    unsure: list[str]
    status: GroupStatus

    @property
    def chosen(self) -> str | None:
        return self.ticked[0] if self.status == "one" and self.ticked else None


def decide_group(group: str, label: str, boxes: Sequence[BoxRead], single: bool = True) -> GroupRead:
    ticked = [b.id for b in boxes if b.ticked]
    unsure = [b.id for b in boxes if b.unsure]
    if single:
        status: GroupStatus = "one" if len(ticked) == 1 else "many" if len(ticked) > 1 else "unsure" if unsure else "none"
    else:
        status = "one" if ticked else "unsure" if unsure else "none"
    return GroupRead(group=group, label=label, single=single, boxes=list(boxes), ticked=ticked, unsure=unsure,
                     status=status)


def _jpeg(img: np.ndarray, max_w: int = CROP_MAX_W) -> bytes:
    h, w = img.shape[:2]
    if w > max_w:
        s = max_w / w
        img = cv2.resize(img, (max_w, max(1, int(round(h * s)))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    return buf.tobytes() if ok else b""


def _crop(img: np.ndarray, rect: spec_v2.RectPx) -> np.ndarray:
    x, y, w, h = rect
    H, W = img.shape[:2]
    return img[max(0, y) : min(H, y + h), max(0, x) : min(W, x + w)]


def _check_kind(prep: PreparedSheet, expected: Literal["rules", "lib"]) -> str | None:
    """The sheet's game id; ScanV2Error when the QR says it is another kind of sheet."""
    q = prep.qr
    if q is None:
        return None
    if q.kind != expected:
        raise ScanV2Error("error.wrong_sheet", {"expected": expected, "got": q.kind})
    return q.id


def _set_path(patch: dict[str, Any], path: str, value: Any) -> None:
    keys = path.split(".")
    cur = patch
    for k in keys[:-1]:
        nxt = cur.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[k] = nxt
        cur = nxt
    cur[keys[-1]] = value


# ======================================================================================================
# Rules sheet (§8.2)
# ======================================================================================================


@dataclass
class RulesSheetRead:
    result: RulesSheetResult
    game_id: str | None
    rows: list[GroupRead]
    story_jpeg: bytes | None
    story_has_ink: bool
    warnings: list[MessageRef] = field(default_factory=list)
    found_ratio: float = 1.0


def _story_has_ink(omr: Omr, rs: dict[str, Any]) -> bool:
    """Handwriting on the "My world is…" lines: strong ink (the printed lines and label are light gray)."""
    st = rs["story_line"]
    x, y, w, h = spec_v2.rect_px(st["rect_mm"])
    lx0, lx1 = (spec_v2.mm_to_px(float(v)) for v in st.get("line_x_mm", [st["rect_mm"][0], st["rect_mm"][0] + st["rect_mm"][2]]))
    m = omr.ink_mask(lx0, y, lx1, y + h, 30.0, float(rs.get("ink_dc", 20.0)))
    return int(m.sum()) >= int(st.get("min_ink_px", 60))


def read_rules_sheet_detail(img: bytes, work_dir: Path | None = None) -> RulesSheetRead:
    """OMR of one Rules Sheet photo. Raises ScanV2Error (error.paper_missing, error.upload_failed, error.wrong_sheet,
    error.not_rules_sheet)."""
    prep = prepare_sheet(img)
    game_id = _check_kind(prep, "rules")
    rs = spec_v2.rules_sheet()
    p = OmrParams.of(rs)
    omr = Omr(prep.sheet)
    warnings: list[MessageRef] = []
    if prep.qr is None:
        warnings.append(MessageRef(key="warning.rules_code_unread", args={}))
    if len(prep.rect.ids) < 4:
        warnings.append(MessageRef(key="warning.marker_inferred", args={"n": 1}))

    rows: list[GroupRead] = []
    found = total = 0
    for row in spec_v2.rules_rows_px():
        boxes = [omr.read_box(o["id"], o["box_px"], p) for o in row["options"]]
        found += sum(1 for b in boxes if b.found)
        total += len(boxes)
        rows.append(decide_group(row["group"], row["label"], boxes, bool(row.get("single", True))))
    ratio = found / max(1, total)
    if ratio < 0.5:
        raise ScanV2Error("error.not_rules_sheet")

    patch: dict[str, Any] = {}
    asks: list[MessageRef] = []
    values: dict[str, Any] = {}
    spec_rows = {r["group"]: r for r in rs["rows"]}
    for g in rows:
        row = spec_rows[g.group]
        opts = {o["id"]: o for o in row["options"]}
        if g.status == "one" and g.chosen is not None:
            value = opts[g.chosen]["value"]
            _set_path(patch, str(row["field"]), value)
            values[g.group] = value
        elif g.status == "many":
            labels = [str(opts[i]["label"]) for i in g.ticked]
            asks.append(MessageRef(key="ask.rules_two_ticks",
                                   args={"row": g.label, "a": labels[0], "b": labels[1], "n": len(labels)}))
        elif g.status == "unsure":
            asks.append(MessageRef(key="ask.rules_unsure", args={"row": g.label, "option": str(opts[g.unsure[0]]["label"])}))
    if not patch and not asks:
        warnings.append(MessageRef(key="warning.rules_nothing_ticked", args={}))

    story = _crop(prep.sheet, spec_v2.rules_story_px())
    story_jpeg = _jpeg(story) if story.size else None
    has_story = _story_has_ink(omr, rs)
    extra: dict[str, Any] = {
        "x_game_id": game_id,
        "x_values": values,
        "x_story_ink": has_story,
        "x_warnings": [w.model_dump() for w in warnings],
    }
    if work_dir is not None and story_jpeg:
        path = Path(work_dir) / "rules" / "story.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(story_jpeg)
        extra["x_story_crop"] = "rules/story.jpg"
    result = RulesSheetResult(patch=patch, asks=asks, **extra)
    return RulesSheetRead(result=result, game_id=game_id, rows=rows, story_jpeg=story_jpeg, story_has_ink=has_story,
                          warnings=warnings, found_ratio=round(ratio, 3))


def read_rules_sheet(img: bytes, work_dir: Path | None = None) -> RulesSheetResult:
    """§11.3d: one Rules Sheet photo -> {patch, asks}. `patch` is a partial GameRules (nested `abilities`); apply it
    with `apply_rules_patch`. Extension keys: x_game_id (from the QR), x_values, x_story_ink, x_story_crop (a
    work_dir-relative JPEG of the "My world is…" lines, for PERCEIVE), x_warnings."""
    return read_rules_sheet_detail(img, work_dir).result


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def apply_rules_patch(rules: GameRules | dict[str, Any] | None, patch: dict[str, Any]) -> dict[str, Any]:
    """The game's rules with a rules-sheet patch merged in (nested keys merge), validated as GameRules. The version
    is left to the server (PUT /games/{id}/rules bumps it)."""
    if isinstance(rules, GameRules):
        base = rules.model_dump(exclude_none=False)
    elif isinstance(rules, dict) and rules:
        base = dict(rules)
    else:
        base = GameRules(version=1).model_dump(exclude_none=False)
    merged = _deep_merge(base, {k: v for k, v in patch.items() if not str(k).startswith("x_")})
    merged.setdefault("version", 1)
    return GameRules.model_validate(merged).model_dump(exclude_none=False)


# ======================================================================================================
# Library sheet (§8.1)
# ======================================================================================================

Archetype = Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher"]


class LibraryDraft(Spec):
    """One creature read from a Library Sheet box: everything a LibraryType needs except the server's id, version,
    author and timestamps (see `draft_to_library_type`)."""

    box: int
    name: str
    name_source: Literal["default", "model", "kid"] = "default"
    name_has_ink: bool = False
    name_crop: str | None = None  # work_dir-relative JPEG of the name line (for PERCEIVE), when written
    letter: str | None = None
    kind: Literal["creature"] = "creature"
    archetype: Archetype | None = None  # None: it stays still
    speed: Literal["slow", "normal", "fast"] = "normal"
    spiky: bool = False
    behavior: Behavior
    collision: Literal["solid", "one_way", "none"] = "none"
    art: LibraryArt
    symbol: LibrarySymbol | None = None
    symbol_samples: int = 0  # symbol cells drawn (3 registers a paper symbol)
    ticks: dict[str, float] = {}
    asks: list[MessageRef] = []
    warnings: list[MessageRef] = []


@dataclass
class LibraryBoxRead:
    index: int
    draft: LibraryDraft | None
    name_jpeg: bytes | None
    checks: dict[str, BoxRead]
    empty: bool


@dataclass
class LibrarySheetRead:
    drafts: list[LibraryDraft]
    boxes: list[LibraryBoxRead]
    game_id: str | None
    warnings: list[MessageRef] = field(default_factory=list)
    calibrated: bool = True


@lru_cache(maxsize=1)
def _grids() -> dict[str, Any]:
    try:
        return dict(json.loads((SHARED_DIR / "spec" / "params.json").read_text()).get("GRIDS", {}))
    except (OSError, json.JSONDecodeError):
        return {}


_GRID_DEFAULTS: dict[str, dict[str, float]] = {
    "walker_speed": {"slow": 1.5, "normal": 2, "fast": 3},
    "flyer_speed": {"slow": 1.5, "normal": 2, "fast": 3},
    "chaser_speed": {"slow": 3, "normal": 4, "fast": 5},
    "hopper_interval": {"slow": 2.5, "normal": 1.6, "fast": 1},
    "shooter_interval": {"slow": 4, "normal": 2.5, "fast": 1.5},
    "crusher_warn": {"slow": 0.8, "normal": 0.5, "fast": 0.3},
}


def _grid(name: str, speed: str) -> float:
    enum = (_grids().get(name) or {}).get("enum") or _GRID_DEFAULTS[name]
    return float(enum.get(speed, _GRID_DEFAULTS[name][speed]))


def creature_behavior(archetype: str | None, speed: str = "normal", spiky: bool = False) -> dict[str, Any]:
    """The typed Behavior for a ticked archetype, its numbers from the §5.6 param grids (slow / normal / fast)."""
    if archetype is None:
        return {"kind": "static"}
    params: dict[str, Any] = {}
    if archetype in ("walker", "flyer", "chaser"):
        params["speed"] = _grid(f"{archetype}_speed", speed)
    if archetype == "flyer":
        params.update(pattern="horizontal", range=4.0)  # a paper "flies" creature patrols, it does not just hover
    elif archetype == "hopper":
        params["interval"] = _grid("hopper_interval", speed)
    elif archetype == "shooter":
        params["interval"] = _grid("shooter_interval", speed)
    elif archetype == "crusher":
        params["warn"] = _grid("crusher_warn", speed)
    return {"kind": "enemy", "archetype": archetype, "spiky": bool(spiky), "params": params}


def _vectorize_region(img: np.ndarray, centers: Centers, prefix: str) -> tuple[list[InkStroke], float]:
    """Ink in one box region -> strokes in cells from the region's top-left (paper scale, 5 mm cells) and ink area."""
    if img.size == 0:
        return [], 0.0
    ppc = float(spec_v2.cell_working_px())
    labels = classify_labels(img, centers)
    masks = ink_masks(labels, ppc)
    vec = vectorize_masks(masks, ppc, offset_cells=(0.0, 0.0), sheet=0, params=VecParams.from_spec(ppc))
    strokes, _ = assemble(vec.components, stroke_prefix=prefix)
    return strokes, float(sum(rc.area for rc in vec.components))


def _normalize_art(strokes: list[InkStroke], lib: dict[str, Any]) -> tuple[list[InkStroke], tuple[float, float]]:
    """Strokes moved so their ink bbox starts at (0, 0), and the in-game size: the long side 1.75 cells, the short side
    at least 0.75 (the long side at most 2), keeping the aspect (N13 fit_creature bounds)."""
    if not strokes:
        return [], (1.0, 1.0)
    x0 = min(p[0] - (s.w[0] if s.kind == "dot" else max(s.w)) / 2 for s in strokes for p in s.pts)
    y0 = min(p[1] - (s.w[0] if s.kind == "dot" else max(s.w)) / 2 for s in strokes for p in s.pts)
    x1 = max(p[0] + (s.w[0] if s.kind == "dot" else max(s.w)) / 2 for s in strokes for p in s.pts)
    y1 = max(p[1] + (s.w[0] if s.kind == "dot" else max(s.w)) / 2 for s in strokes for p in s.pts)
    moved = [
        s.model_copy(update={"pts": [(js_round(x - x0, 64), js_round(y - y0, 64)) for x, y in s.pts]}) for s in strokes
    ]
    bw, bh = max(0.05, x1 - x0), max(0.05, y1 - y0)
    long_c, min_c, cap_c = (float(lib.get(k, d)) for k, d in
                            (("art_max_side_c", 1.75), ("art_min_side_c", 0.75), ("art_cap_c", 2.0)))
    s = long_c / max(bw, bh)
    if min(bw, bh) * s < min_c:
        s = min(min_c / min(bw, bh), cap_c / max(bw, bh))
    return moved, (q16(bw * s), q16(bh * s))


def _majority_color(strokes: Sequence[InkStroke]) -> str:
    weight: dict[str, float] = {}
    for s in strokes:
        n = max(1, len(s.pts))
        weight[s.color] = weight.get(s.color, 0.0) + n * (float(np.median(s.w)) if s.w else 0.3)
    return max(weight, key=lambda c: weight[c]) if weight else "black"


def _read_library_box(
    box: dict[str, Any], prep: PreparedSheet, omr: Omr, centers: Centers, lib: dict[str, Any], p: OmrParams,
    work_dir: Path | None,
) -> LibraryBoxRead:
    i = int(box["index"])
    inset = spec_v2.mm_to_px(float(lib.get("area_inset_mm", 1.0)))
    dx, dy, dw, dh = box["drawing_px"]
    art_raw, art_area = _vectorize_region(
        prep.sheet[dy + inset : dy + dh - inset, dx + inset : dx + dw - inset], centers, "a")
    samples: list[list[InkStroke]] = []
    sym_inset = spec_v2.mm_to_px(0.8)
    for j, (sx, sy, sw, sh) in enumerate(box["symbols_px"], start=1):
        st, area = _vectorize_region(
            prep.sheet[sy + sym_inset : sy + sh - sym_inset, sx + sym_inset : sx + sw - sym_inset], centers, f"y{j}_")
        if st and area >= float(lib.get("symbol_min_ink_c2", 0.05)):
            samples.append(st)
    checks = {c["id"]: omr.read_box(c["id"], c["box_px"], p) for c in box["checks"]}
    name_img = _crop(prep.sheet, box["name_px"])
    name_labels = classify_labels(name_img, centers) if name_img.size else np.zeros((0, 0), np.uint8)
    name_ink = int(np.isin(name_labels, [spec_v2.CLASS_ORDER.index(c) for c in spec_v2.INK_CLASSES]).sum())
    name_has_ink = name_ink >= 40

    groups = lib["groups"]
    moves = decide_group("moves", "moves", [checks[o] for o in groups["moves"]["options"]], True)
    speed_g = decide_group("speed", "speed", [checks[o] for o in groups["speed"]["options"]], True)
    spiky_g = decide_group("spiky", "spiky", [checks[o] for o in groups["spiky"]["options"]], False)
    any_tick = any(b.ticked for b in checks.values())
    if not art_raw and not samples and not any_tick and not name_has_ink:
        return LibraryBoxRead(index=i, draft=None, name_jpeg=None, checks=checks, empty=True)

    asks: list[MessageRef] = []
    warnings: list[MessageRef] = []
    archetype = None
    if moves.status == "one" and moves.chosen:
        archetype = lib["moves_archetype"][moves.chosen]
    elif moves.status == "many":
        asks.append(MessageRef(key="ask.library_two_moves", args={"box": i, "a": moves.ticked[0], "b": moves.ticked[1]}))
    elif moves.status == "unsure":
        asks.append(MessageRef(key="ask.library_unsure", args={"box": i, "option": moves.unsure[0]}))
    speed: Literal["slow", "normal", "fast"] = "normal"
    if speed_g.status == "one" and speed_g.chosen in ("slow", "fast"):
        speed = speed_g.chosen  # type: ignore[assignment]
    elif speed_g.status == "many":
        asks.append(MessageRef(key="ask.library_slow_and_fast", args={"box": i}))
    elif speed_g.status == "unsure":
        asks.append(MessageRef(key="ask.library_unsure", args={"box": i, "option": speed_g.unsure[0]}))
    spiky = spiky_g.status == "one"
    if spiky_g.status == "unsure":
        asks.append(MessageRef(key="ask.library_unsure", args={"box": i, "option": "spiky"}))
    if archetype is None and speed_g.status == "one":
        warnings.append(MessageRef(key="warning.library_speed_without_move", args={"box": i}))
    if not art_raw:
        warnings.append(MessageRef(key="warning.library_no_drawing", args={"box": i}))
    if 0 < len(samples) < 3:
        warnings.append(MessageRef(key="warning.library_symbol_incomplete", args={"box": i, "count": len(samples)}))

    art_strokes, size = _normalize_art(art_raw, lib)
    symbol = None
    if len(samples) >= 3:
        color = _majority_color([s for sample in samples for s in sample])
        symbol = LibrarySymbol(samples=samples[:3], color=color)  # type: ignore[arg-type]
    name_rel = None
    name_jpeg = _jpeg(name_img) if name_img.size else None
    if work_dir is not None and name_jpeg and name_has_ink:
        path = Path(work_dir) / "library" / f"name{i}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(name_jpeg)
        name_rel = f"library/name{i}.jpg"
    draft = LibraryDraft(
        box=i,
        name=str(lib.get("default_name_format", "Creature {i}")).format(i=i)[:16],
        name_has_ink=name_has_ink,
        name_crop=name_rel,
        archetype=archetype,
        speed=speed,
        spiky=spiky,
        behavior=creature_behavior(archetype, speed, spiky),  # type: ignore[arg-type]
        art=LibraryArt(strokes=art_strokes, size_cells=size),
        symbol=symbol,
        symbol_samples=len(samples),
        ticks={k: b.fill for k, b in checks.items()},
        asks=asks,
        warnings=warnings,
    )
    return LibraryBoxRead(index=i, draft=draft, name_jpeg=name_jpeg, checks=checks, empty=False)


def read_library_sheet_detail(img: bytes, work_dir: Path | None = None) -> LibrarySheetRead:
    """OMR + vectorizing of one Library Sheet photo. Raises ScanV2Error (error.paper_missing, error.upload_failed,
    error.wrong_sheet, error.not_library_sheet, error.no_drawing)."""
    prep = prepare_sheet(img)
    game_id = _check_kind(prep, "lib")
    lib = spec_v2.library_sheet()
    p = OmrParams.of(lib)
    omr = Omr(prep.sheet)
    centers, calibrated = calibrate_v2(prep.sheet, spec_v2.library_swatch_patches_px())
    warnings: list[MessageRef] = []
    if prep.qr is None:
        warnings.append(MessageRef(key="warning.library_code_unread", args={}))
    if not calibrated:
        warnings.append(MessageRef(key="warning.calibration_fallback", args={"n": 1}))
    boxes = [_read_library_box(b, prep, omr, centers, lib, p, work_dir) for b in spec_v2.library_boxes_px()]
    found = sum(1 for b in boxes for c in b.checks.values() if c.found)
    total = sum(len(b.checks) for b in boxes)
    if found / max(1, total) < 0.5:
        raise ScanV2Error("error.not_library_sheet")
    drafts = [b.draft for b in boxes if b.draft is not None]
    if not drafts:
        raise ScanV2Error("error.no_drawing")
    return LibrarySheetRead(drafts=drafts, boxes=boxes, game_id=game_id, warnings=warnings, calibrated=calibrated)


def read_library_sheet(img: bytes, work_dir: Path | None = None) -> list[LibraryDraft]:
    """§11.3d: one Library Sheet photo -> a LibraryDraft per filled box (empty boxes are skipped)."""
    return read_library_sheet_detail(img, work_dir).drafts


# ======================================================================================================
# Drafts -> library types
# ======================================================================================================


def assign_letter(name: str, used: Sequence[str] = ()) -> str:
    """The circled paper tag (§8.1): the first letter of the name not used in the game yet, else any free letter."""
    taken = {str(u).upper() for u in used}
    for ch in name.upper():
        if "A" <= ch <= "Z" and ch not in taken:
            return ch
    for ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789":
        if ch not in taken:
            return ch
    return "?"


def draft_to_library_type(
    draft: LibraryDraft,
    *,
    type_id: str,
    game_id: str,
    author: str,
    used_letters: Sequence[str] = (),
    version: int = 1,
    created_at: str = "",
    name: str | None = None,
) -> LibraryType:
    """A confirmed draft as an immutable LibraryType version (the server picks id, version and created_at)."""
    nm = (name or draft.name).strip()[:16] or f"Creature {draft.box}"
    return LibraryType(
        id=type_id,
        game_id=game_id,
        version=version,
        name=nm,
        letter=draft.letter or assign_letter(nm, used_letters),
        kind="creature",
        behavior=draft.behavior,
        spiky=draft.spiky,
        collision=draft.collision,
        art=draft.art,
        symbol=draft.symbol,
        author=author,
        created_at=created_at,
    )


def drafts_json(drafts: Sequence[LibraryDraft]) -> list[dict[str, Any]]:
    """The drafts as JSON for `POST /scan/library-sheet` → {drafts}."""
    return [d.model_dump(mode="json", exclude_none=True) for d in drafts]


__all__ = [
    "BoxRead", "GroupRead", "LibraryBoxRead", "LibraryDraft", "LibrarySheetRead", "Omr", "OmrParams",
    "RulesSheetRead", "apply_rules_patch", "assign_letter", "creature_behavior", "decide_group",
    "draft_to_library_type", "drafts_json", "read_library_sheet", "read_library_sheet_detail", "read_rules_sheet",
    "read_rules_sheet_detail",
]

