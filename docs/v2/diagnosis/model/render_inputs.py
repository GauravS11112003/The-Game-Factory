"""Render 3 canvas drawings with known ground truth, run the v1 CV on them (and on synth_1.jpg),
and write inputs/<scene>/{input.png|jpg, annotated.jpg, cv.json, gt.json}.

Run inside vision/:  uv run --no-sync python ../docs/v2/diagnosis/model/render_inputs.py
No API calls.

Ground truth is authored as objects (name, color, cell-bbox region, role, relations by object
name). CV components are matched to objects by color + max cell overlap with the object's region,
so the score is per CV component (what the model actually labels).
"""
from __future__ import annotations

import json
import math
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "vision"))
from app.cv.pipeline import run_scan  # noqa: E402

OUT = HERE / "inputs"
C = 16  # px per cell on the 768x432 canvas
BLACK, RED, GREEN, BLUE = "#000000", "#e53935", "#43a047", "#1e88e5"
FONT = "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf"
W = 8  # v1 canvas brush px


def cx(x: float) -> float:
    return x * C + C / 2


def line(d, x0, y0, x1, y1, color=BLACK, w=W):
    d.line([(cx(x0), cx(y0)), (cx(x1), cx(y1))], fill=color, width=w, joint="curve")
    for x, y in ((x0, y0), (x1, y1)):
        d.ellipse([cx(x) - w / 2, cx(y) - w / 2, cx(x) + w / 2, cx(y) + w / 2], fill=color)


def wobbly(d, x0, x1, y, amp=0.55, period=7.0, color=BLACK, phase=0.0):
    pts = []
    steps = int((x1 - x0) * 4)
    for i in range(steps + 1):
        x = x0 + (x1 - x0) * i / steps
        pts.append((cx(x), cx(y + amp * math.sin(phase + 2 * math.pi * (x - x0) / period))))
    d.line(pts, fill=color, width=W, joint="curve")


def spikes(d, x0, x1, base_y_px, direction="up", color=RED, h=12):
    """Touching triangles from cell x0 to x1 inclusive, base at base_y_px (pixel), pointing up/down."""
    n = x1 - x0 + 1
    for i in range(n):
        left = (x0 + i) * C
        apex_y = base_y_px - h if direction == "up" else base_y_px + h
        d.polygon([(left, base_y_px), (left + C, base_y_px), (left + C / 2, apex_y)], fill=color)
    d.line([(x0 * C, base_y_px), ((x1 + 1) * C, base_y_px)], fill=color, width=3)


def wall_spikes_left(d, x_px, y0, y1, color=RED, w=12):
    """Spikes on the left face of a wall: base vertical at x_px, apexes pointing left."""
    for j in range(y0, y1 + 1):
        top = j * C
        d.polygon([(x_px, top), (x_px, top + C), (x_px - w, top + C / 2)], fill=color)
    d.line([(x_px, y0 * C), (x_px, (y1 + 1) * C)], fill=color, width=3)


def monster(d, x0, y0, x1, y1):
    d.ellipse([x0 * C, y0 * C + 4, (x1 + 1) * C, (y1 + 1) * C - 4], fill=RED)
    for lx in (x0 * C + 6, (x1 + 1) * C - 14):
        d.rectangle([lx, (y1 + 1) * C - 8, lx + 6, (y1 + 1) * C - 1], fill=RED)
    w = (x1 - x0 + 1) * C
    for ex in (x0 * C + w * 0.3, x0 * C + w * 0.65):
        d.ellipse([ex - 5, y0 * C + 12, ex + 5, y0 * C + 22], fill="white")


def text(d, x, y, s, color=BLACK, size=30):
    # stroke_width 2 makes letter strokes ~7-8 px, like the v1 canvas brush (8 px)
    d.text((x * C, y * C), s, fill=color, font=ImageFont.truetype(FONT, size), stroke_width=2, stroke_fill=color)


def arrow(d, x0, x1, y, color=BLACK):
    line(d, x0, y, x1, y, color, 6)
    d.line([(cx(x1), cx(y)), (cx(x1) - 14, cx(y) - 12)], fill=color, width=6)
    d.line([(cx(x1), cx(y)), (cx(x1) - 14, cx(y) + 12)], fill=color, width=6)


def coin(d, x, y):
    d.ellipse([cx(x) - 6, cx(y) - 6, cx(x) + 6, cx(y) + 6], fill=BLUE)


def obj(name, color, bbox, role, **rel):
    return {"name": name, "color": color, "bbox": bbox, "role": role, **rel}


# ---------------------------------------------------------------------------------------------
def scene_floating_spikes():
    img = Image.new("RGB", (768, 432), "white")
    d = ImageDraw.Draw(img)
    line(d, 1, 25, 20, 25)                          # G1
    line(d, 26, 25, 46, 25)                         # G2
    line(d, 8, 22, 14, 22)                          # P1
    spikes(d, 9, 13, 20 * C + 12, "up")             # S1 floating 1+ cell above P1
    line(d, 16, 19, 23, 19)                         # P2
    arrow(d, 25, 29, 19)                            # arrow -> P2 moves right
    spikes(d, 30, 33, 25 * C + 4, "up")             # S2 sits on G2
    line(d, 34, 6, 46, 6)                           # ceiling
    spikes(d, 37, 41, 6 * C + 12, "down")           # S3 hanging from ceiling
    monster(d, 15, 23, 17, 24)                      # enemy on G1
    d.ellipse([43 * C, 14 * C, 45 * C, 16 * C], fill=GREEN)  # goal floating mid-air
    coin(d, 20, 17); coin(d, 39, 22)
    text(d, 20.3, 21.6, "jump!")                    # handwriting inside drawing
    # cloud decoration
    for (x, y, r) in ((4.5, 4.3, 1.3), (6.3, 3.8, 1.6), (8.0, 4.4, 1.2)):
        d.arc([cx(x) - r * C, cx(y) - r * C, cx(x) + r * C, cx(y) + r * C], 180, 360, fill=BLACK, width=5)
    line(d, 3.2, 4.4, 9.2, 4.4, BLACK, 5)
    # sun decoration
    d.ellipse([cx(26) - 22, cx(4) - 22, cx(26) + 22, cx(4) + 22], outline=BLACK, width=5)
    for k in range(8):
        a = k * math.pi / 4
        d.line([(cx(26) + 30 * math.cos(a), cx(4) + 30 * math.sin(a)), (cx(26) + 42 * math.cos(a), cx(4) + 42 * math.sin(a))], fill=BLACK, width=5)
    gt = [
        obj("G1", "black", [0, 24, 21, 26], "ground"),
        obj("G2", "black", [25, 24, 47, 26], "ground"),
        obj("P1", "black", [7, 21, 15, 23], "platform"),
        obj("P2", "black", [15, 18, 24, 20], "platform"),
        obj("S1", "red", [8, 19, 14, 21], "spike_strip", rests_on="P1", points="up"),
        obj("S2", "red", [29, 23, 34, 25], "spike_strip", rests_on="G2", points="up"),
        obj("CEIL", "black", [33, 5, 47, 6], "ceiling"),
        obj("S3", "red", [36, 6, 42, 8], "spike_strip", attached_to="CEIL", points="down"),
        obj("MON", "red", [14, 22, 18, 25], "enemy", rests_on="G1"),
        obj("GOAL", "green", [42, 13, 46, 17], "goal", rests_on=None),
        obj("COIN", "blue", [0, 0, 47, 26], "coin"),
        obj("ARROW", "black", [24, 18, 30, 20], "arrow", points="right", attached_to="P2"),
        obj("TXT", "black", [19, 21, 27, 24], "text"),
        obj("CLOUD", "black", [2, 1, 10, 5], "decoration"),
        obj("SUN", "black", [22, 0, 30, 7], "decoration"),
    ]
    expected_repairs = [
        "snap S1 down onto P1 (spikes float 1 cell above it), keep pointing up",
        "reclassify TXT ('jump!'), ARROW, CLOUD, SUN so they are not solid tiles",
        "goal floats in mid-air out of reach: move it onto G2 (or nudge it down)",
        "keep MON (enemy on G1), keep S3 hanging from the ceiling pointing down",
        "do NOT delete spikes or the monster; do not widen/close the 5-cell G1-G2 gap (it is jumpable)",
    ]
    return img, gt, expected_repairs


def scene_wobbly_cave():
    img = Image.new("RGB", (768, 432), "white")
    d = ImageDraw.Draw(img)
    wobbly(d, 1, 46, 2, amp=0.4, period=9)               # cave roof
    wobbly(d, 1, 22, 24, amp=0.6, period=7)              # F1 wobbly floor
    wobbly(d, 24, 30, 24, amp=0.4, period=5, phase=1.0)  # F1b after an accidental 1-cell gap
    line(d, 39, 24, 46, 24)                              # F2 after an 8-cell pit
    line(d, 16, 19, 16, 23)                              # tall wall, 5 cells
    spikes(d, 31, 38, 26 * C + 6, "up")                  # lava/spikes at bottom of the pit
    spikes(d, 20, 23, 3 * C + 4, "down")                 # stalactites from roof
    text(d, 32.2, 20.4, "lava!", RED)                    # red handwriting in the air over the pit
    d.polygon([(cx(44), cx(20)), (cx(46), cx(20.8)), (cx(44), cx(21.6))], fill=GREEN)  # flag
    line(d, 44, 20, 44, 23, GREEN, 5)
    # bat decoration (black m-shape) mid-air
    d.line([(cx(9), cx(8)), (cx(10), cx(7)), (cx(11), cx(8)), (cx(12), cx(7)), (cx(13), cx(8))], fill=BLACK, width=5)
    coin(d, 8, 21); coin(d, 27, 21)
    gt = [
        obj("ROOF", "black", [0, 1, 47, 3], "ceiling"),
        obj("F1", "black", [0, 23, 23, 25], "ground"),
        obj("F1b", "black", [23, 23, 31, 25], "ground"),
        obj("F2", "black", [38, 23, 47, 25], "ground"),
        obj("WALL", "black", [15, 18, 17, 23], "wall", rests_on="F1"),
        obj("PIT", "red", [30, 25, 39, 26], "spike_strip", points="up", rests_on=None),
        obj("STAL", "red", [19, 3, 24, 5], "spike_strip", attached_to="ROOF", points="down"),
        obj("TXT", "red", [31, 19, 39, 23], "text"),
        obj("GOAL", "green", [43, 19, 47, 24], "goal", rests_on="F2"),
        obj("BAT", "black", [8, 6, 14, 9], "decoration"),
        obj("COIN", "blue", [0, 0, 47, 26], "coin"),
    ]
    expected_repairs = [
        "straighten F1 (wobbly floor makes 1-cell bumps)",
        "close the accidental 1-cell gap at x=23 between F1 and F1b (or merge them)",
        "reclassify TXT ('lava!' written in RED) as text: otherwise it becomes hazard tiles in mid-air",
        "reclassify BAT as decoration",
        "the 8-cell pit (x=31..38) is wider than the 6-cell max: nudge F2 left or F1b right so it is <= 6",
        "the 5-cell WALL is taller than the 3-cell max jump: nudge it down / flag it",
        "keep PIT spikes and STAL",
    ]
    return img, gt, expected_repairs


def scene_tower_key():
    img = Image.new("RGB", (768, 432), "white")
    d = ImageDraw.Draw(img)
    line(d, 1, 25, 45, 25)                       # ground
    line(d, 6, 22, 11, 22)                       # P1
    line(d, 13, 19, 18, 19)                      # P2
    line(d, 21, 16, 26, 16)                      # P3
    line(d, 29, 12, 46, 12)                      # P4: 4 rows above P3 = impossible jump
    line(d, 46, 13, 46, 24)                      # right wall
    wall_spikes_left(d, 46 * C + 4, 17, 20)      # spikes on the wall's left face
    spikes(d, 8, 10, 22 * C + 4, "up")           # spikes on P1
    d.rectangle([40 * C + 2, 8 * C, 41 * C - 2, 12 * C], fill=BLACK)  # door (thin, 4 tall) on P4
    d.polygon([(cx(44), cx(9.6)), (cx(44.5), cx(10.7)), (cx(45.6), cx(10.8)), (cx(44.7), cx(11.4)), (cx(45), cx(12.4)), (cx(44), cx(11.8)), (cx(43), cx(12.4)), (cx(43.3), cx(11.4)), (cx(42.4), cx(10.8)), (cx(43.5), cx(10.7))], fill=GREEN)  # star goal
    # key: ring + shaft + tooth
    d.ellipse([cx(14.5) - 7, cx(17.5) - 7, cx(14.5) + 7, cx(17.5) + 7], outline=BLUE, width=5)
    d.line([(cx(14.5) + 7, cx(17.5)), (cx(17), cx(17.5))], fill=BLUE, width=5)
    d.line([(cx(16.6), cx(17.5)), (cx(16.6), cx(18.1))], fill=BLUE, width=4)
    monster(d, 23, 14, 25, 15)                   # enemy on P3
    # tree decoration on the ground
    d.ellipse([30 * C, 19 * C, 35 * C, 22 * C], outline=BLACK, width=5)
    line(d, 32.5, 22, 32.5, 24, BLACK, 6)
    text(d, 2, 21.2, "S")                         # start marker
    text(d, 22, 1.5, "key opens door", BLACK, 28)
    coin(d, 12, 20); coin(d, 20, 14)
    gt = [
        obj("GROUND", "black", [0, 24, 45, 26], "ground"),
        obj("P1", "black", [5, 21, 12, 23], "platform"),
        obj("P2", "black", [12, 18, 19, 20], "platform"),
        obj("P3", "black", [20, 15, 27, 17], "platform"),
        obj("P4", "black", [28, 11, 47, 13], "platform"),
        obj("RWALL", "black", [45, 13, 47, 25], "wall"),
        obj("WSPK", "red", [43, 16, 46, 21], "spike_strip", attached_to="RWALL", points="left"),
        obj("S1", "red", [7, 20, 11, 22], "spike_strip", rests_on="P1", points="up"),
        obj("DOOR", "black", [39, 7, 41, 11], "door", rests_on="P4"),
        obj("GOAL", "green", [41, 8, 47, 13], "goal", rests_on="P4"),
        obj("KEY", "blue", [13, 16, 18, 19], "key", rests_on="P2"),
        obj("MON", "red", [22, 13, 26, 16], "enemy", rests_on="P3"),
        obj("TREE", "black", [29, 18, 36, 24], "decoration"),
        obj("S_TXT", "black", [1, 20, 4, 24], "text"),
        obj("TXT", "black", [21, 0, 40, 4], "text"),
        obj("COIN", "blue", [0, 0, 47, 26], "coin"),
    ]
    expected_repairs = [
        "P3 (row 16) -> P4 (row 12) is a 4-cell climb, max is 3: nudge P4 down 1 (or P3 up 1)",
        "reclassify TREE, S_TXT, TXT as non-solid",
        "keep DOOR (it gates the goal), KEY, MON, S1, WSPK (orient left)",
        "do not move the goal; it already rests on P4",
    ]
    return img, gt, expected_repairs


GT_PAPER = [
    obj("G1", "black", [0, 24, 22, 26], "ground"),
    obj("G2", "black", [25, 24, 47, 26], "ground"),
    obj("P1", "black", [7, 19, 14, 21], "platform"),
    obj("P2", "black", [15, 15, 23, 17], "platform"),
    obj("ARROW", "black", [23, 15, 28, 17], "arrow", points="right", attached_to="P2"),
    obj("TXT", "black", [23, 11, 29, 14], "text"),
    obj("S", "red", [29, 23, 34, 25], "spike_strip", rests_on="G2", points="up"),
    obj("GOAL", "green", [42, 20, 46, 24], "goal", rests_on="G2"),
    obj("COIN", "blue", [0, 0, 47, 26], "coin"),
]


def match(components, gt):
    """component id -> object name (color must match; max overlap of cells with the object's bbox)."""
    out = {}
    for c in components:
        best, best_n = None, 0
        for o in gt:
            if o["color"] != c["color"]:
                continue
            x0, y0, x1, y1 = o["bbox"]
            n = sum(1 for (x, y) in c["cells"] if x0 <= x <= x1 and y0 <= y <= y1)
            if n > best_n or (n == best_n and best is not None and n > 0 and _area(o) < _area(best)):
                best, best_n = o, n
        out[c["id"]] = best["name"] if best else None
    return out


def _area(o):
    x0, y0, x1, y1 = o["bbox"]
    return (x1 - x0 + 1) * (y1 - y0 + 1)


def build(scene, src_path: Path, mode: str, gt, expected):
    d = OUT / scene
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    dst = d / ("input" + src_path.suffix)
    shutil.copy(src_path, dst)
    cv = run_scan(dst.read_bytes(), mode, str(d / "work"))
    comps = [c.model_dump() for c in cv.components]
    m = match(comps, gt)
    shutil.copy(cv.annotated_path, d / "annotated.jpg")
    by_name = {o["name"]: o for o in gt}
    # ground truth per component, relations resolved to the largest component of the target object
    largest = {}
    for c in comps:
        n = m[c["id"]]
        if n and (n not in largest or c["area_cells"] > largest[n][1]):
            largest[n] = (c["id"], c["area_cells"])
    per_comp = []
    for c in comps:
        n = m[c["id"]]
        o = by_name.get(n)
        rec = {"id": c["id"], "object": n, "role": o["role"] if o else "unknown"}
        for k in ("rests_on", "attached_to"):
            if o and k in o:
                rec[k] = largest[o[k]][0] if o[k] in largest else None
        if o and "points" in o:
            rec["points"] = o["points"]
        per_comp.append(rec)
    (d / "cv.json").write_text(json.dumps({
        "mode": mode,
        "grid_rows": cv.grid_rows,
        "components": [{k: c[k] for k in ("id", "color", "bbox", "area_cells", "cells")} for c in comps],
        "goal": cv.goal, "coins": cv.coins, "player_start": cv.player_start, "warnings": cv.warnings,
    }, indent=1))
    (d / "gt.json").write_text(json.dumps({"objects": gt, "components": per_comp, "expected_repairs": expected}, indent=1))
    unmatched = [c["id"] for c in per_comp if c["object"] is None]
    print(f"{scene}: {len(comps)} components, unmatched={unmatched}")
    for c in per_comp:
        print("   ", c)
    print("\n".join("    " + r for r in cv.grid_rows))


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    tmp = HERE / "inputs" / "_src"
    tmp.mkdir(exist_ok=True)
    for name, fn in (("canvas_floating_spikes", scene_floating_spikes), ("canvas_wobbly_cave", scene_wobbly_cave), ("canvas_tower_key", scene_tower_key)):
        img, gt, exp = fn()
        p = tmp / f"{name}.png"
        img.save(p)
        build(name, p, "canvas", gt, exp)
    build("paper_synth_1", ROOT / "shared/fixtures/photos/synth_1.jpg", "paper", GT_PAPER, [
        "reclassify the 'moves' handwriting and the arrow so they are not solid",
        "nothing else is broken: no snapping or moving needed (spikes rest on G2, goal on G2)",
    ])
    shutil.rmtree(tmp)
