"""v4 connectors without HTTP (docs/v4/CONTRACTS_V4.md §6): Tiled maps, the Minecraft datapack commands and the RCON
client against a fake server."""
from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path

import pytest
from PIL import Image

from app.connectors import minecraft, rcon, tiled
from app.config import SHARED_DIR
from app.mind import messages
from tests.rcon_fake import FakeRcon

ZOO = json.loads((SHARED_DIR / "spec" / "conformance" / "levels" / "valid" / "entity_zoo_1screen.json").read_text("utf-8"))


def entry(level: dict | None = None) -> dict:
    return {"id": "lvl_zoo", "version": 1, "title": "Entity zoo", "author": "Maya", "level": level or ZOO}


def test_tiled_map_has_tiles_and_entities() -> None:
    m = tiled.level_map(entry())
    assert m["orientation"] == "orthogonal" and m["tilewidth"] == m["tileheight"] == 16
    assert (m["width"], m["height"]) == (48, 27) and m["infinite"] is False
    tiles, objects = m["layers"]
    assert tiles["type"] == "tilelayer" and len(tiles["data"]) == 48 * 27
    rows = ZOO["compiled"]["tiles"]["rows"]
    from app.spec.level import decode_row

    flat = "".join(decode_row(r) for r in rows)
    assert [d for d in tiles["data"]] == [tiled.TILES.index(c) + 1 if c != "." else 0 for c in flat]
    assert objects["type"] == "objectgroup" and len(objects["objects"]) == len(ZOO["compiled"]["entities"])
    by = {o["name"]: o for o in objects["objects"]}
    assert by["e_coin"]["type"] == "coin" and (by["e_coin"]["x"], by["e_coin"]["y"]) == (192.0, 304.0)
    assert by["e_door"]["width"] == 16 and by["e_door"]["height"] == 80  # top-left box, 1 × 5 cells
    assert by["goal"]["x"] == 44.75 * 16 and by["goal"]["height"] == 3 * 16  # the trigger box
    props = {p["name"]: p for p in by["e_walk"]["properties"]}
    assert props["archetype"]["value"] == "walker" and json.loads(props["bounds"]["value"]) == [18.0, 28.0]
    meta = {p["name"]: p["value"] for p in m["properties"]}
    assert meta["level_id"] == "lvl_zoo" and meta["mode"] == "platformer"
    ts = m["tilesets"][0]
    assert ts["image"] == "tileset.png" and ts["tilecount"] == 10 and ts["firstgid"] == 1


def test_tiled_zip_and_tileset_image() -> None:
    data, name = tiled.build_zip({"id": "game_x", "title": "Lava Land"}, [entry(), entry()])
    assert name == "lava-land-tiled.zip"
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    assert "lava-land-tiled/README.txt" in names and "lava-land-tiled/tileset.png" in names
    assert sorted(n for n in names if n.endswith(".tmj")) == ["lava-land-tiled/01-entity-zoo.tmj",
                                                             "lava-land-tiled/02-entity-zoo.tmj"]
    img = Image.open(io.BytesIO(z.read("lava-land-tiled/tileset.png")))
    assert img.size == (160, 16)
    json.loads(z.read("lava-land-tiled/01-entity-zoo.tmj"))


def test_minecraft_commands_build_the_course() -> None:
    cmds, missing = minecraft.level_commands(ZOO)
    assert cmds[0].startswith("fill ~2 ~-1 ~ ~49 ~25 ~2 minecraft:air")
    fills = [c for c in cmds if c.startswith("fill ")]
    assert any("minecraft:white_concrete" in c for c in fills) and any("oak_slab[type=top]" in c for c in fills)
    assert any("pointed_dripstone[vertical_direction=up]" in c for c in fills)  # spikes on the floor
    assert any(c.startswith("summon minecraft:husk ") for c in cmds) and any(c.startswith("summon minecraft:vex") for c in cmds)
    assert any("minecraft:gold_block" in c for c in cmds) and any("minecraft:slime_block" in c for c in cmds)
    goal = [c for c in cmds if "command_block" in c and "title @p title" in c]
    assert goal and any("light_weighted_pressure_plate" in c for c in cmds) and any("minecraft:beacon" in c for c in cmds)
    assert any("spawnpoint @p ~ ~1 ~" in c for c in cmds)  # checkpoint
    assert cmds[-1].startswith("tp @p ") and any(c.startswith("effect give @p minecraft:jump_boost") for c in cmds)
    # rectangles, not one command per block: the whole level takes a few dozen commands
    assert len(cmds) < 60
    assert set(missing) == {"export4.mc.key_door", "export4.mc.saw", "export4.mc.moving", "export4.mc.crumble"}
    for key in missing:
        assert messages.has(key), key
    abs_cmds, _ = minecraft.level_commands(ZOO, minecraft.absolute((100, 64, -20)))
    assert abs_cmds[0] == "fill 102 63 -20 149 89 -18 minecraft:air" and "~" not in abs_cmds[0]


def test_minecraft_marks_rules_modes_and_hidden_things() -> None:
    lv = json.loads(json.dumps(ZOO))
    lv["rules"]["mode"] = "topdown"
    lv["compiled"]["logic"] = [{"id": "r1", "when": {"kind": "start"}, "then": [{"kind": "shake"}]}]
    lv["compiled"]["entities"].append({"id": "p1", "type": "pickup", "x": 5, "y": 5, "item": "star", "hidden": True})
    lv["compiled"]["entities"].append({"id": "z1", "type": "zone", "x": 5, "y": 5, "w": 2, "h": 2, "effect": "wind"})
    _, missing = minecraft.level_commands(lv)
    assert {"export4.mc.rules", "export4.mc.mode", "export4.mc.hidden", "export4.mc.zone"} <= set(missing)


def test_minecraft_datapack_zip() -> None:
    data, name, missing = minecraft.build_zip({"id": "game_x", "title": "Lava Land"}, [entry()])
    z = zipfile.ZipFile(io.BytesIO(data))
    meta = json.loads(z.read("pack.mcmeta"))
    assert meta["pack"]["pack_format"] == minecraft.PACK_FORMAT and name == "lava-land-minecraft.zip"
    fn = [n for n in z.namelist() if n.startswith("data/drawplay/function/")]
    assert fn == ["data/drawplay/function/level_1_entity_zoo.mcfunction"]
    lines = z.read(fn[0]).decode().splitlines()
    assert lines[0].startswith("#") and all(not ln.startswith("/") for ln in lines)
    assert "/function drawplay:level_1_entity_zoo" in z.read("README.txt").decode()
    assert all(re.match(r"^[a-z0-9_./-]+$", n.split("/")[-1].replace(".mcfunction", "")) for n in fn)


def test_rcon_client_logs_in_and_runs_commands() -> None:
    with FakeRcon("hunter2", reject=lambda c: c.startswith("bad")) as srv:
        res = rcon.send_all("127.0.0.1", srv.port, "hunter2", ["say one", "bad two", "say three"], batch=2, pause_s=0)
        assert (res.sent, res.failed) == (3, 1) and srv.commands == ["say one", "bad two", "say three"]
        with pytest.raises(rcon.RconError) as e:
            rcon.send_all("127.0.0.1", srv.port, "wrong", ["say x"])
        assert e.value.code == "auth" and "wrong" not in str(e.value)
        with pytest.raises(rcon.RconError) as e:
            rcon.send_all("127.0.0.1", srv.port, "hunter2", ["bad marker", "say after"], must_work=0)
        assert e.value.code == "no_player" and "say after" not in srv.commands
    with pytest.raises(rcon.RconError) as e:
        rcon.send_all("127.0.0.1", srv.port, "hunter2", ["say x"], timeout_s=1)
    assert e.value.code == "unreachable"


def test_rcon_packets_match_the_source_protocol() -> None:
    pkt = rcon.encode(7, rcon.LOGIN, "pw")
    assert pkt == (12).to_bytes(4, "little") + (7).to_bytes(4, "little") + (3).to_bytes(4, "little") + b"pw\x00\x00"
    assert Path(rcon.__file__).read_text("utf-8").count("log.") == 0  # the client never logs (password safety)
