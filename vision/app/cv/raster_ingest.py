"""Raster ingest: a drawing-area image -> InkDoc, no rectification (PLAN_V2 §3.2 "Raster ingest", §11.3d). Lane C.

    ingest_raster(png, screens=1) -> InkDoc

The same vectorizer as paper (vectorize.py), for v1 canvas drafts, golden PNGs and v1 level migration. The image *is*
the drawing area (48·screens × 27 cells); it is resampled to 32 px per cell (a 768 × 432 canvas is upsampled 2×, so
anti-aliased 8 px brush lines and 6-20 px taps vectorize cleanly: every tap becomes a dot).

Colour classes start from the ideal palette and adapt to the image: each ink centre moves to the median Lab of the
pixels it wins (2 rounds, at most 25 Lab units, and only while it stays nearest its own ideal). That keeps faded
photo ink (v1 `drawing.png` exports of paper scans) and JPEG drafts readable without a swatch row.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

from app.cv.features import assemble
from app.cv.scan_v2 import decode_image
from app.cv.vectorize import Centers, VecParams, bgr_to_lab, classify_labels, ideal_centers, ink_masks, vectorize_masks
from app.spec.ink import InkDoc, NoiseInfo, SheetInfo
from app.template import spec_v2

MAX_INPUT_LONG_EDGE = 12000  # 6 screens at 2× canvas resolution fit; bigger inputs are downscaled first


def infer_screens(width: int, height: int) -> int:
    """Screens of a drawing-area image from its aspect ratio (48·k : 27)."""
    k = (width / max(1, height)) * spec_v2.WORLD_H_CELLS / spec_v2.SCREEN_W_CELLS
    return max(1, min(spec_v2.MAX_SHEETS, int(round(k))))


def estimate_centers(image_bgr: np.ndarray, rounds: int = 2) -> Centers:
    """Ideal palette centres adapted to the image (paper from bright low-chroma pixels, inks from their winners)."""
    p = spec_v2.classify_params()
    max_shift = float(p.get("raster_center_max_shift_lab", 25.0))
    h, w = image_bgr.shape[:2]
    s = min(1.0, 900.0 / max(h, w))
    small = cv2.resize(image_bgr, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA) if s < 1 else image_bgr
    lab = bgr_to_lab(small).reshape(-1, 3)
    ideal = ideal_centers()
    centers = {k: v.copy() for k, v in ideal.items()}
    chroma = np.hypot(lab[:, 1], lab[:, 2])
    paper = lab[(lab[:, 0] > 75) & (chroma < 15)]
    if len(paper) >= 50:
        centers["paper"] = np.median(paper, axis=0).astype(np.float32)
    for _ in range(rounds):
        labels = classify_labels(small, centers).reshape(-1)
        for name in spec_v2.INK_CLASSES:
            i = spec_v2.CLASS_ORDER.index(name)
            sel = lab[labels == i]
            if len(sel) < 30:
                continue
            med = np.median(sel, axis=0).astype(np.float32)
            if float(np.linalg.norm(med - ideal[name])) > max_shift:
                continue
            d_own = float(np.linalg.norm(med - ideal[name]))
            d_other = min(float(np.linalg.norm(med - ideal[o])) for o in spec_v2.INK_CLASSES if o != name)
            if d_own < d_other:
                centers[name] = med
    return centers


def ingest_raster(
    png: bytes,
    screens: int = 1,
    *,
    source: str = "canvas",
    origin: str = "kid",
    ppc: float | None = None,
) -> InkDoc:
    """A drawing-area image (PNG or JPEG bytes) -> InkDoc. `screens` <= 0 infers it from the aspect ratio.

    `source` is the InkDoc source ("canvas" for canvas drafts and goldens, "migrated" for v1 levels); `origin` is
    every stroke's origin. Raises ScanV2Error("error.upload_failed") when the bytes are not an image.
    """
    bgr = decode_image(png, max_long_edge=MAX_INPUT_LONG_EDGE)
    h, w = bgr.shape[:2]
    k = infer_screens(w, h) if screens <= 0 else max(1, min(spec_v2.MAX_SHEETS, int(screens)))
    cells_w, cells_h = spec_v2.SCREEN_W_CELLS * k, spec_v2.WORLD_H_CELLS
    ppc = float(ppc or spec_v2.vectorize_params().get("raster_px_per_cell", 32))
    tw, th = int(round(cells_w * ppc)), int(round(cells_h * ppc))
    interp = cv2.INTER_AREA if w > tw else cv2.INTER_CUBIC
    img = cv2.resize(bgr, (tw, th), interpolation=interp) if (w, h) != (tw, th) else bgr

    centers = estimate_centers(img)
    labels = classify_labels(img, centers)
    masks = ink_masks(labels, ppc)
    vec = vectorize_masks(masks, ppc, offset_cells=(0.0, 0.0), sheet=0, origin=origin, params=VecParams.from_spec(ppc))
    for rc in vec.components:  # canvas strokes carry their screen index as `sheet` (§2.2)
        cx = (rc.bbox[0] + rc.bbox[2]) / 2.0
        rc.sheet = max(0, min(k - 1, int(math.floor(cx / spec_v2.SCREEN_W_CELLS))))
    strokes, comps = assemble(vec.components, stroke_prefix="s")
    return InkDoc(
        v=2,
        source=source,  # type: ignore[arg-type]
        world={"screens": k, "w": cells_w, "h": cells_h},  # type: ignore[arg-type]
        strokes=strokes,
        components=comps,
        character=None,
        typed_rules=[],
        rules_ink=[],
        sheets=[SheetInfo(index=i) for i in range(k)],  # one per screen, like the canvas (core/ink inkFromStrokes)
        noise=NoiseInfo(count=vec.noise),
        parent=None,
    )
