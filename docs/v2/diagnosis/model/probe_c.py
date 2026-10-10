"""Probe C - DESIGNER ENHANCEMENT. Repaired level (Probe B, medium) -> "challenging but fair" additions in a
fixed vocabulary. Applied deterministically, then re-validated with the v1 solver.

Usage (inside vision/ env): python probe_c.py <scene> <effort>
Writes results/probe_c_<scene>_<effort>.json
"""
from __future__ import annotations

import json
import sys
from typing import Literal

from pydantic import BaseModel

from builder import State, evaluate, graph_from_call, load_scene, reachable_summary
from common import H, HERE, RESULTS, W, ascii_grid, call, image_block, make_level, solve_levels


class Cell(BaseModel):
    x: int
    y: int


class Addition(BaseModel):
    op: Literal["add_coin_trail", "add_enemy", "make_crumble", "add_checkpoint", "add_spike_strip", "add_bounce_pad"]
    cells: list[Cell]            # coin trail cells; or the single cell for enemy feet / checkpoint / bounce pad
    component_id: int | None     # make_crumble target
    row: int | None              # add_spike_strip row (the empty row directly above a surface)
    x0: int | None
    x1: int | None
    patrol_dx: int | None        # add_enemy
    reason: str
    makes_harder_or_guides: Literal["harder", "guides", "both"]


class Enhancement(BaseModel):
    additions: list[Addition]
    difficulty_before: Literal["trivial", "easy", "medium", "hard", "unfair"]
    difficulty_after: Literal["trivial", "easy", "medium", "hard", "unfair"]
    pitch_to_kid: str


SYSTEM = """\
You are the designer stage of a level-design assistant for a kids' draw-a-platformer game. The child's level has
already been repaired so it is beatable. Players say these levels feel too easy and flat. Propose 3-6 additions
that make it "challenging but fair" while staying inside the child's idea: reward risky jumps, add tension on long
safe stretches, guide the eye toward the route. Never block the only route, never place anything the player cannot
see coming, never change what the child drew.

Grid: 48 x 27 cells, x right, y DOWN. '#' solid, '^' hazard, '.' empty. The player is 1 wide, 2 tall; it stands
on top of a solid cell (feet cell = row above the surface). Max jump: 3 cells up, 6 empty cells across.
Vocabulary (deterministic code applies these; null unused fields):
- add_coin_trail {cells}: 3-6 coins along the arc of a jump you want to encourage (coins in empty cells).
- add_enemy {cells:[feet cell], patrol_dx}: a walker on a surface; it patrols patrol_dx cells to the right and back,
  staying on that surface.
- make_crumble {component_id}: a platform that falls 0.5 s after you land on it (only on a platform that is
  not needed twice).
- add_checkpoint {cells:[feet cell]}: a respawn flag on a surface, after a hard part.
- add_spike_strip {row, x0, x1}: spikes in the empty row directly above a surface, leaving room to land.
- add_bounce_pad {cells:[surface cell]}: a spring on top of a solid cell (launches ~12 cells up).
"""


def rebuild(scene: str) -> tuple[State, dict]:
    b = json.loads((RESULTS / f"probe_b_{scene}_medium.json").read_text())
    st = State(load_scene(scene), graph_from_call("A:" + scene))
    for e in b["call"]["parsed"]["edits"]:
        st.apply(e)
    return st, b


def standable(rows: list[str], x: int, y: int) -> bool:
    return 0 <= x < W and 1 <= y < H - 1 and rows[y][x] == "0" and rows[y - 1][x] == "0" and rows[y + 1][x] == "1"


def run(scene: str, effort: str) -> dict:
    st, b = rebuild(scene)
    ev = evaluate(st, scene)
    reach = ev.pop("_reachable")
    rows = st.rows()
    ents = [f"start feet {ev['start']}", f"goal {ev['goal']}"]
    for c in st.comps.values():
        if c["role"] in ("coin", "key", "enemy", "door"):
            xs = [x for x, _ in c["cells"]]; ys = [y for _, y in c["cells"]]
            ents.append(f"{c['role']} #{c['id']} bbox [{min(xs)},{min(ys)},{max(xs)},{max(ys)}]")
    plats = []
    for c in st.comps.values():
        if c["role"] in ("platform", "ground") and c["cells"]:
            xs = [x for x, _ in c["cells"]]; ys = [y for _, y in c["cells"]]
            plats.append(f"#{c['id']} {c['role']} x{min(xs)}..{max(xs)} rows {min(ys)}..{max(ys)}")
    text = (
        "Repaired level grid:\n" + ascii_grid(rows)
        + "\n\nEntities: " + "; ".join(ents)
        + "\nSurfaces: " + "; ".join(plats)
        + f"\nSolver: solvable={ev['solvable']}. Reachable standing cells: {reachable_summary(reach)}"
        + "\n\nThe original drawing is attached for intent. Propose the additions."
    )
    rec = call(f"C:{scene}", "C", effort, SYSTEM, [image_block(HERE / "inputs" / scene / "annotated.jpg"), {"type": "text", "text": text}], Enhancement)
    out = {"scene": scene, "effort": effort, "call": rec, "before": ev}
    if not rec.get("parsed"):
        (RESULTS / f"probe_c_{scene}_{effort}.json").write_text(json.dumps(out, indent=1)); return out
    reach_set = {tuple(map(int, r.split(","))) for r in reach}
    g = [list(r) for r in rows]
    extra, checks = [], []
    for a in rec["parsed"]["additions"]:
        op, cells = a["op"], [(c["x"], c["y"]) for c in a["cells"]]
        if op == "add_coin_trail":
            empty = all(0 <= x < W and 0 <= y < H and rows[y][x] == "0" for x, y in cells)
            near = sum(1 for x, y in cells if any(abs(sx - x) <= 3 and 0 <= sy - y <= 4 for sx, sy in reach_set))
            checks.append((op, f"{len(cells)} coins, all in empty cells={empty}, within jump reach={near}/{len(cells)}"))
        elif op == "add_enemy":
            x, y = cells[0]; dx = a.get("patrol_dx") or 0
            span = all(standable(rows, xx, y) for xx in range(min(x, x + dx), max(x, x + dx) + 1))
            checks.append((op, f"feet {cells[0]} patrol {dx}: on surface={standable(rows, x, y)}, whole patrol on surface={span}, reachable surface={(x, y) in reach_set}"))
        elif op == "add_checkpoint":
            x, y = cells[0]
            checks.append((op, f"{cells[0]} standable={standable(rows, x, y)} reachable={(x, y) in reach_set}"))
        elif op == "add_spike_strip":
            r, x0, x1 = a["row"], a["x0"], a["x1"]
            ok = all(0 <= x < W and rows[r][x] == "0" and rows[r + 1][x] == "1" for x in range(x0, x1 + 1))
            for x in range(x0, x1 + 1):
                if 0 <= x < W and 0 <= r < H:
                    g[r][x] = "2"
            checks.append((op, f"row {r} x{x0}..{x1}: on top of solid & empty={ok}"))
        elif op == "add_bounce_pad":
            x, y = cells[0]
            ok = 0 <= x < W and 0 <= y < H and rows[y][x] == "1"
            extra.append({"id": f"bp{x}_{y}", "type": "bounce_pad", "bbox": [x, y, x, y], "strength": 1.0})
            checks.append((op, f"{cells[0]} on solid={ok}"))
        elif op == "make_crumble":
            c = st.comps.get(a.get("component_id"))
            checks.append((op, f"#{a.get('component_id')} role={c and c['role']} (solver cannot model crumble; treated as solid)"))
    new_rows = ["".join(r) for r in g]
    door_open = st.rows(door_open=True)
    g2 = [list(r) for r in door_open]
    for y in range(H):
        for x in range(W):
            if new_rows[y][x] == "2":
                g2[y][x] = "2"
    after = solve_levels([make_level(scene + ":after", ["".join(r) for r in g2], ev["start"], ev["goal"], extra)])[0]
    out.update(checks=checks, after_solvable=after["solvable"], after_reachable=len(after["reachable"]), grid_after=new_rows)
    print("before:", ev)
    for a, c in zip(rec["parsed"]["additions"], checks):
        print(f"  {c[0]}: {c[1]}\n      <- {a['reason']}")
    print("difficulty", rec["parsed"]["difficulty_before"], "->", rec["parsed"]["difficulty_after"], "| still solvable:", after["solvable"])
    print("pitch:", rec["parsed"]["pitch_to_kid"])
    print(ascii_grid(new_rows))
    (RESULTS / f"probe_c_{scene}_{effort}.json").write_text(json.dumps(out, indent=1, default=list))
    return out


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2])
