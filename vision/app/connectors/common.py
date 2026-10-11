"""Shared by the connectors: a game's exportable levels in play order, decoded tiles and entity boxes in cells."""
from __future__ import annotations

import re
import time
import zipfile
from typing import Any

from app import db_v2
from app.spec.level import decode_row

WORLD_H = 27
CELL_PX = 16
STORED = {".png"}


def slug(title: str | None, fallback: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:40].strip("-")
    return s or re.sub(r"[^a-z0-9]+", "-", fallback.lower()).strip("-") or "game"


def game_levels(game_id: str) -> list[dict[str, Any]]:
    """The playable sequence (listed, not held or flagged), in order: [{id, version, title, author, level}]."""
    from app.routers.v2.games import _sequence

    seq, _ = _sequence(db_v2.latest_level_summaries(game_id=game_id, listed_only=True))
    out = []
    for s in seq:
        row = db_v2.get_level_row(s["id"], int(s["version"]))
        if row is None or not isinstance(row.get("level"), dict) or row.get("safety") in ("held", "flag"):
            continue
        lv = row["level"]
        out.append({"id": s["id"], "version": int(s["version"]), "title": str(lv.get("title") or s.get("title") or ""),
                    "author": str(lv.get("author") or s.get("author") or ""), "level": lv})
    return out


def tile_grid(level: dict[str, Any]) -> list[str]:
    """The decoded tile rows, each exactly `w` characters (missing or short rows are empty)."""
    world = level.get("world") or {}
    w = int(world.get("w") or 48 * int(world.get("screens") or 1))
    rows = ((level.get("compiled") or {}).get("tiles") or {}).get("rows") or []
    out = []
    for r in range(WORLD_H):
        try:
            cells = decode_row(rows[r]) if r < len(rows) else ""
        except ValueError:
            cells = ""
        out.append((cells + "." * w)[:w])
    return out


def entity_box(e: dict[str, Any]) -> tuple[float, float, float, float] | None:
    """(x0, y0, w, h) in cells for an entity, by its anchor convention (docs/spec/level-format-v2.md)."""
    t = e.get("type")
    x, y = e.get("x"), e.get("y")
    if t == "spikes":
        x0, x1, fy = float(e.get("x0", 0)), float(e.get("x1", 0)), float(e.get("y", 0))
        return {"up": (x0, fy - 0.5, x1 - x0, 0.5), "down": (x0, fy, x1 - x0, 0.5),
                "left": (fy - 0.5, x0, 0.5, x1 - x0), "right": (fy, x0, 0.5, x1 - x0)}.get(str(e.get("facing")),
                                                                                         (x0, fy - 0.5, x1 - x0, 0.5))
    if t == "goal" and isinstance(e.get("trigger"), (list, tuple)) and len(e["trigger"]) == 4:
        a, b, c, d = (float(v) for v in e["trigger"])
        return a, b, c - a, d - b
    if x is None or y is None:
        return None
    x, y = float(x), float(y)
    if t in ("door", "zone"):
        return x, y, float(e.get("w") or 1), float(e.get("h") or 1)
    if t in ("moving_platform", "crumble", "falling_platform"):
        return x, y, float(e.get("w") or 1), 1.0
    if t in ("player_start", "checkpoint"):
        return x - 0.5, y - 2, 1.0, 2.0
    if t in ("enemy", "npc"):
        w, h = float(e.get("w") or 1), float(e.get("h") or (2 if t == "npc" else 1))
        return x - w / 2, y - h, w, h
    if t == "spring":
        w = float(e.get("w") or 1)
        return x - w / 2, y - 1, w, 1.0
    size = {"saw": 2 * float(e.get("r") or 1), "portal": 1.5, "big_coin": 1.5}.get(str(t), 1.0)
    return x - size / 2, y - size / 2, size, size


def write(z: zipfile.ZipFile, name: str, data: bytes | str) -> None:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    info = zipfile.ZipInfo(name, date_time=time.localtime()[:6])
    info.external_attr = 0o644 << 16
    info.compress_type = zipfile.ZIP_STORED if any(name.endswith(x) for x in STORED) else zipfile.ZIP_DEFLATED
    z.writestr(info, raw)
