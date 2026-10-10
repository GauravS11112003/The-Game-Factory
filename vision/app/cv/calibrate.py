"""Swatch sampling -> Lab class centers (PLAN.md section 6, step 3). Owned by lane A.

Median Lab of each eroded swatch patch plus a "paper" class from the empty
swatch and the drawing-area margins: black, red, green, blue, gray, paper.
Canvas mode uses the ideal hexes from template_spec.json instead.

Lab here is CIE L*a*b* in real units (L 0-100), computed from float BGR so the
8 Lab-unit confidence margin in segment.py means what the plan says.
"""
from __future__ import annotations

import cv2
import numpy as np

from app.template import spec

Centers = dict[str, np.ndarray]  # class name -> float32 (L, a, b), ordered like spec.CLASS_ORDER

CALIBRATION_WARNING = "swatch_calibration_failed"


def bgr_to_lab(image_bgr: np.ndarray) -> np.ndarray:
    """uint8 BGR -> float32 Lab with L in 0..100 and a, b roughly -128..127."""
    return cv2.cvtColor(image_bgr.astype(np.float32) / 255.0, cv2.COLOR_BGR2LAB)


def lab_of_hex(hex_str: str) -> np.ndarray:
    r, g, b = spec.hex_to_rgb(hex_str)
    pixel = np.array([[[b, g, r]]], dtype=np.uint8)
    return bgr_to_lab(pixel)[0, 0].astype(np.float32)


def ideal_centers() -> Centers:
    """Class centers straight from the spec hexes (canvas mode, or the fallback for a bad photo)."""
    palette = spec.colors()
    return {name: lab_of_hex(palette[name]) for name in spec.CLASS_ORDER}


def _inner(rect: spec.RectPx, shrink: float = 0.3) -> tuple[int, int, int, int]:
    x, y, w, h = rect
    dx, dy = int(w * shrink), int(h * shrink)
    return x + dx, y + dy, x + w - dx, y + h - dy


def _median_lab(lab: np.ndarray, region: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = region
    patch = lab[y0:y1, x0:x1].reshape(-1, 3)
    return np.median(patch, axis=0).astype(np.float32)


def _paper_samples(lab: np.ndarray, paper_rect: spec.RectPx) -> np.ndarray:
    """Pixels of the empty swatch plus a band 1-3 mm inside the drawing-area border."""
    x0, y0, x1, y1 = _inner(paper_rect)
    samples = [lab[y0:y1, x0:x1].reshape(-1, 3)]
    ax, ay, aw, ah = spec.drawing_area_px()
    a, b = spec.mm_to_px(1), spec.mm_to_px(3)
    samples.append(lab[ay + a : ay + b, ax + a : ax + aw - a].reshape(-1, 3))
    samples.append(lab[ay + ah - b : ay + ah - a, ax + a : ax + aw - a].reshape(-1, 3))
    samples.append(lab[ay + b : ay + ah - b, ax + a : ax + b].reshape(-1, 3))
    samples.append(lab[ay + b : ay + ah - b, ax + aw - b : ax + aw - a].reshape(-1, 3))
    return np.concatenate(samples, axis=0)


def _plausible(centers: Centers) -> bool:
    """Reject a calibration where the swatches were clearly not where the spec says."""
    ideal = ideal_centers()
    for name in spec.INK_CLASSES:
        # Each ink class must still be closer to its own ideal than to any other class's ideal.
        d_own = float(np.linalg.norm(centers[name] - ideal[name]))
        d_other = min(float(np.linalg.norm(centers[name] - ideal[o])) for o in spec.CLASS_ORDER if o != name)
        if d_own >= d_other:
            return False
    if centers["paper"][0] < 55 or centers["black"][0] > 45:
        return False
    if centers["paper"][0] - centers["gray"][0] < 8:
        return False
    return True


def calibrate_report(sheet_bgr: np.ndarray | None, mode: str = "paper") -> tuple[Centers, list[str]]:
    """Centers plus warnings; paper mode falls back to the ideal hexes when the swatches look wrong."""
    if mode != "paper" or sheet_bgr is None:
        return ideal_centers(), []
    lab = bgr_to_lab(sheet_bgr)
    centers: Centers = {}
    paper_rect: spec.RectPx | None = None
    for patch in spec.swatch_patches_px():
        if patch["name"] == "paper":
            paper_rect = patch["rect_px"]
            continue
        centers[patch["name"]] = _median_lab(lab, _inner(patch["rect_px"]))
    assert paper_rect is not None
    centers["paper"] = np.median(_paper_samples(lab, paper_rect), axis=0).astype(np.float32)
    ordered = {name: centers[name] for name in spec.CLASS_ORDER}
    if not _plausible(ordered):
        return ideal_centers(), [CALIBRATION_WARNING]
    return ordered, []


def calibrate(sheet_bgr: np.ndarray | None, mode: str = "paper") -> Centers:
    """Return an ordered mapping class name -> Lab center (6 entries)."""
    return calibrate_report(sheet_bgr, mode)[0]
