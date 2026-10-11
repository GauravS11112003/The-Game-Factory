"""Creator briefs survive persistence and reach the builder and planner."""
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db_v2
from app.game_brief import brief_rules, resolve_guidance
from app.mind.plan import plan_content
from app.routers.v2 import builds, games, prompts
from app.spec.ink import InkDoc


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import sqlite3

    path = tmp_path / "dal.sqlite"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT, author TEXT, created_at TEXT)")
        conn.execute("CREATE TABLE levels (id TEXT PRIMARY KEY, json TEXT)")
    monkeypatch.setattr(db_v2, "db_path", lambda: path)
    monkeypatch.setattr(prompts.drafts, "draft_dir", lambda draft: tmp_path / draft)
    monkeypatch.setattr(prompts.drafts, "save_state", lambda *args: None)
    app = FastAPI()
    for router in (games.router, builds.router, prompts.router):
        app.include_router(router, prefix="/api/v2")
    return TestClient(app)


def create(client: TestClient, brief=None):
    body = {"title": "Forest Quest", "author": "Tester"}
    if brief is not None:
        body["brief"] = brief
    return client.post("/api/v2/games", json=body)


@pytest.mark.parametrize("category", ["action", "adventure", "rpg", "strategy", "simulation", "puzzle",
                                     "racing", "sports", "platformer", "survival", "custom"])
def test_categories_roundtrip(client: TestClient, category: str):
    brief = {"category": category, "custom_definition": "Explore and race" if category == "custom" else "",
             "theme": "Moonlit forest", "gameplay": "Collect stars", "details": "Hidden doors"}
    response = create(client, brief)
    assert response.status_code == 201
    game = response.json()["game"]
    assert game["brief"] == brief
    assert client.get(f"/api/v2/games/{game['id']}").json()["game"]["brief"] == brief
    assert client.get("/api/v2/games").json()["games"][0]["brief"] == brief


@pytest.mark.parametrize("brief", [{"category": "unknown"}, {"category": "custom"},
                                   {"category": "custom", "custom_definition": "   "},
                                   {"category": "puzzle", "details": "x" * 501}])
def test_invalid_briefs_rejected(client: TestClient, brief):
    assert create(client, brief).status_code == 400
    assert db_v2.list_games_v2() == []


def test_legacy_create_still_works(client: TestClient):
    assert create(client).json()["game"]["brief"] is None


@pytest.mark.parametrize("theme,scene,mechanic", [("harrypotter", "castle", "moving_platforms"),
                                                ("spooky", "haunted", "enemies"),
                                                ("minecrafty", "blocks", "crumbling_platforms"),
                                                ("Celeste", "mountain", "double_jump")])
def test_theme_becomes_persisted_game_guidance(client: TestClient, theme, scene, mechanic):
    game = create(client, {"category": "platformer", "theme": theme}).json()["game"]
    rules = client.get(f"/api/v2/games/{game['id']}").json()["game"]["rules"]
    assert rules["guidance"]["scene"] == scene
    assert mechanic in rules["guidance"]["mechanics"]
    assert rules["abilities"]["double_jump"] == ("double_jump" in rules["guidance"]["mechanics"])


def test_authors_instructions_override_theme_defaults():
    guidance = resolve_guidance({"category": "adventure", "theme": "spooky",
                                 "gameplay": "Collect rings and use moving stairs",
                                 "details": "No enemies or keys. No double jump."})
    assert guidance["scene"] == "haunted"
    assert set(guidance["excluded_mechanics"]) == {"enemies", "keys_doors", "double_jump"}
    assert "enemies" not in guidance["mechanics"]
    assert {"coins", "moving_platforms"} <= set(guidance["mechanics"])
    assert "No enemies" in " ".join(guidance["author_context"])


def test_custom_guidance_retains_author_world_and_theme_field_has_priority():
    custom = resolve_guidance({"category": "puzzle", "theme": "Underwater clockwork city", "details": "Moving platforms"})
    assert custom["scene"] == "custom"
    assert "Underwater clockwork city" in custom["style_prompt"]
    assert "moving_platforms" in custom["mechanics"]
    assert resolve_guidance({"category": "platformer", "theme": "Minecrafty", "details": "Spooky ghosts"})["scene"] == "blocks"


def test_creative_art_uses_author_theme_and_details_unless_style_is_explicit(monkeypatch: pytest.MonkeyPatch):
    from app.creative import style

    brief = {"category": "platformer", "theme": "Minecrafty", "details": "Emerald gems and square trees"}
    monkeypatch.setattr(style, "bible_of", lambda game_id: {})
    monkeypatch.setattr(style, "current", lambda *args: None)
    monkeypatch.setattr(db_v2, "get_game", lambda game_id: {"brief": brief})
    resolved = style.resolve("game_test")
    assert "Minecrafty" in resolved["text"]
    assert "Emerald gems" in resolved["text"]
    monkeypatch.setattr(style, "bible_of", lambda game_id: {"style_prompt": "Hand-painted watercolor"})
    assert style.resolve("game_test")["text"] == "Hand-painted watercolor"


def test_context_reaches_builds_and_prompt_planner(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    game = create(client, {"category": "puzzle", "theme": "Moonlit forest", "gameplay": "Collect stars"}).json()["game"]
    requests = []
    monkeypatch.setattr(builds.runner, "start", requests.append)
    ink = InkDoc.model_validate({"v": 2, "source": "canvas", "world": {"screens": 1, "w": 48},
                                 "strokes": [], "components": [], "typed_rules": [],
                                 "character": {"strokes": []}, "rules_ink": [], "sheets": [],
                                 "noise": {"count": 0}, "parent": None}).model_dump(mode="json")
    response = client.post("/api/v2/builds", json={"ink": ink, "game_id": game["id"],
                                                   "typed_rules": [{"text": "Make the door green"}]})
    assert response.status_code == 202
    assert requests[-1].typed_rules == [*brief_rules(game), {"text": "Make the door green"}]
    response = client.post("/api/v2/prompt-levels", json={"prompt": "A tower", "screens": 1, "game_id": game["id"]})
    assert response.status_code == 202
    assert requests[-1].prompt == "A tower"
    assert requests[-1].typed_rules == brief_rules(game)
    from app.build.orchestrator import default_rules

    content = plan_content("A tower", 1, {**default_rules(), "x_creation_context": [r["text"] for r in brief_rules(game)]})
    assert "Moonlit forest" in content[0]["text"]
    assert "Collect stars" in content[0]["text"]
