"""The v6 Studio API with TestClient (docs/v6/CONTRACTS_V6.md §5.1): games CRUD and authorship, listings, publish,
thumbnails, remix, templates, themes, the copilot endpoints with the model off, and Blocks' object/theme kinds."""
from __future__ import annotations

import base64
import importlib
import json
import os
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.spec.studio import GameDoc, StudioChatResult, StudioGameCard
from tests import test_studio_fixtures as F

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 100


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    os.environ["DAL_DATA_DIR"] = str(tmp_path_factory.mktemp("dal_v6"))
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
    from app.routers.v2 import collab

    collab._RECENT.clear()  # the per-IP profile rate limit is process-wide; earlier test modules use it too
    r = client.post("/api/v2/collab/players", json={"name": name})
    assert r.status_code == 201, r.text
    body = r.json()
    return {"id": body["player"]["id"], "name": name, "h": {"X-DP-Player": f"{body['player']['id']}.{body['token']}"}}


def new_game(client: TestClient, who: dict[str, Any], **body: Any) -> dict[str, Any]:
    r = client.post("/api/v2/studio/games", json=body, headers=who["h"])
    assert r.status_code == 201, r.text
    return r.json()


def key(r: Any) -> str:
    return r.json()["error"]["key"]


def test_create_get_save_and_authorship(client: TestClient) -> None:
    maya, sam = profile(client, "Maya"), profile(client, "Sam")
    r = client.post("/api/v2/studio/games", json={})
    assert r.status_code == 401 and key(r) == "ai.err.need_profile"
    g = new_game(client, maya, title="Lava Run")
    GameDoc.model_validate(g)
    assert g["id"].startswith("sg_") and len(g["id"]) == 15 and g["author"] == "Maya" and g["title"] == "Lava Run"
    assert g["theme"]["name"] == "Sketchbook" and g["created_at"] == g["updated_at"]
    assert client.get(f"/api/v2/studio/games/{g['id']}").json() == g
    assert key(client.get("/api/v2/studio/games/sg_nothere12345")) == "ai.err.not_found"
    assert client.get("/api/v2/studio/games/not-an-id").status_code == 404
    # save: author only, validated, server-owned fields kept
    doc = dict(g, title="Lava Run 2", author="Hacker", created_at="1999", id="sg_other",
               scenes=[{"id": "s1", "objects": [F.BOX]}])
    assert key(client.put(f"/api/v2/studio/games/{g['id']}", json=doc, headers=sam["h"])) == "ai.err.not_author"
    assert client.put(f"/api/v2/studio/games/{g['id']}", json=doc).status_code == 401
    saved = client.put(f"/api/v2/studio/games/{g['id']}", json=doc, headers=maya["h"]).json()
    assert saved["title"] == "Lava Run 2" and saved["author"] == "Maya" and saved["id"] == g["id"]
    assert saved["created_at"] == g["created_at"] and saved["updated_at"] > g["updated_at"]
    assert client.get(f"/api/v2/studio/games/{g['id']}").json()["scenes"][0]["objects"][0]["id"] == "o2"
    bad = client.put(f"/api/v2/studio/games/{g['id']}", json=dict(g, scenes=[]), headers=maya["h"])
    assert bad.status_code == 400 and key(bad) == "ai.err.bad_game" and bad.json()["error"]["args"]["errors"] >= 1
    r = client.put(f"/api/v2/studio/games/{g['id']}", content=b"{nope", headers=maya["h"])
    assert r.status_code == 400 and key(r) == "ai.err.bad_request"
    huge = json.dumps(dict(g, x_pad="x" * (24 * 1024 * 1024)))
    r = client.put(f"/api/v2/studio/games/{g['id']}", content=huge, headers={**maya["h"],
                                                                            "content-type": "application/json"})
    assert r.status_code == 413 and key(r) == "ai.err.too_big"


def test_create_from_template_or_doc(client: TestClient) -> None:
    kim = profile(client, "Kim")
    g = new_game(client, kim, template="tpl_blank")
    assert g["title"] == "Blank canvas" and g["author"] == "Kim"
    g2 = new_game(client, kim, template="blank", title="Mine")
    assert g2["title"] == "Mine" and g2["id"] != g["id"]
    r = client.post("/api/v2/studio/games", json={"template": "nope"}, headers=kim["h"])
    assert r.status_code == 404 and key(r) == "ai.err.not_found"
    g3 = new_game(client, kim, doc=F.car_scene())
    assert len(g3["scenes"][0]["objects"]) == 4 and g3["id"] != "g_test"
    r = client.post("/api/v2/studio/games", json={"doc": {"scenes": "lots"}}, headers=kim["h"])
    assert r.status_code == 400 and key(r) == "ai.err.bad_game"
    r = client.post("/api/v2/studio/games", json={"title": "email me kid@example.com"}, headers=kim["h"])
    assert r.status_code == 409 and key(r) == "ai.err.safety"


def test_listings_publish_and_remix(client: TestClient) -> None:
    ana, bo = profile(client, "Ana"), profile(client, "Bo")
    a1 = new_game(client, ana, title="First")
    a2 = new_game(client, ana, doc=F.car_scene(), title="Second")
    assert client.get("/api/v2/studio/games?mine=1").status_code == 401
    mine = client.get("/api/v2/studio/games?mine=1", headers=ana["h"]).json()["games"]
    assert [c["id"] for c in mine] == [a2["id"], a1["id"]]  # newest first
    for c in mine:
        StudioGameCard.model_validate(c)
    assert mine[0]["objects"] == 4 and mine[0]["scenes"] == 1 and mine[0]["theme_name"] == "Sketchbook"
    assert mine[0]["published"] is False and mine[0]["thumbnail_url"] is None
    assert a1["id"] not in [c["id"] for c in client.get("/api/v2/studio/games?published=1").json()["games"]]
    assert key(client.post(f"/api/v2/studio/games/{a1['id']}/publish", json={"published": True},
                           headers=bo["h"])) == "ai.err.not_author"
    card = client.post(f"/api/v2/studio/games/{a1['id']}/publish", json={"published": True}, headers=ana["h"]).json()
    assert card["published"] is True and card["id"] == a1["id"]
    pub = client.get("/api/v2/studio/games?published=1").json()["games"]
    assert [c["id"] for c in pub if c["id"] in (a1["id"], a2["id"])] == [a1["id"]]
    r = client.post(f"/api/v2/studio/games/{a1['id']}/publish", json={"published": "yes"}, headers=ana["h"])
    assert r.status_code == 400
    # remix: anyone with a profile, a copy owned by them
    assert client.post(f"/api/v2/studio/games/{a2['id']}/remix").status_code == 401
    rx = client.post(f"/api/v2/studio/games/{a2['id']}/remix", headers=bo["h"])
    assert rx.status_code == 201
    copy = rx.json()
    assert copy["id"] != a2["id"] and copy["author"] == "Bo" and copy["x_remix_of"] == a2["id"]
    assert copy["scenes"] == a2["scenes"]
    assert [c["id"] for c in client.get("/api/v2/studio/games?mine=1", headers=bo["h"]).json()["games"]] == [copy["id"]]
    saved = client.put(f"/api/v2/studio/games/{copy['id']}", json=dict(copy, title="Bo's"), headers=bo["h"]).json()
    assert saved["x_remix_of"] == a2["id"]
    assert client.post("/api/v2/studio/games/sg_nothere12345/remix", headers=bo["h"]).status_code == 404


def test_publish_checks_shown_words(client: TestClient) -> None:
    cy = profile(client, "Cy")
    doc = F.doc([dict(F.BOX, rules=[{"id": "r1", "when": {"type": "start"},
                                     "then": [{"type": "say", "params": {"text": "call 555-123-4567"}}]}])])
    g = new_game(client, cy, doc=doc)
    r = client.post(f"/api/v2/studio/games/{g['id']}/publish", json={"published": True}, headers=cy["h"])
    assert r.status_code == 409 and key(r) == "ai.err.safety"
    r = client.post(f"/api/v2/studio/games/{g['id']}/publish", json={"published": False}, headers=cy["h"])
    assert r.status_code == 200


def test_thumbnails(client: TestClient) -> None:
    di, ed = profile(client, "Di"), profile(client, "Ed")
    g = new_game(client, di)
    url = f"/api/v2/studio/games/{g['id']}/thumbnail"
    assert client.get(url + ".png").status_code == 404
    assert key(client.put(url, content=PNG, headers=ed["h"])) == "ai.err.not_author"
    assert key(client.put(url, content=b"GIF89a", headers=di["h"])) == "ai.err.bad_png"
    assert client.put(url, content=b"\x89PNG\r\n\x1a\n" + b"\0" * (600 * 1024), headers=di["h"]).status_code == 413
    assert client.put(url, content=PNG, headers=di["h"]).status_code == 204
    r = client.get(url + ".png")
    assert r.status_code == 200 and r.content == PNG and r.headers["content-type"] == "image/png"
    assert client.put(url, content=base64.b64encode(PNG), headers=di["h"]).status_code == 204  # base64 works too
    card = client.get("/api/v2/studio/games?mine=1", headers=di["h"]).json()["games"][0]
    assert card["thumbnail_url"].startswith(f"/api/v2/studio/games/{g['id']}/thumbnail.png?v=")


def test_templates_and_themes(client: TestClient) -> None:
    tpls = client.get("/api/v2/studio/templates").json()["templates"]
    assert any(t["id"] == "tpl_blank" and t["title"] == "Blank canvas" for t in tpls)
    for t in tpls:
        StudioGameCard.model_validate(t)
    doc = client.get("/api/v2/studio/templates/tpl_blank").json()
    GameDoc.model_validate(doc)
    assert client.get("/api/v2/studio/templates/blank").json()["id"] == "tpl_blank"
    assert key(client.get("/api/v2/studio/templates/nope")) == "ai.err.not_found"
    themes = client.get("/api/v2/studio/themes").json()["themes"]
    assert themes and any(t["name"] == "Sketchbook" for t in themes)


def test_copilot_endpoints_model_off(client: TestClient) -> None:
    body = {"game": F.car_scene(), "scene": "s1", "selection": [], "message": "reimagine as a hill climb racer"}
    r = client.post("/api/v2/studio/chat", json=body)
    assert r.status_code == 200, r.text
    res = StudioChatResult.model_validate(r.json())
    assert res.source == "keywords" and any(e.action == "set_world" for e in res.edits)
    assert key(client.post("/api/v2/studio/chat", json={**body, "message": ""})) == "ai.err.bad_request"
    assert client.post("/api/v2/studio/chat", content=b"").status_code == 400
    rec = {"game": F.car_scene(), "scene": "s1", "object_id": "o2",
           "image_png": base64.b64encode(PNG).decode()}
    r = client.post("/api/v2/studio/recognize", json=rec)
    assert r.status_code == 200 and r.json()["question"] == "What is this?" and r.json()["source"] == "keywords"
    assert key(client.post("/api/v2/studio/recognize", json={**rec, "object_id": "o99"})) == "ai.err.bad_object"
    r = client.post("/api/v2/studio/theme", json={"text": "watercolor forest"})
    assert r.status_code == 200 and r.json()["source"] == "keywords"
    assert r.json()["theme"]["id"] in ("watercolor_dream", "jungle")
    assert client.post("/api/v2/studio/theme", json={"text": ""}).status_code == 400


# ---- blocks: object and theme kinds -------------------------------------------------------------------------------


def test_blocks_object_and_theme_kinds(client: TestClient) -> None:
    fay = profile(client, "Fay")
    obj = dict(F.BOX, kind="car", behaviors=[{"id": "b1", "type": "car", "params": {}}])
    r = client.post("/api/v2/blocks", json={"name": "Red car", "kind": "object", "object": obj, "tags": ["car"]},
                    headers=fay["h"])
    assert r.status_code == 201, r.text
    card = r.json()
    assert card["kind"] == "object" and card["object"]["kind"] == "car" and card["theme"] is None
    assert client.get(f"/api/v2/blocks/{card['id']}").json()["object"]["id"] == "o2"
    r = client.post("/api/v2/blocks", json={"name": "No object", "kind": "object"}, headers=fay["h"])
    assert r.status_code == 400 and r.json()["message_key"] == "ai.err.needs_object"
    from app.studio import assets

    r = client.post("/api/v2/blocks", json={"name": "Spooky", "kind": "theme", "theme": assets.builtin_theme(
        "spooky_night")}, headers=fay["h"])
    assert r.status_code == 201 and r.json()["theme"]["name"] == "Spooky Night"
    r = client.post("/api/v2/blocks", json={"name": "No theme", "kind": "theme"}, headers=fay["h"])
    assert r.json()["message_key"] == "ai.err.needs_theme"
    kinds = client.get("/api/v2/blocks", params={"kind": "theme"}).json()["blocks"]
    assert [b["name"] for b in kinds] == ["Spooky"]
    assert client.get("/api/v2/blocks", params={"kind": "object"}).json()["total"] == 1
    bad = dict(obj, name="call 555-123-4567")
    r = client.post("/api/v2/blocks", json={"name": "Car 2", "kind": "object", "object": bad}, headers=fay["h"])
    assert r.status_code == 409


def test_studio_block_use_counts_and_credits(client: TestClient) -> None:
    """POST /studio/games/{id}/blocks/{bid}/use (v6 §9): counts one use per game and block; only object/theme blocks."""
    ana, ben = profile(client, "Ana"), profile(client, "Ben")
    obj = dict(F.BOX, kind="car")
    block = client.post("/api/v2/blocks", json={"name": "Ana car", "kind": "object", "object": obj},
                        headers=ana["h"]).json()
    g = new_game(client, ben)
    url = f"/api/v2/studio/games/{g['id']}/blocks/{block['id']}/use"
    assert client.post(url).status_code == 401
    assert client.post(url, headers=ben["h"]).json() == {"new": True}
    assert client.post(url, headers=ben["h"]).json() == {"new": False}
    assert client.get(f"/api/v2/blocks/{block['id']}").json()["uses"] == 1
    assert client.post(f"/api/v2/studio/games/sg_000000000000/blocks/{block['id']}/use", headers=ben["h"]).status_code == 404
    assert client.post(f"/api/v2/studio/games/{g['id']}/blocks/nope/use", headers=ben["h"]).status_code == 404
