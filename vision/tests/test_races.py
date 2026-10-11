"""Race integration: atomic seats, private tickets, reconnects, real core proofs and rematches."""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import config, db_v2, races
from app.build.bridge import CorePool, set_pool
from app.routers.v2 import matches

REPO = Path(__file__).resolve().parents[2]
LEVEL_FILE = REPO / "shared/spec/conformance/levels/valid/minimal_1screen.json"
LEVEL = json.loads(LEVEL_FILE.read_text())


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("DAL_DATA_DIR", str(tmp_path))
    config.get_settings.cache_clear()
    db_v2.ensure()
    db_v2.insert_level({"id": LEVEL["id"], "version": 1, "json": json.dumps(LEVEL), "title": LEVEL["title"],
                        "author": "test", "created_at": db_v2.now_iso(), "listed": 1, "order_index": 0,
                        "screens": 1, "verified": 1, "safety": "unchecked", "level_hash": LEVEL["meta"]["level_hash"]})
    clock = [100000.0]
    monkeypatch.setattr(races, "time", SimpleNamespace(time=lambda: clock[0]))
    monkeypatch.setattr(matches, "time", SimpleNamespace(time=lambda: clock[0], monotonic=time.monotonic))
    from app.routers.v2 import runs
    monkeypatch.setattr(runs, "_RECENT", {})
    yield clock
    config.get_settings.cache_clear()


@pytest.fixture
def client(setup):
    @asynccontextmanager
    async def lifespan(app):
        pool = CorePool(n=1, node=os.environ.get("DAL_NODE", "node"))
        await pool.start()
        set_pool(pool)
        yield
        set_pool(None)
        await pool.stop()

    app = FastAPI(lifespan=lifespan)
    app.include_router(matches.router, prefix="/api/v2")
    with TestClient(app) as client:
        yield client


def create(client):
    response = client.post("/api/v2/matches", json={"level_id": LEVEL["id"], "name": "Maya"})
    assert response.status_code == 201, response.text
    return response.json()


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def join(client, created):
    response = client.post(f"/api/v2/matches/{created['match']['id']}/join",
        json={"invite": created["invite"], "name": "Sam", "claim": secrets.token_hex(20)})
    assert response.status_code == 200, response.text
    return response.json()


def test_seat_claims_are_atomic_and_retryable(setup):
    created = races.create(LEVEL["id"], 1, "Maya", True)
    match_id = created["match"]["id"]
    claims = [secrets.token_hex(20), secrets.token_hex(20)]
    def attempt(claim):
        try:
            return races.join(match_id, created["invite"], "Friend", claim)
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, claims))
    assert sum(isinstance(result, dict) for result in results) == 1
    assert 409 in results
    i = next(i for i, result in enumerate(results) if isinstance(result, dict))
    retried = races.join(match_id, created["invite"], "Friend", claims[i])
    assert retried["token"] == results[i]["token"]
    public = races.snapshot(match_id, invite=created["invite"])
    assert "ticket" not in json.dumps(public) and "receipt" not in public and "level" not in public
    with pytest.raises(HTTPException):
        races.snapshot(match_id, token=created["invite"])


def test_socket_auth_and_disconnect_cancel_countdown(client, setup):
    created = create(client)
    guest = join(client, created)
    path = f"/api/v2/matches/{created['match']['id']}"
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(path + "/socket") as ws:
            ws.send_json({"type": "authenticate", "token": "wrong"})
            assert ws.receive_json()["type"] == "error"
            ws.receive_json()
    with client.websocket_connect(path + "/socket") as host:
        host.send_json({"type": "authenticate", "token": created["token"]})
        assert host.receive_json()["seat"] == 1
        with client.websocket_connect(path + "/socket") as friend:
            friend.send_json({"type": "authenticate", "token": guest["token"]})
            assert friend.receive_json()["seat"] == 2
            assert client.post(path + "/ready", json={"round": 1}, headers=auth(created["token"])).status_code == 200
            countdown = client.post(path + "/ready", json={"round": 1}, headers=auth(guest["token"])).json()
            assert countdown["phase"] == "countdown"
        # Disconnect is recorded before inspecting the shared state.
        state = client.get(path, headers=auth(created["token"])).json()
        assert state["phase"] == "waiting"
        assert not any(player["ready"] for player in state["players"])


def test_real_verified_finishes_and_rematch(client, setup):
    script = """
import { readFileSync } from 'node:fs';
import { createSim } from './web/src/core/sim/index.ts';
import { makeReplay } from './web/src/core/replay/verify.ts';
const level = JSON.parse(readFileSync('./shared/spec/conformance/levels/valid/minimal_1screen.json', 'utf8'));
const sim = createSim(level), inputs = [];
while (!sim.view().won && inputs.length < 2000) { inputs.push(10); sim.step(10); }
if (!sim.view().won) throw new Error('Test runner did not finish');
process.stdout.write(JSON.stringify(makeReplay(level, Uint8Array.from(inputs), '2.0.0')));
"""
    replay = json.loads(subprocess.check_output([os.environ.get("DAL_NODE", "node"), "--input-type=module", "-e", script], cwd=REPO))
    created = create(client)
    guest = join(client, created)
    match_id = created["match"]["id"]
    path = f"/api/v2/matches/{match_id}"
    races.connection(match_id, created["token"], "host")
    races.connection(match_id, guest["token"], "friend")
    races.action(match_id, created["token"], "ready", round_no=1)
    state = races.action(match_id, guest["token"], "ready", round_no=1)
    setup[0] = state["start_at"] + replay["frames"] / 60 + 1
    body = {"round": 1, "replay": replay}
    forged = {**body, "replay": {**replay, "input": "AAAA", "frames": 1}}
    assert client.post(path + "/finish", json=forged, headers=auth(created["token"])).status_code == 422
    wrong_version = {**body, "replay": {**replay, "level_version": 2}}
    assert client.post(path + "/finish", json=wrong_version, headers=auth(created["token"])).status_code == 422
    result = client.post(path + "/finish", json=body, headers=auth(created["token"]))
    assert result.status_code == 200, result.text
    assert result.json()["players"][0]["result"]["verified"]
    setup[0] += 2
    final = client.post(path + "/finish", json=body, headers=auth(guest["token"]))
    assert final.status_code == 200, final.text
    assert final.json()["phase"] == "finished" and final.json()["winner"] == 1
    assert client.post(path + "/finish", json=body, headers=auth(created["token"])).json()["phase"] == "finished"
    first = client.post(path + "/rematch", json={"round": 1}, headers=auth(created["token"])).json()
    assert first["phase"] == "finished"
    second = client.post(path + "/rematch", json={"round": 1}, headers=auth(guest["token"])).json()
    assert second["phase"] == "waiting" and second["round"] == 2
    assert all(player["result"] is None and not player["ready"] for player in second["players"])
    assert client.post(path + "/finish", json=body, headers=auth(created["token"])).status_code == 409


def test_reconnect_grace_and_expiry(setup):
    created = races.create(LEVEL["id"], 1, "Maya", True)
    match_id = created["match"]["id"]
    guest = races.join(match_id, created["invite"], "Sam", secrets.token_hex(20))
    for token in (created["token"], guest["token"]):
        races.connection(match_id, token, token[:8])
        races.action(match_id, token, "ready", round_no=1)
    setup[0] += races.COUNTDOWN_S + 1
    assert races.snapshot(match_id, created["token"])["phase"] == "playing"
    races.connection(match_id, guest["token"], guest["token"][:8], close=True)
    setup[0] += 20
    races.connection(match_id, guest["token"], "reopened")
    races.connection(match_id, created["token"], "host")
    assert not races.snapshot(match_id, guest["token"])["players"][1]["forfeit"]
    setup[0] += races.RECONNECT_S + races.ONLINE_S + 1
    assert races.snapshot(match_id, created["token"])["phase"] == "finished"
    unused = races.create(LEVEL["id"], 1, "Maya", True)
    setup[0] += races.INVITE_S + 1
    assert races.snapshot(unused["match"]["id"], unused["token"])["phase"] == "expired"


def test_reopening_does_not_revive_forfeit_or_leave_ready_players_stuck(setup):
    created = races.create(LEVEL["id"], 1, "Maya", True)
    match_id, token = created["match"]["id"], created["token"]
    guest = races.join(match_id, created["invite"], "Sam", secrets.token_hex(20))
    races.connection(match_id, token, "host")
    races.action(match_id, token, "ready", round_no=1)
    setup[0] += races.ONLINE_S + 1
    reconnected = races.connection(match_id, token, "reopened")
    assert reconnected["players"][0]["ready"] is False
    races.connection(match_id, guest["token"], "friend")
    races.action(match_id, token, "ready", round_no=1)
    state = races.action(match_id, guest["token"], "ready", round_no=1)
    assert state["phase"] == "countdown"
    # A disconnect AFTER the shared start cannot send everyone back to the lobby.
    setup[0] = state["start_at"] + 1
    assert races.connection(match_id, token, "reopened", close=True)["phase"] == "playing"
    setup[0] += races.RECONNECT_S + 1
    state = races.connection(match_id, token, "too-late")
    assert state["players"][0]["forfeit"] is True


def test_app_card_and_service_idempotency(client, monkeypatch):
    monkeypatch.setenv("DAL_PUBLIC_URL", "https://draw.example")
    monkeypatch.setenv("DAL_SPECTRUM_SERVICE_SECRET", "test-service-secret")
    headers = {"X-Spectrum-Service": "test-service-secret", "X-Race-Request": "one-message"}
    body = {"level_id": LEVEL["id"], "reserve_host": False}
    first = client.post("/api/v2/matches", json=body, headers=headers).json()
    again = client.post("/api/v2/matches", json=body, headers=headers).json()
    assert first["match"]["id"] == again["match"]["id"] and first["invite"] == again["invite"]
    assert first["token"] is None
    page = client.get(f"/api/v2/matches/{first['match']['id']}/card", params={"invite": first["invite"]})
    assert page.status_code == 200 and 'og:title' in page.text and 'https://draw.example/#/race/' in page.text
    assert page.headers["referrer-policy"] == "no-referrer"
    assert client.post("/api/v2/matches", json=body, headers={"X-Race-Request": "one-message"}).status_code == 403


def test_messages_lobby_has_two_open_seats_and_preserves_the_level_version(client):
    created = client.post("/api/v2/matches", json={"level_id": LEVEL["id"], "version": 1, "reserve_host": False}).json()
    assert created["token"] is None and created["match"]["players"] == []
    first = join(client, created)
    second = join(client, created)
    assert (first["seat"], second["seat"]) == (1, 2)
    assert first["token"] != second["token"]
    path = f"/api/v2/matches/{created['match']['id']}"
    assert client.get(path + "/level", headers=auth(first["token"])).json()["level"]["version"] == 1
    assert client.post(path + "/join", json={"invite": created["invite"], "name": "Third", "claim": secrets.token_hex(20)}).status_code == 409
