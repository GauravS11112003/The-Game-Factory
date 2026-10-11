"""API v4 with TestClient (docs/v4/CONTRACTS_V4.md §6): blocks (CRUD, versions, describe, use in a game), written
rules, game rules with mode and logic, the dashboard and its drafts, and the Tiled / Minecraft connectors (the live
build against a fake RCON server). The model is off; the core's parse_logic is replaced where a test needs it."""
from __future__ import annotations

import copy
import importlib
import io
import json
import os
import zipfile
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import SHARED_DIR
from tests.rcon_fake import FakeRcon

ZOO = json.loads((SHARED_DIR / "spec" / "conformance" / "levels" / "valid" / "entity_zoo_1screen.json").read_text("utf-8"))
STROKE = {"id": "s1", "color": "black", "kind": "line", "pts": [[0, 0], [1, 1], [2, 0]], "w": [0.2], "closed": False,
          "sheet": 0, "origin": "kid"}
ART = {"strokes": [STROKE], "size_cells": [2, 1]}
FLIP = {"id": "r1", "when": {"kind": "key", "key": "space"}, "then": [{"kind": "flip_gravity"}], "once": False}
INK = json.dumps({"v": 2, "source": "canvas", "world": {"screens": 1, "w": 48, "h": 27}, "strokes": [], "components": [],
                  "character": None, "typed_rules": [], "rules_ink": [], "sheets": [], "noise": {"count": 0},
                  "parent": None}).encode()


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    os.environ["DAL_DATA_DIR"] = str(tmp_path_factory.mktemp("dal_v4"))
    os.environ.pop("ANTHROPIC_API_KEY", None)
    os.environ.pop("DAL_FAKE_LLM", None)
    from app import config, db

    config.get_settings.cache_clear()
    config.get_settings_v2.cache_clear()
    db._engine_for.cache_clear()
    main = importlib.reload(importlib.import_module("app.main"))
    with TestClient(main.create_app()) as c:
        yield c


def profile(client: TestClient, name: str) -> dict[str, Any]:
    r = client.post("/api/v2/collab/players", json={"name": name})
    assert r.status_code == 201, r.text
    body = r.json()
    return {"id": body["player"]["id"], "name": name, "h": {"X-DP-Player": f"{body['player']['id']}.{body['token']}"}}


def game(client: TestClient, title: str = "Lava Land", author: str = "Maya") -> str:
    r = client.post("/api/v2/games", json={"title": title, "author": author})
    assert r.status_code == 201
    return r.json()["game"]["id"]


def store_level(game_id: str, level_id: str, *, flags: list[dict[str, Any]] | None = None,
                draft_id: str | None = None) -> None:
    from app import db_v2
    from app.build import levels_io

    lv = copy.deepcopy(ZOO)
    lv.update({"id": level_id, "version": 1, "game_id": game_id, "title": "Entity zoo", "author": "Maya",
               "created_at": db_v2.now_iso(), "order_index": 0})
    lv["design"] = {"flags": flags or []}
    levels_io.store(lv, report={"solvable": True}, listed=True, safety="ok", draft_id=draft_id)


def new_block(client: TestClient, who: dict[str, Any], **over: Any) -> dict[str, Any]:
    body = {"name": "Hoppy", "kind": "creature", "art": ART, "description": "a frog that hops", "tags": ["Frog"],
            "behavior": {"kind": "enemy", "archetype": "hopper", "spiky": False, "params": {}}, **over}
    r = client.post("/api/v2/blocks", json=body, headers=who["h"])
    assert r.status_code == 201, r.text
    return r.json()


# ---- blocks -------------------------------------------------------------------------------------------------------------


def test_blocks_create_list_get_and_versions(client: TestClient) -> None:
    maya, sam = profile(client, "Maya"), profile(client, "Sam")
    assert client.post("/api/v2/blocks", json={"name": "x", "kind": "rules", "logic": [FLIP]}).status_code == 401
    card = new_block(client, maya)
    assert card["id"].startswith("blk_") and len(card["id"]) == 12 and card["version"] == 1
    assert card["author"] == "Maya" and card["author_id"] == maya["id"] and card["uses"] == 0 and card["versions"] == 1
    assert card["tags"] == ["frog"]
    assert client.get(f"/api/v2/blocks/{card['id']}").json()["name"] == "Hoppy"
    pack = new_block(client, sam, name="Flip pack", kind="rules", art=None, behavior=None, logic=[FLIP],
                     description="gravity rules", tags=[])
    assert pack["kind"] == "rules" and pack["behavior"] is None
    listed = client.get("/api/v2/blocks").json()
    assert {b["id"] for b in listed["blocks"]} >= {card["id"], pack["id"]} and listed["total"] >= 2
    assert [b["id"] for b in client.get("/api/v2/blocks", params={"kind": "rules"}).json()["blocks"]] == [pack["id"]]
    assert [b["id"] for b in client.get("/api/v2/blocks", params={"q": "frog"}).json()["blocks"]] == [card["id"]]
    assert [b["id"] for b in client.get("/api/v2/blocks", params={"author_id": sam["id"]}).json()["blocks"]] == [pack["id"]]
    assert client.get("/api/v2/blocks", params={"q": "100%_"}).json() == {"blocks": [], "total": 0}
    assert client.get("/api/v2/blocks", params={"sort": "hot"}).status_code == 400
    page = client.get("/api/v2/blocks", params={"limit": 1, "offset": 1}).json()
    assert len(page["blocks"]) == 1 and page["total"] == listed["total"]
    # versions: the author only; n + 1; ?v= reads an old one
    upd = {"name": "Hoppy", "kind": "creature", "art": ART, "spiky": True,
           "behavior": {"kind": "enemy", "archetype": "hopper", "spiky": True, "params": {}}}
    r = client.post(f"/api/v2/blocks/{card['id']}/versions", json=upd, headers=sam["h"])
    assert r.status_code == 403 and r.json()["message_key"] == "blocks.err.not_author"
    v2 = client.post(f"/api/v2/blocks/{card['id']}/versions", json=upd, headers=maya["h"]).json()
    assert v2["version"] == 2 and v2["spiky"] is True and v2["versions"] == 2 and v2["id"] == card["id"]
    assert client.get(f"/api/v2/blocks/{card['id']}", params={"v": 1}).json()["spiky"] is False
    assert client.get(f"/api/v2/blocks/{card['id']}").json()["version"] == 2
    assert client.get("/api/v2/blocks/blk_nothere1").status_code == 404
    assert client.get("/api/v2/blocks/not-an-id").status_code == 404


def test_block_validation_and_blocklist(client: TestClient) -> None:
    kid = profile(client, "Robin")
    h = kid["h"]
    r = client.post("/api/v2/blocks", json={"name": "Blob", "kind": "creature", "behavior": {"kind": "static"}}, headers=h)
    assert r.status_code == 400 and r.json()["message_key"] == "blocks.err.needs_drawing"
    r = client.post("/api/v2/blocks", json={"name": "Blob", "kind": "prop", "art": ART}, headers=h)
    assert r.json()["message_key"] == "blocks.err.needs_behavior"
    r = client.post("/api/v2/blocks", json={"name": "Rules", "kind": "rules"}, headers=h)
    assert r.json()["message_key"] == "blocks.err.needs_rules"
    r = client.post("/api/v2/blocks", json={"name": "Rules", "kind": "rules", "logic": [FLIP, FLIP]}, headers=h)
    assert r.json()["message_key"] == "blocks.err.duplicate_rule"
    r = client.post("/api/v2/blocks", json={"name": "Rules", "kind": "nope"}, headers=h)
    assert r.status_code == 400 and r.json()["message_key"] == "error.bad_request"
    npc = {"kind": "npc", "lines": ["you are stupid shit"]}
    r = client.post("/api/v2/blocks", json={"name": "Bob", "kind": "prop", "art": ART, "behavior": npc}, headers=h)
    assert r.status_code == 409 and r.json()["message_key"] == "publish.safety_flag"
    r = client.post("/api/v2/blocks", json={"name": "Remix", "kind": "rules", "logic": [FLIP],
                                            "parent": {"block_id": "blk_nothere1", "version": 1}}, headers=h)
    assert r.status_code == 404


def test_describe_uses_keywords_offline(client: TestClient) -> None:
    r = client.post("/api/v2/blocks/describe", json={"name": "Grumpo", "text": "a frog that hops and explodes when you touch it"})
    body = r.json()
    assert r.status_code == 200 and body["source"] == "keywords" and body["kind"] == "creature"
    assert body["behavior"]["archetype"] == "hopper" and body["unknown"] == ["explodes when you touch it"]
    body = client.post("/api/v2/blocks/describe", json={"name": "Lift", "text": "moves up and down 6 blocks"}).json()
    assert body["kind"] == "platform" and body["behavior"] == {**body["behavior"], "kind": "move", "dir": "up", "cells": 6}
    body = client.post("/api/v2/blocks/describe", json={"name": "Zip", "text": "a gem that makes you fast"}).json()
    assert body["behavior"]["kind"] == "pickup" and body["behavior"]["effect"] == "speed"
    assert client.post("/api/v2/blocks/describe", json={"name": "x", "text": "shit"}).status_code == 409
    assert client.post("/api/v2/blocks/describe", json={"text": "no name"}).status_code == 400


def test_use_an_object_block_in_a_game(client: TestClient) -> None:
    maker = profile(client, "Ava")
    card = new_block(client, maker, name="Super Hopping Froggy")
    gid = game(client, "Frog World", "Kim")
    r = client.post(f"/api/v2/games/{gid}/blocks", json={"block_id": card["id"]})
    assert r.status_code == 200, r.text
    lt = r.json()["library_type"]
    assert r.json()["rules"] is None
    assert lt["block"] == {"block_id": card["id"], "version": 1} and lt["game_id"] == gid and lt["version"] == 1
    assert len(lt["name"]) <= 16 and lt["kind"] == "creature" and lt["author"] == "Ava" and lt["letter"]
    lib = client.get(f"/api/v2/games/{gid}/library").json()["types"]
    assert [t["id"] for t in lib] == [lt["id"]]
    again = client.post(f"/api/v2/games/{gid}/blocks", json={"block_id": card["id"], "version": 1}).json()["library_type"]
    assert again["id"] == lt["id"] and again["version"] == 1  # the same block version twice changes nothing
    upd = {"name": "Hoppy", "kind": "creature", "art": ART, "behavior": {"kind": "static"}}
    client.post(f"/api/v2/blocks/{card['id']}/versions", json=upd, headers=maker["h"])
    newer = client.post(f"/api/v2/games/{gid}/blocks", json={"block_id": card["id"]}).json()["library_type"]
    assert newer["id"] == lt["id"] and newer["version"] == 2 and newer["letter"] == lt["letter"]
    assert newer["block"]["version"] == 2 and newer["behavior"] == {"kind": "static"}
    assert client.get(f"/api/v2/blocks/{card['id']}").json()["uses"] == 1  # games, not versions
    credits = client.get(f"/api/v2/collab/games/{gid}/credits").json()["contributors"]
    assert [(c["player"]["id"], c["blocks"]) for c in credits] == [(maker["id"], 1)]
    assert client.post(f"/api/v2/games/{gid}/blocks", json={"block_id": "blk_nothere1"}).status_code == 404
    assert client.post("/api/v2/games/game_nothere/blocks", json={"block_id": card["id"]}).status_code == 404
    pop = client.get("/api/v2/blocks", params={"sort": "popular"}).json()["blocks"]
    assert pop[0]["id"] == card["id"]


def test_use_a_rule_pack_and_game_rules_with_mode(client: TestClient) -> None:
    maker = profile(client, "Lee")
    coins = {"id": "r2", "when": {"kind": "all_coins"}, "then": [{"kind": "win"}], "once": True}
    pack = new_block(client, maker, name="Flip pack", kind="rules", art=None, behavior=None, logic=[FLIP, coins],
                     description=None, tags=[])
    gid = game(client, "Upside Down", "Lee")
    res = client.post(f"/api/v2/games/{gid}/blocks", json={"block_id": pack["id"]}).json()
    assert res["library_type"] is None
    ids = [r["id"] for r in res["rules"]["logic"]]
    assert ids == [f"{pack['id']}_r1", f"{pack['id']}_r2"] and res["rules"]["version"] == 2
    again = client.post(f"/api/v2/games/{gid}/blocks", json={"block_id": pack["id"]}).json()
    assert [r["id"] for r in again["rules"]["logic"]] == ids  # replaced, never doubled
    assert [r["id"] for r in client.get(f"/api/v2/games/{gid}/rules").json()["logic"]] == ids
    # PUT rules: mode and game-wide logic travel in GameRules; platformer and [] are stored as null
    r = client.put(f"/api/v2/games/{gid}/rules", json={"mode": "flappy"})
    assert r.status_code == 200 and r.json()["rules"]["mode"] == "flappy" and len(r.json()["rules"]["logic"]) == 2
    assert client.put(f"/api/v2/games/{gid}/rules", json={"mode": "platformer", "logic": []}).json()["rules"] | {} == \
        {**client.get(f"/api/v2/games/{gid}/rules").json(), "mode": None, "logic": None}
    assert client.put(f"/api/v2/games/{gid}/rules", json={"mode": "sideways"}).status_code == 400
    bad = {"logic": [{"id": "r1", "when": {"kind": "key", "key": "space"}, "then": []}]}
    assert client.put(f"/api/v2/games/{gid}/rules", json=bad).status_code == 400
    check = client.post(f"/api/v2/games/{gid}/rules/check", json={"mode": "topdown", "logic": [FLIP]})
    assert check.status_code == 200 and check.json()["checked"] == 0 and check.json()["rules"]["mode"] == "topdown"


def test_logic_parse_falls_back_to_the_core_then_nothing(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.build.bridge import CoreError
    from app.mind import logic as mlogic

    async def down(method: str, params: dict[str, Any], timeout: float | None) -> Any:
        raise CoreError("internal", "NotImplemented: parseLogic")

    monkeypatch.setattr(mlogic, "_pool_rpc", down)
    r = client.post("/api/v2/logic/parse", json={"sentences": ["space flips gravity", "you have 3 hearts"]})
    assert r.status_code == 200
    assert r.json() == {"rules": [], "mode": None, "unknown": ["space flips gravity", "you have 3 hearts"],
                        "source": "keywords"}

    async def core(method: str, params: dict[str, Any], timeout: float | None) -> Any:
        assert method == "parse_logic" and params["entity_ids"] == ["e_door"]
        return {"rules": [FLIP], "mode": None, "unknown": ["you have 3 hearts"], "source": "keywords"}

    monkeypatch.setattr(mlogic, "_pool_rpc", core)
    body = client.post("/api/v2/logic/parse", json={"sentences": ["space flips gravity", "you have 3 hearts"],
                                                     "entity_ids": ["e_door"]}).json()
    assert body["rules"][0]["id"] == "r1" and body["unknown"] == ["you have 3 hearts"] and body["source"] == "keywords"
    assert client.post("/api/v2/logic/parse", json={"sentences": []}).status_code == 400
    assert client.post("/api/v2/logic/parse", json={"sentences": ["x"], "game_id": "game_nothere"}).status_code == 404


def test_logic_parse_answers_with_whatever_core_is_running(client: TestClient) -> None:
    """The real worker (lane A's parse_logic, or NotImplemented while it lands): always a valid result."""
    from app.spec.api import LogicParseResult

    r = client.post("/api/v2/logic/parse", json={"sentences": ["space flips gravity"]})
    assert r.status_code == 200 and LogicParseResult.model_validate(r.json()).source == "keywords"


# ---- dashboard and drafts -----------------------------------------------------------------------------------------------


def test_dashboard_lists_games_drafts_blocks(client: TestClient) -> None:
    from app import db_v2

    assert client.get("/api/v2/dashboard").status_code == 401
    me = profile(client, "Nia")
    gid = game(client, "Nia's Castle", "Nia")
    assert client.post(f"/api/v2/collab/games/{gid}/join", headers=me["h"]).status_code == 200  # claims it: owner
    store_level(gid, "lvl_nia_1", flags=[{"id": "f1", "code": "x", "severity": "hard"},
                                         {"id": "f2", "code": "y", "severity": "warn"},
                                         {"id": "f3", "code": "z", "severity": "block"}])
    client.put(f"/api/v2/games/{gid}/rules", json={"mode": "runner"})
    r = client.post("/api/v2/builds", files={"ink": ("ink.json", INK, "application/json")}, data={"title": "Draft one"},
                    headers=me["h"])
    assert r.status_code == 202
    draft = r.json()["draft_id"]
    r2 = client.post("/api/v2/builds", files={"ink": ("ink.json", INK, "application/json")}, headers=me["h"])
    published = r2.json()["draft_id"]
    store_level(gid, "lvl_nia_2", draft_id=published)  # this draft became a level: no longer a draft
    client.post("/api/v2/builds", files={"ink": ("ink.json", INK, "application/json")})  # anonymous: nobody's
    block = new_block(client, me, name="Nia frog")
    d = client.get("/api/v2/dashboard", headers=me["h"]).json()
    mine = next(g for g in d["games"] if g["game_id"] == gid)
    assert mine == {"game_id": gid, "title": "Nia's Castle", "role": "owner", "mode": "runner", "level_count": 2,
                    "beatable": 2, "to_fix": 2, "pending_reviews": 0, "open_quests": 0, "cover_level_id": "lvl_nia_1",
                    "updated_at": mine["updated_at"]}
    assert [x["draft_id"] for x in d["drafts"]] == [draft]
    assert d["drafts"][0]["title"] == "Draft one" and d["drafts"][0]["kind"] == "canvas"
    assert [b["id"] for b in d["blocks"]] == [block["id"]] and isinstance(d["unread"], int)
    row = [r for r in db_v2.unpublished_drafts(me["id"])]
    assert [x["draft_id"] for x in row] == [draft]


# ---- connectors ---------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def zoo_game(client: TestClient) -> str:
    gid = game(client, "Zoo Run", "Maya")
    store_level(gid, "lvl_zoo_1")
    return gid


def test_tiled_export(client: TestClient, zoo_game: str) -> None:
    r = client.get(f"/api/v2/games/{zoo_game}/export/tiled")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert 'filename="zoo-run-tiled.zip"' in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert set(z.namelist()) == {"zoo-run-tiled/README.txt", "zoo-run-tiled/tileset.png", "zoo-run-tiled/01-entity-zoo.tmj"}
    m = json.loads(z.read("zoo-run-tiled/01-entity-zoo.tmj"))
    assert m["orientation"] == "orthogonal" and [ly["type"] for ly in m["layers"]] == ["tilelayer", "objectgroup"]
    assert z.read("zoo-run-tiled/tileset.png")[:8] == b"\x89PNG\r\n\x1a\n"
    empty = game(client, "Empty", "Maya")
    assert client.get(f"/api/v2/games/{empty}/export/tiled").json()["message_key"] == "export.no_levels"
    assert client.get("/api/v2/games/game_nothere/export/tiled").status_code == 404


def test_minecraft_export(client: TestClient, zoo_game: str) -> None:
    r = client.get(f"/api/v2/games/{zoo_game}/export/minecraft")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert {"pack.mcmeta", "README.txt", "data/drawplay/function/level_1_entity_zoo.mcfunction"} == set(z.namelist())
    fn = z.read("data/drawplay/function/level_1_entity_zoo.mcfunction").decode()
    assert "fill ~2 ~-1 ~ ~49 ~25 ~2 minecraft:air" in fn and "title @p title" in fn
    assert "export4.mc.key_door" in r.headers["x-drawplay-untranslated"].split(",")


def test_minecraft_live_over_rcon(client: TestClient, zoo_game: str) -> None:
    with FakeRcon("hunter2") as srv:
        body = {"host": "127.0.0.1", "port": srv.port, "password": "hunter2"}
        r = client.post(f"/api/v2/games/{zoo_game}/export/minecraft/live", json=body)
        res = r.json()
        assert r.status_code == 200 and res["ok"] is True and res["message_key"] == "export4.mc_built"
        assert res["commands"] == len(srv.commands) and "export4.mc.saw" in res["untranslated"]
        assert srv.commands[0].startswith("execute at @p run summon minecraft:marker ~ ~ ~ {Tags:[\"drawplay_origin_")
        assert all(c.startswith("execute at @e[type=minecraft:marker,tag=drawplay_origin_") for c in srv.commands[1:-1])
        assert srv.commands[-1].startswith("kill @e[type=minecraft:marker")
        assert "hunter2" not in r.text
        srv.commands.clear()
        res = client.post(f"/api/v2/games/{zoo_game}/export/minecraft/live",
                          json={**body, "origin": [100, 64, -20], "level_id": "lvl_zoo_1"}).json()
        assert res["ok"] and srv.commands[0] == "fill 102 63 -20 149 89 -18 minecraft:air"
        r = client.post(f"/api/v2/games/{zoo_game}/export/minecraft/live", json={**body, "password": "nope"})
        assert r.json() == {"ok": False, "commands": 0, "message_key": "export4.mc_auth",
                            "untranslated": r.json()["untranslated"]} and "nope" not in r.text
    with FakeRcon("hunter2", reject=lambda c: "summon minecraft:marker" in c) as srv:
        res = client.post(f"/api/v2/games/{zoo_game}/export/minecraft/live",
                          json={"port": srv.port, "password": "hunter2"}).json()
        assert res["ok"] is False and res["message_key"] == "export4.mc_no_player" and len(srv.commands) == 1
    with FakeRcon("hunter2", reject=lambda c: "beacon" in c) as srv:
        res = client.post(f"/api/v2/games/{zoo_game}/export/minecraft/live",
                          json={"port": srv.port, "password": "hunter2"}).json()
        assert res["ok"] is True and res["message_key"] == "export4.mc_partly"
    res = client.post(f"/api/v2/games/{zoo_game}/export/minecraft/live", json={"port": srv.port, "password": "x"}).json()
    assert res["ok"] is False and res["message_key"] == "export4.mc_unreachable"
    r = client.post(f"/api/v2/games/{zoo_game}/export/minecraft/live", json={"password": ""})
    assert r.status_code == 400 and "password" not in r.text.replace('"field":"minecraft"', "")
    r = client.post(f"/api/v2/games/{zoo_game}/export/minecraft/live", json={"password": "x", "level_id": "lvl_nope"})
    assert r.status_code == 404
    for host in ("example.com", "8.8.8.8"):  # never an arbitrary internet host
        r = client.post(f"/api/v2/games/{zoo_game}/export/minecraft/live", json={"password": "x", "host": host})
        assert r.status_code == 400 and r.json()["message_key"] == "export4.mc_host_blocked"


def test_rcon_hosts() -> None:
    from app.routers.v2.export_connectors import host_allowed

    assert all(host_allowed(h) for h in ("127.0.0.1", "localhost", "192.168.1.20", "10.0.0.5", "::1"))
    assert not any(host_allowed(h) for h in ("example.com", "8.8.8.8", "", "1.1.1.1"))
    os.environ["DAL_MC_HOSTS"] = "mc.example.com"
    try:
        assert host_allowed("MC.example.com")
    finally:
        os.environ.pop("DAL_MC_HOSTS")


# ---- strings ------------------------------------------------------------------------------------------------------------


def test_every_v4_message_key_has_a_short_sentence() -> None:
    import re
    from pathlib import Path

    from app.mind import messages

    api = json.loads((SHARED_DIR / "spec" / "messages-v4" / "api.json").read_text("utf-8"))["messages"]
    for k, v in api.items():
        assert k.startswith(("blocks.err.", "export4.", "api4.")), k
        for sentence in re.split(r"(?<=[.!?])\s+", v):
            assert len(sentence.split()) <= 20, k
        assert not re.search(r"[a-z]_[a-z]", re.sub(r"\{[^}]+\}", "", v)), k
    app_dir = Path(__file__).resolve().parents[1] / "app"
    used: set[str] = set()
    for f in ["routers/v2/blocks.py", "routers/v2/logic.py", "routers/v2/dashboard.py", "routers/v2/export_connectors.py",
              "connectors/minecraft.py", "connectors/rcon.py"]:
        used |= set(re.findall(r"\"((?:blocks\.err|export4|api4|export|error|collab|publish)\.[a-z0-9_.]+)\"",
                               (app_dir / f).read_text("utf-8")))
    assert used and all(messages.has(k) for k in used), sorted(k for k in used if not messages.has(k))
