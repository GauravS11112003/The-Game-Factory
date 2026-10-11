"""v4 model calls without the network (docs/v4/CONTRACTS_V4.md §2.4, §6): the block describer's keyword reader, the
logic sanitizer and its fallbacks (core parser, nothing at all), and the build's logic plumbing."""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic import TypeAdapter

from app.build.bridge import CoreError
from app.build.orchestrator import intent_edits, logic_input
from app.mind import block as mblock
from app.mind import client
from app.mind import logic as mlogic
from app.mind.client import MindResult
from app.spec.api import BlockDescribeResult, LogicParseResult
from app.spec.behavior import Behavior
from app.spec.logic import RuleV4


@pytest.fixture(autouse=True)
def offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DAL_FAKE_LLM", raising=False)


def describe(name: str, text: str, rpc: Any = None) -> dict[str, Any]:
    res = asyncio.run(mblock.describe(name, text, [], rpc=rpc))
    BlockDescribeResult.model_validate(res)  # every answer is a valid contract shape
    if res["behavior"] is not None:
        TypeAdapter(Behavior).validate_python(res["behavior"])
    assert res["source"] == "keywords"
    return res


@pytest.mark.parametrize("text,kind,behavior", [
    ("it flies around fast", "creature", "enemy"),
    ("a platform that goes up and down 5 blocks", "platform", "move"),
    ("a floor that crumbles when you stand on it", "platform", "crumble"),
    ("a platform that falls", "platform", "falling"),
    ("a trampoline that bounces you super high", "platform", "spring"),
    ("a spinning saw that moves left and right", "hazard", "saw"),
    ("sharp spikes", "hazard", "static"),
    ("a star that makes you fast for 8 seconds and comes back", "pickup", "pickup"),
    ("a blue portal", "prop", "portal"),
    ("a fan that blows you up", "prop", "zone"),
    ('a wizard who says "Find the key!"', "prop", "npc"),
    ("this is me, the hero", "player", "static"),
    ("my hero who walks and jumps", "player", "static"),
])
def test_keyword_describer_kinds(text: str, kind: str, behavior: str) -> None:
    res = describe("Thing", text)
    assert res["kind"] == kind and res["behavior"]["kind"] == behavior, res


def test_keyword_describer_details() -> None:
    lift = describe("Lift", "a platform that goes up and down 5 blocks")["behavior"]
    assert lift["dir"] == "up" and lift["cells"] == 5 and lift["mode"] == "pingpong"
    star = describe("Zoomy", "a star that makes you fast for 8 seconds and comes back")["behavior"]
    assert star == {**star, "item": "star", "effect": "speed", "seconds": 8.0, "respawn_s": 5.0}
    for text, effect in [("a gem that freezes enemies", "freeze"), ("a potion that flips gravity", "flip"),
                         ("a heart that heals you", "heart"), ("a feather that makes you jump higher", "jump"),
                         ("an apple worth 10 points", "score"), ("a moon rock pickup that makes you float", "low_gravity")]:
        assert describe("P", text)["behavior"]["effect"] == effect, text
    for text, zone in [("an icy slippery floor", "ice"), ("water you can swim in", "water"),
                       ("a conveyor belt going left", "conveyor"), ("sticky mud that slows you down", "slow"),
                       ("a zone with low gravity", "low_gravity"), ("windy air", "wind")]:
        assert describe("Z", text)["behavior"]["effect"] == zone, text
    belt = describe("Belt", "a conveyor belt going left")["behavior"]
    assert belt["dir"] == "left"
    npc = describe("Bob", 'a wizard who says "Find the key!" and "Good luck"')["behavior"]
    assert npc["lines"] == ["Find the key!", "Good luck"] and npc["name"] == "Bob"
    assert describe("Shop", "a shopkeeper that says hello there")["behavior"]["lines"] == ["hello there"]
    assert describe("Cloud", "a cloud you can jump through")["collision"] == "one_way"


def test_keyword_describer_reports_unknown_parts() -> None:
    res = describe("Grumpo", "a frog that hops and explodes when you touch it")
    assert res["kind"] == "creature" and res["behavior"]["archetype"] == "hopper"
    assert res["unknown"] == ["explodes when you touch it"]
    assert describe("Lift", "a platform that goes back and forth")["unknown"] == []


def test_keyword_describer_rule_packs_use_the_core_parser() -> None:
    async def rpc(method: str, params: dict[str, Any], timeout: float | None) -> Any:
        assert method == "parse_logic" and params["sentences"] == ["Press space to flip gravity", "Get all coins to win"]
        return {"rules": [{"id": "r1", "when": {"kind": "key", "key": "space"}, "then": [{"kind": "flip_gravity"}]},
                          {"id": "r2", "when": {"kind": "all_coins"}, "then": [{"kind": "win"}]}],
                "mode": None, "unknown": [], "source": "keywords"}

    res = describe("Flip", "Press space to flip gravity. Get all coins to win!", rpc=rpc)
    assert res["kind"] == "rules" and res["behavior"] is None and [r["id"] for r in res["logic"]] == ["r1", "r2"]

    async def down(method: str, params: dict[str, Any], timeout: float | None) -> Any:
        raise CoreError("internal", "NotImplemented: parseLogic")

    res = describe("Flip", "space flips gravity", rpc=down)
    assert res["kind"] == "rules" and res["logic"] == [] and res["unknown"] == ["space flips gravity"]


def flat_rule(sentence: int, when: dict[str, Any], then: list[dict[str, Any]], once: bool = False) -> mlogic.FlatRule:
    w = {"kind": "start", "key": "none", "target": "", "item": "", "seconds": 0, "every": False, "rect": [],
         "at_least": 0, "name": "", **when}
    dos = [{"kind": "win", "times": 0, "seconds": 0, "to_cell": [], "target": "", "to": "none", "n": 0, "name": "",
            "text": "", "sound": "none", **d} for d in then]
    return mlogic.FlatRule.model_validate({"sentence": sentence, "when": w, "then": dos, "once": once})


def test_logic_sanitizer_clamps_and_numbers_rules() -> None:
    flat = mlogic.LogicFlat(rules=[
        flat_rule(2, {"kind": "collect", "item": "Stars!"}, [{"kind": "add_counter", "name": "stars", "n": 0}]),
        flat_rule(0, {"kind": "key", "key": "space"}, [{"kind": "flip_gravity"}]),
        flat_rule(1, {"kind": "touch", "target": "door_9"}, [{"kind": "win"}]),  # not an entity of this level
        flat_rule(3, {"kind": "timer", "seconds": 9000, "every": True},
                  [{"kind": "speed", "times": 12, "seconds": 0}, {"kind": "sound", "sound": "none"}]),
        flat_rule(2, {"kind": "counter", "name": "stars", "at_least": 5}, [{"kind": "win"}]),
    ], mode="flappy", mode_sentence=4, unknown=[1])
    sentences = ["space flips gravity", "touch the door to win", "collect 5 stars to win", "every 9000 s go fast",
                 "it's like flappy bird", "lava rises"]
    out = mlogic.from_flat(flat, sentences, ["e_door"])
    LogicParseResult.model_validate(out.as_result())
    assert [r["id"] for r in out.rules] == ["r1", "r2", "r3", "r4"]
    assert out.rules[0]["when"] == {"kind": "key", "key": "space"}
    assert out.rules[1]["when"] == {"kind": "collect", "item": "stars"} and out.rules[1]["then"][0]["n"] == 1
    assert out.rules[3]["when"] == {"kind": "timer", "seconds": 600.0, "every": True}
    assert out.rules[3]["then"] == [{"kind": "speed", "times": 3.0}, {"kind": "sound", "name": "ding"}]
    assert out.mode == "flappy" and out.unknown == ["touch the door to win", "lava rises"]


def test_logic_parse_uses_the_model_then_the_core_then_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    flat = mlogic.LogicFlat(rules=[flat_rule(0, {"kind": "key", "key": "action"}, [{"kind": "speed", "times": 1.6}])],
                            mode="none", mode_sentence=-1, unknown=[])

    async def model(sentences: list[str], ids: list[str], **_: Any) -> MindResult[Any]:
        return MindResult[mlogic.LogicFlat](kind="logic_parse", status="ok", value=flat)

    monkeypatch.setattr(client, "available", lambda: True)
    monkeypatch.setattr(mlogic, "logic_call", model)
    out = asyncio.run(mlogic.parse(["enter makes you fast"]))
    assert out.source == "model" and out.rules[0]["when"] == {"kind": "key", "key": "action"}

    async def failed(sentences: list[str], ids: list[str], **_: Any) -> MindResult[Any]:
        return MindResult[mlogic.LogicFlat](kind="logic_parse", status="failed", error="timeout")

    async def core(method: str, params: dict[str, Any], timeout: float | None) -> Any:
        return {"rules": [{"id": "r1", "when": {"kind": "key", "key": "action"}, "then": [{"kind": "speed", "times": 1.6}]},
                          {"id": "bad", "when": {"kind": "nope"}, "then": []}],
                "mode": "runner", "unknown": [], "source": "keywords"}

    monkeypatch.setattr(mlogic, "logic_call", failed)
    out = asyncio.run(mlogic.parse(["enter makes you fast", "runner"], rpc=core))
    assert out.source == "keywords" and len(out.rules) == 1 and out.mode == "runner"

    async def down(method: str, params: dict[str, Any], timeout: float | None) -> Any:
        raise CoreError("internal", "NotImplemented: parseLogic")

    out = asyncio.run(mlogic.parse(["enter makes you fast"], rpc=down))
    assert out.as_result() == {"rules": [], "mode": None, "unknown": ["enter makes you fast"], "source": "keywords"}


def test_build_logic_plumbing() -> None:
    assert logic_input({}) == {} and logic_input({"logic": None}) == {}
    rules = [{"id": "r1", "when": {"kind": "key", "key": "space"}, "then": [{"kind": "flip_gravity"}], "once": False}]
    assert logic_input({"logic": {"rules": rules, "mode": None}}) == {"logic": rules}
    assert logic_input({"logic": {"rules": [], "mode": "flappy"}}) == {"logic": [], "mode": "flappy"}
    state = {"edits": {"parser": {"0": [{"id": "p0"}], "1": [{"id": "p1"}]}, "perception": [], "accepted": [], "kid": []},
             "logic_sentences": ["0"]}
    assert [e["id"] for e in intent_edits(state, understood=False)] == ["p1"]


@pytest.fixture
def data_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> Any:
    from app import config

    monkeypatch.setenv("DAL_DATA_DIR", str(tmp_path))
    config.get_settings.cache_clear()
    config.get_settings_v2.cache_clear()
    yield tmp_path
    monkeypatch.undo()
    config.get_settings.cache_clear()
    config.get_settings_v2.cache_clear()


def test_build_adopts_the_model_logic(monkeypatch: pytest.MonkeyPatch, data_dir: Any) -> None:
    """A build with typed rules and the model on: LOGIC runs, its rules become BuildInput.logic / mode, and the
    sentences it made into rules stop contributing v2 parser edits."""
    from app.build import drafts
    from app.build.orchestrator import BuildRequest, Run
    from app.spec.api import BuildInputJson

    flat = mlogic.LogicFlat(rules=[flat_rule(1, {"kind": "key", "key": "space"}, [{"kind": "flip_gravity"}])],
                            mode="flappy", mode_sentence=2, unknown=[0])
    seen: list[list[str]] = []

    async def model(sentences: list[str], ids: list[str], **_: Any) -> MindResult[Any]:
        seen.append(sentences)
        return MindResult[mlogic.LogicFlat](kind="logic_parse", status="ok", value=flat)

    monkeypatch.setattr(mlogic, "logic_call", model)

    class Sink:
        def emit(self, event: str, data: dict[str, Any]) -> int:
            return 1

        def closed(self) -> bool:
            return False

    draft = drafts.new_draft_id()
    drafts.draft_dir(draft).mkdir(parents=True)
    drafts.save_state(draft, drafts.new_state(draft, "canvas"))
    run = Run(BuildRequest(build_id="b_00000001", draft_id=draft), Sink())  # type: ignore[arg-type]
    run.ink = {"v": 2, "source": "canvas", "world": {"screens": 1, "w": 48, "h": 27}, "strokes": [], "components": [],
               "character": None, "rules_ink": [], "sheets": [], "noise": {"count": 0}, "parent": None,
               "typed_rules": [{"text": "the platform moves"}, {"text": "  "}, {"text": "space flips gravity"},
                               {"text": "it's like flappy bird"}]}
    assert run.typed_sentences() == [(0, "the platform moves"), (2, "space flips gravity"), (3, "it's like flappy bird")]

    async def go() -> None:
        await run.adopt_logic(asyncio.create_task(run.logic_call()))

    asyncio.run(go())
    assert seen == [["the platform moves", "space flips gravity", "it's like flappy bird"]]
    assert run.state["logic"]["mode"] == "flappy" and run.state["logic"]["rules"][0]["id"] == "r1"
    assert run.state["logic_sentences"] == ["2", "3"]  # ink.typed_rules indexes, not model indexes
    inp = run.base_input([])
    assert inp["mode"] == "flappy" and inp["logic"][0]["when"] == {"kind": "key", "key": "space"}
    assert {"logic", "mode"} <= set(BuildInputJson.model_fields)
    TypeAdapter(list[RuleV4]).validate_python(inp["logic"])


def flat_block(kind: str, behavior: dict[str, Any], **over: Any) -> mblock.BlockSpecFlat:
    b = {"kind": "static", "archetype": "none", "speed": "none", "dir": "none", "cells": 0, "strength": "none",
         "zone": "none", "effect": "none", "item": "", "seconds": 0, "respawns": False, "pair": "", "lines": [], **behavior}
    return mblock.BlockSpecFlat.model_validate({"kind": kind, "behavior": b, "spiky": False, "collision": "none",
                                                "rules": [], "summary": "It does a thing.", "unknown": [],
                                                "safety_ok": True, **over})


def test_block_describe_model_answers_are_cleaned(monkeypatch: pytest.MonkeyPatch) -> None:
    lift = mblock.from_model(flat_block("platform", {"kind": "move", "dir": "up", "cells": 99, "speed": "fast"}), "L", "")
    assert lift is not None and lift["behavior"] == {"kind": "move", "dir": "up", "cells": 20.0, "speed": 3.5,
                                                     "mode": "pingpong", "wait_s": 0.3}
    star = mblock.from_model(flat_block("pickup", {"kind": "pickup", "item": "Gold Star!", "effect": "jump",
                                                   "seconds": 900}), "S", "")
    assert star["behavior"]["item"] == "gold star" and star["behavior"]["seconds"] == 60.0
    npc = mblock.from_model(flat_block("prop", {"kind": "npc", "lines": ["Hi there", "shit"]}), "Bob", "")
    assert npc["behavior"]["lines"] == ["Hi there"] and npc["behavior"]["name"] == "Bob"
    assert mblock.from_model(flat_block("prop", {"kind": "zone", "zone": "none"}), "Z", "") is None  # → keywords
    assert mblock.from_model(flat_block("rules", {}), "R", "") is None  # a rule pack with no usable rule
    pack = mblock.from_model(flat_block("rules", {}, rules=[flat_rule(0, {"kind": "all_coins"}, [{"kind": "win"}])]), "R", "")
    assert pack["kind"] == "rules" and pack["behavior"] is None and pack["logic"][0]["id"] == "r1"
    assert mblock.from_model(flat_block("creature", {"kind": "enemy"}, safety_ok=False), "X", "") is None

    async def call(name: str, text: str, image: Any, **_: Any) -> MindResult[Any]:
        return MindResult[mblock.BlockSpecFlat](kind="block_describe", status="ok",
                                                value=flat_block("creature", {"kind": "enemy", "archetype": "flyer"}))

    monkeypatch.setattr(client, "available", lambda: True)
    monkeypatch.setattr(mblock, "describe_call", call)
    res = asyncio.run(mblock.describe("Bat", "it flies", []))
    assert res["source"] == "model" and res["behavior"]["archetype"] == "flyer"
    BlockDescribeResult.model_validate(res)
