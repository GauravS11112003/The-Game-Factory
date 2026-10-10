#!/usr/bin/env python3
"""Generate the three Starter World fixture levels into shared/fixtures/levels/.

Plain Python, no dependencies. Run from anywhere:

    python3 shared/fixtures/make_levels.py

Conventions (PLAN.md sections 2 and 3): grid 48x27, y=26 is the bottom row,
rows 25-26 are the floor except in pits. Entity x/y are the standing cell
(the bottom cell of the 2-tall player body); bbox is [x0, y0, x1, y1]
inclusive; a moving_platform path lists bbox top-left positions.

Physics limits respected everywhere: no jump over a gap wider than 6 cells
and no jump up a wall taller than 3 cells (max jump height ~3.8 cells,
flat jump distance ~7.3 cells).
"""
from __future__ import annotations

import json
from pathlib import Path

W, H = 48, 27
OUT_DIR = Path(__file__).resolve().parent / "levels"
CREATED_AT = "2026-10-09T00:00:00Z"
AUTHOR = "team"
GAME_ID = "game_starter"


class GridBuilder:
    def __init__(self) -> None:
        self.cells = [["0"] * W for _ in range(H)]

    def fill(self, x0: int, y0: int, x1: int, y1: int, ch: str) -> None:
        """Set every cell in the inclusive box [x0,y0]..[x1,y1] to ch."""
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.cells[y][x] = ch

    def floor(self, x0: int, x1: int) -> None:
        self.fill(x0, 25, x1, 26, "1")

    def pit(self, x0: int, x1: int) -> None:
        """A pit through the floor with hazard at the bottom row."""
        self.fill(x0, 25, x1, 25, "0")
        self.fill(x0, 26, x1, 26, "2")

    def rows(self) -> list[str]:
        return ["".join(r) for r in self.cells]


def point(eid: str, etype: str, x: int, y: int, **extra: object) -> dict:
    ent: dict = {"id": eid, "type": etype, "x": x, "y": y}
    ent.update(extra)
    return ent


def level(lid: str, title: str, rows: list[str], entities: list[dict], rules: list[dict], order_index: int) -> dict:
    return {
        "schema_version": 1,
        "id": lid,
        "game_id": GAME_ID,
        "parent_id": None,
        "order_index": order_index,
        "title": title,
        "author": AUTHOR,
        "created_at": CREATED_AT,
        "source": {"kind": "fixture", "photo_url": None, "backdrop_url": None, "template_version": 1},
        "grid": {"w": W, "h": H, "cell": 16, "rows": rows},
        "sprites": {"player": None},
        "components": [],
        "entities": entities,
        "rules": rules,
        "meta": {"solvable": True, "warnings": [], "notes_transcript": ""},
    }


def starter_1() -> dict:
    """Flat ground with small steps, 5 coins, goal at the right. No hazards."""
    g = GridBuilder()
    g.floor(0, 47)
    # A staircase up (1-cell rises) and back down.
    g.fill(10, 24, 13, 24, "1")
    g.fill(14, 23, 17, 24, "1")
    g.fill(18, 22, 21, 24, "1")
    g.fill(22, 23, 25, 24, "1")
    g.fill(26, 24, 29, 24, "1")
    # A floating platform 3 cells above the floor (reachable: 3-cell rise).
    g.fill(34, 22, 38, 22, "1")
    entities = [
        point("start", "player_start", 2, 24),
        point("goal", "goal", 45, 24),
        point("c1", "coin", 6, 23),
        point("c2", "coin", 12, 22),
        point("c3", "coin", 20, 20),
        point("c4", "coin", 36, 20),
        point("c5", "coin", 42, 23),
    ]
    return level("lvl_starter1", "First Steps", g.rows(), entities, [], 0)


def starter_2() -> dict:
    """Pits with hazards (gaps <= 5), a moving platform over a 7-cell gap,
    a bounce pad under a high ledge that holds the goal."""
    g = GridBuilder()
    g.floor(0, 47)
    g.pit(10, 13)  # 4 wide
    g.pit(22, 26)  # 5 wide
    # 7-wide gap crossed by the moving platform; the platform owns row 25 here.
    g.pit(31, 37)
    # High ledge: 6 cells above the floor, only reachable via the bounce pad.
    g.fill(43, 19, 47, 19, "1")
    # The bounce pad tiles stay solid (PLAN section 8).
    g.fill(40, 24, 41, 24, "1")
    entities = [
        point("start", "player_start", 2, 24),
        point("goal", "goal", 46, 18),
        point("c1", "coin", 6, 23),
        point("c2", "coin", 12, 22),
        point("c3", "coin", 24, 22),
        point("c4", "coin", 34, 23),
        point("c5", "coin", 45, 17),
        {
            "id": "mp1",
            "type": "moving_platform",
            "component_id": None,
            "bbox": [31, 25, 33, 25],
            "image_url": None,
            "path": [[31, 25], [35, 25]],
            "speed": 2,
        },
        {"id": "bp1", "type": "bounce_pad", "component_id": None, "bbox": [40, 24, 41, 24], "strength": 1.0},
    ]
    return level("lvl_starter2", "Spike Valley", g.rows(), entities, [], 1)


def starter_3() -> dict:
    """A key, a door blocking the goal, a patrolling enemy on a long platform,
    a checkpoint mid-level, rule collect:key -> open:door."""
    g = GridBuilder()
    g.floor(0, 47)
    # Cave ceiling for the look; never in the way.
    g.fill(0, 0, 47, 0, "1")
    # Long platform 3 cells above the floor; the enemy patrols on it.
    g.fill(10, 22, 24, 22, "1")
    # High alcove holding the key (3-cell rise from the platform, 2-cell gap).
    g.fill(27, 19, 29, 19, "1")
    # A hazard pit on the way to the door.
    g.pit(32, 35)  # 4 wide
    # Wall above the door; the door entity owns rows 21-24 at x=40.
    g.fill(40, 1, 40, 20, "1")
    entities = [
        point("start", "player_start", 2, 24),
        point("goal", "goal", 45, 24),
        point("c1", "coin", 12, 20),
        point("c2", "coin", 20, 20),
        point("c3", "coin", 33, 22),
        point("c4", "coin", 44, 23),
        {
            "id": "en1",
            "type": "enemy",
            "component_id": None,
            "bbox": [14, 20, 15, 21],
            "image_url": None,
            "patrol": {"dx": 6, "speed": 3},
        },
        point("key1", "key", 28, 17, opens="door1"),
        point("cp1", "checkpoint", 30, 24),
        {"id": "door1", "type": "door", "component_id": None, "bbox": [40, 21, 40, 24], "image_url": None},
    ]
    rules = [{"when": "collect:key1", "then": "open:door1"}]
    return level("lvl_starter3", "Key Cave", g.rows(), entities, rules, 2)


def check(lvl: dict) -> None:
    """Cheap invariants so a bad edit fails here, not in the engine."""
    rows = lvl["grid"]["rows"]
    assert len(rows) == H and all(len(r) == W for r in rows), lvl["id"]
    assert all(set(r) <= set("012") for r in rows), lvl["id"]
    ids = [e["id"] for e in lvl["entities"]]
    assert len(ids) == len(set(ids)), f"duplicate entity id in {lvl['id']}"
    for e in lvl["entities"]:
        if e["type"] in ("moving_platform", "enemy", "door"):
            x0, y0, x1, y1 = e["bbox"]
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    assert rows[y][x] == "0", f"{lvl['id']}: {e['id']} cell ({x},{y}) must be 0"
        if e["type"] == "bounce_pad":
            x0, y0, x1, y1 = e["bbox"]
            assert all(rows[y][x] == "1" for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)), lvl["id"]
        if "x" in e:
            assert rows[e["y"]][e["x"]] == "0", f"{lvl['id']}: {e['id']} stands in a solid cell"
    for r in lvl["rules"]:
        target = r["then"].split(":", 1)
        if target[0] == "open":
            assert target[1] in ids, f"{lvl['id']}: rule opens unknown entity"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    files = {
        "starter_1_first_steps.json": starter_1(),
        "starter_2_spike_valley.json": starter_2(),
        "starter_3_key_cave.json": starter_3(),
    }
    for name, lvl in files.items():
        check(lvl)
        path = OUT_DIR / name
        path.write_text(json.dumps(lvl, indent=2) + "\n")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
