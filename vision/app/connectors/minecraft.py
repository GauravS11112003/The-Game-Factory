"""Minecraft export (docs/v4/CONTRACTS_V4.md §6): every level as a parkour course built by commands.

GET /games/{id}/export/minecraft → a datapack zip (Java Edition 1.21 or newer):

    <slug>-minecraft.zip      (pack.mcmeta at the top: the zip itself goes into a world's datapacks folder)
      README.txt
      pack.mcmeta
      data/drawplay/function/<level>.mcfunction    one per listed level, e.g. drawplay:level_1_lava_run

`/function drawplay:<level>` builds the course next to whoever runs it (relative ~ coordinates): 1 cell = 1 block,
the level's x runs east (+x, starting 2 blocks away), its rows run up (the bottom row sits one block below the
player's feet) and every tile is extruded 3 blocks deep (+z). The volume is cleared first, then:

    solid #         white concrete              one-way =      oak slabs (top half)
    slopes / \\      quartz stairs              half slopes    quartz stairs (high halves) or slabs (low halves)
    lava ~, X       magma blocks                coins          gold blocks (big coins: diamond blocks)
    spikes          pointed dripstone on floors and ceilings, magma blocks on walls
    springs         slime blocks                platforms      oak slabs where moving / crumbling ones start
    goal            a pressure plate on a command block that runs /title, and a beacon behind it
    checkpoints     a pressure plate on a command block that sets the spawn point
    enemies         mobs (walker husk, hopper slime, flyer vex, shooter blaze, chaser spider, crusher magma cube;
                    standing still: no AI), persistent      npcs: villagers that stay put
    the start       the player gets jump boost and is teleported there, with their spawn point

Runs of equal tiles become one /fill (row runs merged into rectangles) so a level takes tens of commands, not
thousands. What Minecraft cannot do (moving platforms, saws and firebars, keys and doors, portals, zones, pickups,
npc lines, rules, modes) is listed as message keys (`export4.mc.*`) and in README.txt.

`level_commands(level, pos=…)` also serves the live path (app.connectors.rcon): `pos` turns cell offsets into
coordinates (relative for functions and for the marker-anchored RCON build, absolute for a given origin).
"""
from __future__ import annotations

import io
import json
import math
import re
import zipfile
from typing import Any, Callable

from app.connectors.common import WORLD_H, game_levels, slug, tile_grid, write
from app.mind import messages

PACK_FORMAT = 48  # 1.21 (the singular `function` folder); supported_formats lets newer versions load it
DEPTH = 3  # blocks of extrusion (+z)
X0 = 2  # the course starts 2 blocks east of the origin
FILL_MAX = 32768  # /fill volume limit
JUMP_BOOST = 2  # amplifier: Jump Boost III, close to a draw.play jump

TILE_BLOCKS = {
    "#": "minecraft:white_concrete", "=": "minecraft:oak_slab[type=top]",
    "/": "minecraft:quartz_stairs[facing=east]", "\\": "minecraft:quartz_stairs[facing=west]",
    "a": "minecraft:quartz_slab[type=bottom]", "b": "minecraft:quartz_stairs[facing=east]",
    "c": "minecraft:quartz_stairs[facing=west]", "d": "minecraft:quartz_slab[type=bottom]",
    "~": "minecraft:magma_block", "X": "minecraft:magma_block",
}
MOBS = {"walker": "minecraft:husk", "hopper": "minecraft:slime", "flyer": "minecraft:vex", "shooter": "minecraft:blaze",
        "chaser": "minecraft:spider", "crusher": "minecraft:magma_cube", "static": "minecraft:husk"}
UNTRANSLATED = {  # entity type → message key (what the course leaves out or keeps still)
    "moving_platform": "export4.mc.moving", "crumble": "export4.mc.crumble", "falling_platform": "export4.mc.crumble",
    "saw": "export4.mc.saw", "firebar": "export4.mc.saw", "key": "export4.mc.key_door", "door": "export4.mc.key_door",
    "portal": "export4.mc.portal", "zone": "export4.mc.zone", "pickup": "export4.mc.pickup", "npc": "export4.mc.npc",
}

Pos = Callable[[float, float, float], str]


def rel(dx: float, dy: float, dz: float) -> str:
    """Relative coordinates (~ ~ ~) for functions and anchored commands."""
    def one(v: float) -> str:
        if v == 0:
            return "~"
        s = f"{v:.2f}".rstrip("0").rstrip(".")
        return f"~{s}"
    return f"{one(dx)} {one(dy)} {one(dz)}"


def absolute(origin: tuple[int, int, int]) -> Pos:
    ox, oy, oz = origin

    def pos(dx: float, dy: float, dz: float) -> str:
        def one(o: int, v: float) -> str:
            s = f"{o + v:.2f}".rstrip("0").rstrip(".")
            return s or "0"
        return f"{one(ox, dx)} {one(oy, dy)} {one(oz, dz)}"
    return pos


def _y(row: int) -> int:
    """Block y offset of a tile row: the bottom row sits one block below the origin."""
    return (WORLD_H - 2) - row


def _rects(rows: list[str], ch: str) -> list[tuple[int, int, int, int]]:
    """Maximal row runs of `ch` merged downwards into rectangles (x0, r0, x1, r1), inclusive."""
    done: list[tuple[int, int, int, int]] = []
    open_: dict[tuple[int, int], int] = {}  # (x0, x1) → first row
    for r, row in enumerate(rows + [""]):
        runs: set[tuple[int, int]] = set()
        x = 0
        while x < len(row):
            if row[x] != ch:
                x += 1
                continue
            s = x
            while x < len(row) and row[x] == ch:
                x += 1
            runs.add((s, x - 1))
        for key in list(open_):
            if key not in runs:
                done.append((key[0], open_.pop(key), key[1], r - 1))
        for key in runs:
            open_.setdefault(key, r)
    return sorted(done, key=lambda t: (t[1], t[0]))


def _fill(pos: Pos, x0: int, r0: int, x1: int, r1: int, z0: int, z1: int, block: str) -> list[str]:
    """/fill commands for a box of cells (split so none passes the volume limit)."""
    out = []
    height, depth = r1 - r0 + 1, z1 - z0 + 1
    step = max(1, FILL_MAX // max(1, height * depth))
    for a in range(x0, x1 + 1, step):
        b = min(x1, a + step - 1)
        out.append(f"fill {pos(X0 + a, _y(r1), z0)} {pos(X0 + b, _y(r0), z1)} {block}")
    return out


def _cell(v: Any) -> int:
    return int(math.floor(float(v)))


def _row_above(y: Any) -> int:
    """The cell row just above a feet / face line y."""
    return int(round(float(y))) - 1


def level_commands(level: dict[str, Any], pos: Pos = rel) -> tuple[list[str], list[str]]:
    """(commands that build the course, untranslated message keys). Commands carry no leading slash."""
    rows = tile_grid(level)
    w = len(rows[0]) if rows else 48
    cmds: list[str] = []
    untranslated: list[str] = []

    def miss(key: str) -> None:
        if key not in untranslated:
            untranslated.append(key)

    # clear the volume, then the tiles as rectangles
    cmds += _fill(pos, 0, 0, w - 1, WORLD_H - 1, 0, DEPTH - 1, "minecraft:air")
    for ch, block in TILE_BLOCKS.items():
        for x0, r0, x1, r1 in _rects(rows, ch):
            cmds += _fill(pos, x0, r0, x1, r1, 0, DEPTH - 1, block)
    mid = DEPTH // 2
    start: tuple[float, float] | None = None
    rules = level.get("rules") or {}
    compiled = level.get("compiled") or {}
    if rules.get("logic") or compiled.get("logic") or compiled.get("triggers"):
        miss("export4.mc.rules")
    if rules.get("mode") not in (None, "platformer"):
        miss("export4.mc.mode")
    for e in compiled.get("entities") or []:
        if not isinstance(e, dict):
            continue
        t = e.get("type")
        if e.get("hidden"):
            miss("export4.mc.hidden")
            continue
        if t in UNTRANSLATED:
            miss(UNTRANSLATED[t])
        try:
            if t == "player_start":
                start = (float(e["x"]), float(e["y"]))
            elif t in ("coin", "big_coin"):
                block = "minecraft:gold_block" if t == "coin" else "minecraft:diamond_block"
                cmds.append(f"setblock {pos(X0 + _cell(e['x']), _y(_cell(e['y'])), mid)} {block}")
            elif t == "spikes":
                x0, x1, fy = float(e["x0"]), float(e["x1"]), float(e["y"])
                a, b = _cell(x0), max(_cell(x0), int(-(-x1 // 1)) - 1)
                facing = e.get("facing")
                if facing in ("up", "down"):
                    r = _row_above(fy) if facing == "up" else int(round(fy))
                    block = f"minecraft:pointed_dripstone[vertical_direction={facing}]"
                    cmds += _fill(pos, a, r, b, r, 0, DEPTH - 1, block)
                else:  # on a wall: x0..x1 is the vertical run, y the wall's x
                    c = int(round(fy)) - 1 if facing == "left" else int(round(fy))
                    cmds += _fill(pos, c, a, c, b, 0, DEPTH - 1, "minecraft:magma_block")
            elif t == "spring":
                w = max(1, int(round(float(e.get("w") or 1))))
                x0 = _cell(float(e["x"]) - w / 2 + 0.5)
                r = _row_above(e["y"])
                cmds += _fill(pos, x0, r, x0 + w - 1, r, 0, DEPTH - 1, "minecraft:slime_block")
            elif t in ("moving_platform", "crumble", "falling_platform"):
                x0 = _cell(e["x"])
                x1 = max(x0, _cell(float(e["x"]) + float(e.get("w") or 1) - 0.01))
                cmds += _fill(pos, x0, _cell(e["y"]), x1, _cell(e["y"]), 0, DEPTH - 1, "minecraft:oak_slab[type=top]")
            elif t == "goal":
                c, r = _cell(e["x"]), _row_above(e["y"])
                text = json.dumps("You win!")
                cmds.append(f"setblock {pos(X0 + c, _y(r + 1), mid)} minecraft:command_block"
                            f"{{Command:'title @p title {text}'}}")
                cmds.append(f"setblock {pos(X0 + c, _y(r), mid)} minecraft:light_weighted_pressure_plate")
                cmds.append(f"setblock {pos(X0 + c, _y(r), DEPTH - 1)} minecraft:beacon")
            elif t == "checkpoint":
                c, r = _cell(e["x"]), _row_above(e["y"])
                cmds.append(f"setblock {pos(X0 + c, _y(r + 1), mid)} minecraft:command_block"
                            "{Command:'spawnpoint @p ~ ~1 ~'}")
                cmds.append(f"setblock {pos(X0 + c, _y(r), mid)} minecraft:stone_pressure_plate")
            elif t == "enemy":
                arche = str(e.get("archetype") or "walker")
                mob = MOBS.get(arche, "minecraft:husk")
                nbt = "{PersistenceRequired:1b" + (",NoAI:1b" if arche == "static" else "") + \
                      (",Size:0" if mob in ("minecraft:slime", "minecraft:magma_cube") else "") + "}"
                feet = _y(int(round(float(e["y"])))) + 1
                cmds.append(f"summon {mob} {pos(X0 + float(e['x']), feet, mid + 0.5)} {nbt}")
            elif t == "npc":
                feet = _y(int(round(float(e["y"])))) + 1
                cmds.append(f"summon minecraft:villager {pos(X0 + float(e['x']), feet, mid + 0.5)} "
                            "{PersistenceRequired:1b,NoAI:1b,Invulnerable:1b}")
        except (KeyError, TypeError, ValueError):
            continue  # an entity without its anchor fields is skipped, never a broken pack
    if start is not None:
        sx, feet = X0 + start[0], _y(int(round(start[1]))) + 1
        cmds.append(f"effect give @p minecraft:jump_boost infinite {JUMP_BOOST} true")
        cmds.append(f"spawnpoint @p {pos(int(sx), feet, mid)}")
        cmds.append(f"tp @p {pos(sx, feet, mid + 0.5)}")
    return cmds, untranslated


def function_name(index: int, title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (title or "").lower()).strip("_")[:32].strip("_")
    return f"level_{index}" + (f"_{s}" if s else "")


def pack_mcmeta(title: str) -> str:
    return json.dumps({"pack": {"pack_format": PACK_FORMAT, "supported_formats": {"min_inclusive": PACK_FORMAT,
                                                                                    "max_inclusive": 99},
                                "description": f"{title} (draw.play)"}}, indent=2, ensure_ascii=False) + "\n"


def build_zip(game: dict[str, Any], entries: list[dict[str, Any]]) -> tuple[bytes, str, list[str]]:
    """(zip bytes, file name, untranslated message keys over every level)."""
    title = str(game.get("title") or "").strip() or "My game"
    root = f"{slug(title, str(game['id']))}-minecraft"
    missing: list[str] = []
    functions: list[tuple[str, str, list[str]]] = []
    for i, e in enumerate(entries, start=1):
        cmds, miss = level_commands(e["level"], rel)
        name = function_name(i, e.get("title") or "")
        functions.append((name, e.get("title") or name, cmds))
        missing += [k for k in miss if k not in missing]
    readme = [title, "=" * len(title), "", "A Minecraft datapack from draw.play (Java Edition 1.21 or newer).", "",
              "1. Copy this zip into your world's datapacks folder (no need to unzip it).",
              "2. In the game, type /reload.",
              "3. Stand on flat open ground, look east, and type one of these:", ""]
    readme += [f"   /function drawplay:{name}    ({lt})" for name, lt, _ in functions]
    readme += ["", "Each level is built right next to you, then you are moved to its start.",
               "Gold blocks are coins. Step on the pressure plate at the end to win.", ""]
    if missing:
        readme += ["Not in Minecraft:"] + [f"  - {messages.say(k)}" for k in missing] + [""]
    readme += ["The levels are shared under Creative Commons Attribution (CC BY 4.0): keep the authors' names."]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        write(z, "README.txt", "\n".join(readme) + "\n")
        write(z, "pack.mcmeta", pack_mcmeta(title))
        for name, lt, cmds in functions:
            body = [f"# {lt}: built by draw.play, {len(cmds)} commands"] + cmds
            write(z, f"data/drawplay/function/{name}.mcfunction", "\n".join(body) + "\n")
    return buf.getvalue(), f"{root}.zip", missing


def export_game(game: dict[str, Any]) -> tuple[bytes, str, list[str]] | None:
    entries = game_levels(str(game["id"]))
    return build_zip(game, entries) if entries else None
