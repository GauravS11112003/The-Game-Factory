"""Deterministic role-aware level builder + fixed-vocabulary edit applier (no API calls).

This is a throwaway stand-in for what v2's "mind" would do in code: the model proposes roles and
edits, this code applies them, and the real v1 solver validates the result.

Roles -> tiles: ground/platform/wall/ceiling/door -> solid '1'; spike_strip -> hazard '2';
everything else (enemy, text, arrow, decoration, coin, key, goal, character, unknown) -> no tiles.
"""
from __future__ import annotations

import copy
import json
from collections import Counter
from pathlib import Path

from common import CALLS, H, HERE, W, default_start, empty_grid, make_level, rows_of, solve_levels

SOLID = {"ground", "platform", "wall", "ceiling", "door"}
HAZARD = {"spike_strip"}


def load_scene(scene: str) -> dict:
    return json.loads((HERE / "inputs" / scene / "cv.json").read_text())


def graph_from_call(name: str, effort: str = "medium") -> dict:
    for line in CALLS.read_text().splitlines():
        r = json.loads(line)
        if r["name"] == name and r["effort"] == effort and r.get("parsed"):
            return r["parsed"]
    raise KeyError(name)


class State:
    def __init__(self, cv: dict, graph: dict):
        roles = {n["id"]: n for n in graph["nodes"]}
        self.comps: dict[int, dict] = {}
        for c in cv["components"]:
            n = roles.get(c["id"], {})
            self.comps[c["id"]] = {
                "id": c["id"], "color": c["color"], "cells": {tuple(x) for x in c["cells"]},
                "role": n.get("role", "unknown"), "points": n.get("points", "none"),
            }
        self.extra_solid: set[tuple[int, int]] = set()
        g = [c for c in self.comps.values() if c["role"] == "goal"]
        self.goal = tuple(cv["goal"]) if not g else self._bottom_center(max(g, key=lambda c: len(c["cells"])))
        self.start_override: tuple[int, int] | None = None
        self.log: list[str] = []

    @staticmethod
    def _bottom_center(c: dict) -> tuple[int, int]:
        xs = sorted(x for x, _ in c["cells"])
        return (xs[len(xs) // 2], max(y for _, y in c["cells"]))

    # ---------------------------------------------------------------------- build
    def rows(self, door_open: bool = False) -> list[str]:
        g = empty_grid()
        for c in self.comps.values():
            if c["role"] == "door" and door_open:
                continue
            ch = "1" if c["role"] in SOLID else "2" if c["role"] in HAZARD else None
            if ch:
                for x, y in c["cells"]:
                    if 0 <= x < W and 0 <= y < H and not (ch == "1" and g[y][x] == "2"):
                        g[y][x] = ch
        for x, y in self.extra_solid:
            if 0 <= x < W and 0 <= y < H and g[y][x] == "0":
                g[y][x] = "1"
        return rows_of(g)

    def start(self, rows: list[str]) -> tuple[int, int] | None:
        return self.start_override or default_start(rows)

    def key_cell(self) -> tuple[int, int] | None:
        k = [c for c in self.comps.values() if c["role"] == "key"]
        return self._bottom_center(k[0]) if k else None

    # ---------------------------------------------------------------------- edits
    def _top_row(self, cid: int, xs: set[int]) -> int | None:
        ys = [y for x, y in self.comps[cid]["cells"] if x in xs]
        return min(ys) if ys else None

    def _shift(self, cid: int, dx: int, dy: int) -> None:
        c = self.comps[cid]
        c["cells"] = {(x + dx, y + dy) for x, y in c["cells"]}

    def apply(self, e: dict) -> str:
        op, cid, tid = e["op"], e.get("component_id"), e.get("target_id")
        try:
            if op == "reclassify":
                old = self.comps[cid]["role"]; self.comps[cid]["role"] = e["new_role"]
                return f"reclassify #{cid} {old}->{e['new_role']}"
            if op == "orient":
                self.comps[cid]["points"] = e["direction"]; return f"orient #{cid} {e['direction']} (render only)"
            if op == "snap_to_surface":
                # v2-style semantics: the face is chosen from the component's orientation
                # (points up -> sits on top, down -> hangs below, left -> on the target's left face,
                # right -> on its right face). The first version of this probe guessed the face from
                # overlap and mis-applied 2 of 6 high-effort edits (see model.md).
                c, t = self.comps[cid], self.comps[tid]
                cx0, cx1 = min(x for x, _ in c["cells"]), max(x for x, _ in c["cells"])
                cy0, cy1 = min(y for _, y in c["cells"]), max(y for _, y in c["cells"])
                face = {"up": "top", "down": "bottom", "left": "left", "right": "right"}.get(c.get("points", "none"))
                if face is None:
                    face = "top" if cy1 <= min(y for _, y in t["cells"]) else "bottom"
                if face in ("top", "bottom"):
                    ys = [y for x, y in t["cells"] if cx0 <= x <= cx1] or [y for _, y in t["cells"]]
                    dy = (min(ys) - 1 - cy1) if face == "top" else (max(ys) + 1 - cy0)
                    self._shift(cid, 0, dy); return f"snap #{cid} to {face} of #{tid}: dy={dy}"
                xs = [x for x, y in t["cells"] if cy0 <= y <= cy1] or [x for x, _ in t["cells"]]
                dx = (min(xs) - 1 - cx1) if face == "left" else (max(xs) + 1 - cx0)
                self._shift(cid, dx, 0); return f"snap #{cid} to {face} face of #{tid}: dx={dx}"
            if op == "straighten":
                c = self.comps[cid]
                ys = Counter(y for _, y in c["cells"])
                row = e.get("row") if e.get("row") is not None else ys.most_common(1)[0][0]
                xs = [x for x, _ in c["cells"]]
                c["cells"] = {(x, row) for x in range(min(xs), max(xs) + 1)}
                return f"straighten #{cid} -> row {row} x{min(xs)}..{max(xs)}"
            if op in ("merge", "close_gap"):
                if op == "merge" and cid is not None and tid is not None:
                    a, b = self.comps[cid], self.comps[tid]
                    row = e.get("row") if e.get("row") is not None else Counter(y for _, y in a["cells"]).most_common(1)[0][0]
                    ax1 = max(x for x, _ in a["cells"]); bx0 = min(x for x, _ in b["cells"])
                    if ax1 > bx0:
                        ax1, bx0 = max(x for x, _ in b["cells"]), min(x for x, _ in a["cells"])
                    fill = {(x, row) for x in range(ax1 + 1, bx0)}
                    a["cells"] |= b["cells"] | fill; b["cells"] = set(); b["role"] = "merged"
                    return f"merge #{tid} into #{cid}, filled {len(fill)} cells on row {row}"
                row, x0, x1 = e["row"], e["x0"], e["x1"]
                fill = {(x, row) for x in range(min(x0, x1), max(x0, x1) + 1)}
                self.extra_solid |= fill
                return f"close_gap row {row} x{x0}..{x1} ({len(fill)} cells)"
            if op == "move_goal_to_ground":
                rows = self.rows()
                x = e.get("x0") if e.get("x0") is not None else self.goal[0]
                if tid is not None:
                    top = self._top_row(tid, {x})
                    if top is None:
                        txs = sorted(x for x, _ in self.comps[tid]["cells"]); x = txs[-2] if len(txs) > 1 else txs[0]
                        top = self._top_row(tid, {x})
                else:
                    top = next((y for y in range(self.goal[1] + 1, H) if rows[y][x] == "1"), None)
                if top is None:
                    return "move_goal_to_ground: no surface found (no-op)"
                old = self.goal; self.goal = (x, top - 1)
                for c in self.comps.values():
                    if c["role"] == "goal":
                        c["cells"] = {(x, top - 1)}
                return f"goal {old} -> {self.goal}"
            if op == "clear_spawn":
                if e.get("x0") is not None and e.get("row") is not None:
                    self.start_override = (e["x0"], e["row"])
                rows = self.rows(); s = self.start(rows)
                removed = 0
                for c in self.comps.values():
                    if c["role"] in HAZARD:
                        keep = {(x, y) for x, y in c["cells"] if abs(x - s[0]) > 2 or abs(y - s[1]) > 2}
                        removed += len(c["cells"]) - len(keep); c["cells"] = keep
                return f"clear_spawn around {s}: removed {removed} hazard cells"
            if op == "nudge":
                self._shift(cid, e.get("dx") or 0, e.get("dy") or 0)
                if self.comps[cid]["role"] == "goal":
                    self.goal = (self.goal[0] + (e.get("dx") or 0), self.goal[1] + (e.get("dy") or 0))
                return f"nudge #{cid} by ({e.get('dx') or 0},{e.get('dy') or 0})"
        except (KeyError, TypeError, ValueError, IndexError) as exc:
            return f"REJECTED {op}: {type(exc).__name__} {exc}"
        return f"REJECTED unknown op {op}"


def evaluate(state: State, name: str) -> dict:
    """Solve with the door open (goal) and with it closed (key); returns a summary."""
    rows_open, rows_closed = state.rows(door_open=True), state.rows(door_open=False)
    s = state.start(rows_closed)
    levels = [make_level(name + ":goal", rows_open, s, state.goal)]
    k = state.key_cell()
    if k:
        levels.append(make_level(name + ":key", rows_closed, s, k))
        levels.append(make_level(name + ":goal_door_closed", rows_closed, s, state.goal))
    res = {r["name"].split(":")[-1]: r for r in solve_levels(levels)}
    out = {"start": s, "goal": state.goal, "goal_reachable": res["goal"]["solvable"], "reachable_cells": len(res["goal"]["reachable"])}
    if k:
        out.update(key_reachable=res["key"]["solvable"], door_gates_goal=not res["goal_door_closed"]["solvable"])
        out["solvable"] = out["goal_reachable"] and out["key_reachable"]
    else:
        out["solvable"] = out["goal_reachable"]
    out["_reachable"] = res["goal"]["reachable"]
    return out


def reachable_summary(cells: list[str]) -> str:
    by_row: dict[int, list[int]] = {}
    for c in cells:
        x, y = map(int, c.split(","))
        by_row.setdefault(y, []).append(x)
    parts = []
    for y in sorted(by_row):
        xs = sorted(by_row[y]); runs = []; a = b = xs[0]
        for x in xs[1:]:
            if x == b + 1:
                b = x
            else:
                runs.append((a, b)); a = b = x
        runs.append((a, b))
        parts.append(f"row {y}: " + ", ".join(f"{a}" if a == b else f"{a}-{b}" for a, b in runs))
    return "; ".join(parts) if parts else "(none)"
