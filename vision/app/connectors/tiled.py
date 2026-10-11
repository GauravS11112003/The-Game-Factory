"""Tiled export (docs/v4/CONTRACTS_V4.md §6, GET /games/{id}/export/tiled): one Tiled JSON map per listed level.

    <slug>-tiled/
      README.txt              how to open the maps (Tiled, Godot, Phaser, LDtk importers)
      tileset.png             the 10 tile kinds, 16 px each, in gid order
      01-<level>.tmj, …       orthogonal maps, 16 px tiles, width 48 × screens, height 27

Each map embeds the tileset (image tileset.png, so a map opens on its own) and has two layers:
    tiles      a tile layer from compiled.tiles: gid 1 solid `#`, 2 one-way `=`, 3 slope `/`, 4 slope `\\`, 5-8 the half
               slopes `a` `b` `c` `d`, 9 lava `~`, 10 hazard `X` (0 = empty); every tile carries `char` and `kind`
    entities   an object layer from compiled.entities: one rectangle per entity in px (the entity's box from its anchor
               convention), `name` = the entity id, `type` = the entity type, every other field as a custom property
               (lists and objects as JSON strings); hidden entities are invisible objects
Map properties: level_id, version, title, author, level_hash, mode, and the level's rules (`logic`) as JSON.
"""
from __future__ import annotations

import io
import json
import zipfile
from typing import Any

from app.connectors.common import CELL_PX, WORLD_H, entity_box, game_levels, slug, tile_grid, write

TILES = "#=/\\abcd~X"  # gid = index + 1
TILE_KINDS = {"#": "solid", "=": "one_way", "/": "slope_up", "\\": "slope_down", "a": "half_slope_up_low",
              "b": "half_slope_up_high", "c": "half_slope_down_high", "d": "half_slope_down_low", "~": "lava",
              "X": "hazard"}
TILESET_IMAGE = "tileset.png"
TILED_VERSION = "1.10.2"
SKIP_PROPS = {"id", "type", "x", "y", "w", "h", "origin", "sprite"}

# floor line of each slope, px below the cell top at the left and right edges (web/src/core/sim/tiles.ts)
_SLOPES = {"/": (16, 0), "\\": (0, 16), "a": (16, 8), "b": (8, 0), "c": (0, 8), "d": (8, 16)}


def tileset_png() -> bytes:
    """The tileset image: 10 tiles of 16 × 16 px in a row, in the sketchbook palette."""
    from PIL import Image, ImageDraw

    n = len(TILES)
    img = Image.new("RGBA", (n * CELL_PX, CELL_PX), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    ink, fill, wood = (40, 44, 52, 255), (120, 128, 140, 255), (150, 104, 60, 255)
    for i, ch in enumerate(TILES):
        x0 = i * CELL_PX
        x1 = x0 + CELL_PX - 1
        if ch == "#":
            d.rectangle([x0, 0, x1, CELL_PX - 1], fill=fill, outline=ink)
        elif ch == "=":
            d.rectangle([x0, 0, x1, 4], fill=wood, outline=ink)
        elif ch in _SLOPES:
            left, right = _SLOPES[ch]
            d.polygon([(x0, left), (x1 + 1, right), (x1 + 1, CELL_PX), (x0, CELL_PX)], fill=fill, outline=ink)
        elif ch == "~":
            d.rectangle([x0, 0, x1, CELL_PX - 1], fill=(232, 96, 40, 255))
            d.line([(x0, 4), (x0 + 4, 2), (x0 + 8, 4), (x0 + 12, 2), (x1, 4)], fill=(255, 196, 64, 255), width=2)
        else:  # X: a legacy hazard cell
            d.rectangle([x0, 0, x1, CELL_PX - 1], fill=(200, 40, 40, 255), outline=ink)
            d.line([(x0 + 3, 3), (x1 - 3, CELL_PX - 4)], fill=(255, 255, 255, 255), width=2)
            d.line([(x0 + 3, CELL_PX - 4), (x1 - 3, 3)], fill=(255, 255, 255, 255), width=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _prop(name: str, v: Any) -> dict[str, Any] | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return {"name": name, "type": "bool", "value": v}
    if isinstance(v, int):
        return {"name": name, "type": "int", "value": v}
    if isinstance(v, float):
        return {"name": name, "type": "float", "value": v}
    if isinstance(v, str):
        return {"name": name, "type": "string", "value": v}
    return {"name": name, "type": "string", "value": json.dumps(v, separators=(",", ":"), ensure_ascii=False)}


def _props(d: dict[str, Any]) -> list[dict[str, Any]]:
    return [p for p in (_prop(k, v) for k, v in d.items()) if p is not None]


def tileset() -> dict[str, Any]:
    return {
        "firstgid": 1, "name": "drawplay", "image": TILESET_IMAGE, "imagewidth": len(TILES) * CELL_PX,
        "imageheight": CELL_PX, "tilewidth": CELL_PX, "tileheight": CELL_PX, "tilecount": len(TILES),
        "columns": len(TILES), "margin": 0, "spacing": 0,
        "tiles": [{"id": i, "type": TILE_KINDS[ch], "properties": _props({"char": ch, "kind": TILE_KINDS[ch]})}
                  for i, ch in enumerate(TILES)],
    }


def entity_object(e: dict[str, Any], oid: int) -> dict[str, Any] | None:
    box = entity_box(e)
    if box is None:
        return None
    x, y, w, h = box
    props = {k: v for k, v in e.items() if k not in SKIP_PROPS}
    return {"id": oid, "name": str(e.get("id") or ""), "type": str(e.get("type") or ""),
            "x": round(x * CELL_PX, 2), "y": round(y * CELL_PX, 2), "width": round(max(w, 0.0) * CELL_PX, 2),
            "height": round(max(h, 0.0) * CELL_PX, 2), "rotation": 0, "visible": not bool(e.get("hidden")),
            "properties": _props(props)}


def level_map(entry: dict[str, Any]) -> dict[str, Any]:
    """One Tiled JSON map (.tmj) for a stored level."""
    level = entry["level"]
    rows = tile_grid(level)
    w = len(rows[0]) if rows else 48
    data = [TILES.index(ch) + 1 if ch in TILES else 0 for row in rows for ch in row]
    compiled = level.get("compiled") or {}
    objects = []
    for e in compiled.get("entities") or []:
        if isinstance(e, dict):
            o = entity_object(e, len(objects) + 1)
            if o is not None:
                objects.append(o)
    rules = level.get("rules") or {}
    meta = {"level_id": entry["id"], "version": entry.get("version"), "title": entry.get("title"),
            "author": entry.get("author"), "level_hash": (level.get("meta") or {}).get("level_hash"),
            "mode": rules.get("mode") or "platformer"}
    logic = list(rules.get("logic") or []) + list(compiled.get("logic") or [])
    if logic:
        meta["logic"] = logic
    return {
        "type": "map", "version": "1.10", "tiledversion": TILED_VERSION, "orientation": "orthogonal",
        "renderorder": "right-down", "infinite": False, "compressionlevel": -1, "width": w, "height": WORLD_H,
        "tilewidth": CELL_PX, "tileheight": CELL_PX, "nextlayerid": 3, "nextobjectid": len(objects) + 1,
        "properties": _props(meta), "tilesets": [tileset()],
        "layers": [
            {"id": 1, "name": "tiles", "type": "tilelayer", "width": w, "height": WORLD_H, "x": 0, "y": 0,
             "opacity": 1, "visible": True, "data": data},
            {"id": 2, "name": "entities", "type": "objectgroup", "draworder": "topdown", "x": 0, "y": 0,
             "opacity": 1, "visible": True, "objects": objects},
        ],
    }


README = """{title}
{underline}

{n} level{s} from draw.play, as Tiled maps (https://www.mapeditor.org).

Files
  tileset.png    the tiles, 16 x 16 px: solid, one-way, slopes, half slopes, lava, hazard
  *.tmj          one map per level (orthogonal, 16 px tiles, the tileset is embedded)

Open a .tmj in Tiled 1.9 or newer. Each map has a "tiles" layer and an "entities" object layer: every
entity is a rectangle named after its id, typed with its kind (coin, enemy, goal, ...), with its
settings as custom properties. Game engines with Tiled importers (Godot, Phaser, Defold, GameMaker,
LDtk) can load the maps directly.

The levels are shared under Creative Commons Attribution (CC BY 4.0): keep the authors' names with them.
"""


def build_zip(game: dict[str, Any], entries: list[dict[str, Any]]) -> tuple[bytes, str]:
    title = str(game.get("title") or "").strip() or "My game"
    root = f"{slug(title, str(game['id']))}-tiled"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        n = len(entries)
        write(z, f"{root}/README.txt", README.format(title=title, underline="=" * len(title), n=n,
                                                     s="s" if n != 1 else ""))
        write(z, f"{root}/{TILESET_IMAGE}", tileset_png())
        for i, e in enumerate(entries, start=1):
            name = f"{i:02d}-{slug(e.get('title'), e['id'])}.tmj"
            write(z, f"{root}/{name}", json.dumps(level_map(e), ensure_ascii=False, indent=1) + "\n")
    return buf.getvalue(), f"{root}.zip"


def export_game(game: dict[str, Any]) -> tuple[bytes, str] | None:
    """The zip for a game, or None when it has no exportable levels."""
    entries = game_levels(str(game["id"]))
    return build_zip(game, entries) if entries else None
