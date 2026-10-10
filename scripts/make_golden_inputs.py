#!/usr/bin/env python3
"""Golden inputs (PLAN_V2 §11.5, lane C).

1. Copies (never moves) the G01-G15 source inputs into shared/golden/<id>/ (input.png|jpg, prompt.txt, gt.json).
2. Exports the vector strokes of G01-G06 as shared/golden/<id>/strokes.json (InkStroke list, cells, 1/64 precision).
   It replays docs/v2/diagnosis/build/make_kid_drawings.py with the same seeds through a recording marker, so the
   re-rendered raster is byte-identical to the copied input.png (checked; that script is not modified).

Run from vision/:  uv run --no-sync python ../scripts/make_golden_inputs.py [--check]
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import math
import shutil
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "vision"))
GOLDEN = REPO / "shared" / "golden"
BUILD_INPUTS = REPO / "docs" / "v2" / "diagnosis" / "build" / "inputs"
MODEL_INPUTS = REPO / "docs" / "v2" / "diagnosis" / "model" / "inputs"
DRAFTS = REPO / "vision" / "data" / "uploads" / "drafts"
KID_SCRIPT = REPO / "docs" / "v2" / "diagnosis" / "build" / "make_kid_drawings.py"

CELL = 16
QUANT = 64  # ink points: 1/64 cell
RDP_EPS = 0.03  # cells, the canvas simplification (§3.2)

# id -> (list of (source, dest name)), prompt or None
SOURCES: dict[str, tuple[list[tuple[Path, str]], str | None]] = {
    "G01": ([(BUILD_INPUTS / "1_spike_hop.png", "input.png")], None),
    "G02": ([(BUILD_INPUTS / "2_spike_cave.png", "input.png")], None),
    "G03": ([(BUILD_INPUTS / "3_monster_meadow.png", "input.png")], "the monster walks back and forth"),
    "G04": ([(BUILD_INPUTS / "4_words_and_arrows.png", "input.png")], None),
    "G05": ([(BUILD_INPUTS / "5_big_leap.png", "input.png")], None),
    "G06": ([(BUILD_INPUTS / "6_kid_full_level.png", "input.png")], "the monster walks"),
    "G07": ([(MODEL_INPUTS / "canvas_floating_spikes" / "input.png", "input.png"),
             (MODEL_INPUTS / "canvas_floating_spikes" / "gt.json", "gt.json")], None),
    "G08": ([(MODEL_INPUTS / "canvas_wobbly_cave" / "input.png", "input.png"),
             (MODEL_INPUTS / "canvas_wobbly_cave" / "gt.json", "gt.json")], None),
    "G09": ([(MODEL_INPUTS / "canvas_tower_key" / "input.png", "input.png"),
             (MODEL_INPUTS / "canvas_tower_key" / "gt.json", "gt.json")], None),
    "G10": ([(MODEL_INPUTS / "paper_synth_1" / "input.jpg", "input.jpg"),
             (MODEL_INPUTS / "paper_synth_1" / "gt.json", "gt.json")], None),
    "G11": ([(DRAFTS / "d_b14b143e" / "drawing.png", "input.png")], "the high platform moves left and right 4 cells; timer 45"),
    "G12": ([(DRAFTS / "d_dfbfe619" / "photo.jpg", "input.jpg")], None),
    "G13": ([(DRAFTS / "d_79eff85e" / "photo.jpg", "input.jpg")], None),
    "G14": ([(DRAFTS / "d_45f50934" / "photo.jpg", "input.jpg")], None),
    "G15": ([(DRAFTS / "d_23962d19" / "photo.jpg", "input.jpg")], None),
}
KID_DRAWINGS = {"G01": "d1_spike_hop", "G02": "d2_spike_cave", "G03": "d3_monster_meadow", "G04": "d4_words_and_arrows",
                "G05": "d5_big_leap", "G06": "d6_kid_full_level"}


def copy_inputs() -> list[str]:
    missing: list[str] = []
    for gid, (files, prompt) in SOURCES.items():
        d = GOLDEN / gid
        d.mkdir(parents=True, exist_ok=True)
        for src, name in files:
            if not src.exists():
                missing.append(f"{gid}: {src.relative_to(REPO)}")
                continue
            shutil.copy2(src, d / name)
        if prompt:
            (d / "prompt.txt").write_text(prompt + "\n")
    return missing


# ---- vector export (G01-G06) -------------------------------------------------------------------


def _load_kid_module() -> Any:
    spec = importlib.util.spec_from_file_location("make_kid_drawings", KID_SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _rdp(pts: list[tuple[float, float]], eps: float) -> list[int]:
    """Indices kept by Ramer-Douglas-Peucker."""
    if len(pts) < 3:
        return list(range(len(pts)))
    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / norm if norm else math.hypot(px - ax, py - ay)
            if d > best:
                best, idx = d, i
        if best > eps and idx > 0:
            keep.add(idx)
            stack += [(a, idx), (idx, b)]
    return sorted(keep)


def _q(v: float) -> float:
    return round(v * QUANT) / QUANT


def export_strokes(gid: str, mod: Any) -> tuple[list[dict[str, Any]], bytes]:
    colors = {mod.BLACK: "black", mod.RED: "red", mod.GREEN: "green", mod.BLUE: "blue"}
    marks: list[tuple[str, tuple[int, int, int], list[tuple[float, float]], list[float]]] = []

    class RecordingKid(mod.Kid):  # type: ignore[misc, name-defined]
        # Same RNG consumption and drawing as Kid.stroke / Kid.dot, plus a record of what was drawn.
        def stroke(self, pts, color, width=None, wobble=1.8):  # noqa: ANN001, ANN202
            width = width if width is not None else self.rng.uniform(6.5, 9.5)
            r = width * mod.SS / 2
            wob = self._wobble([(float(a), float(b)) for a, b in pts], wobble)
            ws = []
            for i, (x, y) in enumerate(wob):
                rr = r * (1 + 0.12 * math.sin(i * 0.07))
                cx, cy = x * mod.SS, y * mod.SS
                self.d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=color)
                ws.append(2 * rr / mod.SS)
            marks.append(("line", color, wob, ws))

        def dot(self, x, y, color, width=8):  # noqa: ANN001, ANN202
            super().dot(x, y, color, width)
            marks.append(("dot", color, [(float(x), float(y))], [float(width)]))

    original = mod.Kid
    mod.Kid = RecordingKid
    try:
        kid, _info = getattr(mod, KID_DRAWINGS[gid])()
    finally:
        mod.Kid = original
    buf = io.BytesIO()
    kid.img.resize((mod.W, mod.H), mod.Image.LANCZOS).save(buf, format="PNG")

    strokes: list[dict[str, Any]] = []
    for n, (kind, color, pts_px, w_px) in enumerate(marks, 1):
        pts = [(x / CELL, y / CELL) for x, y in pts_px]
        w = [v / CELL for v in w_px]
        if kind == "dot":
            s = {"id": f"s{n}", "color": colors[color], "kind": "dot", "pts": [[_q(pts[0][0]), _q(pts[0][1])]],
                 "w": [_q(w[0])], "closed": True, "sheet": 0, "origin": "kid", "t": n}
        else:
            keep = _rdp(pts, RDP_EPS)
            closed = len(pts) > 8 and math.dist(pts[0], pts[-1]) <= max(w)
            s = {"id": f"s{n}", "color": colors[color], "kind": "line", "pts": [[_q(pts[i][0]), _q(pts[i][1])] for i in keep],
                 "w": [_q(w[i]) for i in keep], "closed": closed, "sheet": 0, "origin": "kid", "t": n}
        strokes.append(s)
    return strokes, buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="verify only; write nothing")
    a = ap.parse_args()
    from app.spec.ink import InkStroke

    missing = [] if a.check else copy_inputs()
    for m in missing:
        print("MISSING", m)
    mod = _load_kid_module()
    bad = 0
    for gid in KID_DRAWINGS:
        strokes, png = export_strokes(gid, mod)
        for s in strokes:
            InkStroke.model_validate(s)
        target = GOLDEN / gid / "input.png"
        same = target.exists() and target.read_bytes() == png
        if not same and target.exists():
            from PIL import Image, ImageChops

            same_pixels = ImageChops.difference(Image.open(target).convert("RGB"), Image.open(io.BytesIO(png)).convert("RGB")).getbbox() is None
            print(f"{gid}: raster bytes differ; pixels {'identical' if same_pixels else 'DIFFER'}")
            bad += not same_pixels
        if not a.check:
            (GOLDEN / gid / "strokes.json").write_text(json.dumps(strokes, separators=(",", ":")) + "\n")
        print(f"{gid}: {len(strokes)} strokes, raster {'byte-identical' if same else 'checked'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
