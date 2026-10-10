"""Controlled sweeps through v1's CV (analyze_drawing, canvas mode) to isolate root causes.

1. tap size: a single blue dot of diameter D px (canvas brush is 8 px) -> coin or not
2. line phase: an 8 px black horizontal line at y = 200 + k px -> 1 or 2 rows of collision
3. spike hover: a red zigzag (13 px tall) whose base is G px above an 8 px platform -> rows, attached?
4. slope: an 8 px line rising R px over 400 px -> number of 1-cell steps
Run from vision/: uv run --no-sync python ../docs/v2/diagnosis/build/probe_sweeps.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path.cwd()))
from app.cv.calibrate import ideal_centers  # noqa: E402
from app.cv.pipeline import analyze_drawing  # noqa: E402
from app.template import spec  # noqa: E402

SS = 4
HERE = Path(__file__).resolve().parent


def canvas(draw_fn) -> np.ndarray:
    im = Image.new("RGB", (768 * SS, 432 * SS), "white")
    draw_fn(ImageDraw.Draw(im))
    im = im.resize((768, 432), Image.LANCZOS)
    bgr = np.asarray(im)[:, :, ::-1].copy()
    return cv2.resize(bgr, spec.working_px(), interpolation=cv2.INTER_LINEAR)  # same as run_scan canvas mode


def line(d, pts, w, color):
    d.line([(x * SS, y * SS) for x, y in pts], fill=color, width=int(w * SS), joint="curve")
    for x, y in (pts[0], pts[-1]):
        r = w * SS / 2
        d.ellipse((x * SS - r, y * SS - r, x * SS + r, y * SS + r), fill=color)


def rows_of(grid, ch):
    return sorted({y for y, r in enumerate(grid) for c in r if c == ch})


centers = ideal_centers()
out: dict = {}

# 1. tap size
res = []
for dia in (6, 8, 10, 12, 14, 16, 20):
    a = analyze_drawing(canvas(lambda d: d.ellipse(((300 - dia / 2) * SS, (200 - dia / 2) * SS, (300 + dia / 2) * SS, (200 + dia / 2) * SS), fill=(0x1E, 0x88, 0xE5))), centers)
    res.append({"diameter_px": dia, "coins": len(a.coins)})
out["tap_size"] = res

# 2. line phase
res = []
for k in range(0, 16, 2):
    y = 200 + k
    a = analyze_drawing(canvas(lambda d: line(d, [(100, y), (500, y)], 8, (0, 0, 0))), centers)
    res.append({"line_center_y_px": y, "phase_in_cell": y % 16, "solid_rows": rows_of(a.comps.grid_rows, "1")})
out["line_phase"] = res

# 3. spike hover
res = []
for gap in (0, 6, 12, 16, 20, 24, 32, 48):
    def f(d, gap=gap):
        line(d, [(200, 280), (400, 280)], 8, (0, 0, 0))
        base = 280 - 4 - gap  # platform top edge is y-4
        pts = []
        for i in range(13):
            pts.append((220 + i * 13, base - (13 if i % 2 else 0)))
        line(d, pts, 7, (0xE5, 0x39, 0x35))
    a = analyze_drawing(canvas(f), centers)
    g = a.comps.grid_rows
    hz, so = rows_of(g, "2"), rows_of(g, "1")
    attached = bool(hz) and bool(so) and (min(so) - max(hz)) <= 1
    res.append({"hover_gap_px": gap, "hazard_rows": hz, "solid_rows": so, "spikes_touch_platform": attached,
                "drawn_spike_height_px": 13, "hazard_height_px": 16 * len(hz)})
out["spike_hover"] = res

# 4. slope
res = []
for rise in (0, 8, 16, 32, 64, 128):
    a = analyze_drawing(canvas(lambda d: line(d, [(100, 300), (500, 300 - rise)], 8, (0, 0, 0))), centers)
    g = a.comps.grid_rows
    tops = {}
    for y, r in enumerate(g):
        for x, c in enumerate(r):
            if c == "1" and x not in tops:
                tops[x] = y
    xs = sorted(tops)
    steps = sum(1 for i in range(len(xs) - 1) if tops[xs[i + 1]] != tops[xs[i]])
    res.append({"rise_px_over_400": rise, "surface_steps": steps, "rows_spanned": len(set(tops.values()))})
out["slope"] = res

(HERE / "probe_sweeps.json").write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps(out, indent=1))
