"""Per-pixel nearest-swatch classification -> color masks (PLAN.md section 6, steps 4-5). Owned by lane A.

Vectorized argmin over the 6 Lab distances; gray and paper are background;
confidence margin of 8 Lab units against background kills shadows. Then
OPEN 3x3, CLOSE 5x5, and a cell/4 dilation used only for coverage.
"""
from __future__ import annotations

import cv2
import numpy as np

from app.cv.calibrate import Centers, bgr_to_lab
from app.template import spec

CONFIDENCE_MARGIN = 8.0  # Lab units
PAPER_INDEX = spec.CLASS_ORDER.index("paper")
GRAY_INDEX = spec.CLASS_ORDER.index("gray")
INK_COUNT = len(spec.INK_CLASSES)

_OPEN_KERNEL = np.ones((3, 3), np.uint8)
_CLOSE_KERNEL = np.ones((5, 5), np.uint8)


def classify_labels(image_bgr: np.ndarray, centers: Centers) -> np.ndarray:
    """Per-pixel class index into spec.CLASS_ORDER (uint8); shadowed paper is forced to paper."""
    lab = bgr_to_lab(image_bgr)
    stack = np.stack([centers[name] for name in spec.CLASS_ORDER]).astype(np.float32)  # (6, 3)
    dist = np.empty(lab.shape[:2] + (len(spec.CLASS_ORDER),), dtype=np.float32)
    for i in range(stack.shape[0]):
        diff = lab - stack[i]
        dist[..., i] = np.sqrt(np.einsum("...k,...k->...", diff, diff))
    nearest = np.argmin(dist, axis=2).astype(np.uint8)
    d_nearest = np.take_along_axis(dist, nearest[..., None].astype(np.int64), axis=2)[..., 0]
    d_background = np.minimum(dist[..., GRAY_INDEX], dist[..., PAPER_INDEX])
    # An ink-nearest pixel that is nearly as close to a background class is a
    # shadow or an anti-aliased edge, not ink. Background-nearest pixels keep
    # their class (gray stays gray) so the debug class map stays readable.
    ambiguous = (nearest < INK_COUNT) & ((d_background - d_nearest) < CONFIDENCE_MARGIN)
    nearest[ambiguous] = PAPER_INDEX
    return nearest


def clean_mask(mask: np.ndarray) -> np.ndarray:
    """OPEN 3x3 (specks) then CLOSE 5x5 (join strokes)."""
    opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, _OPEN_KERNEL)
    return cv2.morphologyEx(opened, cv2.MORPH_CLOSE, _CLOSE_KERNEL)


def classify(drawing_bgr: np.ndarray, centers: Centers) -> dict[str, np.ndarray]:
    """Return cleaned binary masks per ink color: {"black": m, "red": m, "green": m, "blue": m} (uint8 0/255)."""
    labels = classify_labels(drawing_bgr, centers)
    masks: dict[str, np.ndarray] = {}
    for i, name in enumerate(spec.INK_CLASSES):
        raw = (labels == i).astype(np.uint8) * 255
        masks[name] = clean_mask(raw)
    return masks


def dilate_for_coverage(mask: np.ndarray, cell_px: int | None = None) -> np.ndarray:
    """Dilate by cell/4 so thin marker lines still register in the grid coverage."""
    cell = cell_px or spec.cell_working_px()
    r = max(1, cell // 4)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    return cv2.dilate(mask, kernel)


def class_map_image(labels: np.ndarray) -> np.ndarray:
    """Debug view of a label map: each class painted in its palette color (BGR)."""
    palette = spec.colors()
    out = np.zeros(labels.shape + (3,), dtype=np.uint8)
    for i, name in enumerate(spec.CLASS_ORDER):
        r, g, b = spec.hex_to_rgb(palette[name])
        out[labels == i] = (b, g, r)
    return out
