"""Color classification: swatches classify to themselves, shadowed paper is background (PLAN.md section 16). Owned by lane A."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from app.cv.calibrate import CALIBRATION_WARNING, calibrate, calibrate_report, ideal_centers
from app.cv.pipeline import decode_image
from app.cv.rectify import rectify
from app.cv.segment import classify, classify_labels
from app.template import spec
from app.template.generate import render_blank
from tests.make_synthetic import ensure_fixtures


def _patch(bgr: tuple[int, int, int], size: int = 40) -> np.ndarray:
    return np.full((size, size, 3), bgr, dtype=np.uint8)


def _bgr(hex_str: str) -> tuple[int, int, int]:
    r, g, b = spec.hex_to_rgb(hex_str)
    return b, g, r


def _majority(labels: np.ndarray) -> str:
    return spec.CLASS_ORDER[int(np.bincount(labels.ravel(), minlength=len(spec.CLASS_ORDER)).argmax())]


@pytest.fixture(scope="module")
def synthetic() -> list[tuple[Path, dict]]:
    return [(photo, json.loads(expected.read_text())) for photo, expected in ensure_fixtures()]


def test_ideal_swatches_classify_to_themselves() -> None:
    centers = ideal_centers()
    for name, hex_str in spec.colors().items():
        if name == "annotation_magenta":
            continue
        assert _majority(classify_labels(_patch(_bgr(hex_str)), centers)) == name


def test_rendered_sheet_calibrates_to_its_swatches() -> None:
    sheet = np.asarray(render_blank("dal1|blank"))[:, :, ::-1].copy()
    centers, warnings = calibrate_report(sheet, "paper")
    assert warnings == []
    assert list(centers) == list(spec.CLASS_ORDER)
    for patch in spec.swatch_patches_px():
        x, y, w, h = patch["rect_px"]
        inner = sheet[y + h // 4 : y + 3 * h // 4, x + w // 4 : x + 3 * w // 4]
        assert _majority(classify_labels(inner, centers)) == patch["name"]


def test_photo_swatches_classify_to_themselves(synthetic: list[tuple[Path, dict]]) -> None:
    for photo, _ in synthetic:
        image, _ = decode_image(photo.read_bytes())
        sheet = rectify(image).image
        centers, warnings = calibrate_report(sheet, "paper")
        assert CALIBRATION_WARNING not in warnings, photo.name
        for patch in spec.swatch_patches_px():
            x, y, w, h = patch["rect_px"]
            inner = sheet[y + h // 4 : y + 3 * h // 4, x + w // 4 : x + 3 * w // 4]
            assert _majority(classify_labels(inner, centers)) == patch["name"], f"{photo.name}: {patch['name']}"


def test_shadowed_paper_and_gray_are_background() -> None:
    centers = ideal_centers()
    for value in (235, 215, 195, 176, 150):
        labels = classify_labels(_patch((value, value, value)), centers)
        assert _majority(labels) in spec.BACKGROUND_CLASSES, value
        masks = classify(_patch((value, value, value)), centers)
        assert all(int(m.max()) == 0 for m in masks.values()), value
    # A warm shadow (slightly tinted) is still background.
    labels = classify_labels(_patch((180, 190, 200)), centers)
    assert _majority(labels) in spec.BACKGROUND_CLASSES


def test_confidence_margin_kills_edge_pixels() -> None:
    centers = ideal_centers()
    # Half-way between paper and the printed gray: nearest ink class is far, so background.
    labels = classify_labels(_patch((200, 200, 200)), centers)
    assert _majority(labels) in spec.BACKGROUND_CLASSES
    # A pixel 4 Lab units closer to blue than to gray would still be ambiguous (< 8) -> background.
    blue = np.array(_bgr(spec.colors()["blue"]), dtype=np.float32)
    gray = np.array(_bgr(spec.colors()["gray"]), dtype=np.float32)
    mid = tuple(int(v) for v in (blue * 0.45 + gray * 0.55))
    assert _majority(classify_labels(_patch(mid), centers)) in spec.BACKGROUND_CLASSES


def test_canvas_mode_uses_ideal_centers() -> None:
    centers = calibrate(None, "canvas")
    ideal = ideal_centers()
    for name in spec.CLASS_ORDER:
        assert np.allclose(centers[name], ideal[name])


def test_masks_are_clean_binary_images() -> None:
    centers = ideal_centers()
    img = np.full((200, 300, 3), 255, dtype=np.uint8)
    img[50:100, 40:200] = _bgr(spec.colors()["black"])
    img[120:160, 60:90] = _bgr(spec.colors()["red"])
    img[10, 250] = _bgr(spec.colors()["green"])  # a single speck, removed by the 3x3 open
    masks = classify(img, centers)
    assert set(masks) == set(spec.INK_CLASSES)
    assert masks["black"].dtype == np.uint8 and set(np.unique(masks["black"])) <= {0, 255}
    assert masks["black"][75, 120] == 255 and masks["red"][140, 75] == 255
    assert int(masks["green"].max()) == 0 and int(masks["blue"].max()) == 0
