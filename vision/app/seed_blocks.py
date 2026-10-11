"""Starter blocks for the public library (docs/v4/CONTRACTS_V4.md §5): a handful of objects and rule packs by the
draw.play team, so the Blocks library is never empty and every v4 primitive has an example to remix.

Idempotent: a block id that already exists is left alone. Art is drawn here as simple ink strokes (cells), the same
shape a kid's drawing has after the canvas, so thumbnails, stamps and the legend treat them like any other block.
"""
from __future__ import annotations

import logging
import math
from typing import Any

from pydantic import ValidationError

from app import db_v2
from app.spec.blocks import Block

log = logging.getLogger(__name__)

TEAM = "draw.play team"
CREATED = "2026-10-10T00:00:00Z"


def _line(pts: list[tuple[float, float]], color: str, w: float = 0.22, closed: bool = False) -> dict[str, Any]:
    return {"color": color, "kind": "line", "pts": [[round(x, 3), round(y, 3)] for x, y in pts], "w": [w],
            "closed": closed, "sheet": 0, "origin": "kid"}


def _circle(cx: float, cy: float, r: float, n: int = 18) -> list[tuple[float, float]]:
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def _star(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    pts = []
    for i in range(10):
        a = -math.pi / 2 + i * math.pi / 5
        rr = r if i % 2 == 0 else r * 0.45
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts


def _spiral(cx: float, cy: float, r: float) -> list[tuple[float, float]]:
    return [(cx + (r * t / 30) * math.cos(t * 0.55), cy + (r * t / 30) * math.sin(t * 0.55)) for t in range(31)]


def _art(strokes: list[dict[str, Any]], size: tuple[float, float]) -> dict[str, Any]:
    return {"strokes": [{"id": f"s{i + 1}", **s} for i, s in enumerate(strokes)], "size_cells": list(size)}


def _rule(rid: str, when: dict[str, Any], then: list[dict[str, Any]]) -> dict[str, Any]:
    return {"id": rid, "when": when, "then": then, "once": False}


def _blocks() -> list[dict[str, Any]]:
    cloud = [(0.3, 1.6), (0.4, 0.9), (1.1, 0.6), (1.6, 0.1), (2.4, 0.2), (2.9, 0.7), (3.6, 0.8), (3.8, 1.5), (3.3, 1.9), (0.8, 1.9)]
    heart = [(1.0, 1.8), (0.25, 1.0), (0.2, 0.5), (0.55, 0.2), (1.0, 0.5), (1.45, 0.2), (1.8, 0.5), (1.75, 1.0)]
    out: list[dict[str, Any]] = [
        {"id": "blk_bouncy01", "name": "Bouncy cloud", "kind": "platform", "collision": "one_way",
         "behavior": {"kind": "spring", "dir": "up", "strength": 1.3},
         "art": _art([_line(cloud, "black", closed=True)], (4, 2)),
         "description": "A soft cloud. Land on it and it throws you up high.", "tags": ["platform", "bounce"]},
        {"id": "blk_speedst1", "name": "Speed star", "kind": "pickup", "collision": "none",
         "behavior": {"kind": "pickup", "item": "star", "effect": "speed", "seconds": 5},
         "art": _art([_line(_star(1, 1, 0.9), "blue", closed=True)], (2, 2)),
         "description": "Grab it to run twice as fast for five seconds.", "tags": ["power up", "speed"]},
        {"id": "blk_jumpmsh1", "name": "Jump mushroom", "kind": "pickup", "collision": "none",
         "behavior": {"kind": "pickup", "item": "mushroom", "effect": "jump", "seconds": 6},
         "art": _art([_line([(0.2, 1.0), (0.4, 0.4), (1.0, 0.1), (1.6, 0.4), (1.8, 1.0)], "blue", closed=True),
                      _line([(0.7, 1.0), (0.7, 1.8), (1.3, 1.8), (1.3, 1.0)], "blue")], (2, 2)),
         "description": "Eat it and your jumps go much higher for a while.", "tags": ["power up", "jump"]},
        {"id": "blk_gravgem1", "name": "Gravity gem", "kind": "pickup", "collision": "none",
         "behavior": {"kind": "pickup", "item": "gem", "effect": "flip", "seconds": None},
         "art": _art([_line([(1, 0.1), (1.8, 1), (1, 1.9), (0.2, 1)], "blue", closed=True),
                      _line([(1, 0.5), (1, 1.5)], "pencil")], (2, 2)),
         "description": "Touch it and up becomes down. Walk on the ceiling!", "tags": ["power up", "gravity"]},
        {"id": "blk_heart001", "name": "Extra heart", "kind": "pickup", "collision": "none",
         "behavior": {"kind": "pickup", "item": "heart", "effect": "heart", "seconds": None, "respawn_s": 20},
         "art": _art([_line(heart, "red", closed=True)], (2, 2)),
         "description": "Gives back one heart. It grows back after a while.", "tags": ["power up", "health"]},
        {"id": "blk_portal01", "name": "Portal", "kind": "prop", "collision": "none",
         "behavior": {"kind": "portal", "pair": "a"},
         "art": _art([_line(_circle(1, 1, 0.95), "pencil", closed=True), _line(_spiral(1, 1, 0.75), "pencil")], (2, 2)),
         "description": "Draw two of these. Step in one and pop out of the other.", "tags": ["portal", "travel"]},
        {"id": "blk_windup01", "name": "Wind tunnel", "kind": "prop", "collision": "none",
         "behavior": {"kind": "zone", "effect": "wind", "dir": "up", "strength": 1.2},
         "art": _art([_line([(0.5 + 0.15 * math.sin(y * 2), 3.8 - y) for y in [i * 0.25 for i in range(15)]], "pencil"),
                      _line([(1.5 + 0.15 * math.sin(y * 2 + 1), 3.8 - y) for y in [i * 0.25 for i in range(15)]], "pencil"),
                      _line([(2.5 + 0.15 * math.sin(y * 2 + 2), 3.8 - y) for y in [i * 0.25 for i in range(15)]], "pencil")], (3, 4)),
         "description": "A gust that pushes you up. Float over big gaps.", "tags": ["zone", "wind"]},
        {"id": "blk_waterp01", "name": "Water pool", "kind": "prop", "collision": "none",
         "behavior": {"kind": "zone", "effect": "water", "dir": "up", "strength": 1.0},
         "art": _art([_line([(x * 0.25, 0.4 + 0.15 * math.sin(x * 1.2)) for x in range(25)], "blue"),
                      _line([(x * 0.25, 1.4 + 0.15 * math.sin(x * 1.2 + 1)) for x in range(25)], "blue")], (6, 2)),
         "description": "Swim! You sink slowly and jump to paddle up.", "tags": ["zone", "water"]},
        {"id": "blk_icefloo1", "name": "Ice floor", "kind": "prop", "collision": "none",
         "behavior": {"kind": "zone", "effect": "ice", "dir": "right", "strength": 1.0},
         "art": _art([_line([(0, 0.8), (6, 0.8)], "blue"), _line([(0.5, 0.3), (1.1, 0.6)], "blue"),
                      _line([(2.6, 0.3), (3.2, 0.6)], "blue"), _line([(4.7, 0.3), (5.3, 0.6)], "blue")], (6, 1)),
         "description": "Slippery! You slide when you try to stop.", "tags": ["zone", "ice"]},
        {"id": "blk_crumbl01", "name": "Crumble bridge", "kind": "platform", "collision": "one_way",
         "behavior": {"kind": "crumble", "delay_s": 0.5, "respawn_s": 3.0},
         "art": _art([_line([(0, 0.5), (1.3, 0.5)], "black"), _line([(1.6, 0.5), (2.9, 0.5)], "black"),
                      _line([(3.2, 0.5), (4.5, 0.5)], "black"), _line([(4.8, 0.5), (6, 0.5)], "black")], (6, 1)),
         "description": "Falls apart a moment after you step on it. Keep moving.", "tags": ["platform", "crumble"]},
        {"id": "blk_liftpl01", "name": "Sky lift", "kind": "platform", "collision": "one_way",
         "behavior": {"kind": "move", "dir": "up", "cells": 6, "speed": 2.5, "mode": "pingpong", "wait_s": 0.6},
         "art": _art([_line([(0, 0.4), (4, 0.4)], "black", w=0.45), _line([(2, 0.4), (2, -0.8)], "pencil")], (4, 1)),
         "description": "A platform that rides up and down like an elevator.", "tags": ["platform", "moving"]},
        {"id": "blk_hopslm01", "name": "Hop slime", "kind": "creature", "collision": "none",
         "behavior": {"kind": "enemy", "archetype": "hopper", "spiky": False, "params": {"interval": 1.2, "forward": True}},
         "art": _art([_line([(0.1, 1.9), (0.3, 0.9), (1.0, 0.3), (1.7, 0.9), (1.9, 1.9)], "red", closed=True),
                      _line([(0.7, 1.0), (0.75, 1.05)], "red", w=0.25), _line([(1.25, 1.0), (1.3, 1.05)], "red", w=0.25)], (2, 2)),
         "description": "A slime that hops toward you. Stomp it!", "tags": ["creature", "hopper"]},
        {"id": "blk_spinsaw1", "name": "Spin saw", "kind": "hazard", "collision": "none",
         "behavior": {"kind": "saw", "radius": 1.0, "dir": "right", "cells": 5, "speed": 3.0},
         "art": _art([_line(_star(1, 1, 0.95)[::1] + _star(1, 1, 0.95)[:1], "red", closed=True),
                      _line(_circle(1, 1, 0.3, 10), "red", closed=True)], (2, 2)),
         "description": "A spinning blade that rolls back and forth. Jump over it.", "tags": ["hazard", "saw"]},
        {"id": "blk_shopkp01", "name": "Friendly guide", "kind": "prop", "collision": "none",
         "behavior": {"kind": "npc", "name": "Pip", "lines": [
             "Hi! I'm Pip.", "The stars make you fast.", "Press space to flip up and down!"]},
         "art": _art([_line(_circle(1, 0.7, 0.55), "black", closed=True), _line([(1, 1.25), (1, 2.6)], "black"),
                      _line([(0.4, 1.8), (1.6, 1.8)], "black"), _line([(1, 2.6), (0.5, 3.4)], "black"),
                      _line([(1, 2.6), (1.5, 3.4)], "black")], (2, 3.5)),
         "description": "A helper who talks when you touch them. Write their lines.", "tags": ["character", "story"]},
        {"id": "blk_flippk01", "name": "Gravity flip pack", "kind": "rules", "collision": "none",
         "logic": [_rule("flip", {"kind": "key", "key": "space"}, [{"kind": "flip_gravity"}, {"kind": "sound", "name": "whoosh"}])],
         "description": "Press space to flip gravity. Walk on the ceiling to dodge spikes.", "tags": ["rules", "gravity"]},
        {"id": "blk_coinrun1", "name": "Collect them all", "kind": "rules", "collision": "none",
         "logic": [_rule("allcoins", {"kind": "all_coins"}, [{"kind": "say", "text": "You got every coin!", "seconds": 2},
                                                              {"kind": "win"}])],
         "description": "Grab every coin to win. No flag needed.", "tags": ["rules", "coins"]},
        {"id": "blk_moonjp01", "name": "Moon jumps", "kind": "rules", "collision": "none",
         "logic": [_rule("moon", {"kind": "start"}, [{"kind": "gravity", "times": 0.5}])],
         "description": "Low gravity all the time. Every jump floats.", "tags": ["rules", "gravity"]},
        {"id": "blk_hurryup1", "name": "Hurry up", "kind": "rules", "collision": "none",
         "logic": [_rule("hurry", {"kind": "timer", "seconds": 45}, [{"kind": "say", "text": "Too slow!", "seconds": 2}, {"kind": "lose"}]),
                   _rule("tick", {"kind": "timer", "seconds": 35}, [{"kind": "say", "text": "Ten seconds left!", "seconds": 2},
                                                                    {"kind": "shake"}])],
         "description": "Finish in 45 seconds or start over. A warning comes at 35.", "tags": ["rules", "timer"]},
    ]
    return out


def seed_blocks() -> int:
    """Insert every starter block that is not there yet. Returns how many were added."""
    added = 0
    for raw in _blocks():
        try:
            if db_v2.get_block(raw["id"]) is not None:
                continue
            doc = {"version": 1, "spiky": False, "symbol": None, "logic": [], "tags": [], "author": TEAM, "author_id": None,
                   "parent": None, "created_at": CREATED, **raw}
            Block.model_validate(doc)
            db_v2.insert_block(doc, listed=True, safety="ok")
            added += 1
        except ValidationError:
            log.exception("starter block %s is invalid", raw.get("id"))
        except Exception:  # noqa: BLE001 - seeds never stop the app
            log.exception("starter block %s failed", raw.get("id"))
    return added
