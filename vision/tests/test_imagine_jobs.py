"""Generation remains observable across API processes and resumable after reloads."""
import asyncio
import hashlib
import json
import subprocess
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config
from app.build import drafts, imagine
from app.mind import client as mind
from app.routers.v2 import imagine as routes


@pytest.fixture(autouse=True)
def isolated_jobs(tmp_path, monkeypatch):
    monkeypatch.setenv("DAL_DATA_DIR", str(tmp_path))
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


def job(draft_id="d_abcdef12", **values):
    ink = {"v": 2, "strokes": [], "typed_rules": [], "world": {"screens": 1, "w": 48}}
    state = {"draft_id": draft_id, "game_id": None, "status": "building", "context": "Moon racing",
             "title": "Moon Rally", "conversation": [{"role": "user", "content": "Moon racing"}], **values}
    imagine.save(draft_id, state)
    drafts.write_json(draft_id, "original-ink.json", ink)
    return state, ink


def test_another_process_cannot_mark_running_job_interrupted_or_duplicate_retry():
    state, _ = job()
    path = imagine.artifact_path(state["draft_id"]).with_name("generation.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    owner = subprocess.Popen([sys.executable, "-c",
        "import fcntl,sys; f=open(sys.argv[1],'a+'); fcntl.flock(f,fcntl.LOCK_EX); "
        "print('locked',flush=True); sys.stdin.read()", str(path)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert owner.stdout.readline().strip() == "locked"
        assert state["draft_id"] not in imagine.TASKS
        app = FastAPI()
        app.include_router(routes.router, prefix="/api/v2")
        with TestClient(app) as client:
            response = client.get(f"/api/v2/imagined-games/{state['draft_id']}")
            assert response.json()["status"] == "building"
            assert "message_key" not in response.json()
            retried = client.post(f"/api/v2/imagined-games/{state['draft_id']}/retry").json()
            assert retried["draft_id"] == state["draft_id"]
        assert imagine.read(state["draft_id"])["status"] == "building"
    finally:
        owner.communicate("", timeout=5)
    assert not imagine.running(state["draft_id"])


def test_cancelled_generation_resumes_exact_context_in_same_draft(monkeypatch):
    state, ink = job()
    game = {"revision_context": {"html": "current game mechanics", "conversation": state["conversation"]}}
    calls = []
    html = "<html><body><script>" + "/* game */" * 150 + "</script></body></html>"

    async def no_art(*args, **kwargs):
        return {"assets": [], "cost_usd": 0}

    async def exercise():
        started = asyncio.Event()

        async def call(kind, schema, content, **kwargs):
            calls.append(content)
            if len(calls) == 1:
                started.set()
                await asyncio.Future()
            return mind.MindResult(kind="imagine", status="ok", value=imagine.ImaginedGame(
                title="Moon Rally", summary="A finished race", controls=["Arrows"], html=html))

        monkeypatch.setattr(mind, "call", call)
        assert imagine.start(state["draft_id"], ink, game, state["context"], state["title"])
        assert not imagine.start(state["draft_id"], ink, game, "duplicate", "duplicate")
        await started.wait()
        task = imagine.TASKS[state["draft_id"]]
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert imagine.read(state["draft_id"])["status"] == "building"
        assert not imagine.running(state["draft_id"])
        assert imagine.recover(state["draft_id"])
        assert imagine.recover(state["draft_id"])  # Polling cannot launch another model request.
        await imagine.TASKS[state["draft_id"]]

    monkeypatch.setattr(imagine.imagine_assets, "build", no_art)
    asyncio.run(exercise())
    assert len(calls) == 2 and calls[0] == calls[1]
    saved = imagine.read(state["draft_id"])
    assert saved["status"] == "ready" and saved["resume_count"] == 1
    assert saved["conversation"] == state["conversation"] + [{"role": "assistant", "content": "A finished race"}]
    assert imagine.artifact_path(state["draft_id"]).is_file()
    assert not imagine.running(state["draft_id"])


def test_owner_status_recovers_legacy_interrupted_draft_without_new_token(monkeypatch):
    state, _ = job(status="failed", message_key="imagine.interrupted", category="racing")
    token = "creator-secret"
    path = imagine.artifact_path(state["draft_id"]).with_name("creator.sha256")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(hashlib.sha256(token.encode()).hexdigest())
    calls = []

    async def generate(draft_id, ink, game, context, title):
        calls.append((draft_id, game, context, title))
        finished = imagine.read(draft_id)
        finished.update(status="ready", summary="Recovered")
        imagine.save(draft_id, finished)

    monkeypatch.setattr(imagine, "generate", generate)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v2")
    with TestClient(app) as client:
        response = client.get(f"/api/v2/imagined-games/{state['draft_id']}", headers={"X-DP-Draft": token}).json()
        assert response["status"] == "building" and response["can_publish"]
        assert "message_key" not in response
        ready = client.get(f"/api/v2/imagined-games/{state['draft_id']}", headers={"X-DP-Draft": token}).json()
        assert ready["status"] == "ready"
    assert len(calls) == 1 and calls[0][0] == state["draft_id"]
    assert calls[0][1]["brief"]["category"] == "racing"
    assert calls[0][2:] == ("Moon racing", "Moon Rally")
    assert path.read_text() == hashlib.sha256(token.encode()).hexdigest()


def test_legacy_canvas_revision_recovery_preserves_both_sketches():
    previous, original = job('d_98765432', status='ready')
    imagine.artifact_path(previous['draft_id']).parent.mkdir(parents=True, exist_ok=True)
    imagine.artifact_path(previous['draft_id']).write_text('<html><script>original</script></html>')
    revision, updated = job(revision_of=previous['draft_id'], canvas_updated=True, context='Change the platforms')
    updated['typed_rules'] = [{'text': 'The platforms move'}]
    drafts.write_json(revision['draft_id'], 'original-ink.json', updated)
    request = imagine._saved_request(revision['draft_id'], revision)
    assert request['ink'] == updated
    assert request['game']['revision_context']['previous_canvas'] == original
    assert request['game']['revision_context']['canvas_updated']
    assert request['context'] == 'Change the platforms'


def test_recovery_limit_and_superseded_jobs_do_not_start_again():
    state, _ = job(resume_count=imagine.MAX_RESUMES)
    assert not imagine.recover(state["draft_id"])
    state.update(resume_count=0, retried_as="d_12345678")
    imagine.save(state["draft_id"], state)
    assert not imagine.recover(state["draft_id"])
    assert not imagine.running(state["draft_id"])
