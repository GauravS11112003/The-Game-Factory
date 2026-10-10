"""FastAPI TestClient against a temporary DAL_DATA_DIR (PLAN.md sections 9 and 12). Owned by lane D.

Covers everything that does not depend on the CV / compile / template lanes;
their endpoints must answer 422 or 503 (never 500) while those are stubs.
"""
from __future__ import annotations

import importlib
import json
import os
import re
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.models import Level
from tests.conftest import FIXTURES_DIR

DRAFT_RE = re.compile(r"^d_[0-9a-f]{8}$")
LEVEL_RE = re.compile(r"^lvl_[0-9a-f]{8}$")


@pytest.fixture(scope="module")
def data_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("dal_data")


@pytest.fixture(scope="module")
def client(data_dir: Path) -> Iterator[TestClient]:
    os.environ["DAL_DATA_DIR"] = str(data_dir)
    os.environ.pop("ANTHROPIC_API_KEY", None)
    from app import config, db

    config.get_settings.cache_clear()
    db._engine_for.cache_clear()
    main = importlib.import_module("app.main")
    main = importlib.reload(main)
    with TestClient(main.create_app()) as c:
        yield c


def test_health(client: TestClient) -> None:
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["llm"] in ("fake", "live")


def test_seed_creates_one_game_with_three_levels_and_the_remix_chain(client: TestClient, data_dir: Path) -> None:
    feed = client.get("/api/games").json()["games"]
    assert len(feed) == 1
    game = feed[0]
    assert game["id"] == "game_starter"
    assert game["title"] == "Starter World"
    assert game["author"] == "team"
    # The sequence is the three starter levels; the remix chain hangs under starter 1
    # in the tree but still counts towards the game's authors and likes.
    assert game["level_count"] == 3
    assert game["authors"] == ["team", "maya", "sam"]
    assert game["likes"] == 12 + 5 + 2
    cover = Level.model_validate(game["cover"])
    assert cover.id == "lvl_starter1"
    assert cover.source.backdrop_url == "/uploads/lvl_starter1/backdrop.png"
    assert (data_dir / "uploads" / "lvl_starter1" / "backdrop.png").is_file()

    detail = client.get("/api/games/game_starter").json()
    assert detail["game"]["id"] == "game_starter"
    ids = [l["id"] for l in detail["levels"]]
    assert ids == ["lvl_starter1", "lvl_starter2", "lvl_starter3"]
    assert [l["order_index"] for l in detail["levels"]] == [0, 1, 2]
    for entry in detail["levels"]:
        Level.model_validate(entry["level"])
        assert entry["backdrop_url"] == f"/uploads/{entry['id']}/backdrop.png"
    for remix_id in ("lvl_remix_maya", "lvl_remix_sam"):
        remix = client.get(f"/api/levels/{remix_id}").json()
        assert remix["game"]["id"] == "game_starter"
        assert remix["level"]["order_index"] == 0
        assert (data_dir / "uploads" / remix_id / "backdrop.png").is_file()


def test_backdrop_is_served_as_png(client: TestClient) -> None:
    res = client.get("/uploads/lvl_starter1/backdrop.png")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("image/png")
    assert res.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_level_detail_has_children_and_likes(client: TestClient) -> None:
    body = client.get("/api/levels/lvl_starter1").json()
    assert body["author"] == "team"
    assert body["likes"] == 12
    assert body["game"]["id"] == "game_starter"
    assert body["parent"] is None
    assert body["next_level_id"] == "lvl_starter2"
    assert [c["id"] for c in body["children"]] == ["lvl_remix_maya"]
    assert body["children"][0]["author"] == "maya"
    Level.model_validate(body["level"])

    maya = client.get("/api/levels/lvl_remix_maya").json()
    assert maya["parent"] == {"id": "lvl_starter1", "title": "First Steps", "author": "team"}
    assert [c["id"] for c in maya["children"]] == ["lvl_remix_sam"]

    # After a remix of starter 1, "next level" continues the game with starter 2.
    last = client.get("/api/levels/lvl_remix_sam").json()
    assert last["next_level_id"] == "lvl_starter2"
    assert client.get("/api/levels/lvl_starter3").json()["next_level_id"] is None
    assert client.get("/api/levels/nope").status_code == 404


def test_seeded_remixes_validate_and_differ_from_parent(client: TestClient) -> None:
    starter = Level.model_validate(client.get("/api/levels/lvl_starter1").json()["level"])
    maya = Level.model_validate(client.get("/api/levels/lvl_remix_maya").json()["level"])
    sam = Level.model_validate(client.get("/api/levels/lvl_remix_sam").json()["level"])

    assert maya.title == "First Steps + spikes" and maya.author == "maya" and maya.parent_id == "lvl_starter1"
    assert "".join(starter.grid.rows).count("2") == 0
    assert "".join(maya.grid.rows).count("2") == 3
    assert sam.title == "First Steps speedrun" and sam.author == "sam" and sam.parent_id == "lvl_remix_maya"
    assert sam.grid.rows == maya.grid.rows
    assert {"when": "timer:45", "then": "lose"} in [r.model_dump() for r in sam.rules]


def test_tree_nests_maya_then_sam(client: TestClient) -> None:
    tree = client.get("/api/levels/lvl_starter1/tree").json()
    assert tree["id"] == "lvl_starter1" and tree["author"] == "team" and tree["title"] == "First Steps"
    assert tree["created_at"]
    assert len(tree["children"]) == 1
    maya = tree["children"][0]
    assert maya["id"] == "lvl_remix_maya" and maya["author"] == "maya"
    assert [c["id"] for c in maya["children"]] == ["lvl_remix_sam"]
    assert maya["children"][0]["children"] == []
    Level.model_validate(tree["level"])
    assert client.get("/api/levels/nope/tree").status_code == 404


def test_like_increments(client: TestClient) -> None:
    before = client.get("/api/levels/lvl_remix_sam").json()["likes"]
    assert client.post("/api/levels/lvl_remix_sam/like").json() == {"likes": before + 1}
    assert client.post("/api/levels/lvl_remix_sam/like").json() == {"likes": before + 2}
    assert client.get("/api/levels/lvl_remix_sam").json()["likes"] == before + 2
    assert client.post("/api/levels/nope/like").status_code == 404


def test_scan_with_bogus_image_is_422_or_503(client: TestClient) -> None:
    res = client.post(
        "/api/scan",
        files={"image": ("photo.jpg", b"definitely not an image", "image/jpeg")},
        data={"mode": "paper"},
    )
    assert res.status_code in (422, 503), res.text
    assert isinstance(res.json()["detail"], str)

    res = client.post(
        "/api/scan",
        files={"image": ("photo.jpg", b"x", "image/jpeg")},
        data={"mode": "sideways"},
    )
    assert res.status_code == 422


def test_scan_with_real_png_never_500s(client: TestClient, tmp_path: Path) -> None:
    img = Image.new("RGB", (768, 432), (255, 255, 255))
    path = tmp_path / "drawing.png"
    img.save(path)
    with path.open("rb") as fh:
        res = client.post(
            "/api/scan",
            files={"image": ("drawing.png", fh, "image/png")},
            data={"mode": "canvas", "prompt": "timer 60"},
        )
    assert res.status_code in (200, 422, 503), res.text
    if res.status_code == 200:
        body = res.json()
        assert DRAFT_RE.match(body["draft_id"])
        Level.model_validate(body["level"])
        assert body["level"]["source"]["photo_url"] == f"/uploads/drafts/{body['draft_id']}/photo.jpg"
        assert client.get(f"/api/drafts/{body['draft_id']}").status_code == 200
    else:
        assert isinstance(res.json()["detail"], str)


def test_fixtures_endpoint_returns_json(client: TestClient) -> None:
    names = client.get("/api/fixtures").json()["fixtures"]
    assert "starter_1_first_steps" in names
    res = client.get("/api/fixtures/starter_1_first_steps")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
    doc = res.json()
    assert doc == json.loads((FIXTURES_DIR / "levels" / "starter_1_first_steps.json").read_text())
    assert Level.model_validate(doc).id == "lvl_starter1"
    assert client.get("/api/fixtures/does_not_exist").status_code == 404
    assert client.get("/api/fixtures/..%2Flevel").status_code == 404


def _fake_draft(data_dir: Path, draft_id: str, *, parent_id: str | None = None, game_id: str | None = None,
                safety_ok: bool = True) -> Path:
    """What the scan endpoint leaves behind, built by hand because run_scan/compile are other lanes' work."""
    work_dir = data_dir / "uploads" / "drafts" / draft_id
    work_dir.mkdir(parents=True, exist_ok=True)
    prefix = f"/uploads/drafts/{draft_id}"
    level = Level.model_validate(json.loads((FIXTURES_DIR / "levels" / "starter_2_spike_valley.json").read_text()))
    level.id = draft_id
    level.title = "Drafted Valley"
    level.author = "draft"
    level.parent_id = parent_id
    level.game_id = game_id
    level.source.kind = "canvas"
    level.source.photo_url = f"{prefix}/photo.jpg"
    level.source.backdrop_url = f"{prefix}/backdrop.png"
    level.sprites.player = f"{prefix}/player.png"
    for name in ("photo.jpg", "backdrop.png", "player.png"):
        Image.new("RGBA" if name.endswith("png") else "RGB", (8, 8), (255, 255, 255, 255)).save(work_dir / name)
    (work_dir / "level.json").write_text(level.model_dump_json(indent=2))
    (work_dir / "draft.json").write_text(json.dumps({
        "draft_id": draft_id, "parent_hint": parent_id, "game_hint": game_id,
        "safety": {"ok": safety_ok, "reason": None if safety_ok else "test flag"},
    }))
    return work_dir


def test_publish_creates_a_game_and_moves_the_files(client: TestClient, data_dir: Path) -> None:
    work_dir = _fake_draft(data_dir, "d_0a0a0a0a")
    res = client.post("/api/levels", json={"draft_id": "d_0a0a0a0a", "author": "  Judge ", "solvable": True})
    assert res.status_code == 200, res.text
    level = Level.model_validate(res.json()["level"])
    assert LEVEL_RE.match(level.id)
    assert level.author == "Judge" and level.title == "Drafted Valley"
    assert level.meta.solvable is True and level.order_index == 0 and level.parent_id is None
    assert level.game_id and level.game_id.startswith("game_")
    assert level.source.photo_url == f"/uploads/{level.id}/photo.jpg"
    assert level.source.backdrop_url == f"/uploads/{level.id}/backdrop.png"
    assert level.sprites.player == f"/uploads/{level.id}/player.png"
    assert not work_dir.exists()
    assert (data_dir / "uploads" / level.id / "backdrop.png").is_file()
    assert (data_dir / "uploads" / level.id / "level.json").is_file()
    assert client.get(f"/uploads/{level.id}/player.png").status_code == 200

    feed = client.get("/api/games").json()["games"]
    assert len(feed) == 2
    created = next(g for g in feed if g["id"] == level.game_id)
    assert created["title"] == "Drafted Valley" and created["author"] == "Judge"
    assert created["level_count"] == 1 and created["cover"]["id"] == level.id

    detail = client.get(f"/api/levels/{level.id}").json()
    assert detail["likes"] == 0 and detail["children"] == []
    assert client.get("/api/drafts/d_0a0a0a0a").status_code == 404
    assert client.post("/api/levels", json={"draft_id": "d_0a0a0a0a", "author": "x", "solvable": False}).status_code == 404


def test_publish_remix_joins_parent_game_and_tree(client: TestClient, data_dir: Path) -> None:
    _fake_draft(data_dir, "d_0b0b0b0b", parent_id="lvl_remix_sam")
    res = client.post("/api/levels", json={"draft_id": "d_0b0b0b0b", "author": "", "title": "Sam's cousin", "solvable": False})
    assert res.status_code == 200, res.text
    level = Level.model_validate(res.json()["level"])
    assert level.author == "anonymous" and level.title == "Sam's cousin"
    # A remix takes its parent's slot in the game instead of extending the sequence.
    assert level.parent_id == "lvl_remix_sam" and level.game_id == "game_starter" and level.order_index == 0

    tree = client.get("/api/levels/lvl_starter1/tree").json()
    sam = tree["children"][0]["children"][0]
    assert [c["id"] for c in sam["children"]] == [level.id]
    game = client.get("/api/games/game_starter").json()
    assert [l["id"] for l in game["levels"]] == ["lvl_starter1", "lvl_starter2", "lvl_starter3"]
    assert client.get(f"/api/levels/{level.id}").json()["next_level_id"] == "lvl_starter2"
    feed_game = next(g for g in client.get("/api/games").json()["games"] if g["id"] == "game_starter")
    assert feed_game["level_count"] == 3 and "anonymous" in feed_game["authors"]


def test_publish_with_explicit_game_and_bad_refs(client: TestClient, data_dir: Path) -> None:
    _fake_draft(data_dir, "d_0c0c0c0c")
    res = client.post("/api/levels", json={"draft_id": "d_0c0c0c0c", "author": "ana", "solvable": True, "game_id": "game_starter"})
    assert res.status_code == 200, res.text
    assert res.json()["level"]["game_id"] == "game_starter"
    assert res.json()["level"]["order_index"] == 3  # appended after the three starters

    _fake_draft(data_dir, "d_0d0d0d0d")
    bad_game = client.post("/api/levels", json={"draft_id": "d_0d0d0d0d", "author": "ana", "solvable": True, "game_id": "game_nope"})
    assert bad_game.status_code == 422
    bad_parent = client.post("/api/levels", json={"draft_id": "d_0d0d0d0d", "author": "ana", "solvable": True, "parent_id": "lvl_nope"})
    assert bad_parent.status_code == 422
    assert (data_dir / "uploads" / "drafts" / "d_0d0d0d0d" / "level.json").is_file()  # the draft survives a refused publish

    _fake_draft(data_dir, "d_0e0e0e0e", safety_ok=False)
    flagged = client.post("/api/levels", json={"draft_id": "d_0e0e0e0e", "author": "ana", "solvable": True})
    assert flagged.status_code == 422 and "test flag" in flagged.json()["detail"]


def test_add_level_to_game_appends(client: TestClient, data_dir: Path) -> None:
    _fake_draft(data_dir, "d_0f0f0f0f")
    level_id = client.post("/api/levels", json={"draft_id": "d_0f0f0f0f", "author": "bo", "solvable": True}).json()["level"]["id"]
    res = client.post("/api/games/game_starter/levels", json={"level_id": level_id})
    assert res.status_code == 200, res.text
    assert res.json()["order_index"] == 4  # three starters + the level appended in the previous test
    assert res.json()["level"]["game_id"] == "game_starter"
    assert client.get("/api/games/game_starter").json()["levels"][-1]["id"] == level_id
    assert client.post("/api/games/game_nope/levels", json={"level_id": level_id}).status_code == 404
    assert client.post("/api/games/game_starter/levels", json={"level_id": "lvl_nope"}).status_code == 404


def test_templates_are_pdf_or_503(client: TestClient) -> None:
    for url in ("/api/templates/blank.pdf", "/api/templates/blank.pdf?game_id=game_starter", "/api/templates/remix/lvl_starter1.pdf"):
        res = client.get(url)
        assert res.status_code in (200, 503), url
        if res.status_code == 200:
            assert res.headers["content-type"] == "application/pdf"
            assert res.content[:4] == b"%PDF"
        else:
            assert isinstance(res.json()["detail"], str)
    assert client.get("/api/templates/blank.pdf?game_id=game_nope").status_code == 404
    assert client.get("/api/templates/remix/lvl_nope.pdf").status_code == 404
