"""Probe D - PROMPT-TO-LEVEL. One sentence -> structured level skeleton -> rasterize -> v1 solver.

Usage (inside vision/ env): python probe_d.py <prompt_key> <effort>
Writes results/probe_d_<key>_<effort>.json
"""
from __future__ import annotations

import json
import sys

from pydantic import BaseModel

from builder import reachable_summary  # noqa: F401  (handy when debugging)
from common import H, RESULTS, W, ascii_grid, call, empty_grid, make_level, rows_of, solve_levels

PROMPTS = {
    "lava_key": "a lava cave where you need a key to open the exit, medium difficulty",
    "tutorial": "an easy first level that teaches jumping over small gaps",
    "gauntlet": "a hard spike gauntlet with moving platforms over a bottomless pit",
    "tower": "a tower you climb to the top while dodging walking enemies, medium difficulty",
}


class Rect(BaseModel):
    x0: int
    y0: int
    x1: int
    y1: int


class Point(BaseModel):
    x: int
    y: int


class Section(BaseModel):
    name: str
    x0: int
    x1: int
    purpose: str


class MovingPlatform(BaseModel):
    x0: int
    y: int
    width: int
    dx: int
    dy: int


class Enemy(BaseModel):
    x: int
    y: int
    patrol_dx: int


class LevelSkeleton(BaseModel):
    title: str
    design_notes: str
    sections: list[Section]
    solids: list[Rect]
    hazards: list[Rect]
    moving_platforms: list[MovingPlatform]
    enemies: list[Enemy]
    coins: list[Point]
    checkpoints: list[Point]
    key: Point | None
    door: Rect | None
    start: Point
    goal: Point


SYSTEM = """\
You design levels for a 2D platformer from a one-sentence request. Output a level skeleton that a child will then
draw on top of, so keep shapes simple (rectangles) and the structure readable.

Grid: 48 x 27 cells (one screen), x right, y DOWN, origin top-left, all coordinates are integer cells and rects are
inclusive [x0..x1] x [y0..y1]. The player is 1 cell wide and 2 cells tall. A point entity (start, goal, key, coin,
checkpoint, enemy) is given by the cell of the player's FEET / the object's bottom cell; to stand on a solid whose
top row is r, use y = r - 1.
Physics (measured, exact): max jump height 3 cells (a ledge whose top is 3 rows above your current surface is
reachable, 4 is not); max flat gap 6 empty cells; falling is unlimited; falling off the bottom row kills.
- solids: ground, platforms and walls (each a rect; platforms are usually 1 row thick).
- hazards: spikes/lava rects; touching one kills.
- moving_platforms: a 1-row platform at (x0, y) of width cells that ping-pongs by (dx, dy) cells.
- enemies walk back and forth patrol_dx cells on the surface they stand on.
- key + door: the door is a solid rect that disappears when the key is collected. If the request needs a key, the
  goal must be unreachable while the door is closed, and the key must be reachable without passing the door.
Make it fair: everything required must be reachable with the physics above. Match the requested difficulty with
the size of gaps, hazard placement and enemies, not with impossible jumps.
"""


def rasterize(sk: dict, door_closed: bool) -> list[str]:
    g = empty_grid()
    def fill(r: dict, ch: str) -> int:
        bad = 0
        for y in range(min(r["y0"], r["y1"]), max(r["y0"], r["y1"]) + 1):
            for x in range(min(r["x0"], r["x1"]), max(r["x0"], r["x1"]) + 1):
                if 0 <= x < W and 0 <= y < H:
                    g[y][x] = ch
                else:
                    bad += 1
        return bad
    oob = sum(fill(r, "1") for r in sk["solids"])
    oob += sum(fill(r, "2") for r in sk["hazards"])
    if door_closed and sk.get("door"):
        oob += fill(sk["door"], "1")
    rasterize.oob = oob  # type: ignore[attr-defined]
    return rows_of(g)


def validate(sk: dict, name: str) -> dict:
    open_rows = rasterize(sk, door_closed=False)
    closed_rows = rasterize(sk, door_closed=True)
    oob = rasterize.oob  # type: ignore[attr-defined]
    s = (sk["start"]["x"], sk["start"]["y"])
    gl = (sk["goal"]["x"], sk["goal"]["y"])
    mp = [{"id": f"mp{i}", "type": "moving_platform", "bbox": [m["x0"], m["y"], m["x0"] + m["width"] - 1, m["y"]],
           "path": [[m["x0"], m["y"]], [m["x0"] + m["dx"], m["y"] + m["dy"]]], "speed": 2}
          for i, m in enumerate(sk["moving_platforms"])]
    levels = [make_level(name + ":goal_door_open", open_rows, s, gl, mp)]
    if sk.get("key"):
        k = (sk["key"]["x"], sk["key"]["y"])
        levels.append(make_level(name + ":key_door_closed", closed_rows, s, k, mp))
        levels.append(make_level(name + ":goal_door_closed", closed_rows, s, gl, mp))
    res = {r["name"].split(":")[-1]: r for r in solve_levels(levels)}
    def standable(p, rows):
        x, y = p
        return 0 <= x < W and 1 <= y < H - 1 and rows[y][x] == "0" and rows[y - 1][x] == "0" and rows[y + 1][x] == "1"
    def in_solid(p, rows):
        x, y = p
        return not (0 <= x < W and 0 <= y < H) or rows[y][x] != "0"
    reach = set(res["goal_door_open"]["reachable"])
    coins_reachable = sum(
        1 for c in sk["coins"]
        if any(abs(int(r.split(",")[0]) - c["x"]) <= 3 and 0 <= int(r.split(",")[1]) - c["y"] <= 4 for r in reach)
    )
    enemies_ok = sum(1 for e in sk["enemies"] if standable((e["x"], e["y"]), open_rows))
    out = {
        "goal_reachable": res["goal_door_open"]["solvable"],
        "start_standable": standable(s, closed_rows),
        "goal_in_solid": in_solid(gl, open_rows),
        "out_of_bounds_cells": oob,
        "coins_reachable": f"{coins_reachable}/{len(sk['coins'])}",
        "enemies_on_surface": f"{enemies_ok}/{len(sk['enemies'])}",
        "reachable_cells": len(reach),
    }
    if sk.get("key"):
        out["key_reachable_door_closed"] = res["key_door_closed"]["solvable"]
        out["door_gates_goal"] = not res["goal_door_closed"]["solvable"]
        out["solvable"] = out["goal_reachable"] and out["key_reachable_door_closed"]
    else:
        out["solvable"] = out["goal_reachable"]
    out["grid_closed"] = closed_rows
    return out


def run(key: str, effort: str) -> dict:
    prompt = PROMPTS[key]
    rec = call(f"D:{key}", "D", effort, SYSTEM, [{"type": "text", "text": f"Request: {prompt}\n\nReturn the level skeleton."}], LevelSkeleton)
    out = {"key": key, "prompt": prompt, "effort": effort, "call": rec}
    if rec.get("parsed"):
        v = validate(rec["parsed"], key)
        out["validation"] = v
        print(json.dumps({k: v[k] for k in v if k != "grid_closed"}))
        print(ascii_grid(v["grid_closed"]))
        sk = rec["parsed"]
        print("start", sk["start"], "goal", sk["goal"], "key", sk["key"], "door", sk["door"], "mp", sk["moving_platforms"], "enemies", sk["enemies"])
    (RESULTS / f"probe_d_{key}_{effort}.json").write_text(json.dumps(out, indent=1))
    return out


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2])
