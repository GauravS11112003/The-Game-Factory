"""Loads shared/template_spec_v2.json and converts mm to canvas pixels (PLAN_V2 §6.4). Lane C.

The v2 template generator (generate_v2.py) and the CV v2 scanner (app/cv/scan_v2.py) both read the sheet layout
through this module, so no coordinate is hardcoded twice. Every *_px helper returns integer canvas pixels at
page.px_per_mm (10 px/mm -> 2970x2100). The v1 loader (spec.py) is untouched; the v2 layout keeps every v1 position.

The QR v2 grammar (§6.4) also lives here, because the generator writes it and the scanner reads it:

    dal2|p|<pack_id>|<n>/<k>     a drawing sheet n of a k-sheet pack
    dal2|rules|<game_id>         the game rules sheet (§8.2)
    dal2|lib|<game_id>           the library sheet (§8.1)
    dal1|blank, dal1|game|<id>, dal1|lvl|<id>   v1 sheets, read as a 1-sheet pack
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Literal, Sequence

from app.config import SHARED_DIR

TEMPLATE_SPEC_V2_PATH = SHARED_DIR / "template_spec_v2.json"

RectPx = tuple[int, int, int, int]  # (x, y, w, h)

# Class order used by the v2 classifier; the first four are ink, the last two background.
INK_CLASSES: tuple[str, ...] = ("black", "red", "green", "blue")
BACKGROUND_CLASSES: tuple[str, ...] = ("gray", "paper")
CLASS_ORDER: tuple[str, ...] = INK_CLASSES + BACKGROUND_CLASSES

SCREEN_W_CELLS = 48
WORLD_H_CELLS = 27
MAX_SHEETS = 6


@lru_cache(maxsize=1)
def load_spec() -> dict[str, Any]:
    return json.loads(TEMPLATE_SPEC_V2_PATH.read_text())


def section(name: str) -> dict[str, Any]:
    return dict(load_spec()[name])


def px_per_mm() -> float:
    return float(load_spec()["page"]["px_per_mm"])


def mm_to_px(mm: float) -> int:
    return int(round(mm * px_per_mm()))


def rect_px(rect_mm: Sequence[float]) -> RectPx:
    """[x, y, w, h] in mm -> (x, y, w, h) in canvas px."""
    x, y, w, h = rect_mm
    return mm_to_px(x), mm_to_px(y), mm_to_px(w), mm_to_px(h)


def point_px(point_mm: Sequence[float]) -> tuple[int, int]:
    x, y = point_mm
    return mm_to_px(x), mm_to_px(y)


def canvas_size_px() -> tuple[int, int]:
    w, h = load_spec()["page"]["canvas_px"]
    return int(w), int(h)


def page_size_mm() -> tuple[float, float]:
    w, h = load_spec()["page"]["size_mm"]
    return float(w), float(h)


def hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    h = hex_str.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def hex_to_bgr(hex_str: str) -> tuple[int, int, int]:
    r, g, b = hex_to_rgb(hex_str)
    return b, g, r


def colors() -> dict[str, str]:
    """Palette name -> hex, including gray, paper and the annotation magenta."""
    return dict(load_spec()["colors"])


# --- markers -------------------------------------------------------------------------------------


def marker_specs() -> list[dict[str, Any]]:
    """Each marker as {id, position, rect_px, outer_corner_index, outer_corner_px}."""
    out = []
    for m in load_spec()["markers"]["ids"]:
        out.append(
            {
                "id": int(m["id"]),
                "position": m["position"],
                "rect_px": rect_px(m["rect_mm"]),
                "outer_corner_index": int(m["outer_corner_index"]),
                "outer_corner_px": point_px(m["outer_corner_mm"]),
            }
        )
    return out


def outer_corners_px() -> list[tuple[int, int]]:
    """The four marker outer corners (TL, TR, BR, BL) the homography maps onto."""
    return [point_px(p) for p in load_spec()["markers"]["outer_corners_mm"]]


def marker_size_px() -> int:
    return mm_to_px(load_spec()["markers"]["size_mm"])


def min_markers_for_rectify() -> int:
    return int(load_spec()["markers"]["min_markers_for_rectify"])


# --- boxes ---------------------------------------------------------------------------------------


def header_rect_px() -> RectPx:
    return rect_px(load_spec()["header"]["rect_mm"])


def legend_rect_px() -> RectPx:
    return rect_px(load_spec()["legend"]["rect_mm"])


def qr_rect_px() -> RectPx:
    return rect_px(load_spec()["qr"]["rect_mm"])


def drawing_area_mm() -> tuple[float, float, float, float]:
    x, y, w, h = load_spec()["drawing_area"]["rect_mm"]
    return float(x), float(y), float(w), float(h)


def drawing_area_px() -> RectPx:
    return rect_px(load_spec()["drawing_area"]["rect_mm"])


def grid_cells() -> tuple[int, int]:
    w, h = load_spec()["drawing_area"]["grid_cells"]
    return int(w), int(h)


def cell_mm() -> float:
    return float(load_spec()["drawing_area"]["cell_mm"])


def working_px() -> tuple[int, int]:
    w, h = load_spec()["drawing_area"]["working_px"]
    return int(w), int(h)


def cell_working_px() -> int:
    return int(load_spec()["drawing_area"]["cell_working_px"])


def character_box_px() -> RectPx:
    return rect_px(load_spec()["character_box"]["rect_mm"])


def character_box_mm() -> tuple[float, float, float, float]:
    x, y, w, h = load_spec()["character_box"]["rect_mm"]
    return float(x), float(y), float(w), float(h)


def character_sheets() -> list[int]:
    return [int(n) for n in load_spec()["character_box"].get("sheets", [1])]


def sprite_px() -> tuple[int, int]:
    w, h = load_spec()["character_box"]["sprite_px"]
    return int(w), int(h)


def rules_box_px() -> RectPx:
    return rect_px(load_spec()["rules_box"]["rect_mm"])


def rules_box_mm() -> tuple[float, float, float, float]:
    x, y, w, h = load_spec()["rules_box"]["rect_mm"]
    return float(x), float(y), float(w), float(h)


def rules_sheets() -> list[int]:
    return [int(n) for n in load_spec()["rules_box"].get("sheets", [1])]


def box_inset_px(name: Literal["character_box", "rules_box"]) -> int:
    return mm_to_px(float(load_spec()[name].get("inset_mm", 1.5)))


def pack_map_px() -> RectPx:
    return rect_px(load_spec()["pack_map"]["rect_mm"])


def pack_map_boxes_px(k: int) -> list[RectPx]:
    """The k sheet boxes of the pack map (sheets 2..k), left to right, as (x, y, w, h) canvas px.

    One layout function for the printer (generate_v2._draw_pack_map) and the QR-fallback reader
    (cv/stitch.read_pack_map): boxes are 48:27 like a screen, as tall as the map allows, narrowed to fit k of them.
    """
    x, y, w, h = pack_map_px()
    k = max(1, int(k))
    top = y + mm_to_px(6)
    bh = h - mm_to_px(8)
    bw = int(bh * 48 / 27)
    gap = mm_to_px(2.5)
    if k * bw + (k - 1) * gap > w:
        bw = int((w - (k - 1) * gap) / k)
        bh = int(bw * 27 / 48)
    return [(x + i * (bw + gap), top, bw, bh) for i in range(k)]


def pack_map_read_params() -> dict[str, Any]:
    return dict(load_spec()["pack_map"].get("read", {}))


def stitch_params() -> dict[str, Any]:
    return section("stitch")


# --- rules sheet (§8.2) and library sheet (§8.1) ---------------------------------------------------


def rules_sheet() -> dict[str, Any]:
    return section("rules_sheet")


def rules_rows_px() -> list[dict[str, Any]]:
    """Rules-sheet rows with every option box (and theme swatch) converted to canvas px (`box_px`, `swatch_px`)."""
    rows = []
    for row in load_spec()["rules_sheet"]["rows"]:
        opts = []
        for o in row["options"]:
            q = dict(o)
            q["box_px"] = rect_px(o["box_mm"])
            if "swatch_mm" in o:
                q["swatch_px"] = rect_px(o["swatch_mm"])
            opts.append(q)
        r = dict(row)
        r["options"] = opts
        r["y_px"] = mm_to_px(float(row["y_mm"]))
        rows.append(r)
    return rows


def rules_story_px() -> RectPx:
    return rect_px(load_spec()["rules_sheet"]["story_line"]["rect_mm"])


def library_sheet() -> dict[str, Any]:
    return section("library_sheet")


def library_boxes_px() -> list[dict[str, Any]]:
    """The 6 library boxes with every rect in canvas px: frame, drawing, name, symbols[3], checks[{id, label, box_px}]."""
    out = []
    for b in load_spec()["library_sheet"]["boxes"]:
        out.append(
            {
                "index": int(b["index"]),
                "frame_px": rect_px(b["frame_mm"]),
                "title_px": point_px(b["title_mm"]),
                "drawing_px": rect_px(b["drawing_mm"]),
                "drawing_mm": tuple(float(v) for v in b["drawing_mm"]),
                "symbol_label_px": point_px(b["symbol_label_mm"]),
                "symbols_px": [rect_px(s) for s in b["symbols_mm"]],
                "name_label_px": point_px(b["name_label_mm"]),
                "name_line_px": tuple(mm_to_px(float(v)) for v in b["name_line_mm"]),
                "name_px": rect_px(b["name_mm"]),
                "checks": [{"id": c["id"], "label": c["label"], "box_px": rect_px(c["box_mm"])} for c in b["checks"]],
            }
        )
    return out


def library_swatch_patches_px() -> list[dict[str, Any]]:
    """The library sheet's header swatch strip as {name, hex, rect_px, outlined} (same shape as swatch_patches_px)."""
    return [
        {"name": p["name"], "hex": p["hex"], "rect_px": rect_px(p["rect_mm"]), "outlined": bool(p.get("outlined", False))}
        for p in load_spec()["library_sheet"]["swatches"]
    ]


def swatches_rect_px() -> RectPx:
    return rect_px(load_spec()["swatches"]["rect_mm"])


def swatch_patches_px() -> list[dict[str, Any]]:
    """Each patch as {name, hex, rect_px, outlined}, in spec order (black, red, green, blue, gray, paper)."""
    out = []
    for p in load_spec()["swatches"]["patches"]:
        out.append(
            {
                "name": p["name"],
                "hex": p["hex"],
                "rect_px": rect_px(p["rect_mm"]),
                "outlined": bool(p.get("outlined", False)),
            }
        )
    return out


def mm_rect_in_drawing_cells(rect_mm: Sequence[float]) -> tuple[float, float, float, float]:
    """A sheet rectangle [x, y, w, h] mm -> [x0, y0, x1, y1] in cells relative to the drawing-area origin."""
    ax, ay, _, _ = drawing_area_mm()
    c = cell_mm()
    x, y, w, h = rect_mm
    return (x - ax) / c, (y - ay) / c, (x + w - ax) / c, (y + h - ay) / c


def rules_box_drawing_cells(inset: bool = True) -> tuple[float, float, float, float]:
    """The rules-box interior in drawing-area cells (y > 27): the frame rules-box strokes are reported in."""
    x, y, w, h = rules_box_mm()
    i = float(load_spec()["rules_box"].get("inset_mm", 1.5)) if inset else 0.0
    return mm_rect_in_drawing_cells((x + i, y + i, w - 2 * i, h - 2 * i))


# --- tunables ------------------------------------------------------------------------------------


def vectorize_params() -> dict[str, Any]:
    return section("vectorize")


def feature_params() -> dict[str, Any]:
    return section("features")


def classify_params() -> dict[str, Any]:
    return section("classify")


def illumination_params() -> dict[str, Any]:
    return section("illumination")


def annotate_params() -> dict[str, Any]:
    return section("annotate")


def seam_marks() -> dict[str, Any]:
    return section("seam_marks")


def pack_params() -> dict[str, Any]:
    return section("pack")


# --- QR v2 grammar ---------------------------------------------------------------------------------

QrKind = Literal["pack", "rules", "lib"]


@dataclass(frozen=True)
class QrInfo:
    """A parsed sheet QR. `legacy` is set for v1 dal1|... payloads (read as a 1-sheet pack)."""

    raw: str
    kind: QrKind
    id: str | None  # pack id (pack), game id (rules, lib); None for dal1|blank
    n: int = 1  # 1-based sheet number (packs)
    k: int = 1  # sheets in the pack
    legacy: Literal["blank", "game", "lvl"] | None = None
    legacy_id: str | None = None  # dal1|game|<game_id> / dal1|lvl|<level_id>

    @property
    def is_blank(self) -> bool:
        return self.kind == "pack" and (self.id is None or self.id == blank_pack_id())


def qr_regex() -> str:
    return str(load_spec()["qr"]["payload_grammar"]["regex"])


def qr_legacy_regex() -> str:
    return str(load_spec()["qr"]["payload_grammar"]["legacy_regex"])


def blank_pack_id() -> str:
    return str(load_spec()["qr"].get("blank_pack_id", "blank"))


@lru_cache(maxsize=1)
def _qr_patterns() -> tuple[re.Pattern[str], re.Pattern[str]]:
    return re.compile(qr_regex()), re.compile(qr_legacy_regex())


def parse_qr(payload: str | None) -> QrInfo | None:
    """Parse a v2 (or v1) sheet payload; None when it is not one of ours or is inconsistent (n > k)."""
    if not payload:
        return None
    raw = payload.strip()
    v2, v1 = _qr_patterns()
    if v2.match(raw):
        parts = raw.split("|")
        tag, ident = parts[1], parts[2]
        n, k = 1, 1
        if len(parts) == 4:
            a, b = parts[3].split("/")
            n, k = int(a), int(b)
            if n > k:
                return None
        kind: QrKind = "pack" if tag == "p" else "rules" if tag == "rules" else "lib"
        return QrInfo(raw=raw, kind=kind, id=ident, n=n, k=k)
    if v1.match(raw):
        parts = raw.split("|")
        if parts[1] == "blank":
            return QrInfo(raw=raw, kind="pack", id=None, legacy="blank")
        legacy: Literal["game", "lvl"] = "game" if parts[1] == "game" else "lvl"
        return QrInfo(raw=raw, kind="pack", id=None, legacy=legacy, legacy_id=parts[2])
    return None


def pack_payload(pack_id: str, n: int, k: int) -> str:
    """dal2|p|<pack_id>|<n>/<k>; raises ValueError when the result would not parse."""
    payload = f"dal2|p|{pack_id}|{n}/{k}"
    if parse_qr(payload) is None:
        raise ValueError(f"invalid pack QR payload {payload!r}")
    return payload


def rules_payload(game_id: str) -> str:
    payload = f"dal2|rules|{game_id}"
    if parse_qr(payload) is None:
        raise ValueError(f"invalid rules QR payload {payload!r}")
    return payload


def library_payload(game_id: str) -> str:
    payload = f"dal2|lib|{game_id}"
    if parse_qr(payload) is None:
        raise ValueError(f"invalid library QR payload {payload!r}")
    return payload
