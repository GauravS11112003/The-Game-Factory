"""run_scan_v2: paper photos -> InkDoc (PLAN_V2 §3.2 "Paper", §6.4, §11.3d). Lane C.

    run_scan_v2(images, pack, work_dir) -> ScanV2 {ink: InkDoc, sheets: [SheetInfo], warnings: [MessageRef]}

Per photo (sheets run in parallel threads; OpenCV releases the GIL):
1. Decode (EXIF rotation, alpha flattened onto white, long edge <= 2400 px).
2. **Rectify** with the v1 marker approach (ArUco DICT_4X4_50 ids 0-3, a CLAHE second pass), upgraded: every
   corner of every detected marker feeds one RANSAC homography, so 3 markers give a true perspective fit (v1
   completed a parallelogram, which is affine-only and drifts under a 25° tilt). Canonical sheet 2970x2100.
3. **Flatten the lighting**: a robust degree-3 polynomial of the paper brightness (thin ink removed by a max filter,
   dark masses rejected as outliers) divides out shadow gradients before calibration.
4. **Calibrate** Lab class centres from the printed swatches (v1), falling back to the ideal hexes if implausible.
5. **QR v2** (`dal2|p|<pack>|n/k`, or v1 `dal1|…` as a 1-sheet pack) gives the sheet number n. When the QR cannot
   be read, the printed pack map (sheets 2..k) or the sheet-1 boxes give it instead (stitch.py).
6. Classify the drawing area (Lab nearest centre, 8-unit background margin), vectorize (vectorize.py), map to
   world x ∈ [48·(n−1), 48·n). The character box (sheet 1) becomes `character.strokes` (+ a sprite PNG), and the
   rules box (sheet 1) becomes strokes listed in `rules_ink` (drawing-area cells, y > 27).
7. Light pencil marks (the gray class, which is background) are counted, never silently dropped: a warning asks
   the child to trace them with a marker. Remix sheets skip this: their gray is the parent's printed ink.

Across photos (stitch.py): photos in any order; a sheet scanned twice keeps the newest photo; photos with no
readable place are put where their stroke ends meet the neighbours'; missing sheets become empty screens with a
warning; a remix keeps the parent's screen for every sheet not scanned and carries the parent's strokes (origin
`parent`); an extend sheet adds one screen after the parent. world.screens = k (remix: max(k, parent screens);
extend: parent screens + 1).

Files written under work_dir (the draft folder, §11.3i): sheets/<screen>.jpg (rectified sheet, 1-based screen),
sheets/<screen>.character.png; ScanV2.files keys them as "sheet:<screen>" and "character:<screen>".
"""
from __future__ import annotations

import io
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal, Sequence

import cv2
import numpy as np
from PIL import Image, ImageOps

from app.cv import stitch
from app.cv.vectorize import (
    Centers,
    RawComponent,
    RawStroke,
    VecParams,
    bgr_to_lab,
    classify_labels,
    ideal_centers,
    ink_masks,
    vectorize_masks,
)
from app.spec.common import MessageRef
from app.spec.ink import InkDoc, NoiseInfo, SheetInfo
from app.template import spec_v2
from app.template.spec_v2 import QrInfo, parse_qr

PackKind = Literal["new", "game", "remix", "extend"]
MAX_LONG_EDGE = 2400
JPEG_QUALITY = 85
THIN_INK_C = 0.08  # median stroke width below this (0.4 mm) earns the "thicker marker" tip


# ======================================================================================================
# Public types
# ======================================================================================================


@dataclass(frozen=True)
class PackInfo:
    """The server's pack record (packs table, §6.4): the QR only carries the id and n/k."""

    pack_id: str
    kind: PackKind = "new"
    k: int = 1
    game_id: str | None = None
    parent_id: str | None = None


class ScanV2Error(ValueError):
    """No sheet could be read. `message` is the kid-facing MessageRef (error.paper_missing, error.no_drawing, …)."""

    def __init__(self, key: str, args: dict[str, str | int | float | bool | None] | None = None) -> None:
        self.message = MessageRef(key=key, args=args or {})
        super().__init__(key)


@dataclass
class SheetScan:
    """One photo after rectify + vectorize (internal; ScanV2.scans keeps the ones that were used)."""

    photo_index: int
    n: int  # 1-based sheet number
    qr: QrInfo | None
    payload: str | None
    n_source: str = "qr"  # qr | pack_map | layout (sheet-1 boxes) | default (unknown) | seam | only (stitch.py)
    k_hint: int | None = None  # sheets in the pack, from the QR or the pack map
    x0: float = 0.0  # world x (cells) of the drawing area's left edge
    screen: int = 0  # 0-based world screen (SheetInfo.index, InkStroke.sheet)
    raws: list[RawComponent] = field(default_factory=list)
    noise: int = 0
    pencil: int = 0  # stroke-like gray-class marks (light pencil) in the drawing area
    character: list[tuple[RawStroke, str]] = field(default_factory=list)  # (stroke, ink colour), box-local cells
    rules: list[tuple[RawStroke, str]] = field(default_factory=list)  # (stroke, ink colour), drawing-area cells
    warnings: list[MessageRef] = field(default_factory=list)
    files: dict[str, Path] = field(default_factory=dict)
    markers: list[int] = field(default_factory=list)
    lighting_fixed: bool = False
    calibrated: bool = True
    ms: dict[str, float] = field(default_factory=dict)


@dataclass
class ScanV2:
    ink: InkDoc
    sheets: list[SheetInfo]
    warnings: list[MessageRef]
    scans: list[SheetScan] = field(default_factory=list)
    files: dict[str, Path] = field(default_factory=dict)  # "sheet:<screen>", "character:<screen>" -> path (1-based)
    pack: PackInfo | None = None  # the pack the photos were resolved to (given, looked up, or v1 legacy remix)
    qr_pack_id: str | None = None  # the pack id the QR codes carry (most common), for the caller's lookup
    ms: dict[str, float] = field(default_factory=dict)
    seams: list[stitch.SeamReport] = field(default_factory=list)  # N11 join candidates per seam
    complete: bool = True  # every sheet of the pack is there (publishing needs all k, §6.4)
    playable_screens: int = 1  # screens in the contiguous run from sheet 1 (playable as soon as >= 1)
    parent: dict[str, Any] | None = None  # the parent LevelV2 a remix or extend pack was stitched onto


# ======================================================================================================
# Decode and rectify
# ======================================================================================================


def decode_image(image_bytes: bytes, max_long_edge: int = MAX_LONG_EDGE) -> np.ndarray:
    """EXIF-rotated BGR uint8 image with its long edge <= max_long_edge; ScanV2Error if it is not an image."""
    try:
        pil = Image.open(io.BytesIO(image_bytes))
        pil = ImageOps.exif_transpose(pil) or pil
        if pil.mode in ("RGBA", "LA", "P", "PA"):
            rgba = pil.convert("RGBA")
            flat = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            flat.alpha_composite(rgba)
            pil = flat.convert("RGB")
        else:
            pil = pil.convert("RGB")
    except Exception as exc:  # noqa: BLE001 - any decode failure is a user-facing error
        raise ScanV2Error("error.upload_failed") from exc
    bgr = np.ascontiguousarray(np.asarray(pil)[:, :, ::-1])
    h, w = bgr.shape[:2]
    if max(h, w) > max_long_edge:
        s = max_long_edge / max(h, w)
        bgr = cv2.resize(bgr, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_AREA)
    return bgr


def _aruco_detector() -> cv2.aruco.ArucoDetector:
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    return cv2.aruco.ArucoDetector(dictionary, params)


def _detect(gray: np.ndarray, det: cv2.aruco.ArucoDetector) -> dict[int, np.ndarray]:
    corners, ids, _ = det.detectMarkers(gray)
    found: dict[int, np.ndarray] = {}
    if ids is None:
        return found
    wanted = {m["id"] for m in spec_v2.marker_specs()}
    for quad, marker_id in zip(corners, ids.flatten()):
        mid = int(marker_id)
        if mid in wanted and mid not in found:
            found[mid] = quad.reshape(4, 2).astype(np.float32)
    return found


def detect_markers(image_bgr: np.ndarray) -> dict[int, np.ndarray]:
    """Marker id -> its 4 corners (cv2.aruco order: the marker's TL, TR, BR, BL) in image pixels."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    det = _aruco_detector()
    found = _detect(gray, det)
    need = spec_v2.min_markers_for_rectify()
    if len(found) < 4:
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        for k, v in _detect(clahe.apply(gray), det).items():
            found.setdefault(k, v)
    if len(found) < need:
        # Strong shadows: normalize by a blurred background before the third try.
        bg = cv2.GaussianBlur(gray, (0, 0), max(8.0, gray.shape[1] / 60.0))
        norm = cv2.divide(gray, np.maximum(bg, 1), scale=200)
        for k, v in _detect(norm, det).items():
            found.setdefault(k, v)
    return found


def _marker_dst_corners() -> dict[int, np.ndarray]:
    out: dict[int, np.ndarray] = {}
    for m in spec_v2.marker_specs():
        x, y, w, h = m["rect_px"]
        out[m["id"]] = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], dtype=np.float32)
    return out


@dataclass
class Rectified:
    image: np.ndarray  # canonical sheet, BGR, spec canvas size
    ids: list[int]
    homography: np.ndarray


def rectify_v2(image_bgr: np.ndarray) -> Rectified:
    found = detect_markers(image_bgr)
    if len(found) < spec_v2.min_markers_for_rectify():
        raise ScanV2Error("error.paper_missing")
    dst_by_id = _marker_dst_corners()
    src = np.vstack([found[i] for i in sorted(found)]).astype(np.float32)
    dst = np.vstack([dst_by_id[i] for i in sorted(found)]).astype(np.float32)
    scale = spec_v2.canvas_size_px()[0] / max(image_bgr.shape[:2])
    H, _ = cv2.findHomography(src, dst, cv2.RANSAC, max(3.0, 3.0 * scale))
    if H is None:
        # Degenerate RANSAC: fall back to the outer corners (v1), completing a parallelogram from 3.
        H = _outer_corner_homography(found)
    w, h = spec_v2.canvas_size_px()
    warped = cv2.warpPerspective(image_bgr, H, (w, h), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    return Rectified(image=warped, ids=sorted(found), homography=H)


def _outer_corner_homography(found: dict[int, np.ndarray]) -> np.ndarray:
    specs = {m["id"]: m for m in spec_v2.marker_specs()}
    outer = {i: found[i][specs[i]["outer_corner_index"]] for i in found if i in specs}
    missing = [i for i in range(4) if i not in outer]
    if len(missing) == 1:
        m = missing[0]
        p = outer
        if m == 0:
            p[0] = p[1] + p[3] - p[2]
        elif m == 1:
            p[1] = p[0] + p[2] - p[3]
        elif m == 2:
            p[2] = p[1] + p[3] - p[0]
        else:
            p[3] = p[0] + p[2] - p[1]
    if len(outer) < 4:
        raise ScanV2Error("error.paper_missing")
    src = np.array([outer[i] for i in range(4)], dtype=np.float32)
    dst = np.array(spec_v2.outer_corners_px(), dtype=np.float32)
    return cv2.getPerspectiveTransform(src, dst)


# ======================================================================================================
# Lighting and calibration
# ======================================================================================================


def _poly_terms(x: np.ndarray, y: np.ndarray, degree: int) -> np.ndarray:
    cols = [x**i * y**j for i in range(degree + 1) for j in range(degree + 1 - i)]
    return np.stack(cols, axis=-1)


def flatten_illumination(sheet_bgr: np.ndarray) -> tuple[np.ndarray, bool]:
    """Divide out a smooth shadow gradient; returns (image, applied)."""
    p = spec_v2.illumination_params()
    ds = max(2, int(p["downscale"]))
    H, W = sheet_bgr.shape[:2]
    sw, sh = max(8, W // ds), max(8, H // ds)
    small = cv2.resize(sheet_bgr, (sw, sh), interpolation=cv2.INTER_AREA)
    bg = cv2.dilate(small, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(p["dilate_px"]),) * 2)).astype(np.float64)
    yy, xx = np.mgrid[0:sh, 0:sw].astype(np.float64)
    xn, yn = xx / (sw - 1) * 2 - 1, yy / (sh - 1) * 2 - 1
    deg = int(p["poly_degree"])
    A = _poly_terms(xn.ravel(), yn.ravel(), deg)
    vals = bg.reshape(-1, 3)
    lum = vals.mean(axis=1)
    sample = np.zeros(len(lum), dtype=bool)
    sample[::2] = True
    use = sample.copy()
    coef = None
    for _ in range(int(p["iterations"])):
        if use.sum() < A.shape[1] * 4:
            break
        coef, *_ = np.linalg.lstsq(A[use], vals[use], rcond=None)
        resid = lum - (A @ coef).mean(axis=1)
        use = sample & (resid > -float(p["outlier_below"]))
    if coef is None:
        return sheet_bgr, False
    surf = (A @ coef).reshape(sh, sw, 3)
    surf_l = surf.mean(axis=2)
    hi, lo = np.percentile(surf_l, 98), np.percentile(surf_l, 2)
    if hi <= 1 or (hi - lo) / hi < float(p["min_variation"]):
        return sheet_bgr, False
    ref = np.percentile(surf.reshape(-1, 3), 95, axis=0)
    gain = (ref[None, None, :] / np.maximum(surf, 8.0)).astype(np.float32)
    gain = np.clip(gain, 0.5, 3.0)
    gain_full = cv2.resize(gain, (W, H), interpolation=cv2.INTER_LINEAR)
    out = np.clip(sheet_bgr.astype(np.float32) * gain_full, 0, 255).astype(np.uint8)
    return out, True


def _inner(rect: spec_v2.RectPx, shrink: float = 0.3) -> tuple[int, int, int, int]:
    x, y, w, h = rect
    dx, dy = int(w * shrink), int(h * shrink)
    return x + dx, y + dy, x + w - dx, y + h - dy


def _paper_samples(lab: np.ndarray, paper_rect: spec_v2.RectPx, with_area_border: bool = True) -> np.ndarray:
    """The empty swatch plus (drawing sheets) a band 1-3 mm inside the drawing-area border."""
    x0, y0, x1, y1 = _inner(paper_rect)
    samples = [lab[y0:y1, x0:x1].reshape(-1, 3)]
    if not with_area_border:
        return samples[0]
    ax, ay, aw, ah = spec_v2.drawing_area_px()
    a, b = spec_v2.mm_to_px(1), spec_v2.mm_to_px(3)
    samples.append(lab[ay + a : ay + b, ax + a : ax + aw - a].reshape(-1, 3))
    samples.append(lab[ay + ah - b : ay + ah - a, ax + a : ax + aw - a].reshape(-1, 3))
    samples.append(lab[ay + b : ay + ah - b, ax + a : ax + b].reshape(-1, 3))
    samples.append(lab[ay + b : ay + ah - b, ax + aw - b : ax + aw - a].reshape(-1, 3))
    return np.concatenate(samples, axis=0)


def _plausible(centers: Centers) -> bool:
    ideal = ideal_centers()
    for name in spec_v2.INK_CLASSES:
        d_own = float(np.linalg.norm(centers[name] - ideal[name]))
        d_other = min(float(np.linalg.norm(centers[name] - ideal[o])) for o in spec_v2.CLASS_ORDER if o != name)
        if d_own >= d_other:
            return False
    if centers["paper"][0] < 55 or centers["black"][0] > 45:
        return False
    if centers["paper"][0] - centers["gray"][0] < 8:
        return False
    return True


def calibrate_v2(sheet_bgr: np.ndarray, patches: Sequence[dict[str, Any]] | None = None) -> tuple[Centers, bool]:
    """Lab centres from the printed swatches; (ideal centres, False) when they look wrong.

    `patches` defaults to the drawing sheet's swatch block; the library sheet passes its header swatch strip."""
    lab = bgr_to_lab(sheet_bgr)
    centers: Centers = {}
    paper_rect = None
    drawing_sheet = patches is None
    for patch in patches if patches is not None else spec_v2.swatch_patches_px():
        if patch["name"] == "paper":
            paper_rect = patch["rect_px"]
            continue
        x0, y0, x1, y1 = _inner(patch["rect_px"])
        centers[patch["name"]] = np.median(lab[y0:y1, x0:x1].reshape(-1, 3), axis=0).astype(np.float32)
    if paper_rect is None or any(name not in centers for name in spec_v2.CLASS_ORDER if name != "paper"):
        return ideal_centers(), False
    centers["paper"] = np.median(_paper_samples(lab, paper_rect, drawing_sheet), axis=0).astype(np.float32)
    ordered = {name: centers[name] for name in spec_v2.CLASS_ORDER}
    if not _plausible(ordered):
        return ideal_centers(), False
    return ordered, True


# ======================================================================================================
# QR v2
# ======================================================================================================


def decode_qr_v2(sheet_bgr: np.ndarray, photo_bgr: np.ndarray | None = None) -> str | None:
    """The sheet's QR payload if it reads and parses (v2 grammar or v1 legacy), else None."""
    x, y, w, h = spec_v2.qr_rect_px()
    m = spec_v2.mm_to_px(float(spec_v2.load_spec()["qr"].get("decode_margin_mm", 4)))
    H, W = sheet_bgr.shape[:2]
    crop = sheet_bgr[max(0, y - m) : min(H, y + h + m), max(0, x - m) : min(W, x + w + m)]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    big = cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    _, otsu = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    candidates = [big, otsu, cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_LINEAR), gray]
    detectors: list[object] = [cv2.QRCodeDetector()]
    if hasattr(cv2, "QRCodeDetectorAruco"):
        detectors.append(cv2.QRCodeDetectorAruco())
    for det in detectors:
        for img in candidates:
            payload = _try_qr(det, img)
            if payload:
                return payload
    if photo_bgr is not None:
        pg = cv2.cvtColor(photo_bgr, cv2.COLOR_BGR2GRAY)
        for det in detectors:
            payload = _try_qr(det, pg)
            if payload:
                return payload
    return None


def _try_qr(det: object, img: np.ndarray) -> str | None:
    try:
        data, _, _ = det.detectAndDecode(img)  # type: ignore[attr-defined]
    except cv2.error:
        return None
    if data and parse_qr(data) is not None:
        return str(data).strip()
    return None


# ======================================================================================================
# Boxes
# ======================================================================================================


def _box_interior(sheet_bgr: np.ndarray, rect: spec_v2.RectPx, inset: int) -> tuple[np.ndarray, tuple[int, int]]:
    x, y, w, h = rect
    return sheet_bgr[y + inset : y + h - inset, x + inset : x + w - inset], (x + inset, y + inset)


def _union_mask(masks: dict[str, np.ndarray]) -> np.ndarray:
    out = None
    for m in masks.values():
        out = m.copy() if out is None else cv2.bitwise_or(out, m)
    return out if out is not None else np.zeros((1, 1), np.uint8)


def character_sprite(box_bgr: np.ndarray, ink: np.ndarray) -> np.ndarray | None:
    """BGRA sprite fitted into spec sprite_px (centred, feet on the bottom edge), or None when the box is empty."""
    if cv2.countNonZero(ink) < 0.03 * spec_v2.cell_working_px() ** 2:
        return None
    alpha = cv2.GaussianBlur(ink, (0, 0), 1.0)
    ys, xs = np.nonzero(alpha > 8)
    y0, y1, x0, x1 = int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1
    crop_bgr, crop_a = box_bgr[y0:y1, x0:x1], alpha[y0:y1, x0:x1]
    tw, th = spec_v2.sprite_px()
    ch, cw = crop_a.shape
    s = min(tw / cw, th / ch)
    nw, nh = max(1, int(round(cw * s))), max(1, int(round(ch * s)))
    interp = cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR
    small_bgr = cv2.resize(crop_bgr, (nw, nh), interpolation=interp)
    small_a = cv2.resize(crop_a, (nw, nh), interpolation=interp)
    out = np.zeros((th, tw, 4), dtype=np.uint8)
    ox, oy = (tw - nw) // 2, th - nh
    out[oy : oy + nh, ox : ox + nw, :3] = small_bgr
    out[oy : oy + nh, ox : ox + nw, 3] = small_a
    out[out[..., 3] == 0, :3] = 0
    return out


def _pencil_marks(labels: np.ndarray, ppc: float) -> int:
    """Stroke-like gray-class marks inside the drawing area (pencil, faint marker); the dot grid and border excluded."""
    p = spec_v2.classify_params()
    gray_i = spec_v2.CLASS_ORDER.index("gray")
    m = cv2.medianBlur((labels == gray_i).astype(np.uint8) * 255, 3)
    n, _, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    H, W = labels.shape
    min_area = float(p["pencil_min_area_c2"]) * ppc * ppc
    max_thick = 2.0 * float(p["pencil_max_half_width_c"]) * ppc
    edge = int(0.2 * ppc)
    count = 0
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i, :5])
        if area < min_area or x <= edge or y <= edge or x + w >= W - edge or y + h >= H - edge:
            continue
        if area / max(w, h, 1) <= max_thick and max(w, h) >= 0.5 * ppc:
            count += 1
    return count


# ======================================================================================================
# One sheet
# ======================================================================================================


def _boxed_strokes(comps: list[RawComponent]) -> list[tuple[RawStroke, str]]:
    ordered = sorted(comps, key=lambda r: (r.bbox[0], r.bbox[1]))
    return [(s, rc.color) for rc in ordered for s in sorted(rc.strokes, key=lambda t: (t.pts[0][0], t.pts[0][1]))]


@dataclass
class PreparedSheet:
    """One photo, rectified onto the canonical canvas with the lighting flattened, and its QR read."""

    photo: np.ndarray
    rect: Rectified
    sheet: np.ndarray  # canonical sheet (BGR), lighting flattened
    lighting_fixed: bool
    payload: str | None
    qr: QrInfo | None
    ms: dict[str, float] = field(default_factory=dict)


def prepare_sheet(image_bytes: bytes) -> PreparedSheet:
    """Decode, rectify, flatten the lighting and read the QR (drawing, rules and library sheets alike)."""
    ms: dict[str, float] = {}
    t0 = time.perf_counter()
    photo = decode_image(image_bytes)
    rect = rectify_v2(photo)
    ms["rectify"] = (time.perf_counter() - t0) * 1000
    t = time.perf_counter()
    sheet, fixed = flatten_illumination(rect.image)
    payload = decode_qr_v2(sheet, photo)
    ms["qr"] = (time.perf_counter() - t) * 1000
    return PreparedSheet(photo=photo, rect=rect, sheet=sheet, lighting_fixed=fixed, payload=payload,
                         qr=parse_qr(payload), ms=ms)


def scan_sheet(image_bytes: bytes, photo_index: int, work_dir: Path | None) -> SheetScan:
    """Rectify, calibrate and vectorize one photo. Its sheet number comes from the QR; when the QR cannot be read,
    from the printed pack map (sheets 2..k) or the sheet-1 boxes; otherwise stitch.py places it by its seams."""
    t0 = time.perf_counter()
    prep = prepare_sheet(image_bytes)
    rect, sheet, payload, qr = prep.rect, prep.sheet, prep.payload, prep.qr
    ms = dict(prep.ms)
    t = time.perf_counter()
    centers, calibrated = calibrate_v2(sheet)
    ms["calibrate"] = (time.perf_counter() - t) * 1000

    n, n_source, k_hint = 1, "qr", None
    if qr is not None and qr.kind == "pack":
        n, k_hint = qr.n, (qr.k if qr.legacy is None else 1)
    elif qr is None:
        pm = stitch.read_pack_map(sheet)
        if pm is not None:
            k_hint = pm.k
            if pm.n is not None:
                n, n_source = pm.n, "pack_map"
            else:
                n_source = "default"
        elif stitch.has_first_sheet_layout(sheet):
            n, n_source = 1, "layout"
        else:
            n_source = "default"
    warnings: list[MessageRef] = []
    if qr is None:
        warnings.append(MessageRef(key="warning.qr_not_read", args={"n": n}))
    if len(rect.ids) < 4:
        warnings.append(MessageRef(key="warning.marker_inferred", args={"n": n}))
    if not calibrated:
        warnings.append(MessageRef(key="warning.calibration_fallback", args={"n": n}))
    scan = SheetScan(photo_index=photo_index, n=n, qr=qr, payload=payload, n_source=n_source, k_hint=k_hint,
                     x0=float(spec_v2.SCREEN_W_CELLS * (n - 1)), screen=n - 1, warnings=warnings, markers=rect.ids,
                     lighting_fixed=prep.lighting_fixed, calibrated=calibrated, ms=ms)
    if qr is not None and qr.kind != "pack":
        return scan  # a rules or library sheet: run_scan_v2 reports it; it has no drawing area

    t = time.perf_counter()
    ppc = float(spec_v2.cell_working_px())
    P = VecParams.from_spec(ppc)
    ax, ay, aw, ah = spec_v2.drawing_area_px()
    drawing = sheet[ay : ay + ah, ax : ax + aw]
    labels = classify_labels(drawing, centers)
    masks = ink_masks(labels, ppc)
    vec = vectorize_masks(
        masks, ppc, offset_cells=(float(spec_v2.SCREEN_W_CELLS * (n - 1)), 0.0), sheet=n - 1, params=P
    )
    scan.raws, scan.noise = vec.components, vec.noise
    scan.pencil = _pencil_marks(labels, ppc)
    widths = [rc.width_c for rc in vec.components if not (len(rc.strokes) == 1 and rc.strokes[0].kind == "dot")]
    if widths and float(np.median(widths)) < THIN_INK_C:
        warnings.append(MessageRef(key="warning.thin_ink", args={"n": n}))
    ms["vectorize"] = (time.perf_counter() - t) * 1000

    t = time.perf_counter()
    if n in spec_v2.character_sheets():
        box, _ = _box_interior(sheet, spec_v2.character_box_px(), spec_v2.box_inset_px("character_box"))
        box_masks = ink_masks(classify_labels(box, centers), ppc)
        cvec = vectorize_masks(box_masks, ppc, offset_cells=(0.0, 0.0), sheet=n - 1, params=P)
        scan.character = _boxed_strokes(cvec.components)
        sprite = character_sprite(box, _union_mask(box_masks))
        if sprite is not None and work_dir is not None:
            path = work_dir / "sheets" / f"photo{photo_index}.character.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(path), sprite)
            scan.files["character"] = path
    if n in spec_v2.rules_sheets():
        rbox, _ = _box_interior(sheet, spec_v2.rules_box_px(), spec_v2.box_inset_px("rules_box"))
        rx0, ry0, _, _ = spec_v2.rules_box_drawing_cells(inset=True)
        rmasks = ink_masks(classify_labels(rbox, centers), ppc)
        rvec = vectorize_masks(
            rmasks, ppc, offset_cells=(float(spec_v2.SCREEN_W_CELLS * (n - 1)) + rx0, ry0), sheet=n - 1, params=P
        )
        scan.rules = _boxed_strokes(rvec.components)
    ms["boxes"] = (time.perf_counter() - t) * 1000

    if work_dir is not None:
        path = work_dir / "sheets" / f"photo{photo_index}.rect.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(path), sheet, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        scan.files["sheet"] = path
    ms["total"] = (time.perf_counter() - t0) * 1000
    return scan


# ======================================================================================================
# run_scan_v2
# ======================================================================================================


def _scan_or_message(args: tuple[bytes, int, Path | None]) -> SheetScan | MessageRef:
    data, i, work = args
    try:
        return scan_sheet(data, i, work)
    except ScanV2Error as e:
        return MessageRef(key="warning.photo_unreadable", args={"i": i + 1, "why": e.message.key})


def _resolve_pack(
    scans: list[SheetScan], pack: PackInfo | None, lookup: Callable[[str], PackInfo | None] | None
) -> tuple[PackInfo | None, str | None]:
    """The pack the photos belong to: the given one, else the server record for the most common QR pack id."""
    ids = [s.qr.id for s in scans if s.qr is not None and s.qr.kind == "pack" and s.qr.legacy is None
           and not s.qr.is_blank and s.qr.id]
    read_id = max(set(ids), key=ids.count) if ids else None
    if pack is not None:
        return pack, read_id
    if read_id is not None and lookup is not None:
        try:
            found = lookup(read_id)
        except Exception:  # noqa: BLE001 - a lookup failure must not lose the scan
            found = None
        if found is not None:
            return found, read_id
    legacy = next((s.qr for s in scans if s.qr is not None and s.qr.legacy == "lvl"), None)
    if legacy is not None and legacy.legacy_id:
        return PackInfo(pack_id="legacy", kind="remix", k=1, parent_id=legacy.legacy_id), read_id
    return None, read_id


def _load_parent(
    pack: PackInfo | None,
    parent: dict[str, Any] | None,
    lookup: Callable[[str], dict[str, Any] | None] | None,
) -> dict[str, Any] | None:
    """The parent LevelV2 of a remix or extend pack: given, from `lookup(parent_id)`, else the v2 levels table."""
    if pack is None or pack.kind not in ("remix", "extend"):
        return None
    if parent is not None:
        return parent
    pid = pack.parent_id
    if not pid:
        return None
    try:
        if lookup is not None:
            found = lookup(pid)
        else:  # the server's own store (read-only); lane D may pass `parent` / `parent_lookup` instead
            from app import db_v2

            row = db_v2.get_level_row(pid)
            found = (row or {}).get("level")
    except Exception:  # noqa: BLE001 - a lookup failure must not lose the scan
        found = None
    return found if isinstance(found, dict) else None


def _place_files(s: SheetScan, work: Path) -> dict[str, Path]:
    """Rename the photo's outputs to its world screen (sheets/<screen>.jpg, 1-based) and key them for the caller."""
    out: dict[str, Path] = {}
    names = {"sheet": f"{s.screen + 1}.jpg", "character": f"{s.screen + 1}.character.png"}
    for key, path in list(s.files.items()):
        target = work / "sheets" / names.get(key, path.name)
        try:
            if path != target:
                path.replace(target)
            s.files[key] = target
        except OSError:
            target = path
        out[f"{key}:{s.screen + 1}"] = target
    return out


def run_scan_v2(
    images: list[bytes],
    pack: PackInfo | None,
    work_dir: Path,
    *,
    pack_lookup: Callable[[str], PackInfo | None] | None = None,
    parent: dict[str, Any] | None = None,
    parent_lookup: Callable[[str], dict[str, Any] | None] | None = None,
) -> ScanV2:
    """1-6 photos of one pack (any order) -> one InkDoc. Raises ScanV2Error when no photo yields a sheet.

    `pack` is the server's pack record when the caller knows it; otherwise `pack_lookup(pack_id)` is asked with the
    pack id read from the QR codes. Without either, k is inferred from the QR codes, the pack maps and the photo count.
    For a remix or extend pack, `parent` (a LevelV2 dict) is the level the sheets were printed over; without it,
    `parent_lookup(parent_id)` or the v2 levels table is asked.
    """
    t0 = time.perf_counter()
    if not images:
        raise ScanV2Error("error.bad_request")
    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)
    jobs = [(data, i, work) for i, data in enumerate(images[: spec_v2.MAX_SHEETS * 2])]
    if len(jobs) == 1:
        results = [_scan_or_message(jobs[0])]
    else:
        with ThreadPoolExecutor(max_workers=min(4, len(jobs))) as ex:
            results = list(ex.map(_scan_or_message, jobs))

    warnings: list[MessageRef] = []
    scans: list[SheetScan] = []
    errors: list[MessageRef] = []
    for r in results:
        if isinstance(r, MessageRef):
            errors.append(r)
            warnings.append(r)
        elif r.qr is not None and r.qr.kind != "pack":
            warnings.append(MessageRef(key="warning.not_a_drawing_sheet", args={"i": r.photo_index + 1}))
        else:
            scans.append(r)
    if not scans:
        if errors and all(e.args.get("why") == "error.upload_failed" for e in errors):
            raise ScanV2Error("error.upload_failed")
        raise ScanV2Error("error.paper_missing")

    pack, read_id = _resolve_pack(scans, pack, pack_lookup)
    parent_level = _load_parent(pack, parent, parent_lookup)
    if pack is not None and pack.kind == "extend" and parent_level is not None:
        screens = int((parent_level.get("world") or {}).get("screens", 1) or 1)
        if screens >= spec_v2.MAX_SHEETS:
            raise ScanV2Error("error.level_too_long", {"max": spec_v2.MAX_SHEETS})
    placement = stitch.place_sheets(scans, pack, parent=parent_level)
    warnings.extend(placement.warnings)

    used = sorted(placement.by_n.values(), key=lambda s: s.screen)
    remix = pack is not None and pack.kind in ("remix", "extend")
    for s in used:
        if s.pencil and not remix:  # remix sheets print the parent in gray: that gray is not pencil
            s.warnings.append(MessageRef(key="warning.pencil_marks", args={"n": s.n, "count": s.pencil}))

    st = stitch.assemble_sheets(placement, parent=parent_level)
    warnings.extend(st.warnings)
    if st.noise:
        warnings.append(MessageRef(key="warning.specks_ignored", args={"n": st.noise}))
    kid_ink = any(s.origin == "kid" for s in st.strokes) or (st.character is not None and parent_level is None)
    if not kid_ink and not (remix and st.strokes):
        raise ScanV2Error("error.no_drawing")

    files: dict[str, Path] = {}
    for s in used:
        warnings.extend(s.warnings)
        files.update(_place_files(s, work))
    ink = InkDoc(
        v=2,
        source="paper",
        world={"screens": st.screens, "w": spec_v2.SCREEN_W_CELLS * st.screens, "h": spec_v2.WORLD_H_CELLS},  # type: ignore[arg-type]
        strokes=st.strokes,
        components=st.components,
        character=st.character,
        typed_rules=[],
        rules_ink=st.rules_ids,
        sheets=st.sheets,
        noise=NoiseInfo(count=st.noise),
        parent=st.parent,
    )
    return ScanV2(
        ink=ink,
        sheets=st.sheets,
        warnings=_dedupe(warnings),
        scans=used,
        files=files,
        pack=pack,
        qr_pack_id=read_id,
        ms={"total": (time.perf_counter() - t0) * 1000, **{f"sheet{s.n}": s.ms.get("total", 0.0) for s in used}},
        seams=st.seams,
        complete=placement.complete,
        playable_screens=placement.playable_screens,
        parent=parent_level,
    )


def _dedupe(msgs: list[MessageRef]) -> list[MessageRef]:
    seen: set[tuple[str, tuple[tuple[str, object], ...]]] = set()
    out: list[MessageRef] = []
    for m in msgs:
        key = (m.key, tuple(sorted(m.args.items())))
        if key in seen:
            continue
        seen.add(key)
        out.append(m)
    return out
