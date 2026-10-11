"""Server-side validation of copilot edits (docs/v6/CONTRACTS_V6.md §5.2, §5.3): shapes, catalog types, clamps,
targets, fresh ids, ask_draw folding and the limits. Every edit that survives must apply as a valid StudioEdit."""
from __future__ import annotations

import json
from typing import Any

from app.spec.studio import ObjectDef, StudioEdit
from app.studio import catalog
from app.studio.edits import MAX_EDITS, validate_edits
from tests import test_studio_fixtures as F


def run(edits: list[dict[str, Any]], doc: dict[str, Any] | None = None, scene: str = "s1"):
    d = doc or F.car_scene()
    out, warnings = validate_edits(edits, d, scene)
    for e in out:
        StudioEdit.model_validate(e)
    return out, warnings


def test_catalog_renders_every_type() -> None:
    text = catalog.render()
    for section in ("behaviors", "events", "actions"):
        for e in catalog.load()[section]:
            assert f"- {e['type']}:" in text
    assert "speed=280 [40..1200]" in text and "key=(action|space|action2|auto|click) def space" in text
    assert "hill climb racer" in text and "needs 2 wheel objects" in text


def test_update_object_partial_and_clamped() -> None:
    out, _ = run([{"action": "update_object", "target": "o2", "data": {
        "kind": "Car", "physics": {"body": "dynamic", "density": 999, "friction": -3, "bogus": 1, "shape": "line"},
        "behaviors": [{"type": "car", "params": {"power": 99, "max_speed": "fast", "nope": 3, "fuel_counter": "Fuel!"}},
                      {"type": "teleporter"}],
        "counters": {"Fuel": 100, "bad name!": 3, "1x": 2}, "tags": ["Player", "player", "!!"],
        "drawing": {"strokes": [{"points": [[0, 0]]}], "w": 10, "h": 5}, "player": 7, "colour": "red"}}])
    assert len(out) == 1
    d = out[0]["data"]
    assert d["kind"] == "car"
    assert d["physics"] == {"body": "static", "shape": "line", "density": 50, "friction": 0}  # line forces static
    assert d["behaviors"] == [{"id": "b1", "type": "car", "params": {"power": 3, "fuel_counter": "fuel"}}]
    assert d["counters"] == {"fuel": 100, "bad name": 3, "x": 2}
    assert d["tags"] == ["player"]
    assert d["drawing"] == {"w": 10, "h": 5}  # strokes are never accepted
    assert d["player"] == 2 and "colour" not in d


def test_create_needs_box_and_position_and_gets_defaults() -> None:
    out, _ = run([{"action": "update_object", "target": "spawner1",
                   "data": {"kind": "spawner", "behaviors": [{"type": "spawner", "params": {"template": "o5",
                                                                                            "every": 0.0001}}]}},
                  {"action": "add_behavior", "target": "spawner1", "data": {"type": "rotate"}}])
    assert [e["action"] for e in out] == ["update_object", "add_behavior"]
    d = out[0]["data"]
    assert d["drawing"] == {"w": 120.0, "h": 120.0} and d["x"] == 800 and d["y"] == 450
    assert d["behaviors"][0]["params"] == {"template": "o5", "every": 0.05}
    assert out[1]["data"]["id"] == "b2"  # unique after the created object's b1
    ObjectDef.model_validate({"id": "spawner1", **d})


def test_unknown_targets_types_and_actions_are_dropped() -> None:
    out, warnings = run([
        {"action": "add_behavior", "target": "ghost", "data": {"type": "rotate"}},
        {"action": "add_behavior", "target": "o2", "data": {"type": "laser_eyes"}},
        {"action": "explode", "target": "o2", "data": {}},
        {"action": "delete_object", "target": "nope", "data": {}},
        {"action": "add_rule", "target": "o2", "data": {"when": {"type": "on_tuesday"}, "then": [{"type": "win"}]}},
        {"action": "add_rule", "target": "o2", "data": {"when": {"type": "start"}, "then": [{"type": "dance"}]}},
        {"action": "update_behavior", "target": "o2", "data": {"type": "platformer", "params": {"speed": 1}}},
        {"action": "set_title", "data": {"title": ""}},
        {"action": "add_joint", "target": "o2", "data": {"type": "glue", "to": "o3"}},
        {"action": "add_joint", "target": "o2", "data": {"type": "wheel", "to": "o2"}},
        {"action": "update_object", "target": "bad id!", "data": {"kind": "x"}},
        {"action": "set_world", "data": "not json"},
    ])
    assert out == [] and len(warnings) >= 6


def test_data_json_strings_are_parsed() -> None:
    out, _ = run([{"action": "set_world", "target": "", "data_json": json.dumps({"gravity": [0, 99], "edges": "wrap",
                                                                                 "width": 10, "camera": {
            "mode": "follow", "target": "o2", "zoom": 0}})},
                  {"action": "set_title", "data": '```json\n{"title": "Hill Climb Racer"}\n```'}])
    assert out[0]["data"] == {"width": 320, "gravity": [0, 5], "edges": "wrap",
                              "camera": {"mode": "follow", "target": "o2", "zoom": 0.15}}
    assert out[1]["data"] == {"title": "Hill Climb Racer"}


def test_rules_scopes_ids_and_params() -> None:
    doc = F.doc([dict(F.BOX, rules=[{"id": "r1", "when": {"type": "start"}, "then": [{"type": "win"}]}])],
                rules=[{"id": "r1", "when": {"type": "start"}, "then": [{"type": "lose"}]}])
    out, _ = run([
        {"action": "add_rule", "target": None, "data": {
            "id": "r1", "when": {"type": "every", "params": {"seconds": -4}},
            "conditions": [{"subject": "game", "counter": "Score", "op": "=>", "value": "3"}, {"counter": "!!"}],
            "then": [{"type": "add", "params": {"counter": "score", "amount": 1}}, {"type": "nope"},
                     {"type": "say", "params": {"text": "Hello there"}}], "text": "every so often"}},
        {"action": "add_rule", "target": "@scene", "data": {"when": {"type": "all_gone", "params": {"tag": "Enemy"}},
                                                            "then": "win"}},
        {"action": "add_rule", "target": "o2", "data": {"id": "r1", "when": "clicked", "then": [{"type": "destroy"}]}},
        {"action": "update_rule", "target": "@game", "data": {"id": "r1", "once": True}},
        {"action": "remove_rule", "target": "o2", "data": {"id": "r1"}},
        {"action": "update_rule", "target": "o2", "data": {"id": "r1", "off": True}},  # just removed: dropped
    ], doc)
    assert [(e["action"], e["target"]) for e in out] == [("add_rule", "@game"), ("add_rule", "@scene"),
                                                         ("add_rule", "o2"), ("update_rule", "@game"),
                                                         ("remove_rule", "o2")]
    g = out[0]["data"]
    assert g["id"] == "r2"  # r1 is taken in the game scope: renamed
    assert g["when"] == {"type": "every", "params": {"seconds": 0.05}}
    assert g["conditions"] == [{"subject": "game", "counter": "score", "op": ">=", "value": 3}]
    assert [a["type"] for a in g["then"]] == ["add", "say"] and g["text"] == "every so often"
    assert out[1]["data"]["when"]["params"] == {"tag": "enemy"} and out[1]["data"]["then"] == [
        {"type": "win", "params": {}}]
    assert out[2]["data"]["id"] != "r1"
    assert out[3]["data"] == {"id": "r1", "once": True}


def test_behaviour_update_remove_by_id_or_type() -> None:
    doc = F.doc([dict(F.GUY, behaviors=[{"id": "b1", "type": "platformer", "params": {}},
                                        {"id": "hp", "type": "health", "params": {"max": 3}}])])
    out, _ = run([
        {"action": "update_behavior", "target": "o7", "data": {"type": "platformer", "params": {"jump": 99999,
                                                                                               "double_jump": "yes"}}},
        {"action": "update_behavior", "target": "o7", "data": {"id": "hp", "off": True}},
        {"action": "remove_behavior", "target": "o7", "data": {"type": "health"}},
        {"action": "remove_behavior", "target": "o7", "data": {"type": "health"}},
    ], doc)
    assert out[0]["data"] == {"id": "b1", "params": {"jump": 2000, "double_jump": True}}
    assert out[1]["data"] == {"id": "hp", "off": True}
    assert out[2]["data"] == {"id": "hp"} and len(out) == 3


def test_theme_presets_and_partials() -> None:
    out, _ = run([{"action": "set_theme", "data": {"preset": "spooky_night"}},
                  {"action": "set_theme", "data": {"palette": {"bg": "#000", "ink": "nope"}, "stroke": {
                      "style": "neon", "glow": True, "width_scale": 9}, "particles": "lasers", "font": "pixel"}},
                  {"action": "set_theme", "data": {"preset": "no such theme"}}])
    assert len(out) == 2
    spooky = out[0]["data"]  # no themes.json preset with that id → the built-in palette, expanded
    assert spooky.get("preset") == "spooky_night" or spooky["name"] == "Spooky Night"
    assert out[1]["data"] == {"palette": {"bg": "#000000"}, "stroke": {"style": "neon", "width_scale": 4,
                                                                       "glow": True}, "font": "pixel"}


def test_hud_and_counters() -> None:
    out, _ = run([{"action": "set_hud", "data": {"items": [{"subject": "player1", "counter": "Fuel", "style": "bar",
                                                            "max": 100}, {"counter": ""}, {"subject": "?!", "counter":
                                                                                            "score", "style": "huge"}],
                                                 "timer": True}},
                  {"action": "set_game_counters", "data": {"counters": {"Lives": 3, "x": "many"}}},
                  {"action": "set_counters", "target": "o2", "data": {"counters": {"fuel": None, "coins": 2}}}])
    hud = out[0]["data"]
    assert [(i["subject"], i["counter"], i["style"]) for i in hud["items"]] == [("player1", "fuel", "bar"),
                                                                                ("game", "score", "number")]
    assert hud["timer"] is True
    assert out[1]["data"] == {"counters": {"lives": 3}}
    assert out[2]["data"] == {"counters": {"fuel": None, "coins": 2}}


def test_ask_draw_folding_ids_and_limits() -> None:
    edits = [
        {"action": "add_joint", "target": "o2", "data": {"type": "wheel", "to": "wheel_back", "motor": True}},
        {"action": "add_behavior", "target": "car2", "data": {"type": "car"}},  # before its ask: still folded
        {"action": "ask_draw", "data": {"id": "car2", "prompt": "Draw your car", "object": {
            "kind": "car", "physics": {"body": "dynamic"}, "drawing": {"strokes": [1]}}}},
        {"action": "ask_draw", "data": {"id": "o2", "prompt": "", "object": {"kind": "wheel"}}},  # id taken: renamed
        {"action": "ask_draw", "data": {"id": "wheel_back", "prompt": "Draw the back wheel", "object": {}}},
        {"action": "ask_draw", "data": {"id": "extra", "prompt": "One too many", "object": {}}},
        {"action": "set_counters", "target": "car2", "data": {"counters": {"fuel": 50}}},
        {"action": "add_joint", "target": "car2", "data": {"type": "wheel", "to": "wheel_back"}},
    ]
    out, warnings = run(edits)
    asks = [e for e in out if e["action"] == "ask_draw"]
    assert [a["data"]["id"] for a in asks] == ["car2", "o22", "wheel_back"]
    assert asks[1]["data"]["prompt"] == "Draw the wheel"
    car = asks[0]["data"]["object"]
    assert car["behaviors"][0]["type"] == "car" and car["counters"] == {"fuel": 50}
    assert car["joints"][0]["to"] == "wheel_back" and "drawing" not in car
    assert [e["action"] for e in out if e["action"] != "ask_draw"] == ["add_joint"]  # the joint to an ask id stays
    assert any("3 ask_draw" in w for w in warnings)


def test_add_scene_and_scene_targets() -> None:
    out, _ = run([{"action": "add_scene", "data": {"id": "s1", "name": "Level 2", "copy_from": "s1",
                                                   "world": {"kind": "platformer", "width": 3200}}},
                  {"action": "update_object", "target": "o2", "scene": "s2", "data": {"kind": "box"}},
                  {"action": "update_object", "target": "o2", "scene": "nope", "data": {"kind": "box"}}])
    assert out[0]["data"]["id"] == "s2" and out[0]["data"]["copy_from"] == "s1"
    assert out[1]["scene"] == "s2" and out[2]["scene"] is None


def test_at_most_40_edits_and_blocklisted_text() -> None:
    many = [{"action": "duplicate_object", "target": "o2", "data": {"count": 999, "dx": 5}}] * 60
    out, _ = run(many)
    assert len(out) == MAX_EDITS and out[0]["data"] == {"count": 50, "dx": 5}
    out, _ = run([{"action": "set_title", "data": {"title": "call me at 555-123-4567"}},
                  {"action": "add_rule", "target": "o2", "data": {"when": {"type": "start"}, "then": [
                      {"type": "say", "params": {"text": "email me at kid@example.com"}}]}}])
    assert out == []
