"""run_scan(image_bytes, mode) -> CVResult (PLAN.md section 6). Owned by lane A (CV).

Steps: decode + downscale, rectify (paper only), calibrate from swatches,
classify pixels, clean masks, components, grid coverage, point entities,
sprite, backdrop, annotated image for the model, QR, debug images.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from PIL import Image, ImageOps

from app.cv.calibrate import Centers, calibrate_report
from app.cv.components import ComponentsResult, find_components
from app.cv.rectify import RectifyError, RectifyResult, rectify
from app.cv.segment import class_map_image, classify, classify_labels
from app.cv.sprite import extract_sprite
from app.models import CVComponent, CVResult
from app.template import spec

MAX_LONG_EDGE = 2400
ANNOTATED_WIDTH = 1500
THIN_INK_PX = 3  # median stroke width below this (at working resolution) is flagged

W_MARKER_INFERRED = "marker_inferred"
W_QR_NOT_READ = "qr_not_read"
W_NO_GOAL = "no_goal_drawn"
W_NO_GROUND = "no_ground_drawn"
W_NO_CHARACTER = "no_character_drawn"
W_THIN_INK = "thin_ink"


class ScanError(ValueError):
    """Raised when the photo cannot be turned into a level; the message is shown to the user.

    Example: "Couldn't see the corner markers. Keep the whole sheet in frame."
    """


@dataclass
class DrawingAnalysis:
    """Everything derived from the drawing area alone (shared with the synthetic-fixture generator)."""

    masks: dict[str, np.ndarray]
    comps: ComponentsResult
    goal: tuple[int, int]
    coins: list[tuple[int, int]]
    player_start: tuple[int, int]
    warnings: list[str] = field(default_factory=list)


class _Debug:
    """Numbered intermediate images under work_dir/debug/, or a no-op when debug is off."""

    def __init__(self, folder: Path | None) -> None:
        self.folder = folder
        self.n = 0
        if folder is not None:
            folder.mkdir(parents=True, exist_ok=True)

    def __call__(self, name: str, image: np.ndarray, jpeg: bool = False) -> None:
        if self.folder is None:
            return
        self.n += 1
        if jpeg:
            cv2.imwrite(str(self.folder / f"{self.n:02d}_{name}.jpg"), image, [cv2.IMWRITE_JPEG_QUALITY, 85])
        else:
            cv2.imwrite(str(self.folder / f"{self.n:02d}_{name}.png"), image)


# --- step 1: decode ---------------------------------------------------------------


def decode_image(image_bytes: bytes, max_long_edge: int = MAX_LONG_EDGE) -> tuple[np.ndarray, float]:
    """EXIF-rotated BGR image with its long edge <= max_long_edge, plus the scale applied."""
    try:
        pil = Image.open(io.BytesIO(image_bytes))
        pil = ImageOps.exif_transpose(pil) or pil
    except Exception as exc:  # noqa: BLE001 - any decode failure is a user-facing error
        raise ScanError("That file isn't an image we can read. Try a JPEG or PNG.") from exc
    if pil.mode in ("RGBA", "LA", "P"):
        rgba = pil.convert("RGBA")
        flat = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        flat.alpha_composite(rgba)
        pil = flat.convert("RGB")
    else:
        pil = pil.convert("RGB")
    bgr = np.asarray(pil)[:, :, ::-1].copy()
    h, w = bgr.shape[:2]
    scale = 1.0
    if max(h, w) > max_long_edge:
        scale = max_long_edge / max(h, w)
        bgr = cv2.resize(bgr, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_AREA)
    return bgr, scale


# --- steps 4-8: the drawing area ---------------------------------------------------


def _top_of_column(grid_rows: list[str], x: int) -> int | None:
    for y, row in enumerate(grid_rows):
        if row[x] != "0":
            return y
    return None


def _standing_cell_above(grid_rows: list[str], x: int) -> tuple[int, int] | None:
    """Cell just above the topmost tile in column x, clamped so a 2-tall body fits."""
    top = _top_of_column(grid_rows, x)
    if top is None:
        return None
    return x, max(1, top - 1)


def analyze_drawing(drawing_bgr: np.ndarray, centers: Centers, debug: _Debug | None = None) -> DrawingAnalysis:
    dbg = debug or _Debug(None)
    cols, rows = spec.grid_cells()
    cell = spec.cell_working_px()
    warnings: list[str] = []

    if dbg.folder is not None:
        dbg("class_map", class_map_image(classify_labels(drawing_bgr, centers)))
    masks = classify(drawing_bgr, centers)
    for color, mask in masks.items():
        dbg(f"mask_{color}", mask)
    comps = find_components(masks, cell)
    for color, cov in comps.coverage.items():
        dbg(f"coverage_{color}", (np.clip(cov, 0, 1) * 255).astype(np.uint8))

    solid_cols = [x for x in range(cols) if any(row[x] != "0" for row in comps.grid_rows)]
    if not solid_cols:
        warnings.append(W_NO_GROUND)

    greens = [c for c in comps.components if c.color == "green"]
    if greens:
        best = max(greens, key=lambda c: comps.areas_px[c.id])
        gx, gy = comps.centroids_px[best.id]
        goal = (min(cols - 1, int(gx // cell)), min(rows - 1, int(gy // cell)))
    else:
        warnings.append(W_NO_GOAL)
        goal = _standing_cell_above(comps.grid_rows, solid_cols[-1]) if solid_cols else (cols - 3, rows - 3)

    coins: list[tuple[int, int]] = []
    for c in comps.components:
        if c.color == "blue":
            cx, cy = comps.centroids_px[c.id]
            coins.append((min(cols - 1, int(cx // cell)), min(rows - 1, int(cy // cell))))

    start = _standing_cell_above(comps.grid_rows, solid_cols[0]) if solid_cols else (2, rows - 3)

    black = comps.masks.get("black")
    if black is not None and cv2.countNonZero(black) > 0:
        dist = cv2.distanceTransform(black, cv2.DIST_L2, 3)
        # For a stroke of width w the median distance of its pixels to the edge is about w/4.
        if float(np.median(dist[black > 0])) * 4 < THIN_INK_PX:
            warnings.append(W_THIN_INK)

    return DrawingAnalysis(masks=masks, comps=comps, goal=goal, coins=coins, player_start=start, warnings=warnings)


# --- steps 10-12: outputs ------------------------------------------------------------


def cleaned_drawing(drawing_bgr: np.ndarray, comps: ComponentsResult) -> np.ndarray:
    """Original pixels where ink was found (with a 2 px halo for soft edges), pure white elsewhere."""
    ink = np.zeros(drawing_bgr.shape[:2], dtype=np.uint8)
    for mask in comps.masks.values():
        ink |= mask
    halo = cv2.dilate(ink, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    out = np.full_like(drawing_bgr, 255)
    out[halo > 0] = drawing_bgr[halo > 0]
    return out


def write_annotated(
    sheet_bgr: np.ndarray,
    drawing_origin: tuple[int, int],
    components: list[CVComponent],
    out_path: Path,
) -> None:
    """Sheet at <= 1500 px wide with magenta component ids at each bbox and a 1-cell ruler on both axes."""
    cell = spec.cell_working_px()
    cols, rows = spec.grid_cells()
    ox, oy = drawing_origin
    h, w = sheet_bgr.shape[:2]
    s = min(1.0, ANNOTATED_WIDTH / w)
    img = cv2.resize(sheet_bgr, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_AREA)
    r, g, b = spec.hex_to_rgb(spec.colors()["annotation_magenta"])
    magenta = (b, g, r)
    font = cv2.FONT_HERSHEY_SIMPLEX

    def pt(x_px: float, y_px: float) -> tuple[int, int]:
        return int(round((ox + x_px) * s)), int(round((oy + y_px) * s))

    # Ruler: ticks every cell, numbers every 4 cells, along the top and left edges of the drawing area.
    for i in range(cols + 1):
        x, y = pt(i * cell, 0)
        cv2.line(img, (x, y - (10 if i % 4 == 0 else 5)), (x, y), magenta, 1)
        if i % 4 == 0 and i < cols:
            cv2.putText(img, str(i), (x + 2, y - 12), font, 0.4, magenta, 1, cv2.LINE_AA)
    for j in range(rows + 1):
        x, y = pt(0, j * cell)
        cv2.line(img, (x - (10 if j % 4 == 0 else 5), y), (x, y), magenta, 1)
        if j % 4 == 0 and j < rows:
            cv2.putText(img, str(j), (x - 30, y + 14), font, 0.4, magenta, 1, cv2.LINE_AA)
    cv2.rectangle(img, pt(0, 0), pt(cols * cell, rows * cell), magenta, 1)

    for c in components:
        x0, y0, x1, y1 = c.bbox
        cv2.rectangle(img, pt(x0 * cell, y0 * cell), pt((x1 + 1) * cell, (y1 + 1) * cell), magenta, 1)
        tx, ty = pt(x0 * cell, y0 * cell)
        label = str(c.id)
        (tw, th), _ = cv2.getTextSize(label, font, 0.7, 2)
        cv2.rectangle(img, (tx, ty - th - 6), (tx + tw + 6, ty), (255, 255, 255), -1)
        cv2.putText(img, label, (tx + 3, ty - 3), font, 0.7, magenta, 2, cv2.LINE_AA)
    cv2.imwrite(str(out_path), img, [cv2.IMWRITE_JPEG_QUALITY, 85])


def decode_qr(sheet_bgr: np.ndarray) -> str | None:
    """Payload of the sheet's QR code if it reads and matches the dal1|... grammar, else None."""
    x, y, w, h = spec.qr_rect_px()
    m = spec.mm_to_px(4)
    H, W = sheet_bgr.shape[:2]
    crop = sheet_bgr[max(0, y - m) : min(H, y + h + m), max(0, x - m) : min(W, x + w + m)]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    pattern = re.compile(spec.qr_regex())
    detector = cv2.QRCodeDetector()
    candidates = [cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)]
    _, otsu = cv2.threshold(candidates[0], 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    candidates.append(otsu)
    candidates.append(cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_LINEAR))
    for img in candidates:
        try:
            data, _, _ = detector.detectAndDecode(img)
        except cv2.error:
            continue
        if data and pattern.match(data):
            return data
    return None


# --- run_scan ---------------------------------------------------------------------------


def run_scan(
    image_bytes: bytes,
    mode: Literal["paper", "canvas"],
    work_dir: str,
    debug: bool = False,
) -> CVResult:
    """Turn a photo (paper) or a canvas PNG into a CVResult, writing images into work_dir.

    With debug=True every intermediate image is also written into work_dir/debug/.
    """
    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)
    dbg = _Debug(work / "debug" if debug else None)
    warnings: list[str] = []

    image, _ = decode_image(image_bytes)
    dbg("input", image, jpeg=True)
    wpx, hpx = spec.working_px()

    if mode == "paper":
        try:
            rect: RectifyResult = rectify(image, str(dbg.folder) if dbg.folder else None)
        except RectifyError as exc:
            raise ScanError(str(exc)) from exc
        if rect.inferred_id is not None:
            warnings.append(W_MARKER_INFERRED)
        sheet = rect.image
        dbg("rectified", sheet, jpeg=True)
        centers, cal_warnings = calibrate_report(sheet, "paper")
        warnings.extend(cal_warnings)
        ax, ay, aw, ah = spec.drawing_area_px()
        drawing = sheet[ay : ay + ah, ax : ax + aw]
        if drawing.shape[1] != wpx or drawing.shape[0] != hpx:
            drawing = cv2.resize(drawing, (wpx, hpx), interpolation=cv2.INTER_AREA)
        drawing_origin = (ax, ay)
        qr_payload = decode_qr(sheet)
        if qr_payload is None:
            warnings.append(W_QR_NOT_READ)
    else:
        sheet = None
        centers, _ = calibrate_report(None, "canvas")
        interp = cv2.INTER_AREA if image.shape[1] > wpx else cv2.INTER_LINEAR
        drawing = cv2.resize(image, (wpx, hpx), interpolation=interp)
        drawing_origin = (0, 0)
        qr_payload = None
    dbg("drawing_area", drawing, jpeg=True)

    analysis = analyze_drawing(drawing, centers, dbg)
    warnings.extend(analysis.warnings)
    comps = analysis.comps

    sprite_path: str | None = None
    if mode == "paper" and sheet is not None:
        sprite_path = extract_sprite(sheet, centers, str(work / "player.png"))
        if sprite_path is None:
            warnings.append(W_NO_CHARACTER)

    clean = cleaned_drawing(drawing, comps)
    drawing_path = work / "drawing.png"
    cv2.imwrite(str(drawing_path), clean)
    backdrop_path = work / "backdrop.png"
    cv2.imwrite(str(backdrop_path), cv2.resize(clean, spec.backdrop_px(), interpolation=cv2.INTER_AREA))
    labels_path = work / "labels.png"
    cv2.imwrite(str(labels_path), comps.labels.astype(np.uint16))

    annotated_path = work / "annotated.jpg"
    if sheet is not None:
        write_annotated(sheet, drawing_origin, comps.components, annotated_path)
    else:
        # Canvas mode has no sheet: pad the cleaned drawing so the ruler has room.
        pad = spec.mm_to_px(8)
        padded = cv2.copyMakeBorder(clean, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        write_annotated(padded, (pad, pad), comps.components, annotated_path)

    if dbg.folder is not None:
        vis = np.zeros(comps.labels.shape + (3,), dtype=np.uint8)
        rng = np.random.default_rng(0)
        palette = rng.integers(60, 255, size=(max(2, len(comps.components) + 1), 3), dtype=np.uint8)
        palette[0] = 255
        vis[:] = palette[np.minimum(comps.labels, len(palette) - 1)]
        dbg("labels_vis", vis)
        dbg("grid", _grid_image(analysis))
        dbg("backdrop", cv2.imread(str(backdrop_path)))

    return CVResult(
        mode=mode,
        grid_rows=comps.grid_rows,
        components=comps.components,
        goal=analysis.goal,
        coins=analysis.coins,
        player_start=analysis.player_start,
        sprite_path=sprite_path,
        backdrop_path=str(backdrop_path),
        drawing_path=str(drawing_path),
        labels_path=str(labels_path),
        annotated_path=str(annotated_path),
        qr_payload=qr_payload,
        warnings=warnings,
        work_dir=str(work),
    )


def _grid_image(analysis: DrawingAnalysis, scale: int = 16) -> np.ndarray:
    cols, rows = spec.grid_cells()
    img = np.full((rows * scale, cols * scale, 3), 255, dtype=np.uint8)
    for j, row in enumerate(analysis.comps.grid_rows):
        for i, ch in enumerate(row):
            if ch == "0":
                continue
            color = (0, 0, 0) if ch == "1" else (53, 57, 229)
            cv2.rectangle(img, (i * scale, j * scale), ((i + 1) * scale - 1, (j + 1) * scale - 1), color, -1)
    for x, y in analysis.coins:
        cv2.circle(img, (x * scale + scale // 2, y * scale + scale // 2), scale // 3, (229, 136, 30), -1)
    gx, gy = analysis.goal
    cv2.circle(img, (gx * scale + scale // 2, gy * scale + scale // 2), scale // 2, (71, 160, 67), 2)
    sx, sy = analysis.player_start
    cv2.rectangle(img, (sx * scale, sy * scale), ((sx + 1) * scale - 1, (sy + 1) * scale - 1), (255, 0, 255), 2)
    return img
