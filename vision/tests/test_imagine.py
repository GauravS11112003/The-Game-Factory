"""Full drawing/context transmission and generated-game isolation/persistence."""
import asyncio
import base64
import io
import json
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app import config, db_v2
from app.build import imagine
from app.mind import client as mind
from app.routers.v2 import imagine as routes
from app.routers.v2 import games as game_routes


def ink(screens=1):
    return {"v": 2, "source": "canvas", "world": {"screens": screens, "w": screens * 48},
            "strokes": [{"id": "s1", "color": "black", "kind": "line", "pts": [[4, 8], [42, 8]],
                         "w": [0.6], "closed": False, "sheet": 0, "origin": "kid"}],
            "components": [], "typed_rules": [{"text": "The arrow is a wind spell"}],
            "character": {"strokes": []}, "rules_ink": [], "sheets": [], "noise": {"count": 0}, "parent": None}


def create_game():
    from app.build.orchestrator import default_rules
    db_v2.create_game("game_test", "Tower", "Author", default_rules())
    return db_v2.get_game("game_test")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DAL_DATA_DIR", str(tmp_path))
    config.get_settings.cache_clear()
    path = tmp_path / "dal.sqlite"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT, author TEXT, created_at TEXT)")
        conn.execute("CREATE TABLE levels (id TEXT PRIMARY KEY, json TEXT)")
    monkeypatch.setattr(db_v2, "db_path", lambda: path)
    monkeypatch.setattr(mind, "available", lambda: True)
    monkeypatch.setattr(imagine, "start", lambda *args: None)
    monkeypatch.setattr(imagine, "recover", lambda *args: False)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v2")
    app.include_router(game_routes.router, prefix="/api/v2")
    yield TestClient(app)
    config.get_settings.cache_clear()


def test_all_canvas_parts_and_author_context_reach_model():
    brief = {"category": "custom", "custom_definition": "Wind-driven puzzle", "theme": "Spooky",
             "gameplay": "Guide friendly spirits", "details": "No enemies"}
    content = imagine.content_for(ink(6), {"brief": brief}, "Invent beautiful art", "Wind Tower")
    images = [c for c in content if c["type"] == "image"]
    assert len(images) == 3
    canvas = Image.open(io.BytesIO(base64.b64decode(images[0]["source"]["data"])))
    assert canvas.width > 1000 and canvas.getpixel((200, 192))[0] < 100
    text = content[-1]["text"]
    assert all(value in text for value in brief.values())
    assert "wind spell" in text and "Invent beautiful art" in text
    assert "not author requirements" in text


def test_start_persists_original_and_game_job(client, monkeypatch):
    game = create_game()
    calls = []
    monkeypatch.setattr(imagine, "start", lambda *args: calls.append(args))
    response = client.post("/api/v2/imagined-games", json={"ink": ink(), "game_id": game["id"], "context": "Wind magic"})
    assert response.status_code == 202
    state = response.json()
    original = imagine.drafts.read_json(state["draft_id"], "original-ink.json")
    assert original["typed_rules"][0]["text"] == ink()["typed_rules"][0]["text"]
    assert calls[0][3] == "Wind magic"
    assert db_v2.get_game(game["id"])["generated"]["draft_id"] == state["draft_id"]


def test_missing_model_and_missing_game_are_explicit(client, monkeypatch):
    assert client.post("/api/v2/imagined-games", json={"ink": ink(), "game_id": "missing"}).status_code == 404
    monkeypatch.setattr(mind, "available", lambda: False)
    response = client.post("/api/v2/imagined-games", json={"ink": ink()})
    assert response.status_code == 503 and response.json()["message_key"] == "imagine.no_key"


def test_retry_reuses_saved_input_and_follows_existing_retry(client, monkeypatch):
    game = create_game()
    old = "d_44444444"
    imagine.save(old, {"draft_id": old, "game_id": game["id"], "status": "failed", "title": "Wind Tower", "context": "Wind magic"})
    imagine.drafts.write_json(old, "original-ink.json", ink())
    calls = []
    monkeypatch.setattr(imagine, "start", lambda *args: calls.append(args))
    response = client.post(f"/api/v2/imagined-games/{old}/retry")
    assert response.status_code == 202
    new = response.json()
    assert new["draft_id"] != old and new["timeout_s"] == 360
    assert calls[0][3:] == ("Wind magic", "Wind Tower")
    assert calls[0][1]["strokes"][0]["pts"] == ink()["strokes"][0]["pts"]
    assert imagine.read(old)["retried_as"] == new["draft_id"]
    assert client.post(f"/api/v2/imagined-games/{old}/retry").json()["draft_id"] == new["draft_id"]
    assert len(calls) == 1


def test_status_responses_cannot_be_cached(client):
    imagine.save("d_55555555", {"draft_id": "d_55555555", "status": "ready"})
    response = client.get("/api/v2/imagined-games/d_55555555")
    assert response.headers["cache-control"] == "no-store"


def test_timeout_is_saved_with_specific_recovery_message(client, monkeypatch):
    imagine.save("d_66666666", {"draft_id": "d_66666666", "status": "building"})

    async def timed_out(*args, **kwargs):
        raise TimeoutError()

    monkeypatch.setattr(mind, "call", timed_out)
    asyncio.run(imagine.generate("d_66666666", ink(), None, "Wind", "Tower"))
    state = imagine.read("d_66666666")
    assert state["status"] == "failed" and state["message_key"] == "imagine.timeout"
    assert state["started_at"] and state["timeout_s"] == 360


def test_generation_saves_sandboxed_game_and_honors_newer_requests(client, monkeypatch):
    game = create_game()
    draft = "d_11111111"
    state = {"draft_id": draft, "game_id": game["id"], "status": "building"}
    imagine.save(draft, state)
    db_v2.set_generated_game(game["id"], state)
    html = "<!doctype html><html><body><canvas></canvas><script>" + "/* graphics */" * 100 + "</script></body></html>"
    calls = []

    async def call(*args, **kwargs):
        calls.append(kwargs)
        await kwargs["on_progress"](500)
        assert imagine.read(draft)["phase"] == "writing"
        assert imagine.read(draft)["output_chars"] == 500
        return mind.MindResult(kind="imagine", status="ok", served_by="claude-sonnet-5-5",
                               value=imagine.ImaginedGame(title="Wind Tower", summary="A magical adventure", controls=["Arrows"], html=html))

    monkeypatch.setattr(mind, "call", call)
    asyncio.run(imagine.generate(draft, ink(), game, "Wind", "Tower"))
    assert calls[0]["model"] == "claude-sonnet-5-5"
    assert db_v2.get_game(game["id"])["generated"]["status"] == "ready"
    response = client.get(f"/api/v2/imagined-games/{draft}/play")
    assert response.status_code == 200 and response.text == html
    assert "sandbox allow-scripts" in response.headers["content-security-policy"]
    assert "connect-src 'none'" in response.headers["content-security-policy"]
    assert "uploads" not in imagine.artifact_path(draft).parts
    newer = {"draft_id": "d_22222222", "status": "building"}
    db_v2.set_generated_game(game["id"], newer)
    asyncio.run(imagine.generate(draft, ink(), game, "Wind", "Tower"))
    assert db_v2.get_game(game["id"])["generated"] == newer


def test_failure_and_restart_persist_failed_status(client, monkeypatch):
    game = create_game()
    state = {"draft_id": "d_33333333", "game_id": game["id"], "status": "building"}
    imagine.save(state["draft_id"], state)
    db_v2.set_generated_game(game["id"], state)

    async def call(*args, **kwargs):
        return mind.MindResult(kind="imagine", status="failed", error="timeout")

    monkeypatch.setattr(mind, "call", call)
    asyncio.run(imagine.generate(state["draft_id"], ink(), game, "", ""))
    assert db_v2.get_game(game["id"])["generated"]["status"] == "failed"
    assert json.loads(imagine.artifact_path(state["draft_id"]).with_name("failure.json").read_text())["error"] == "timeout"
    assert "error" not in imagine.read(state["draft_id"])
    assert client.get(f"/api/v2/imagined-games/{state['draft_id']}/play").status_code == 404
    imagine.save(state["draft_id"], {**state, "status": "building"})
    assert client.get(f"/api/v2/imagined-games/{state['draft_id']}").json()["message_key"] == "imagine.interrupted"


@pytest.mark.parametrize("html", ["<html><script></script></html>", "x" * 1001, "<script>" + "x" * 300001 + "</html>"])
def test_incomplete_artifact_rejected(html):
    with pytest.raises(ValueError):
        imagine.check_html(html)


def test_sonnet_uses_stable_structured_output_without_opus_fallback(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setenv("DAL_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DAL_FAKE_LLM", raising=False)
    monkeypatch.setenv("DAL_FAST_MODE", "1")
    config.get_settings_v2.cache_clear()
    calls = []

    async def parse(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(stop_reason="end_turn", parsed_output=imagine.ImaginedGame(title="Tower", summary="Story", controls=[], html="test"),
                               model="claude-sonnet-5-5", usage=SimpleNamespace(input_tokens=1000, output_tokens=200), _request_id="test")

    fake = SimpleNamespace(messages=SimpleNamespace(parse=parse))
    fake.with_options = lambda **kwargs: fake
    monkeypatch.setattr(mind, "_get_client", lambda: fake)
    import time
    result = asyncio.run(mind.call("imagine", imagine.ImaginedGame, [{"type": "text", "text": "Tower"}],
                                   model="claude-sonnet-5-5", draft_id=None, deadline=time.monotonic() + 30))
    assert result.ok and result.cost_usd == pytest.approx(0.004)
    assert calls[0]["model"] == "claude-sonnet-5-5"
    assert not {"betas", "fallbacks", "speed"} & calls[0].keys()
    config.get_settings_v2.cache_clear()


def test_streaming_reports_real_output_and_returns_parsed_game(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setenv("DAL_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DAL_FAKE_LLM", raising=False)
    config.get_settings_v2.cache_clear()
    progress = []
    output = imagine.ImaginedGame(title="Tower", summary="Story", controls=[], html="test")

    class Stream:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        @property
        def text_stream(self):
            async def chunks():
                for text in ('{"title":', '"Tower"}'):
                    yield text
            return chunks()

        async def get_final_message(self):
            return SimpleNamespace(stop_reason="end_turn", parsed_output=output, model="claude-sonnet-5-5", usage=None)

    fake = SimpleNamespace(messages=SimpleNamespace(stream=lambda **kwargs: Stream()))
    fake.with_options = lambda **kwargs: fake
    monkeypatch.setattr(mind, "_get_client", lambda: fake)

    async def update(count):
        progress.append(count)

    import time
    result = asyncio.run(mind.call("imagine", imagine.ImaginedGame, [{"type": "text", "text": "Tower"}],
                                   model="claude-sonnet-5-5", draft_id=None, deadline=time.monotonic() + 30, on_progress=update))
    assert result.ok and result.value == output
    assert progress == [9, 17]
    config.get_settings_v2.cache_clear()

def test_prompt_only_generation_infers_details_and_preserves_category_on_retry(client, monkeypatch):
    game = create_game()
    calls = []
    monkeypatch.setattr(imagine, "start", lambda *args: calls.append(args))
    context = "Race on the moon. " + "Jump craters and collect stars. " * 90
    response = client.post("/api/v2/imagined-games", json={"game_id": game["id"], "category": "racing", "context": context})
    assert response.status_code == 202
    state = response.json()
    assert state["infer_title"] and state["category"] == "racing"
    sent_ink, sent_game = calls[0][1:3]
    assert sent_ink["source"] == "prompt" and sent_ink["strokes"] == []
    content = imagine.content_for(sent_ink, sent_game, calls[0][3], calls[0][4])
    assert not any(part["type"] == "image" for part in content)
    assert context.strip() in content[0]["text"] and '"category": "racing"' in content[0]["text"]
    assert '"title": null' in content[0]["text"]
    assert client.post(f"/api/v2/imagined-games/{state['draft_id']}/retry").status_code == 202
    assert calls[1][2]["brief"]["category"] == "racing" and calls[1][4] == ""


def test_empty_prompt_and_invalid_category_rejected(client):
    response = client.post("/api/v2/imagined-games", json={"context": "  "})
    assert response.status_code == 400 and response.json()["message_key"] == "imagine.prompt_required"
    assert client.post("/api/v2/imagined-games", json={"context": "Race", "category": "unknown"}).status_code == 422


def test_inferred_title_updates_studio_only_for_current_completed_job(client):
    game = create_game()
    pending = {"draft_id": "d_77777777", "status": "building", "infer_title": True, "title": "New game"}
    db_v2.set_generated_game(game["id"], pending)
    assert db_v2.get_game(game["id"])["title"] == "Tower"
    ready = {**pending, "status": "ready", "title": "Moon Rally"}
    db_v2.set_generated_game(game["id"], ready, expected_draft=pending["draft_id"])
    assert db_v2.get_game(game["id"])["title"] == "Moon Rally"
    newer = {"draft_id": "d_88888888", "status": "building"}
    db_v2.set_generated_game(game["id"], newer)
    db_v2.set_generated_game(game["id"], {**ready, "title": "Outdated"}, expected_draft=pending["draft_id"])
    assert db_v2.get_game(game["id"])["title"] == "Moon Rally"


def test_game_draft_publish_and_original_inputs_are_preserved(client):
    game = client.post("/api/v2/games", json={"title": "New game", "author": "Creator", "draft": True}).json()["game"]
    assert client.get("/api/v2/games").json()["games"] == []
    assert client.get("/api/v2/games?scope=mine&author=Creator").json()["games"][0]["draft"]
    created = client.post("/api/v2/imagined-games", json={"game_id": game["id"], "category": "puzzle",
                          "context": "Wind magic and moving stairs", "ink": ink(6)}).json()
    draft_id = created["draft_id"]
    token = created["publish_token"]
    assert "publish_token" not in imagine.read(draft_id)
    assert not client.get(f"/api/v2/imagined-games/{draft_id}").json()["can_publish"]
    assert client.get(f"/api/v2/imagined-games/{draft_id}", headers={"X-DP-Draft": token}).json()["can_publish"]
    assert client.post(f"/api/v2/imagined-games/{draft_id}/publish", json={"token": token}).status_code == 409
    state = imagine.read(draft_id)
    state.update(status="ready", title="Wind Tower", summary="A wind puzzle", controls=["Arrows"],
                 play_url=f"/api/v2/imagined-games/{draft_id}/play")
    imagine.artifact_path(draft_id).write_text("<html><script>/* sample game */</script></html>")
    imagine.save(draft_id, state)
    db_v2.set_generated_game(game["id"], state)
    assert client.post(f"/api/v2/imagined-games/{draft_id}/publish", json={}).status_code == 403
    response = client.post(f"/api/v2/imagined-games/{draft_id}/publish", json={"token": token})
    assert response.status_code == 200 and response.json()["publication"] == "published"
    public = client.get("/api/v2/games").json()["games"][0]
    assert public["title"] == "Wind Tower" and public["generated"]["draft_id"] == draft_id
    assert not public["draft"]
    source = client.get(f"/api/v2/imagined-games/{draft_id}/inputs").json()
    assert source["prompt"] == "Wind magic and moving stairs" and source["category"] == "puzzle"
    assert source["ink"]["strokes"] == routes.InkDoc.model_validate(ink(6)).model_dump(mode="json")["strokes"]
    assert len(source["canvases"]) == 3 and "publish_token" not in source
    assert client.get(source["canvases"][0]).headers["content-type"] == "image/jpeg"
    assert client.get(f"/api/v2/imagined-games/{draft_id}/canvas?section=9").status_code == 404
    # A subsequent draft leaves the published game and its inputs in discovery intact.
    newer = client.post("/api/v2/imagined-games", json={"game_id": game["id"], "category": "racing", "context": "New version"}).json()
    assert client.get("/api/v2/games").json()["games"][0]["generated"]["draft_id"] == draft_id
    assert client.get(f"/api/v2/games/{game['id']}?published=true").json()["game"]["generated"]["draft_id"] == draft_id
    assert client.get(f"/api/v2/games/{game['id']}").json()["game"]["generated"]["draft_id"] == newer["draft_id"]
    assert client.post(f"/api/v2/imagined-games/{draft_id}/publish", json={"token": token}).status_code == 409


def test_prompt_only_inputs_are_honest_about_no_canvas(client):
    state = client.post("/api/v2/imagined-games", json={"context": "Moon Rally", "category": "racing"}).json()
    source = client.get(f"/api/v2/imagined-games/{state['draft_id']}/inputs").json()
    assert source["prompt"] == "Moon Rally" and source["canvases"] == []


def test_character_drawing_is_included_in_original_canvas_inputs(client):
    drawing = ink()
    drawing["character"]["strokes"] = drawing["strokes"]
    drawing["strokes"] = []
    state = client.post("/api/v2/imagined-games", json={"context": "A friendly ghost puzzle", "ink": drawing}).json()
    source = client.get(f"/api/v2/imagined-games/{state['draft_id']}/inputs").json()
    assert len(source["canvases"]) == 1 and "character=true" in source["canvases"][0]
    assert client.get(source["canvases"][0]).headers["content-type"] == "image/png"
    assert len([part for part in imagine.content_for(source["ink"], None, source["prompt"], "") if part["type"] == "image"]) == 1


def finish_level(state, title):
    state = {key: value for key, value in state.items() if key != 'publish_token'}
    state.update(status='ready', title=title, summary='Collect stars', controls=['Arrows'],
                 play_url=f"/api/v2/imagined-games/{state['draft_id']}/play")
    imagine.artifact_path(state['draft_id']).write_text('<html><script>/* original mechanics */</script></html>')
    imagine.save(state['draft_id'], state)
    db_v2.set_generated_game(state['game_id'], state, expected_draft=state['draft_id'])
    return state


def test_chat_revision_preserves_artifact_history_level_and_publication(client, monkeypatch):
    game = create_game()
    first = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Fly over towers', 'ink': ink()}).json()
    token = first['publish_token']
    ready = finish_level(first, 'Wizard Flight')
    ready['conversation'] = [{'role': 'user', 'content': 'Fly over towers'}, {'role': 'assistant', 'content': 'Collect stars'}]
    imagine.save(ready['draft_id'], ready)
    assert client.post(f"/api/v2/imagined-games/{ready['draft_id']}/publish", json={'token': token}).status_code == 200
    calls = []
    monkeypatch.setattr(imagine, 'start', lambda *args: calls.append(args))
    url = f"/api/v2/imagined-games/{ready['draft_id']}/refine"
    assert client.post(url, json={'message': 'Add double jump'}).status_code == 403
    assert client.post(url, json={'message': '  ', 'token': token}).status_code == 400
    response = client.post(url, json={'message': 'Add double jump', 'token': token})
    assert response.status_code == 202
    revision = response.json()
    assert revision['revision_of'] == ready['draft_id']
    assert revision['level_id'] == ready['level_id'] and revision['level_number'] == 1
    assert revision['conversation'] == ready['conversation'] + [{'role': 'user', 'content': 'Add double jump'}]
    assert revision['publication'] == 'draft'
    assert calls[0][2]['revision_context']['html'] == imagine.artifact_path(ready['draft_id']).read_text()
    assert calls[0][2]['revision_context']['conversation'] == revision['conversation']
    assert calls[0][1]['strokes'] == imagine.drafts.read_json(ready['draft_id'], 'original-ink.json')['strokes']
    assert imagine.read(ready['draft_id'])['revised_as'] == revision['draft_id']
    assert len(db_v2.get_game(game['id'])['generated_levels']) == 1
    assert db_v2.get_game(game['id'])['published_generated']['draft_id'] == ready['draft_id']
    assert client.post(url, json={'message': 'Add double jump', 'token': token}).json()['draft_id'] == revision['draft_id']
    assert len(calls) == 1
    assert client.post(url, json={'message': 'Something else', 'token': token}).status_code == 409
    assert client.post(f"/api/v2/imagined-games/{revision['draft_id']}/refine", json={'message': 'More coins', 'token': token}).status_code == 409
    finish_level(revision, 'Wizard Flight')
    assert client.get(f"/api/v2/imagined-games/{revision['draft_id']}", headers={'X-DP-Draft': token}).json()['can_publish']
    assert client.post(f"/api/v2/imagined-games/{revision['draft_id']}/publish", json={'token': token}).status_code == 200
    assert db_v2.get_game(game['id'])['published_generated']['draft_id'] == revision['draft_id']


def test_chat_retry_keeps_artifact_and_does_not_repeat_user_message(client, monkeypatch):
    game = create_game()
    first = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Moon racing'}).json()
    ready = finish_level(first, 'Moon Rally')
    token = first['publish_token']
    revision = client.post(f"/api/v2/imagined-games/{ready['draft_id']}/refine",
                           json={'message': 'Add a boost', 'token': token}).json()
    revision.update(status='failed', message_key='imagine.timeout')
    revision.pop('publish_token', None)
    imagine.save(revision['draft_id'], revision)
    calls = []
    monkeypatch.setattr(imagine, 'start', lambda *args: calls.append(args))
    url = f"/api/v2/imagined-games/{revision['draft_id']}/retry"
    assert client.post(url).status_code == 403
    retried = client.post(url, headers={'X-DP-Draft': token}).json()
    assert retried['revision_of'] == ready['draft_id']
    assert retried['conversation'] == revision['conversation']
    assert retried['level_id'] == ready['level_id']
    assert calls[0][2]['revision_context']['html'] == imagine.artifact_path(ready['draft_id']).read_text()
    assert calls[0][3] == 'Add a boost'
    finish_level(retried, 'Moon Rally')
    assert client.get(f"/api/v2/imagined-games/{retried['draft_id']}", headers={'X-DP-Draft': token}).json()['can_publish']


@pytest.mark.parametrize('message', ['Add blue wind platforms', ''])
def test_canvas_iteration_uses_updated_drawing_and_existing_game(client, monkeypatch, message):
    game = create_game()
    first = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Fly over towers', 'ink': ink()}).json()
    ready = finish_level(first, 'Wizard Flight')
    original = imagine.drafts.read_json(ready['draft_id'], 'original-ink.json')
    updated = ink(2)
    updated['strokes'][0].update(color='blue', pts=[[4, 12], [42, 12]])
    updated['character']['strokes'] = [{**updated['strokes'][0], 'id': 'c2', 'color': 'red'}]
    updated['typed_rules'] = [{'text': 'Blue platforms move with the wind'}]
    normalized = routes.InkDoc.model_validate(updated).model_dump(mode='json')
    calls = []
    monkeypatch.setattr(imagine, 'start', lambda *args: calls.append(args))
    url = f"/api/v2/imagined-games/{ready['draft_id']}/refine"
    assert client.post(url, json={'message': message, 'ink': updated}).status_code == 403
    body = {'message': message, 'ink': updated, 'token': first['publish_token']}
    response = client.post(url, json=body)
    assert response.status_code == 202
    revised = response.json()
    assert revised['canvas_updated'] and revised['revision_of'] == ready['draft_id']
    assert revised['level_id'] == ready['level_id']
    assert revised['original_context'] == 'Fly over towers'
    assert revised['conversation'][-1] == {'role': 'user', 'content': message or 'Apply my canvas changes to the current game.', 'canvas_updated': True}
    assert calls[0][1] == normalized
    revision_context = calls[0][2]['revision_context']
    assert revision_context['canvas_updated'] and revision_context['previous_canvas'] == original
    assert 'original mechanics' in revision_context['html']
    content = imagine.content_for(*calls[0][1:])
    assert len([part for part in content if part['type'] == 'image']) == 2
    assert 'UPDATED sketch' in content[-1]['text'] and 'Blue platforms move with the wind' in content[-3]['text']
    assert imagine.drafts.read_json(ready['draft_id'], 'original-ink.json') == original
    assert client.get(f"/api/v2/imagined-games/{revised['draft_id']}/inputs").json()['ink'] == normalized
    assert client.post(url, json=body).json()['draft_id'] == revised['draft_id']
    assert len(calls) == 1
    updated['strokes'][0]['color'] = 'green'
    assert client.post(url, json={**body, 'ink': updated}).status_code == 409
    # A failed build retries the submitted sketch against the last completed game.
    imagine.save(revised['draft_id'], {**imagine.read(revised['draft_id']), 'status': 'failed'})
    retry = client.post(f"/api/v2/imagined-games/{revised['draft_id']}/retry", headers={'X-DP-Draft': first['publish_token']})
    assert retry.status_code == 202 and retry.json()['canvas_updated']
    assert calls[-1][1] == normalized
    assert calls[-1][2]['revision_context']['previous_canvas'] == original
    assert retry.json()['conversation'] == revised['conversation']


def test_cleared_canvas_is_an_explicit_revision_and_kept_in_later_chat(client, monkeypatch):
    game = create_game()
    first = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Wind game', 'ink': ink()}).json()
    ready = finish_level(first, 'Wind Game')
    updated = ink()
    updated.update(strokes=[], typed_rules=[])
    url = f"/api/v2/imagined-games/{ready['draft_id']}/refine"
    response = client.post(url, json={'ink': updated, 'token': first['publish_token']})
    assert response.status_code == 202
    revision = finish_level(response.json(), 'Wind Game')
    calls = []
    monkeypatch.setattr(imagine, 'start', lambda *args: calls.append(args))
    next_change = client.post(f"/api/v2/imagined-games/{revision['draft_id']}/refine",
                             json={'message': 'Add a timer', 'token': first['publish_token']})
    assert next_change.status_code == 202
    assert not next_change.json().get('canvas_updated')
    assert calls[0][1]['strokes'] == [] and calls[0][1]['typed_rules'] == []
    assert next_change.json()['conversation'][-2]['canvas_updated']


def test_revision_prompt_uses_current_game_and_saves_assistant_response(client, monkeypatch):
    game = create_game()
    first = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Moon racing'}).json()
    ready = finish_level(first, 'Moon Rally')
    starts = []
    monkeypatch.setattr(imagine, 'start', lambda *args: starts.append(args))
    revision = client.post(f"/api/v2/imagined-games/{ready['draft_id']}/refine",
                           json={'message': 'Add a boost', 'token': first['publish_token']}).json()
    html = '<html><body><script>' + '/* boost */' * 150 + '</script></body></html>'

    async def call(kind, schema, content, **kwargs):
        assert any('EXISTING playable game' in part.get('text', '') for part in content)
        assert 'original mechanics' in content[0]['text']
        return mind.MindResult(kind='imagine', status='ok', value=imagine.ImaginedGame(
            title='Moon Rally', summary='Added a boost. Press Space.', controls=['Space to boost'], html=html))

    monkeypatch.setattr(mind, 'call', call)
    asyncio.run(imagine.generate(*starts[0]))
    saved = imagine.read(revision['draft_id'])
    assert saved['conversation'][-1] == {'role': 'assistant', 'content': 'Added a boost. Press Space.'}
    assert saved['conversation'][-2] == {'role': 'user', 'content': 'Add a boost'}
    assert imagine.artifact_path(revision['draft_id']).read_text() == html
    assert imagine.artifact_path(ready['draft_id']).is_file()


def test_add_level_keeps_initial_game_and_passes_original_to_sonnet(client, monkeypatch):
    game = create_game()
    first = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Fly over towers'}).json()
    finish_level(first, 'Wizard Flight')
    calls = []
    monkeypatch.setattr(imagine, 'start', lambda *args: calls.append(args))
    second = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'append_level': True,
                         'category': 'platformer', 'context': 'Fly through icy caves', 'ink': ink(2)}).json()
    saved = client.get(f"/api/v2/games/{game['id']}").json()['game']
    assert [level['level_number'] for level in saved['generated_levels']] == [1, 2]
    assert saved['generated']['draft_id'] == first['draft_id']
    assert saved['title'] == 'Wizard Flight'
    assert second['base_draft_id'] == first['draft_id']
    sent = imagine.content_for(calls[0][1], calls[0][2], calls[0][3], calls[0][4])
    assert 'original mechanics' in sent[-2]['text'] and 'SAME game' in sent[-1]['text']
    assert calls[0][2]['level_context']['controls'] == ['Arrows']
    finish_level(second, 'Ice Cave')
    assert db_v2.get_game(game['id'])['title'] == 'Wizard Flight'
    assert client.get(f"/api/v2/imagined-games/{second['draft_id']}/inputs").json()['prompt'] == 'Fly through icy caves'
    assert client.get(f"/api/v2/imagined-games/{first['draft_id']}/inputs").json()['prompt'] == 'Fly over towers'
    # An initial level can still be published after a second level is generated.
    assert client.post(f"/api/v2/imagined-games/{first['draft_id']}/publish", json={'token': first['publish_token']}).status_code == 200
    public = client.get(f"/api/v2/games/{game['id']}?published=true").json()['game']
    assert len(public['generated_levels']) == 1
    assert client.post(f"/api/v2/imagined-games/{second['draft_id']}/publish", json={'token': second['publish_token']}).status_code == 200
    public = client.get(f"/api/v2/games/{game['id']}?published=true").json()['game']
    assert [level['title'] for level in public['generated_levels']] == ['Wizard Flight', 'Ice Cave']
    assert client.get('/api/v2/games').json()['games'][0]['level_count'] == 2


def test_retry_and_edit_replace_only_selected_level(client):
    game = create_game()
    first = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Initial'}).json()
    finish_level(first, 'First')
    second = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Second', 'append_level': True}).json()
    third = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Third', 'append_level': True}).json()
    assert third['level_number'] == 3
    retry = client.post(f"/api/v2/imagined-games/{second['draft_id']}/retry").json()
    assert retry['level_id'] == second['level_id'] and retry['level_number'] == 2
    assert retry['base_draft_id'] == first['draft_id']
    edited = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Revised second', 'level_id': second['level_id']}).json()
    finish_level(edited, 'Second revised')
    # A late completion from the previous attempt cannot replace the new version.
    finish_level(retry, 'Obsolete')
    levels = db_v2.get_game(game['id'])['generated_levels']
    assert len(levels) == 3 and levels[1]['draft_id'] == edited['draft_id']
    assert levels[0]['draft_id'] == first['draft_id'] and levels[2]['draft_id'] == third['draft_id']
    assert client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'Bad edit', 'level_id': 'missing'}).status_code == 404


def test_existing_generated_game_becomes_level_one_without_regeneration(client):
    game = create_game()
    legacy = {'draft_id': 'd_12121212', 'status': 'ready', 'title': 'Original', 'game_id': game['id']}
    with db_v2.connect() as conn:
        conn.execute('UPDATE games SET generated_json = ?, generated_levels_json = NULL WHERE id = ?', (json.dumps(legacy), game['id']))
    before = db_v2.get_game(game['id'])['generated_levels']
    assert before[0]['level_number'] == 1 and before[0]['draft_id'] == legacy['draft_id']
    new = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'append_level': True, 'context': 'Next'}).json()
    assert new['level_number'] == 2
    assert db_v2.get_game(game['id'])['generated']['draft_id'] == legacy['draft_id']


def test_simultaneous_additions_allocate_distinct_ordered_levels(client):
    from concurrent.futures import ThreadPoolExecutor
    game = create_game()
    db_v2.set_generated_game(game['id'], {'draft_id': 'd_13131313', 'status': 'ready'})
    def reserve(index):
        state = {'draft_id': f'd_{index:08d}', 'status': 'building'}
        return db_v2.reserve_generated_level(game['id'], state, append=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(reserve, range(20, 24)))
    assert sorted(state['level_number'] for state in results) == [2, 3, 4, 5]
    assert len({state['level_id'] for state in results}) == 4
    assert db_v2.get_game(game['id'])['generated']['draft_id'] == 'd_13131313'


def test_interactive_response_saves_completed_changes_and_optional_additions(client, monkeypatch):
    draft = 'd_1234abcd'
    imagine.save(draft, {'draft_id': draft, 'status': 'building',
                         'conversation': [{'role': 'user', 'content': 'A moon race'}]})
    html = '<html><body><script>' + '/* race */' * 150 + '</script></body></html>'

    async def no_art(*args, **kwargs):
        return {'assets': [], 'cost_usd': 0}

    async def call(*args, **kwargs):
        return mind.MindResult(kind='imagine', status='ok', value=imagine.ImaginedGame(
            title='Moon race', summary='Your moon race is ready.', controls=['Arrows to steer'], html=html,
            changes=['Added crater obstacles'], suggestions=[imagine.GameSuggestion(
                title='Reward close calls', description='Earn energy for narrowly dodging a crater.',
                prompt='Add a near-miss energy reward. Preserve the race and cars.', kind='mechanic')]))

    monkeypatch.setattr(imagine.imagine_assets, 'build', no_art)
    monkeypatch.setattr(mind, 'call', call)
    asyncio.run(imagine.generate(draft, ink(), None, 'A moon race', ''))
    response = client.get(f'/api/v2/imagined-games/{draft}').json()
    assert response['status'] == 'ready'
    assert response['changes'] == ['Added crater obstacles']
    suggestion = response['suggestions'][0]
    assert suggestion['kind'] == 'mechanic' and 'Preserve the race' in suggestion['prompt']
    assert response['conversation'][-1]['suggestions'] == response['suggestions']
    assert response['conversation'][-1]['changes'] == response['changes']
    assert imagine.artifact_path(draft).read_text() == html


def test_better_graphics_defaults_off_and_is_saved_with_inputs(client):
    standard = client.post('/api/v2/imagined-games', json={'context': 'A forest puzzle'}).json()
    assert standard['better_graphics'] is False
    enhanced = client.post('/api/v2/imagined-games', json={'context': 'An ocean race', 'better_graphics': True}).json()
    assert enhanced['better_graphics'] is True
    inputs = client.get(f"/api/v2/imagined-games/{enhanced['draft_id']}/inputs").json()
    assert inputs['better_graphics'] is True
    state = imagine.read(enhanced['draft_id']); state['status'] = 'failed'; imagine.save(state['draft_id'], state)
    retried = client.post(f"/api/v2/imagined-games/{enhanced['draft_id']}/retry").json()
    assert retried['better_graphics'] is True


def test_graphics_choice_carries_to_revisions_and_levels_with_explicit_override(client):
    game = create_game()
    first = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'A moon race', 'better_graphics': True}).json()
    ready = finish_level(first, 'Moon Race')
    level = client.post('/api/v2/imagined-games', json={'game_id': game['id'], 'context': 'An ice race', 'append_level': True}).json()
    assert level['better_graphics'] is True
    revision = client.post(f"/api/v2/imagined-games/{ready['draft_id']}/refine",
                           json={'message': 'Add a boost', 'token': first['publish_token']}).json()
    assert revision['better_graphics'] is True
    finish_level(revision, 'Moon Race')
    off = client.post(f"/api/v2/imagined-games/{revision['draft_id']}/refine",
                      json={'better_graphics': False, 'token': first['publish_token']})
    assert off.status_code == 202 and off.json()['better_graphics'] is False
