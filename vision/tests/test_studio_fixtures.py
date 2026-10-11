"""Shared GameDocs for the Studio tests (docs/v6/CONTRACTS_V6.md)."""
from __future__ import annotations

import copy
import math
from typing import Any


def _circle(r: float, cx: float = 0, cy: float = 0, n: int = 16) -> list[list[float]]:
    return [[round(cx + r * math.cos(2 * math.pi * i / n), 1), round(cy + r * math.sin(2 * math.pi * i / n), 1)]
            for i in range(n)]


def _box(w: float, h: float) -> list[list[float]]:
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]]


def obj(oid: str, x: float, y: float, strokes: list[dict[str, Any]], w: float, h: float, **over: Any) -> dict[str, Any]:
    return {"id": oid, "x": x, "y": y, "drawing": {"strokes": strokes, "w": w, "h": h}, **over}


HILL = obj("o1", 800, 760, [{"points": [[-700, 40], [-300, -30], [0, 20], [300, -60], [700, 30]], "color": "#3bb273",
                             "width": 8}], 1400, 100)
BOX = obj("o2", 600, 500, [{"points": _box(160, 70), "color": "#d7263d", "width": 6, "closed": True}], 160, 70)
WHEEL_A = obj("o3", 550, 560, [{"points": _circle(25), "color": "#1f1b18", "width": 6, "closed": True}], 50, 50)
WHEEL_B = obj("o4", 650, 560, [{"points": _circle(25), "color": "#1f1b18", "width": 6, "closed": True}], 50, 50)
BLOB_BLUE = obj("o5", 1100, 400, [{"points": [[-30, 0], [-10, -25], [20, -20], [35, 5], [10, 30], [-25, 20], [-30, 0]],
                                   "color": "#2e86ab", "width": 6}], 65, 55)
BLOB_BLUE2 = obj("o6", 1300, 380, [{"points": [[-30, 0], [-10, -25], [20, -20], [35, 5], [10, 30], [-25, 20]],
                                    "color": "#1e5aa8", "width": 6}], 65, 55)
GUY = obj("o7", 300, 600, [{"points": [[0, -40], [0, 20], [-15, 45], [0, 20], [15, 45]], "color": "#1f1b18", "width": 6},
                           {"points": _circle(12, 0, -52), "color": "#1f1b18", "width": 6, "closed": True}], 40, 110)


def doc(objects: list[dict[str, Any]] | None = None, **over: Any) -> dict[str, Any]:
    d = {"format": "drawplay-studio", "version": 1, "id": "g_test", "title": "Untitled game",
         "scenes": [{"id": "s1", "name": "Level 1", "objects": copy.deepcopy(objects or [])}]}
    d.update(over)
    from app.spec.studio import GameDoc

    return GameDoc.model_validate(d).model_dump(mode="json", by_alias=True)


def car_scene() -> dict[str, Any]:
    return doc([HILL, BOX, WHEEL_A, WHEEL_B])
