"""Rectification error < 3 px at the corners on synthetic photos (PLAN.md section 16). Owned by lane A."""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.cv.pipeline import ScanError, decode_image, run_scan
from app.cv.rectify import RectifyError, detect_outer_corners, rectify
from app.template import spec
from tests.make_synthetic import ensure_fixtures

MAX_CORNER_ERROR_PX = 3.0


@pytest.fixture(scope="module")
def synthetic() -> list[tuple[Path, dict]]:
    return [(photo, json.loads(expected.read_text())) for photo, expected in ensure_fixtures()]


def test_ground_truth_corners_land_on_canonical_positions(synthetic: list[tuple[Path, dict]]) -> None:
    for photo, expected in synthetic:
        image, scale = decode_image(photo.read_bytes())
        result = rectify(image)
        assert sorted(result.ids) == [0, 1, 2, 3], photo.name
        truth = np.array(expected["marker_outer_corners_photo"], dtype=np.float32) * scale
        projected = cv2.perspectiveTransform(truth.reshape(-1, 1, 2), result.homography).reshape(-1, 2)
        canonical = np.array(spec.outer_corners_px(), dtype=np.float32)
        errors = np.linalg.norm(projected - canonical, axis=1)
        assert errors.max() < MAX_CORNER_ERROR_PX, f"{photo.name}: corner errors {errors.round(2).tolist()}"


def test_markers_redetected_on_rectified_sheet(synthetic: list[tuple[Path, dict]]) -> None:
    for photo, _ in synthetic:
        image, _ = decode_image(photo.read_bytes())
        sheet = rectify(image).image
        assert sheet.shape[:2] == spec.canvas_size_px()[::-1]
        found = detect_outer_corners(sheet)
        assert sorted(found) == [0, 1, 2, 3], photo.name
        for marker in spec.marker_specs():
            err = float(np.linalg.norm(found[marker["id"]] - np.array(marker["outer_corner_px"], np.float32)))
            assert err < MAX_CORNER_ERROR_PX, f"{photo.name}: marker {marker['id']} off by {err:.2f}px"


def test_three_markers_are_enough(synthetic: list[tuple[Path, dict]]) -> None:
    photo, expected = synthetic[0]
    image, scale = decode_image(photo.read_bytes())
    # Paint over the bottom-right marker so only three remain.
    x, y = (np.array(expected["marker_outer_corners_photo"][2]) * scale).astype(int)
    cv2.rectangle(image, (x - 220, y - 220), (x + 40, y + 40), (255, 255, 255), -1)
    result = rectify(image)
    assert sorted(result.ids) == [0, 1, 3]
    assert result.inferred_id == 2
    truth = np.array(expected["marker_outer_corners_photo"], dtype=np.float32) * scale
    projected = cv2.perspectiveTransform(truth.reshape(-1, 1, 2), result.homography).reshape(-1, 2)
    canonical = np.array(spec.outer_corners_px(), dtype=np.float32)
    # The inferred corner is a parallelogram guess, so only the detected three are held to 3 px.
    errors = np.linalg.norm(projected - canonical, axis=1)
    assert max(errors[0], errors[1], errors[3]) < MAX_CORNER_ERROR_PX


def test_too_few_markers_raise(tmp_path: Path) -> None:
    blank = np.full((900, 1200, 3), 240, dtype=np.uint8)
    with pytest.raises(RectifyError):
        rectify(blank)
    ok, buf = cv2.imencode(".png", blank)
    assert ok
    with pytest.raises(ScanError, match="corner markers"):
        run_scan(buf.tobytes(), "paper", str(tmp_path / "no_markers"))
