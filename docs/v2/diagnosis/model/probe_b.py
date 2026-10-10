"""Probe B - REPAIR PLANNING. Scene graph (from Probe A, medium) + role-aware grid + solver facts ->
fixed-vocabulary edits. The edits are applied by builder.py and re-validated with the v1 solver.

Usage (inside vision/ env): python probe_b.py <scene> <effort>
Writes results/probe_b_<scene>_<effort>.json
"""
from __future__ import annotations

import json
import sys
from typing import Literal

from pydantic import BaseModel

from builder import State, evaluate, graph_from_call, load_scene, reachable_summary
from common import HERE, RESULTS, ascii_grid, call, image_block

Op = Literal["snap_to_surface", "orient", "straighten", "merge", "close_gap", "move_goal_to_ground",
             "clear_spawn", "nudge", "reclassify"]
Role = Literal["ground", "platform", "wall", "ceiling", "spike_strip", "enemy", "decoration", "text", "arrow",
               "goal", "coin", "key", "door", "character", "unknown"]


class Edit(BaseModel):
    op: Op
    component_id: int | None
    target_id: int | None
    dx: int | None
    dy: int | None
    row: int | None
    x0: int | None
    x1: int | None
    direction: Literal["up", "down", "left", "right"] | None
    new_role: Role | None
    reason: str
    confidence: float


class RepairPlan(BaseModel):
    edits: list[Edit]
    left_alone: list[str]
    summary_for_kid: str


SYSTEM = """\
You are the repair stage of a level-design assistant for a kids' draw-a-platformer game. A child drew a level;
perception has labeled every ink component. Your job: propose the SMALLEST set of edits that makes the level play
the way the child obviously meant, without redesigning it. Every edit must be explainable to the child in one
sentence. Preserve intent: never delete or move something just to make the level easier; never remove hazards or
enemies; don't "fix" things that already work.

Grid: 48 x 27 cells, x right, y DOWN. '#' solid, '^' hazard, '.' empty. The player is 1 cell wide and 2 cells tall
and stands on top of a solid cell (its feet cell is the row just above the surface).
Physics (measured, exact): the player can jump UP at most 3 cells (a ledge whose top is 3 rows above the
surface the player stands on is reachable; 4 is not) and ACROSS a gap of at most 6 empty cells on the flat. A
1-cell-wide hole in a floor swallows the player.

Edit vocabulary (deterministic code applies these; fill only the fields the op uses, null the rest):
- reclassify {component_id, new_role}: e.g. words/arrows/decoration -> text/arrow/decoration (no collision),
  a misread wall -> door, etc. Only roles ground/platform/wall/ceiling/door collide; spike_strip is a hazard.
- snap_to_surface {component_id, target_id}: move spikes/enemy/object vertically (or sideways for wall spikes) so
  it touches the surface it was meant to rest on / hang from.
- orient {component_id, direction}: which way spikes point.
- straighten {component_id, row}: replace a wobbly line by a straight horizontal line on that row (same x span).
- merge {component_id, target_id, row}: join two pieces of one floor/platform, filling the gap on that row.
- close_gap {row, x0, x1}: add solid cells from x0 to x1 on that row (accidental pen-lift holes only).
- move_goal_to_ground {target_id, x0}: put the goal standing on surface target_id at column x0.
- clear_spawn {x0, row}: put the player start at (x0, row) (the feet cell) and clear hazards near it.
- nudge {component_id, dx, dy}: move a component a little (prefer 1-2 cells) to make an impossible jump possible.
List what you deliberately left alone in left_alone. summary_for_kid: one friendly sentence.
"""


def run(scene: str, effort: str) -> dict:
    cv = load_scene(scene)
    graph = graph_from_call("A:" + scene)
    st = State(cv, graph)
    before = evaluate(st, scene)
    reach = before.pop("_reachable")
    rows = st.rows()
    nodes = [{k: n[k] for k in ("id", "role", "rests_on", "attached_to", "points", "part_of", "confidence")} for n in graph["nodes"]]
    comps = {c["id"]: c for c in cv["components"]}
    for n in nodes:
        n["bbox"] = comps[n["id"]]["bbox"]
    facts = (
        f"Start (feet cell): {before['start']}   Goal cell: {before['goal']}\n"
        f"Solver on the grid below: goal reachable = {before['goal_reachable']}"
        + (f", key reachable = {before.get('key_reachable')}" if "key_reachable" in before else "")
        + f"\nReachable standing cells: {reachable_summary(reach)}"
    )
    text = (
        "Scene graph from perception (bbox in cells):\n" + json.dumps(nodes, separators=(",", ":"))
        + "\n\nCreator intent (perception's guess): " + graph["creator_intent"]
        + "\n\nGrid as built from the scene graph (text/arrows/decoration already removed, enemies/coins/goal not drawn):\n"
        + ascii_grid(rows) + "\n\n" + facts + "\n\nPropose the repair plan."
    )
    rec = call(f"B:{scene}", "B", effort, SYSTEM, [image_block(HERE / "inputs" / scene / "annotated.jpg"), {"type": "text", "text": text}], RepairPlan)
    out = {"scene": scene, "effort": effort, "call": rec, "before": before}
    if rec.get("parsed"):
        log = [st.apply(e) for e in rec["parsed"]["edits"]]
        after = evaluate(st, scene)
        after.pop("_reachable")
        out.update(applied=log, after=after, grid_after=st.rows(door_open=False))
        print("before:", before)
        for e, l in zip(rec["parsed"]["edits"], log):
            print(f"  [{e['confidence']:.2f}] {l}   <- {e['reason']}")
        print("left alone:", rec["parsed"]["left_alone"])
        print("kid:", rec["parsed"]["summary_for_kid"])
        print("after:", after)
        print(ascii_grid(out["grid_after"]))
    (RESULTS / f"probe_b_{scene}_{effort}.json").write_text(json.dumps(out, indent=1, default=list))
    return out


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2])
