"""Loads shared/template_spec.json and converts mm to canvas pixels (PLAN.md section 5).

Both the template generator and the CV rectifier read the spec through this
module so no coordinate is hardcoded twice. Every *_px helper returns
integer canvas pixels at spec.page.px_per_mm (10 px/mm -> 2970x2100).
"""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Any, Sequence

from app.config import TEMPLATE_SPEC_PATH

RectPx = tuple[int, int, int, int]  # (x, y, w, h)

# Class order used by the CV calibrate/segment modules; the first four are ink.
INK_CLASSES: tuple[str, ...] = ("black", "red", "green", "blue")
BACKGROUND_CLASSES: tuple[str, ...] = ("gray", "paper")
CLASS_ORDER: tuple[str, ...] = INK_CLASSES + BACKGROUND_CLASSES


@lru_cache(maxsize=1)
def load_spec() -> dict[str, Any]:
    return json.loads(TEMPLATE_SPEC_PATH.read_text())


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


def outer_corners_px() -> list[tuple[int, int]]:
    """The four marker outer corners (TL, TR, BR, BL) the homography maps onto."""
    return [point_px(p) for p in load_spec()["markers"]["outer_corners_mm"]]


def hex_to_rgb(hex_str: str) -> tuple[int, int, int]:
    h = hex_str.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def colors() -> dict[str, str]:
    """Palette name -> hex, including gray, paper and the annotation magenta."""
    return dict(load_spec()["colors"])


# --- markers -----------------------------------------------------------------


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


def marker_size_px() -> int:
    return mm_to_px(load_spec()["markers"]["size_mm"])


def min_markers_for_rectify() -> int:
    return int(load_spec()["markers"]["min_markers_for_rectify"])


# --- boxes -------------------------------------------------------------------


def header_rect_px() -> RectPx:
    return rect_px(load_spec()["header"]["rect_mm"])


def legend_rect_px() -> RectPx:
    return rect_px(load_spec()["legend"]["rect_mm"])


def qr_rect_px() -> RectPx:
    return rect_px(load_spec()["qr"]["rect_mm"])


def qr_regex() -> str:
    return str(load_spec()["qr"]["payload_grammar"]["regex"])


def drawing_area_px() -> RectPx:
    return rect_px(load_spec()["drawing_area"]["rect_mm"])


def grid_cells() -> tuple[int, int]:
    w, h = load_spec()["drawing_area"]["grid_cells"]
    return int(w), int(h)


def working_px() -> tuple[int, int]:
    w, h = load_spec()["drawing_area"]["working_px"]
    return int(w), int(h)


def cell_working_px() -> int:
    return int(load_spec()["drawing_area"]["cell_working_px"])


def backdrop_px() -> tuple[int, int]:
    w, h = load_spec()["drawing_area"]["backdrop_px"]
    return int(w), int(h)


def character_box_px() -> RectPx:
    return rect_px(load_spec()["character_box"]["rect_mm"])


def sprite_px() -> tuple[int, int]:
    w, h = load_spec()["character_box"]["sprite_px"]
    return int(w), int(h)


def rules_box_px() -> RectPx:
    return rect_px(load_spec()["rules_box"]["rect_mm"])


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
