"""Synthetic "photos" of the template (PLAN.md section 16). Owned by lane A.

Renders the blank template, draws a known level in the four palette colors
with Pillow (12 px lines at 10 px/mm), writes handwritten-looking labels,
applies a seeded perspective warp (corners jittered by up to 6 % of the image
size), gamma 0.7-1.4, uneven lighting, slight blur, JPEG 80 ->

    shared/fixtures/photos/synth_<seed>.jpg            the photo
    shared/fixtures/photos/synth_<seed>.expected.json  expected grid, coins, goal, marker corners
    shared/fixtures/photos/synth_<seed>.canvas.png     the ideal drawing area at 768x432 (canvas mode)

The expected grid is the spec's coverage rule applied to the *ideal* rendering
(no warp, no blur), cross-checked against hand-placed cells that must be
solid, hazard or empty, so a coverage bug fails generation instead of being
baked into the fixtures.

    uv run python tests/make_synthetic.py --count 3 --seed 1 [--force]
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

VISION_DIR = Path(__file__).resolve().parents[1]
if str(VISION_DIR) not in sys.path:
    sys.path.insert(0, str(VISION_DIR))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from app.config import FIXTURES_DIR  # noqa: E402
from app.cv.calibrate import ideal_centers  # noqa: E402
from app.cv.pipeline import analyze_drawing  # noqa: E402
from app.template import spec  # noqa: E402
from app.template.generate import font, render_blank  # noqa: E402

GENERATOR_VERSION = 4
PHOTOS_DIR = FIXTURES_DIR / "photos"
PHOTO_SIZE = (3200, 2400)
LINE_PX = 12
QR_PAYLOAD = "dal1|blank"

_HANDWRITING_FONTS = [
    "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
    "/System/Library/Fonts/Supplemental/Comic Sans MS Bold.ttf",
    "/System/Library/Fonts/Supplemental/Chalkboard.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def handwriting(size_px: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in _HANDWRITING_FONTS:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size_px)
            except OSError:
                continue
    return font(size_px, bold=True)


# --- the known level -----------------------------------------------------------------


class LevelDesign:
    """Hand-placed geometry in grid cells; `draw` paints it, the must_* lists pin the expected grid."""

    floor_a = (25, 1, 20)  # row, first cell, last cell
    floor_b = (25, 26, 46)
    platform_1 = (20, 8, 13)
    platform_2 = (16, 16, 22)
    spikes = (24, 30, 33)
    goal = (44, 22)
    coins = [(10, 18), (19, 14), (36, 22)]
    label_cell = (24, 13)  # "moves" text top-left
    arrow = (16, 24, 28)  # row, from cell, to cell

    @classmethod
    def must_solid(cls) -> list[tuple[int, int]]:
        cells = []
        for row, a, b in (cls.floor_a, cls.floor_b, cls.platform_1, cls.platform_2):
            cells += [(x, row) for x in range(a + 1, b)]  # skip the end cells, they are near the threshold
        return cells

    @classmethod
    def must_hazard(cls) -> list[tuple[int, int]]:
        row, a, b = cls.spikes
        return [(x, row) for x in range(a, b + 1)]

    @classmethod
    def must_empty(cls) -> list[tuple[int, int]]:
        return [(5, 5), (40, 5), (24, 22), (3, 23), (10, 24), (14, 20), (7, 20), (44, 20), (23, 25), (12, 22)]


def _rgb(name: str) -> tuple[int, int, int]:
    return spec.hex_to_rgb(spec.colors()[name])


def draw_level(sheet: Image.Image, seed: int) -> None:
    """Paint LevelDesign plus the doodle, the in-drawing label and the rules sentence onto the sheet."""
    d = ImageDraw.Draw(sheet)
    ax, ay, _, _ = spec.drawing_area_px()
    cell = spec.cell_working_px()

    def cx(c: float) -> int:
        return int(ax + c * cell)

    def cy(r: float) -> int:
        return int(ay + r * cell)

    black, red, green, blue = _rgb("black"), _rgb("red"), _rgb("green"), _rgb("blue")
    for row, a, b in (LevelDesign.floor_a, LevelDesign.floor_b, LevelDesign.platform_1, LevelDesign.platform_2):
        d.line([(cx(a) + 6, cy(row + 0.5)), (cx(b + 1) - 6, cy(row + 0.5))], fill=black, width=LINE_PX)

    # Spikes as one filled zigzag (the way a marker draws them), base 6 px above the floor row.
    row, a, b = LevelDesign.spikes
    base, top = cy(row) + 44, cy(row) + 3
    zigzag: list[tuple[int, int]] = [(cx(a), base)]
    for c in range(a, b + 1):
        zigzag += [(cx(c + 0.5), top), (cx(c + 1), base)]
    d.polygon(zigzag, fill=red)

    gx, gy = LevelDesign.goal
    d.ellipse([cx(gx + 0.5) - 40, cy(gy + 0.5) - 40, cx(gx + 0.5) + 40, cy(gy + 0.5) + 40], fill=green)
    for x, y in LevelDesign.coins:
        d.ellipse([cx(x + 0.5) - 20, cy(y + 0.5) - 20, cx(x + 0.5) + 20, cy(y + 0.5) + 20], fill=blue)

    lx, ly = LevelDesign.label_cell
    d.text((cx(lx), cy(ly)), "moves", fill=black, font=handwriting(70), stroke_width=2, stroke_fill=black)
    row, a, b = LevelDesign.arrow
    y = cy(row + 0.5)
    d.line([(cx(a), y), (cx(b), y)], fill=black, width=8)
    d.line([(cx(b), y), (cx(b) - 30, y - 25)], fill=black, width=8)
    d.line([(cx(b), y), (cx(b) - 30, y + 25)], fill=black, width=8)

    # Character box doodle: a stick figure with a red hat.
    bx, by, bw, bh = spec.character_box_px()
    mx, my = bx + bw // 2, by + bh // 2
    d.ellipse([mx - 40, my - 110, mx + 40, my - 30], outline=black, width=10)
    d.ellipse([mx - 15, my - 80, mx - 7, my - 72], fill=black)
    d.ellipse([mx + 7, my - 80, mx + 15, my - 72], fill=black)
    d.line([(mx, my - 30), (mx, my + 60)], fill=black, width=10)
    d.line([(mx - 50, my + 10), (mx + 50, my + 10)], fill=black, width=10)
    d.line([(mx, my + 60), (mx - 40, my + 130)], fill=black, width=10)
    d.line([(mx, my + 60), (mx + 40, my + 130)], fill=black, width=10)
    d.polygon([(mx - 45, my - 105), (mx + 45, my - 105), (mx, my - 150)], fill=red)

    rx, ry, _, _ = spec.rules_box_px()
    d.text((rx + 30, ry + 25), "the platform moves. 60 seconds", fill=black, font=handwriting(44))
    hx, hy, _, _ = spec.header_rect_px()
    d.text((hx + 330, hy + 78), f"Synth {seed}", fill=black, font=handwriting(44))


# --- the photo --------------------------------------------------------------------------


def photograph(sheet_bgr: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray, dict]:
    """Warp the sheet into a 'phone photo'; returns (jpeg-degraded BGR, homography sheet->photo, params)."""
    rng = random.Random(seed)
    nrng = np.random.default_rng(seed)
    W, H = PHOTO_SIZE
    sw, sh = spec.canvas_size_px()
    fit_w = int(W * 0.9)
    fit_h = int(fit_w * sh / sw)
    x0, y0 = (W - fit_w) // 2, (H - fit_h) // 2
    base = [(x0, y0), (x0 + fit_w, y0), (x0 + fit_w, y0 + fit_h), (x0, y0 + fit_h)]
    jitter = 0.06
    quad = []
    for x, y in base:
        jx = rng.uniform(-jitter, jitter) * W
        jy = rng.uniform(-jitter, jitter) * H
        quad.append((min(W - 20, max(20, x + jx)), min(H - 20, max(20, y + jy))))
    src = np.array([(0, 0), (sw, 0), (sw, sh), (0, sh)], dtype=np.float32)
    dst = np.array(quad, dtype=np.float32)
    Hm = cv2.getPerspectiveTransform(src, dst)

    table = np.array([rng.randint(60, 90), rng.randint(90, 120), rng.randint(120, 160)], dtype=np.float32)
    photo = cv2.warpPerspective(
        sheet_bgr, Hm, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=table.tolist()
    ).astype(np.float32)
    texture = nrng.normal(0, 6, size=(H, W, 1)).astype(np.float32)
    outside = cv2.warpPerspective(np.full((sh, sw), 255, np.uint8), Hm, (W, H)) == 0
    photo[outside] = np.clip(photo[outside] + texture[outside], 0, 255)

    # Uneven lighting: a linear falloff in a random direction, plus a mild warm cast.
    angle = rng.uniform(0, 2 * np.pi)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    ramp = (np.cos(angle) * xx / W + np.sin(angle) * yy / H + 1) / 2
    strength = rng.uniform(0.10, 0.18)
    light = (1 - strength) + strength * ramp
    cast = np.array([rng.uniform(0.92, 1.0), rng.uniform(0.96, 1.0), 1.0], dtype=np.float32)
    photo = photo * light[..., None] * cast[None, None, :]

    gamma = rng.uniform(0.7, 1.4)
    photo = 255.0 * np.power(np.clip(photo, 0, 255) / 255.0, gamma)
    sigma = rng.uniform(0.6, 1.1)
    photo = cv2.GaussianBlur(photo, (0, 0), sigma)
    photo = photo + nrng.normal(0, 2.0, size=photo.shape).astype(np.float32)
    photo8 = np.clip(photo, 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", photo8, [cv2.IMWRITE_JPEG_QUALITY, 80])
    assert ok
    degraded = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    params = {"quad": [[float(x), float(y)] for x, y in quad], "gamma": gamma, "blur_sigma": sigma, "light": strength}
    return degraded, Hm, params


def _project(Hm: np.ndarray, points: list[tuple[int, int]]) -> list[list[float]]:
    pts = np.array(points, dtype=np.float32).reshape(-1, 1, 2)
    out = cv2.perspectiveTransform(pts, Hm).reshape(-1, 2)
    return [[float(x), float(y)] for x, y in out]


def generate(seed: int, out_dir: Path = PHOTOS_DIR) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    sheet = render_blank(QR_PAYLOAD)
    draw_level(sheet, seed)
    sheet_bgr = np.asarray(sheet)[:, :, ::-1].copy()

    ax, ay, aw, ah = spec.drawing_area_px()
    ideal_drawing = sheet_bgr[ay : ay + ah, ax : ax + aw]
    analysis = analyze_drawing(ideal_drawing, ideal_centers())
    rows = analysis.comps.grid_rows
    for x, y in LevelDesign.must_solid():
        if rows[y][x] != "1":
            raise RuntimeError(f"seed {seed}: expected solid at {(x, y)}, got {rows[y][x]!r}")
    for x, y in LevelDesign.must_hazard():
        if rows[y][x] != "2":
            raise RuntimeError(f"seed {seed}: expected hazard at {(x, y)}, got {rows[y][x]!r}")
    for x, y in LevelDesign.must_empty():
        if rows[y][x] != "0":
            raise RuntimeError(f"seed {seed}: expected empty at {(x, y)}, got {rows[y][x]!r}")
    if tuple(analysis.goal) != LevelDesign.goal or sorted(analysis.coins) != sorted(LevelDesign.coins):
        raise RuntimeError(f"seed {seed}: goal/coins mismatch: {analysis.goal} {analysis.coins}")

    photo, Hm, params = photograph(sheet_bgr, seed)
    photo_path = out_dir / f"synth_{seed}.jpg"
    cv2.imwrite(str(photo_path), photo, [cv2.IMWRITE_JPEG_QUALITY, 80])
    canvas_path = out_dir / f"synth_{seed}.canvas.png"
    cv2.imwrite(str(canvas_path), cv2.resize(ideal_drawing, spec.backdrop_px(), interpolation=cv2.INTER_AREA))

    expected = {
        "generator_version": GENERATOR_VERSION,
        "seed": seed,
        "photo": photo_path.name,
        "canvas": canvas_path.name,
        "photo_size": list(PHOTO_SIZE),
        "qr_payload": QR_PAYLOAD,
        "grid_rows": rows,
        "goal": list(LevelDesign.goal),
        "coins": [list(c) for c in LevelDesign.coins],
        "coin_count": len(LevelDesign.coins),
        "player_start": list(analysis.player_start),
        "must_solid": [list(c) for c in LevelDesign.must_solid()],
        "must_hazard": [list(c) for c in LevelDesign.must_hazard()],
        "must_empty": [list(c) for c in LevelDesign.must_empty()],
        "component_count": len(analysis.comps.components),
        "marker_outer_corners_photo": _project(Hm, spec.outer_corners_px()),
        "warp": params,
    }
    expected_path = out_dir / f"synth_{seed}.expected.json"
    expected_path.write_text(json.dumps(expected, indent=2) + "\n")
    return photo_path, expected_path


def ensure_fixtures(seeds: tuple[int, ...] = (1, 2, 3), force: bool = False) -> list[tuple[Path, Path]]:
    """Generate any missing or outdated synthetic fixtures; returns (photo, expected) pairs."""
    out = []
    for seed in seeds:
        photo = PHOTOS_DIR / f"synth_{seed}.jpg"
        expected = PHOTOS_DIR / f"synth_{seed}.expected.json"
        canvas = PHOTOS_DIR / f"synth_{seed}.canvas.png"
        fresh = photo.exists() and expected.exists() and canvas.exists()
        if fresh and not force:
            try:
                fresh = json.loads(expected.read_text()).get("generator_version") == GENERATOR_VERSION
            except (OSError, ValueError):
                fresh = False
        if not fresh or force:
            generate(seed)
        out.append((photo, expected))
    return out


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic template photos")
    parser.add_argument("--count", type=int, default=3)
    parser.add_argument("--seed", type=int, default=1, help="first seed; seeds run seed..seed+count-1")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--out", default=str(PHOTOS_DIR))
    args = parser.parse_args(argv)
    for seed in range(args.seed, args.seed + args.count):
        photo, expected = generate(seed, Path(args.out))
        print(f"wrote {photo} and {expected.name}")


if __name__ == "__main__":
    main()
