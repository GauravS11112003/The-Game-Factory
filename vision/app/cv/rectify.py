"""ArUco detect -> homography -> canonical 2970x2100 sheet (PLAN.md section 6, step 2). Owned by lane A.

cv2.aruco.ArucoDetector(DICT_4X4_50); needs ids 0-3. Exactly 3 found -> infer
the 4th as the parallelogram completion. Fewer -> RectifyError (the pipeline
re-raises it as ScanError). The marker layout and outer corners come from
app.template.spec.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from app.template import spec

MARKERS_MESSAGE = "Couldn't see the corner markers. Keep the whole sheet in frame."


class RectifyError(ValueError):
    """Fewer than the minimum number of corner markers were found."""


@dataclass
class RectifyResult:
    image: np.ndarray  # BGR canonical sheet, spec.canvas_size_px()
    ids: list[int]  # marker ids actually detected
    inferred_id: int | None  # the id completed from the parallelogram, if any
    homography: np.ndarray  # 3x3, photo pixels -> canonical pixels
    src_corners: np.ndarray  # 4x2 float32 photo-space outer corners (TL, TR, BR, BL)


def _detector() -> cv2.aruco.ArucoDetector:
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    return cv2.aruco.ArucoDetector(dictionary, params)


def detect_outer_corners(image_bgr: np.ndarray) -> dict[int, np.ndarray]:
    """Marker id -> its outer corner (float32 x, y) in image pixels, for ids 0-3 only."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY) if image_bgr.ndim == 3 else image_bgr
    found = _detect(gray)
    if len(found) < spec.min_markers_for_rectify():
        # Second pass for dim or low-contrast photos.
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        found.update({k: v for k, v in _detect(clahe.apply(gray)).items() if k not in found})
    return found


def _detect(gray: np.ndarray) -> dict[int, np.ndarray]:
    corners, ids, _ = _detector().detectMarkers(gray)
    found: dict[int, np.ndarray] = {}
    if ids is None:
        return found
    by_id = {m["id"]: m for m in spec.marker_specs()}
    for quad, marker_id in zip(corners, ids.flatten()):
        marker_id = int(marker_id)
        if marker_id in by_id and marker_id not in found:
            found[marker_id] = quad.reshape(4, 2)[by_id[marker_id]["outer_corner_index"]].astype(np.float32)
    return found


def complete_parallelogram(found: dict[int, np.ndarray]) -> tuple[dict[int, np.ndarray], int | None]:
    """With exactly three of TL(0) TR(1) BR(2) BL(3), add the fourth as the parallelogram completion."""
    if len(found) == 4:
        return found, None
    missing = [i for i in range(4) if i not in found]
    if len(missing) != 1:
        return found, None
    (m,) = missing
    p = found
    # Each corner equals the sum of its two neighbours minus the opposite corner.
    if m == 0:
        p[0] = p[1] + p[3] - p[2]
    elif m == 1:
        p[1] = p[0] + p[2] - p[3]
    elif m == 2:
        p[2] = p[1] + p[3] - p[0]
    else:
        p[3] = p[0] + p[2] - p[1]
    return p, m


def rectify(image_bgr: np.ndarray, debug_dir: str | None = None) -> RectifyResult:
    """Return the rectified canonical sheet (BGR, canvas_px) and the detected marker ids."""
    found = detect_outer_corners(image_bgr)
    detected = sorted(found)
    if len(found) < spec.min_markers_for_rectify():
        raise RectifyError(MARKERS_MESSAGE)
    found, inferred = complete_parallelogram(found)
    src = np.array([found[i] for i in range(4)], dtype=np.float32)
    dst = np.array(spec.outer_corners_px(), dtype=np.float32)
    H = cv2.getPerspectiveTransform(src, dst)
    w, h = spec.canvas_size_px()
    warped = cv2.warpPerspective(image_bgr, H, (w, h), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))

    if debug_dir:
        out = Path(debug_dir)
        out.mkdir(parents=True, exist_ok=True)
        vis = image_bgr.copy()
        for i in range(4):
            x, y = found[i]
            color = (0, 0, 255) if i == inferred else (0, 255, 0)
            cv2.circle(vis, (int(x), int(y)), 12, color, 3)
            cv2.putText(vis, str(i), (int(x) + 14, int(y) - 14), cv2.FONT_HERSHEY_SIMPLEX, 1.2, color, 3)
        cv2.imwrite(str(out / "markers.jpg"), vis, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return RectifyResult(image=warped, ids=detected, inferred_id=inferred, homography=H, src_corners=src)
