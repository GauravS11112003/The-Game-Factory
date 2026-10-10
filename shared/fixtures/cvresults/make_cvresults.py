#!/usr/bin/env python3
"""Write synthetic CVResult fixtures so lane C's tests do not depend on the CV pipeline.

Run from anywhere (needs Pillow and numpy, both in the vision venv):

    cd vision && uv run python ../shared/fixtures/cvresults/make_cvresults.py

Each case lands in shared/fixtures/cvresults/<case>/ with the files a real
run_scan writes (drawing.png 2400x1350, labels.png 16-bit, backdrop.png
768x432, annotated.jpg <= 1500 px wide, optional sprite.png), cvresult.json
with paths relative to the case dir (work_dir "."), interpretation.json, and a
copy of that interpretation in ../interpretations/<sha1 of annotated.jpg>.json
so fake mode finds it. hashes.json remembers the hashed names so a re-run can
remove stale ones.

Component numbering follows the CV pipeline: reading order (top-left first).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
INTERPRETATIONS_DIR = HERE.parent / "interpretations"

GRID_W, GRID_H = 48, 27
DRAW_W, DRAW_H = 2400, 1350
CELL = DRAW_W // GRID_W  # 50 px
BACKDROP = (768, 432)
SHEET = (1500, 1061)  # A4 landscape at 1500 px wide
PX_PER_MM = SHEET[0] / 297
DRAW_AREA_MM = (28, 26, 240, 135)
INK = {"black": (20, 20, 20), "red": (229, 57, 53), "green": (67, 160, 71), "blue": (30, 136, 229)}
MAGENTA = (255, 0, 255)

Cell = tuple[int, int]


def rect(x0: int, y0: int, x1: int, y1: int) -> list[Cell]:
    return [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


def floor() -> list[Cell]:
    return rect(0, 25, 47, 26)


CASES: dict[str, dict] = {
    "first_jump": {
        "blobs": [
            ("blue", [(22, 18)]),
            ("black", rect(20, 20, 25, 20)),
            ("green", rect(44, 22, 45, 24)),
            ("black", floor()),
        ],
        "sprite": False,
        "notes": "the platform is bouncy",
        "interpretation": {
            "title": "First Jump",
            "annotation_component_ids": [],
            "bindings": [{"component_id": 2, "behavior": "bounce", "params": {"strength": 1.5}}],
            "timer_seconds": None,
            "notes_transcript": "the platform is bouncy",
            "safety_ok": True,
            "safety_reason": None,
        },
    },
    "rules_demo": {
        "blobs": [
            ("black", rect(14, 16, 19, 16)),  # handwritten "moves ->", an annotation
            ("black", rect(14, 18, 22, 18)),  # 9-cell platform
            ("black", rect(40, 21, 40, 24)),  # tall 1x4 bar near the goal: the door
            ("green", rect(43, 21, 45, 23)),  # goal
            ("blue", [(5, 22)]),  # far blue blob: the key
            ("red", rect(30, 23, 31, 24)),  # 2x2 red blob: the patroller
            ("blue", [(42, 23)]),  # blue blob near the goal: stays a coin
            ("black", floor()),
        ],
        "sprite": True,
        "notes": "platform moves right 10. enemy walks. key opens the door. 90 seconds",
        "interpretation": {
            "title": "Rules Demo",
            "annotation_component_ids": [1],
            "bindings": [
                {"component_id": 2, "behavior": "move", "params": {"dx": 10, "speed": 2}},
                {"component_id": 6, "behavior": "patrol", "params": {"dx": 6, "speed": 3}},
                {"component_id": 3, "behavior": "door", "params": {}},
                {"component_id": 5, "behavior": "key", "params": {"opens_component_id": 3}},
            ],
            "timer_seconds": 90,
            "notes_transcript": "platform moves right 10. enemy walks. key opens the door. 90 seconds",
            "safety_ok": True,
            "safety_reason": None,
        },
    },
}


def components_of(blobs: list[tuple[str, list[Cell]]]) -> list[dict]:
    comps = []
    for color, cells in blobs:
        xs, ys = [c[0] for c in cells], [c[1] for c in cells]
        comps.append({"color": color, "cells": cells, "bbox": [min(xs), min(ys), max(xs), max(ys)], "area_cells": len(cells)})
    comps.sort(key=lambda c: (c["bbox"][1], c["bbox"][0]))
    for i, c in enumerate(comps, start=1):
        c["id"] = i
    return comps


def paint(comps: list[dict]) -> tuple[Image.Image, np.ndarray]:
    drawing = Image.new("RGB", (DRAW_W, DRAW_H), "white")
    draw = ImageDraw.Draw(drawing)
    labels = np.zeros((DRAW_H, DRAW_W), dtype=np.uint16)
    inset = 6  # ink does not fill the whole cell, like a marker stroke
    for c in comps:
        for x, y in c["cells"]:
            px0, py0 = x * CELL + inset, y * CELL + inset
            px1, py1 = (x + 1) * CELL - inset, (y + 1) * CELL - inset
            draw.rectangle((px0, py0, px1 - 1, py1 - 1), fill=INK[c["color"]])
            labels[py0:py1, px0:px1] = c["id"]
    return drawing, labels


def backdrop_of(drawing: Image.Image) -> Image.Image:
    small = drawing.resize(BACKDROP, Image.BOX)
    arr = np.asarray(small).copy()
    arr[(arr >= 240).all(axis=2)] = 255  # background pure white, as the contract says
    return Image.fromarray(arr, "RGB")


def annotated_of(drawing: Image.Image, comps: list[dict], title: str, notes: str) -> Image.Image:
    sheet = Image.new("RGB", SHEET, "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=22)
    small = ImageFont.load_default(size=18)
    ax, ay, aw, ah = (round(v * PX_PER_MM) for v in DRAW_AREA_MM)
    draw.text((ax, round(10 * PX_PER_MM)), f"DRAW A LEVEL    Level name: {title}", fill=(0, 0, 0), font=font)
    sheet.paste(drawing.resize((aw, ah), Image.BOX), (ax, ay))
    draw.rectangle((ax, ay, ax + aw, ay + ah), outline=(200, 200, 200))
    rx, ry = round(66 * PX_PER_MM), round(165 * PX_PER_MM)
    draw.rectangle((rx, ry, round(230 * PX_PER_MM), round(199 * PX_PER_MM)), outline=(0, 0, 0))
    draw.text((rx + 6, ry + 4), "Rules: " + notes, fill=(0, 0, 0), font=small)
    for c in comps:
        x0, y0 = c["bbox"][0], c["bbox"][1]
        px, py = ax + round(x0 * aw / GRID_W), ay + round(y0 * ah / GRID_H)
        draw.text((px + 2, py - 20), str(c["id"]), fill=MAGENTA, font=font)
    return sheet


def sprite_image() -> Image.Image:
    img = Image.new("RGBA", (32, 48), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((6, 2, 26, 22), fill=(240, 180, 60, 255), outline=(20, 20, 20, 255), width=2)
    d.rectangle((10, 22, 22, 42), fill=(30, 136, 229, 255), outline=(20, 20, 20, 255), width=2)
    d.point((13, 10), fill=(0, 0, 0, 255))
    d.point((19, 10), fill=(0, 0, 0, 255))
    return img


def grid_rows(comps: list[dict]) -> list[str]:
    rows = [["0"] * GRID_W for _ in range(GRID_H)]
    for c in comps:
        for x, y in c["cells"]:
            if c["color"] == "red":
                rows[y][x] = "2"
            elif c["color"] == "black" and rows[y][x] != "2":
                rows[y][x] = "1"
    return ["".join(r) for r in rows]


def centroid(cells: list[Cell]) -> Cell:
    return (round(sum(c[0] for c in cells) / len(cells)), round(sum(c[1] for c in cells) / len(cells)))


def default_start(rows: list[str]) -> Cell:
    for x in range(GRID_W):
        for y in range(GRID_H):
            if rows[y][x] == "1":
                return (x, max(1, y - 1))
    return (2, 24)


def build_case(name: str, spec: dict) -> str:
    out = HERE / name
    out.mkdir(parents=True, exist_ok=True)
    comps = components_of(spec["blobs"])
    drawing, labels = paint(comps)
    drawing.save(out / "drawing.png")
    Image.fromarray(labels).save(out / "labels.png")  # uint16 -> 16-bit PNG
    backdrop_of(drawing).save(out / "backdrop.png")
    annotated_of(drawing, comps, spec["interpretation"]["title"], spec["notes"]).save(out / "annotated.jpg", quality=85)
    if spec["sprite"]:
        sprite_image().save(out / "sprite.png")

    rows = grid_rows(comps)
    greens = [c for c in comps if c["color"] == "green"]
    goal = centroid(max(greens, key=lambda c: c["area_cells"])["cells"]) if greens else None
    cvresult = {
        "mode": "paper",
        "grid_rows": rows,
        "components": [
            {"id": c["id"], "color": c["color"], "bbox": c["bbox"], "area_cells": c["area_cells"], "cells": c["cells"]}
            for c in comps
        ],
        "goal": list(goal) if goal else None,
        "coins": [list(centroid(c["cells"])) for c in comps if c["color"] == "blue"],
        "player_start": list(default_start(rows)),
        "sprite_path": "sprite.png" if spec["sprite"] else None,
        "backdrop_path": "backdrop.png",
        "drawing_path": "drawing.png",
        "labels_path": "labels.png",
        "annotated_path": "annotated.jpg",
        "qr_payload": "dal1|blank",
        "warnings": [],
        "work_dir": ".",
    }
    (out / "cvresult.json").write_text(json.dumps(cvresult, indent=1) + "\n")
    (out / "interpretation.json").write_text(json.dumps(spec["interpretation"], indent=2) + "\n")

    sha1 = hashlib.sha1((out / "annotated.jpg").read_bytes()).hexdigest()
    INTERPRETATIONS_DIR.mkdir(parents=True, exist_ok=True)
    (INTERPRETATIONS_DIR / f"{sha1}.json").write_text(json.dumps(spec["interpretation"], indent=2) + "\n")
    return sha1


def main() -> None:
    hashes_path = HERE / "hashes.json"
    old = json.loads(hashes_path.read_text()) if hashes_path.is_file() else {}
    new = {name: build_case(name, spec) for name, spec in CASES.items()}
    for name, sha1 in old.items():
        if new.get(name) != sha1:
            (INTERPRETATIONS_DIR / f"{sha1}.json").unlink(missing_ok=True)
    hashes_path.write_text(json.dumps(new, indent=2) + "\n")
    for name, sha1 in new.items():
        print(f"{name}: annotated sha1 {sha1}")


if __name__ == "__main__":
    main()
