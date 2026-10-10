"""run_scan end to end on synthetic photos (PLAN.md section 16). Owned by lane A.

Grid IoU >= 0.9 over solid+hazard cells, coin count exact, goal within 1 cell,
sprite file exists and is non-empty, labels_path max == len(components).
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.cv.pipeline import run_scan
from app.models import CVResult
from app.template import spec
from tests.make_synthetic import ensure_fixtures

MIN_GRID_IOU = 0.9


def grid_iou(a: list[str], b: list[str]) -> float:
    """IoU over cells that are solid or hazard in either grid (exact class match counts as intersection)."""
    inter = union = 0
    for ra, rb in zip(a, b):
        for ca, cb in zip(ra, rb):
            if ca != "0" or cb != "0":
                union += 1
                if ca == cb:
                    inter += 1
    return inter / union if union else 1.0


@pytest.fixture(scope="module")
def synthetic() -> list[tuple[Path, dict]]:
    return [(photo, json.loads(expected.read_text())) for photo, expected in ensure_fixtures()]


@pytest.fixture(scope="module")
def scans(synthetic: list[tuple[Path, dict]], tmp_path_factory: pytest.TempPathFactory) -> list[tuple[CVResult, dict]]:
    out = []
    for photo, expected in synthetic:
        work = tmp_path_factory.mktemp(photo.stem)
        out.append((run_scan(photo.read_bytes(), "paper", str(work), debug=True), expected))
    return out


def _check_geometry(cv: CVResult, expected: dict, name: str) -> None:
    iou = grid_iou(cv.grid_rows, expected["grid_rows"])
    assert iou >= MIN_GRID_IOU, f"{name}: grid IoU {iou:.3f}"
    for x, y in expected["must_solid"]:
        assert cv.grid_rows[y][x] == "1", f"{name}: expected solid at {(x, y)}"
    for x, y in expected["must_hazard"]:
        assert cv.grid_rows[y][x] == "2", f"{name}: expected hazard at {(x, y)}"
    for x, y in expected["must_empty"]:
        assert cv.grid_rows[y][x] == "0", f"{name}: expected empty at {(x, y)}"
    assert len(cv.coins) == expected["coin_count"], f"{name}: coins {cv.coins}"
    for ex, ey in expected["coins"]:
        assert any(abs(cx - ex) <= 1 and abs(cy - ey) <= 1 for cx, cy in cv.coins), f"{name}: coin {(ex, ey)}"
    assert cv.goal is not None
    gx, gy = expected["goal"]
    assert abs(cv.goal[0] - gx) <= 1 and abs(cv.goal[1] - gy) <= 1, f"{name}: goal {cv.goal} vs {(gx, gy)}"
    sx, sy = expected["player_start"]
    assert abs(cv.player_start[0] - sx) <= 1 and abs(cv.player_start[1] - sy) <= 1, f"{name}: start {cv.player_start}"


def test_paper_scan_matches_expected(scans: list[tuple[CVResult, dict]]) -> None:
    for cv, expected in scans:
        _check_geometry(cv, expected, expected["photo"])
        assert cv.mode == "paper"
        assert cv.qr_payload == expected["qr_payload"], expected["photo"]
        assert "swatch_calibration_failed" not in cv.warnings
        assert "no_goal_drawn" not in cv.warnings and "no_character_drawn" not in cv.warnings


def test_sprite_is_extracted(scans: list[tuple[CVResult, dict]]) -> None:
    tw, th = spec.sprite_px()
    for cv, expected in scans:
        assert cv.sprite_path is not None, expected["photo"]
        p = Path(cv.sprite_path)
        assert p.exists() and p.stat().st_size > 0
        sprite = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
        assert sprite.shape == (th, tw, 4)
        assert int((sprite[..., 3] > 0).sum()) > 50, "sprite alpha is nearly empty"
        assert int(sprite[..., 3].max()) == 255


def test_output_images_have_the_contracted_shapes(scans: list[tuple[CVResult, dict]]) -> None:
    for cv, _ in scans:
        backdrop = cv2.imread(cv.backdrop_path)
        assert backdrop.shape[:2][::-1] == spec.backdrop_px()
        # Background is pure white, not the paper tone of the photo.
        assert int((backdrop == 255).all(axis=2).mean() * 100) > 70
        drawing = cv2.imread(cv.drawing_path)
        assert drawing.shape[:2][::-1] == spec.working_px()
        labels = cv2.imread(cv.labels_path, cv2.IMREAD_UNCHANGED)
        assert labels.dtype == np.uint16 and labels.shape[:2][::-1] == spec.working_px()
        assert int(labels.max()) == len(cv.components)
        assert cv.annotated_path is not None
        annotated = cv2.imread(cv.annotated_path)
        assert annotated is not None and annotated.shape[1] <= 1500
        assert Path(cv.work_dir, "debug").is_dir() and any(Path(cv.work_dir, "debug").iterdir())


def test_components_are_numbered_in_reading_order(scans: list[tuple[CVResult, dict]]) -> None:
    for cv, expected in scans:
        ids = [c.id for c in cv.components]
        assert ids == list(range(1, len(ids) + 1))
        keys = [(c.bbox[1], c.bbox[0]) for c in cv.components]
        assert keys == sorted(keys), f"{expected['photo']}: components not in reading order"
        for c in cv.components:
            assert c.area_cells == len(c.cells) >= 1
            x0, y0, x1, y1 = c.bbox
            assert all(x0 <= x <= x1 and y0 <= y <= y1 for x, y in c.cells)
        labels = cv2.imread(cv.labels_path, cv2.IMREAD_UNCHANGED)
        cell = spec.cell_working_px()
        for c in cv.components:
            ys, xs = np.nonzero(labels == c.id)
            assert len(xs) > 0
            assert xs.min() // cell >= c.bbox[0] - 1 and xs.max() // cell <= c.bbox[2] + 1


def test_canvas_mode_scan(synthetic: list[tuple[Path, dict]], tmp_path: Path) -> None:
    for photo, expected in synthetic:
        canvas_png = photo.with_name(expected["canvas"])
        work = tmp_path / canvas_png.stem
        cv = run_scan(canvas_png.read_bytes(), "canvas", str(work))
        assert cv.mode == "canvas"
        assert cv.sprite_path is None and cv.qr_payload is None
        _check_geometry(cv, expected, canvas_png.name)
        assert cv2.imread(cv.backdrop_path).shape[:2][::-1] == spec.backdrop_px()
        assert cv.annotated_path is not None and Path(cv.annotated_path).exists()


def test_remix_sheet_gray_overlay_is_ignored(scans: list[tuple[CVResult, dict]], tmp_path: Path) -> None:
    """A photographed remix sheet yields only the new ink; the gray parent print and its numbers vanish."""
    from PIL import ImageDraw

    from app.models import Component, Grid, Level, Meta, Source, Sprites
    from app.template.generate import render_remix
    from tests.make_synthetic import photograph

    parent_cv, _ = scans[0]
    parent = Level(
        id="lvl_parent",
        title="Synth One",
        author="team",
        created_at="2026-10-09T00:00:00Z",
        source=Source(kind="paper"),
        grid=Grid(rows=parent_cv.grid_rows),
        sprites=Sprites(),
        components=[Component(**c.model_dump(exclude={"cells"})) for c in parent_cv.components],
        entities=[],
        rules=[],
        meta=Meta(),
    )
    sheet = render_remix(parent, parent_cv.backdrop_path)
    draw = ImageDraw.Draw(sheet)
    ax, ay, _, _ = spec.drawing_area_px()
    cell = spec.cell_working_px()
    r, g, b = spec.hex_to_rgb(spec.colors()["blue"])
    draw.ellipse([ax + 5 * cell + 5, ay + 10 * cell + 5, ax + 6 * cell - 5, ay + 11 * cell - 5], fill=(r, g, b))
    draw.line([(ax + 30 * cell + 6, ay + 12.5 * cell), (ax + 36 * cell - 6, ay + 12.5 * cell)], fill=(0, 0, 0), width=12)
    photo, _, _ = photograph(np.asarray(sheet)[:, :, ::-1].copy(), seed=4)
    ok, buf = cv2.imencode(".jpg", photo, [cv2.IMWRITE_JPEG_QUALITY, 80])
    assert ok

    cv = run_scan(buf.tobytes(), "paper", str(tmp_path / "remix"))
    assert cv.qr_payload == "dal1|lvl|lvl_parent"
    assert [(c.color, c.bbox) for c in cv.components] == [("blue", (5, 10, 5, 10)), ("black", (30, 12, 35, 12))]
    assert cv.coins == [(5, 10)]
    assert cv.grid_rows[12][30:36] == "111111"
    assert sum(row.count("1") + row.count("2") for row in cv.grid_rows) == 6


def test_empty_canvas_gets_defaults_and_warnings(tmp_path: Path) -> None:
    blank = np.full((432, 768, 3), 255, dtype=np.uint8)
    ok, buf = cv2.imencode(".png", blank)
    assert ok
    cv = run_scan(buf.tobytes(), "canvas", str(tmp_path / "empty"))
    assert cv.components == [] and cv.coins == []
    assert "no_goal_drawn" in cv.warnings and "no_ground_drawn" in cv.warnings
    assert cv.goal is not None and cv.player_start is not None
    assert all(set(row) == {"0"} for row in cv.grid_rows)
