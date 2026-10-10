"""Character box -> 32x48 RGBA PNG (PLAN.md section 6, step 9). Owned by lane A.

Ink = not a background class (paper or the printed gray); keep the largest
blob plus anything within 5 px; alpha = ink mask blurred 1 px; tight-crop;
fit into 32x48 with INTER_NEAREST. No ink -> None (the engine uses the
default doodle).
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.cv.calibrate import Centers
from app.cv.segment import INK_COUNT, classify_labels
from app.template import spec

MIN_INK_PX = 120  # ~1.2 mm^2 at 10 px/mm; anything smaller is a stray dot
NEIGHBOUR_PX = 5


def character_box_crop(sheet_bgr: np.ndarray) -> np.ndarray:
    """The box interior, inset so the printed border never counts as ink."""
    x, y, w, h = spec.character_box_px()
    inset = spec.mm_to_px(1.5)
    return sheet_bgr[y + inset : y + h - inset, x + inset : x + w - inset]


def ink_mask(box_bgr: np.ndarray, centers: Centers) -> np.ndarray:
    labels = classify_labels(box_bgr, centers)
    mask = (labels < INK_COUNT).astype(np.uint8) * 255
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))


def sprite_from_box(box_bgr: np.ndarray, centers: Centers) -> np.ndarray | None:
    """BGRA sprite fitted into spec.sprite_px(), or None when the box has no drawing."""
    mask = ink_mask(box_bgr, centers)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return None
    areas = stats[1:, cv2.CC_STAT_AREA]
    largest = 1 + int(np.argmax(areas))
    if int(areas[largest - 1]) < MIN_INK_PX:
        return None
    near = cv2.dilate(
        (lab == largest).astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * NEIGHBOUR_PX + 1, 2 * NEIGHBOUR_PX + 1)),
    )
    keep_ids = np.unique(lab[near > 0])
    keep_ids = keep_ids[keep_ids != 0]
    keep = np.isin(lab, keep_ids).astype(np.uint8) * 255

    alpha = cv2.GaussianBlur(keep, (0, 0), 1.0)
    ys, xs = np.nonzero(alpha)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    crop_bgr = box_bgr[y0:y1, x0:x1]
    crop_a = alpha[y0:y1, x0:x1]

    tw, th = spec.sprite_px()
    ch, cw = crop_a.shape
    scale = min(tw / cw, th / ch)
    nw, nh = max(1, int(round(cw * scale))), max(1, int(round(ch * scale)))
    small_bgr = cv2.resize(crop_bgr, (nw, nh), interpolation=cv2.INTER_NEAREST)
    small_a = cv2.resize(crop_a, (nw, nh), interpolation=cv2.INTER_NEAREST)

    out = np.zeros((th, tw, 4), dtype=np.uint8)
    ox, oy = (tw - nw) // 2, th - nh  # centred, feet on the bottom edge
    out[oy : oy + nh, ox : ox + nw, :3] = small_bgr
    out[oy : oy + nh, ox : ox + nw, 3] = small_a
    out[out[..., 3] == 0, :3] = 0
    return out


def extract_sprite(sheet_bgr: np.ndarray, centers: Centers, out_path: str) -> str | None:
    """Write player.png to out_path and return it, or None when the box is empty."""
    sprite = sprite_from_box(character_box_crop(sheet_bgr), centers)
    if sprite is None:
        return None
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(out_path, sprite)
    return out_path
