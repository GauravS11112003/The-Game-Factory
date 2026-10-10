"""Connected components + grid coverage (PLAN.md section 6, steps 6-7). Owned by lane A.

connectedComponentsWithStats per color (8-connectivity), drop area < 0.3 cell,
number 1..N in reading order. Coverage per cell via cv2.resize INTER_AREA from
the dilated mask to 48x27: solid if black >= 0.25, hazard if red >= 0.25
(hazard wins).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from app.cv.segment import dilate_for_coverage
from app.models import CVComponent
from app.template import spec

MIN_AREA_CELLS = 0.3
COVERAGE_THRESHOLD = 0.25


@dataclass
class ComponentsResult:
    components: list[CVComponent]
    labels: np.ndarray  # uint16, pixel value = component id, 0 = background
    grid_rows: list[str]
    coverage: dict[str, np.ndarray] = field(default_factory=dict)  # color -> (rows, cols) float32 in 0..1
    masks: dict[str, np.ndarray] = field(default_factory=dict)  # color -> cleaned mask of kept components
    centroids_px: dict[int, tuple[float, float]] = field(default_factory=dict)
    areas_px: dict[int, int] = field(default_factory=dict)


def coverage_grid(mask: np.ndarray, cols: int, rows: int) -> np.ndarray:
    """Fraction of each cell covered by the mask; INTER_AREA on a block-aligned image is an exact mean."""
    return cv2.resize(mask.astype(np.float32) / 255.0, (cols, rows), interpolation=cv2.INTER_AREA)


def _component_cells(
    labels: np.ndarray, comp_id: int, bbox_px: tuple[int, int, int, int], cell: int, cols: int, rows: int
) -> list[tuple[int, int]]:
    """Cells where this component's dilated pixels cover >= 0.25 (computed on a cell-aligned crop)."""
    x0, y0, x1, y1 = bbox_px
    r = max(1, cell // 4)
    cx0, cy0 = max(0, (x0 - r) // cell), max(0, (y0 - r) // cell)
    cx1, cy1 = min(cols - 1, (x1 + r) // cell), min(rows - 1, (y1 + r) // cell)
    crop = labels[cy0 * cell : (cy1 + 1) * cell, cx0 * cell : (cx1 + 1) * cell]
    mask = (crop == comp_id).astype(np.uint8) * 255
    cov = coverage_grid(dilate_for_coverage(mask, cell), cx1 - cx0 + 1, cy1 - cy0 + 1)
    ys, xs = np.nonzero(cov >= COVERAGE_THRESHOLD)
    return [(int(cx0 + x), int(cy0 + y)) for y, x in sorted(zip(ys, xs))]


def find_components(masks: dict[str, np.ndarray], cell_px: int | None = None) -> ComponentsResult:
    """Components numbered in reading order, the 16-bit label image, and the tile grid."""
    cell = cell_px or spec.cell_working_px()
    cols, rows = spec.grid_cells()
    sample = next(iter(masks.values()))
    h, w = sample.shape[:2]
    min_area_px = MIN_AREA_CELLS * cell * cell

    raw: list[dict] = []
    for color in spec.INK_CLASSES:
        mask = masks.get(color)
        if mask is None:
            continue
        n, lab, stats, cents = cv2.connectedComponentsWithStats(mask, connectivity=8, ltype=cv2.CV_32S)
        for i in range(1, n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area < min_area_px:
                continue
            x, y = int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP])
            bw, bh = int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT])
            raw.append(
                {
                    "color": color,
                    "lab": lab,
                    "index": i,
                    "bbox_px": (x, y, x + bw - 1, y + bh - 1),
                    "area": area,
                    "centroid": (float(cents[i, 0]), float(cents[i, 1])),
                }
            )
    # Reading order: by the top-left cell first, then by exact pixel position.
    raw.sort(key=lambda c: (c["bbox_px"][1] // cell, c["bbox_px"][0] // cell, c["bbox_px"][1], c["bbox_px"][0]))

    labels = np.zeros((h, w), dtype=np.uint16)
    kept = {color: np.zeros((h, w), dtype=np.uint8) for color in spec.INK_CLASSES}
    for comp_id, c in enumerate(raw, start=1):
        x0, y0, x1, y1 = c["bbox_px"]
        region = c["lab"][y0 : y1 + 1, x0 : x1 + 1] == c["index"]
        labels[y0 : y1 + 1, x0 : x1 + 1][region] = comp_id
        kept[c["color"]][y0 : y1 + 1, x0 : x1 + 1][region] = 255

    coverage = {color: coverage_grid(dilate_for_coverage(kept[color], cell), cols, rows) for color in spec.INK_CLASSES}
    solid = coverage["black"] >= COVERAGE_THRESHOLD
    hazard = coverage["red"] >= COVERAGE_THRESHOLD
    grid_rows = []
    for j in range(rows):
        grid_rows.append("".join("2" if hazard[j, i] else "1" if solid[j, i] else "0" for i in range(cols)))

    components: list[CVComponent] = []
    centroids: dict[int, tuple[float, float]] = {}
    areas: dict[int, int] = {}
    for comp_id, c in enumerate(raw, start=1):
        cells = _component_cells(labels, comp_id, c["bbox_px"], cell, cols, rows)
        if not cells:
            cx, cy = c["centroid"]
            cells = [(min(cols - 1, int(cx // cell)), min(rows - 1, int(cy // cell)))]
        xs, ys = [p[0] for p in cells], [p[1] for p in cells]
        components.append(
            CVComponent(
                id=comp_id,
                color=c["color"],
                bbox=(min(xs), min(ys), max(xs), max(ys)),
                area_cells=len(cells),
                cells=cells,
            )
        )
        centroids[comp_id] = c["centroid"]
        areas[comp_id] = c["area"]
    return ComponentsResult(
        components=components,
        labels=labels,
        grid_rows=grid_rows,
        coverage=coverage,
        masks=kept,
        centroids_px=centroids,
        areas_px=areas,
    )
