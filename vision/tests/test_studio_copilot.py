"""The Studio copilot (docs/v6/CONTRACTS_V6.md §5.3): every keyword fallback path (model off), the model path with a
monkeypatched client.call, failures falling back to keywords, DAL_FAKE_LLM replies, and the game summary."""
from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

import pytest

from app.mind import client
from app.mind.client import MindResult
from app.spec.studio import RecognizeResult, StudioChatResult, StudioTheme, ThemeResult
from app.studio import assets, copilot, summary
from tests import test_studio_fixtures as F

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 64).decode()


@pytest.fixture(autouse=True)
def model_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DAL_FAKE_LLM", raising=False)


def chat(msg: str, doc: dict[str, Any] | None = None, selection: list[str] | None = None) -> dict[str, Any]:
    body = {"game": doc or F.doc([F.HILL, F.BOX, F.WHEEL_A, F.WHEEL_B, F.GUY]), "scene": "s1",
            "selection": selection or [], "message": msg, "history": []}
    res = asyncio.run(copilot.chat(body))
    StudioChatResult.model_validate(res)
    return res


def actions(res: dict[str, Any]) -> list[tuple[str, str | None]]:
    return [(e["action"], e["target"]) for e in res["edits"]]


def obj_edit(res: dict[str, Any], oid: str) -> dict[str, Any]:
    return next(e["data"] for e in res["edits"] if e["action"] == "update_object" and e["target"] == oid)


# ---- summary ------------------------------------------------------------------------------------------------------


def test_summary_has_shapes_colours_and_no_strokes() -> None:
    doc = F.doc([F.HILL, F.BOX, F.WHEEL_A, dict(F.BLOB_BLUE, behaviors=[{"id": "b1", "type": "patrol",
                                                                         "params": {"range": 200, "speed": 50}}])])
    text = summary.game_summary(doc, "s1", ["o2"])
    assert "o1 kind=thing at (800,760) size 1400x100 | looks like: a long line | colours: green #3bb273" in text
    assert "looks like: 1 box" in text and "looks like: 1 circle" in text
    assert "behaviours: b1:patrol(speed=50)" in text  # only the params that differ from the default
    assert "SELECTED" in text and "o2" in text.split("SELECTED")[1]
    assert "points" not in text and "-700" not in text
    assert summary.colour_name("#2e86ab") in ("teal", "blue", "cyan") and summary.colour_name("#d7263d") == "red"


# ---- keyword fallbacks: chat --------------------------------------------------------------------------------------


@pytest.mark.parametrize("msg,world,theme", [
    ("Reimagine the canvas as a hill climb racer", "hill climb racer", "desert_dunes"),
    ("make it a fighting game", "fighting game", "comic_pop"),
    ("turn this into a space shooter", "space shooter", "deep_space"),
    ("make a platformer like mario", "platformer", "crayon_kids"),
    ("turn it into angry birds", "physics puzzle", "sketchbook"),
    ("make it a catch game", "catch game", "candy"),
    ("let's make flappy bird", "flappy", "pixel_retro"),
    ("reimagine as an endless runner", "endless runner", "neon_arcade"),
    ("make it a zelda style top-down game", "top-down", "jungle"),
])
def test_keyword_reimagine_every_game_kind(msg: str, world: str, theme: str) -> None:
    res = chat(msg)
    assert res["source"] == "keywords" and res["edits"] and 2 <= len(res["suggestions"]) <= 4
    w = next(e["data"] for e in res["edits"] if e["action"] == "set_world")
    assert w["kind"] == world
    th = next(e["data"] for e in res["edits"] if e["action"] == "set_theme")
    assert th.get("preset", th.get("id")) == theme
    assert any(a == "set_hud" for a, _ in actions(res))
    assert sum(1 for a, _ in actions(res) if a == "ask_draw") <= 3
    assert len(res["reply"].split()) <= 40


def test_racer_repurposes_box_wheels_and_hill() -> None:
    res = chat("reimagine the canvas as a hill climb racer")
    car = obj_edit(res, "o2")
    assert car["kind"] == "car" and car["player"] == 1 and car["behaviors"][0]["type"] == "car"
    assert car["behaviors"][0]["params"]["fuel_counter"] == "fuel" and car["counters"]["fuel"] == 100
    assert obj_edit(res, "o1")["physics"]["shape"] == "line"
    assert obj_edit(res, "o3")["kind"] == "wheel" and obj_edit(res, "o4")["kind"] == "wheel"
    joints = [e["data"] for e in res["edits"] if e["action"] == "add_joint"]
    assert {j["to"] for j in joints} == {"o3", "o4"} and all(j["motor"] for j in joints)
    assert next(e["data"] for e in res["edits"] if e["action"] == "set_world")["camera"]["target"] == "o2"
    assert not any(a == "ask_draw" for a, _ in actions(res))


def test_reimagine_on_an_empty_canvas_asks_to_draw() -> None:
    res = chat("make a hill climb racer", F.doc([]))
    asks = [e["data"] for e in res["edits"] if e["action"] == "ask_draw"]
    assert [a["id"] for a in asks] == ["car", "wheel_back", "wheel_front"]
    assert asks[0]["object"]["behaviors"][0]["type"] == "car"
    assert len(asks[0]["object"]["joints"]) == 2  # joints from the car to the wheels folded into the car's ask
    assert any(e["action"] == "update_object" and e["target"] == "floor" for e in res["edits"])  # invisible floor
    assert "Draw your car" in res["reply"]


def test_make_this_an_archetype_uses_the_selection() -> None:
    res = chat("make this a car", selection=["o2"])
    assert obj_edit(res, "o2")["kind"] == "car"
    assert {e["data"]["to"] for e in res["edits"] if e["action"] == "add_joint"} == {"o3", "o4"}
    res = chat("make this a car", F.doc([F.BOX]), selection=["o2"])
    assert [e["data"]["id"] for e in res["edits"] if e["action"] == "ask_draw"] == ["wheel_back", "wheel_front"]


def test_colour_words_find_objects_and_modifiers_apply() -> None:
    doc = F.doc([F.HILL, F.BLOB_BLUE, F.BLOB_BLUE2, dict(F.GUY, player=1, tags=["player"])])
    res = chat("the blue blobs are enemies that shoot at me", doc)
    for oid in ("o5", "o6"):
        d = obj_edit(res, oid)
        types = [b["type"] for b in d["behaviors"]]
        assert d["tags"] == ["enemy"] and "shooter" in types and "damage" in types
        sh = next(b for b in d["behaviors"] if b["type"] == "shooter")
        assert sh["params"]["key"] == "auto" and sh["params"]["direction"] == "player"
    assert "o7" not in [t for _, t in actions(res)]  # the player is not touched


def test_add_an_archetype_asks_to_draw_it() -> None:
    res = chat("add a coin", selection=["o7"])
    assert actions(res) == [("ask_draw", None)]
    assert res["edits"][0]["data"]["object"]["kind"] == "coin" and "Draw a coin" in res["reply"]


def test_gravity_words() -> None:
    for msg, g in [("turn gravity off", [0, 0]), ("low gravity please", [0, 0.4]), ("flip the gravity", [0, -1]),
                   ("stronger gravity", [0, 2]), ("normal gravity", [0, 1])]:
        res = chat(msg)
        assert res["edits"] == [{"action": "set_world", "target": None, "scene": None, "data": {"gravity": g}}], msg
    res = chat("pressing space flips gravity")
    rule = res["edits"][0]
    assert rule["action"] == "add_rule" and rule["target"] == "@game"
    assert rule["data"]["when"] == {"type": "key_down", "params": {"key": "space"}}
    assert not any(e["action"] == "set_theme" for e in res["edits"])  # "space" is the key, not the theme


def test_lives_health_sword_and_speed() -> None:
    doc = F.doc([dict(F.GUY, player=1, tags=["player"], behaviors=[
        {"id": "b1", "type": "platformer", "params": {}}, {"id": "b2", "type": "health", "params": {"on_zero": "lose"}}])])
    res = chat("give the player 3 lives and a sword", doc)
    a = actions(res)
    assert ("set_game_counters", None) in a and ("add_behavior", "o7") in a and ("add_rule", "@game") in a
    assert next(e for e in res["edits"] if e["action"] == "set_game_counters")["data"] == {"counters": {"lives": 3}}
    assert next(e for e in res["edits"] if e["action"] == "add_behavior")["data"]["type"] == "melee"
    hud = next(e for e in res["edits"] if e["action"] == "set_hud")["data"]
    assert hud["items"][0] == {"subject": "game", "counter": "lives", "label": None, "style": "hearts", "max": 3}
    upd = next(e for e in res["edits"] if e["action"] == "update_behavior")["data"]
    assert upd == {"id": "b2", "params": {"on_zero": "respawn"}}
    res = chat("give it 7 health", doc, selection=["o7"])
    assert next(e for e in res["edits"] if e["action"] == "update_behavior")["data"] == {"id": "b2",
                                                                                           "params": {"max": 7}}
    res = chat("make it faster and jump higher", doc, selection=["o7"])
    params = [e["data"]["params"] for e in res["edits"] if e["action"] == "update_behavior"]
    assert {"speed": 420.0} in params and {"jump": 864} in params


def test_archetype_plus_health_in_one_message_does_not_double_up() -> None:
    res = chat("make this the player and give it 5 health and a sword", F.doc([F.GUY]), selection=["o7"])
    d = obj_edit(res, "o7")
    types = [b["type"] for b in d["behaviors"]]
    assert types.count("health") == 1 and "melee" in types
    assert next(b for b in d["behaviors"] if b["type"] == "health")["params"]["max"] == 5
    assert d["counters"]["health"] == 5


def test_theme_words_and_rephrase() -> None:
    res = chat("make it spooky")
    assert res["edits"][0]["action"] == "set_theme" and "Spooky Night" in res["reply"]
    res = chat("asdf qwerty")
    assert res["edits"] == [] and len(res["suggestions"]) == 3 and res["source"] == "keywords"
    res = chat("you are a stupid idiot")  # blocklisted words
    assert res["edits"] == []


def test_keyword_theme_uses_themes_json_when_present(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    themes = {"themes": [dict(assets.builtin_theme("neon_arcade"), id="neon-arcade", x_keywords=["glowy"]),
                         dict(assets.builtin_theme("sketchbook"))]}
    p = tmp_path / "themes.json"
    p.write_text(json.dumps(themes), encoding="utf-8")
    monkeypatch.setattr(assets, "THEMES_PATH", p)
    assert [t["id"] for t in assets.themes()] == ["neon-arcade", "sketchbook"]
    res = chat("make it look glowy")
    assert res["edits"][0]["data"] == {"preset": "neon-arcade"}
    res = chat("geometry dash style")
    assert res["edits"][0]["data"] == {"preset": "neon-arcade"}  # built-in keywords map onto the file's preset


# ---- keyword fallbacks: recognize and theme -----------------------------------------------------------------------


def test_recognize_and_theme_fallbacks() -> None:
    body = {"game": F.car_scene(), "scene": "s1", "object_id": "o2", "image_png": PNG}
    res = asyncio.run(copilot.recognize(body))
    RecognizeResult.model_validate(res)
    assert res == {"question": "What is this?", "name": "", "kind": "thing", "edits": [], "source": "keywords"}
    t = asyncio.run(copilot.theme({"text": "spooky halloween"}))
    ThemeResult.model_validate(t)
    assert t["source"] == "keywords" and t["theme"]["id"] == "spooky_night"
    t = asyncio.run(copilot.theme({"text": "something nobody has words for"}))
    assert t["theme"]["id"] == "sketchbook"
    t = asyncio.run(copilot.theme({"text": "hmm", "game_kind": "space shooter"}))
    assert t["theme"]["id"] == "deep_space"


# ---- the model path -----------------------------------------------------------------------------------------------


def fake_call(monkeypatch: pytest.MonkeyPatch, value: Any, status: str = "ok", seen: list[Any] | None = None) -> None:
    async def call(kind: str, schema: Any, content: list[dict[str, Any]], **_: Any) -> MindResult[Any]:
        if seen is not None:
            seen.append((kind, content))
        return MindResult[schema](kind=kind, status=status, value=value if status == "ok" else None)

    monkeypatch.setattr(client, "available", lambda: True)
    monkeypatch.setattr(client, "call", call)


def test_model_chat_validates_edits(monkeypatch: pytest.MonkeyPatch) -> None:
    flat = copilot.ChatFlat(edits=[
        copilot.FlatEdit(action="update_object", target="o2", scene="", data_json=json.dumps(
            {"kind": "car", "physics": {"body": "dynamic"}, "behaviors": [{"type": "car"}], "player": 1})),
        copilot.FlatEdit(action="add_behavior", target="o2", scene="", data_json='{"type": "teleport_anywhere"}'),
        copilot.FlatEdit(action="add_joint", target="o2", scene="", data_json='{"type": "wheel", "to": "o3", '
                                                                              '"motor": true}'),
        copilot.FlatEdit(action="set_title", target="", scene="", data_json="not json"),
        copilot.FlatEdit(action="ask_draw", target="", scene="", data_json=json.dumps(
            {"id": "flag", "prompt": "Draw a flag", "object": {"kind": "goal", "behaviors": [{"type": "goal"}]}})),
    ], reply="Your box is a car now! Press right to drive.", suggestions=["Add coins", "x" * 200, "Make it faster"])
    seen: list[Any] = []
    fake_call(monkeypatch, flat, seen=seen)
    body = {"game": F.car_scene(), "scene": "s1", "selection": ["o2"], "message": "make this a car",
            "history": [{"role": "user", "text": "hi"}, {"role": "copilot", "text": "Hello!"}], "snapshot_png": PNG}
    res = asyncio.run(copilot.chat(body))
    StudioChatResult.model_validate(res)
    assert res["source"] == "model" and res["reply"].startswith("Your box is a car")
    assert [e["action"] for e in res["edits"]] == ["ask_draw", "update_object", "add_joint"]
    assert len(res["suggestions"]) == 3 and len(res["suggestions"][1]) <= 60
    kind, content = seen[0]
    assert kind == "studio_chat"
    assert content[0].get("cache_control") == {"type": "ephemeral"} and "# CATALOG" in content[0]["text"]
    assert any(b["type"] == "image" for b in content)
    text = content[-1]["text"]
    assert "THE MAKER SAYS: make this a car" in text and "Maker: hi" in text and "SELECTED" in text


@pytest.mark.parametrize("status", ["failed", "refused", "truncated", "skipped"])
def test_model_failures_fall_back_to_keywords(monkeypatch: pytest.MonkeyPatch, status: str) -> None:
    fake_call(monkeypatch, None, status=status)
    res = chat("make it spooky")
    assert res["source"] == "keywords" and res["edits"][0]["action"] == "set_theme"
    body = {"game": F.car_scene(), "scene": "s1", "object_id": "o3", "image_png": PNG}
    assert asyncio.run(copilot.recognize(body))["source"] == "keywords"
    assert asyncio.run(copilot.theme({"text": "neon"}))["source"] == "keywords"


def test_model_recognize(monkeypatch: pytest.MonkeyPatch) -> None:
    flat = copilot.RecognizeFlat(question="Is this a wheel?", name="Wheel", kind="Wheel", edits=[
        copilot.FlatEdit(action="update_object", target="o3", scene="", data_json=json.dumps(
            {"kind": "wheel", "physics": {"body": "dynamic", "shape": "circle", "friction": 1.2}})),
        copilot.FlatEdit(action="add_joint", target="o2", scene="", data_json=json.dumps(
            {"type": "wheel", "to": "o3", "at": [-50, 60], "motor": True}))])
    seen: list[Any] = []
    fake_call(monkeypatch, flat, seen=seen)
    res = asyncio.run(copilot.recognize({"game": F.car_scene(), "scene": "s1", "object_id": "o3", "image_png": PNG}))
    RecognizeResult.model_validate(res)
    assert res["source"] == "model" and res["kind"] == "wheel" and res["question"] == "Is this a wheel?"
    assert [e["action"] for e in res["edits"]] == ["update_object", "add_joint"]
    text = seen[0][1][-1]["text"]
    assert "THE NEW DRAWING: o3" in text and "Near it:" in text and "o2" in text.split("Near it:")[1]


def test_model_theme_custom_contrast_and_preset(monkeypatch: pytest.MonkeyPatch) -> None:
    flat = copilot.ThemeFlat(preset="", name="Snowy Day", bg="#eaf4fb", ink="#f0f0f0", accent="#e63946",
                             accent2="#457b9d", text="#ffffff", danger="#d62828", good="#2a9d8f", background="hills",
                             background_colors=["#eaf4fb", "#ffffff", "oops"], stroke="marker", outline="",
                             width_scale=9, glow=False, halftone=False, wobble=0.1, recolor=False, particles="snow",
                             font="hand", music="calm")
    fake_call(monkeypatch, flat)
    res = asyncio.run(copilot.theme({"text": "winter snow"}))
    ThemeResult.model_validate(res)
    t = res["theme"]
    StudioTheme.model_validate(t)
    assert res["source"] == "model" and t["name"] == "Snowy Day" and t["particles"] == "snow"
    assert t["palette"]["ink"] == "#1f1b18" and t["palette"]["text"] == "#1f1b18"  # fixed: too pale on a pale bg
    assert t["background"]["colors"] == ["#eaf4fb", "#ffffff"] and t["stroke"]["width_scale"] == 4
    assert copilot.contrast(t["palette"]["ink"], t["palette"]["bg"]) >= 4.5
    fake_call(monkeypatch, flat.model_copy(update={"preset": "deep_space"}))
    assert asyncio.run(copilot.theme({"text": "space"}))["theme"]["id"] == "deep_space"


def test_fake_llm_replies(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    root = tmp_path / "replies"
    (root / "studio_chat").mkdir(parents=True)
    (root / "studio_chat" / "default.json").write_text(json.dumps({
        "edits": [{"action": "set_world", "target": "", "scene": "", "data_json": '{"gravity": [0, 0]}'}],
        "reply": "Everything floats now!", "suggestions": ["Turn gravity back on", "Add a spaceship"]}),
        encoding="utf-8")
    (root / "studio_theme").mkdir()
    (root / "studio_theme" / "default.json").write_text(json.dumps({"stop_reason": "refusal", "output": None}),
                                                        encoding="utf-8")
    monkeypatch.setenv("DAL_FAKE_LLM", "1")
    monkeypatch.setenv("DAL_FAKE_REPLIES_DIR", str(root))
    res = chat("no gravity please")
    assert res["source"] == "model" and res["edits"][0]["data"] == {"gravity": [0, 0]}
    assert asyncio.run(copilot.theme({"text": "spooky"}))["source"] == "keywords"  # refused → keywords
    body = {"game": F.car_scene(), "scene": "s1", "object_id": "o2", "image_png": PNG}
    assert asyncio.run(copilot.recognize(body))["source"] == "keywords"  # fake mode without a reply


def test_calls_are_registered_with_prompts() -> None:
    for kind, (effort, tokens, timeout) in {"studio_chat": ("medium", 8000, 40), "studio_recognize": ("low", 2500, 15),
                                            "studio_theme": ("low", 2000, 12)}.items():
        spec = client.CALLS[kind]
        assert (spec.effort, spec.max_tokens, spec.timeout_s) == (effort, tokens, timeout)
        assert len(client.system_prompt(kind).split()) >= 380
