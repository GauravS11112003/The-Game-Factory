"""Two-seat sessions for generated games. Host simulation; bounded, authenticated relay.

SQLite checkpoints make sessions survive API restarts and coordinate API processes.
Generated scripts remain opaque-origin sandboxes with no network or player tickets.
"""
from __future__ import annotations
import hashlib
import json
import math
import secrets
import time
from contextlib import closing, contextmanager
from typing import Any
from fastapi import HTTPException
from app import db_v2
from app.build import imagine
from app.config import get_settings

ONLINE_S = 5
MAX_WORLD_BYTES = 48_000


def fail(status: int, message: str) -> None:
    raise HTTPException(status, {"message": message})


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@contextmanager
def transaction():
    with closing(db_v2.connect()) as conn, conn:
        conn.execute("CREATE TABLE IF NOT EXISTS play_rooms (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, data TEXT NOT NULL)")
        conn.execute("BEGIN IMMEDIATE")
        yield conn


def load(conn, room_id):
    row = conn.execute("SELECT data FROM play_rooms WHERE id=?", (room_id,)).fetchone()
    if not row:
        fail(404, "This invitation is unavailable.")
    room = json.loads(row[0])
    advance(room)
    return room


def save(conn, room):
    conn.execute("UPDATE play_rooms SET data=? WHERE id=?", (json.dumps(room, allow_nan=False), room["id"]))


def member(room, token):
    for player in room["players"]:
        if secrets.compare_digest(player["token_hash"], digest(token)):
            return player
    fail(403, "Your player session is unavailable. Reopen your invitation.")


def authorize_invite(room, invite):
    if not invite or not secrets.compare_digest(digest(invite), room["invite_hash"]):
        fail(403, "This invitation is unavailable.")


def advance(room):
    now = time.time()
    if now >= room["expires_at"]:
        room["phase"] = "expired"
        return
    online = len(room["players"]) == 2 and all(p["online_until"] > now and p["ready"] for p in room["players"])
    if room["phase"] in ("playing", "countdown") and not online:
        room["phase"] = "paused"
        room["inputs"] = [[], []]
    if room["phase"] in ("waiting", "paused") and online:
        room["phase"] = "countdown"
        room["start_at"] = now + 3
    if room["phase"] == "countdown" and now >= room["start_at"]:
        room["phase"] = "playing"


def public(room):
    return {key: room[key] for key in ("id", "draft_id", "title", "phase", "round", "seed", "start_at", "expires_at", "winner", "result", "spec")} | {
        "kind": "generated", "server_time": time.time(),
        "players": [{"seat": p["seat"], "name": p["name"], "ready": p["ready"], "connected": p["online_until"] > time.time(), "rematch": p["rematch"], "forfeit": False, "result": None} for p in room["players"]]}


def artifact_path(room_id):
    return get_settings().data_dir / "play-rooms" / room_id / "game.html"


def create(draft_id, name="Player 1", reserve_host=True, request_key=""):
    with transaction() as conn:
        if request_key:
            row = conn.execute("SELECT data FROM play_rooms WHERE request_key=?", (request_key,)).fetchone()
            if row:
                room = json.loads(row[0])
                advance(room)
                return {"match": public(room), "invite": room["invite"], "token": None}
        state = imagine.read(draft_id)
        if not state or state.get("status") != "ready" or not state.get("multiplayer") or not state.get("multiplayer_spec"):
            fail(409, "Create this game with Multiplayer selected before inviting a friend.")
        source = imagine.artifact_path(draft_id)
        if not source.is_file():
            fail(404, "This game is unavailable.")
        room_id = "room_" + secrets.token_hex(12)
        invite = secrets.token_urlsafe(32)
        token = secrets.token_urlsafe(32) if reserve_host else None
        room = {"id": room_id, "draft_id": draft_id, "title": state["title"], "spec": state["multiplayer_spec"],
                "phase": "waiting", "round": 1, "seed": secrets.randbelow(2**31), "start_at": None,
                "expires_at": time.time() + 86400, "invite": invite, "invite_hash": digest(invite),
                "players": [], "world": None, "world_seq": 0, "inputs": [[], []], "winner": None, "result": None}
        if token:
            room["players"].append(new_player(0, name, token))
        artifact = artifact_path(room_id)
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text(source.read_text())  # Pin the exact build; later edits never replace an active game.
        conn.execute("INSERT INTO play_rooms VALUES(?,?,?)", (room_id, request_key or None, json.dumps(room)))
        return {"match": public(room), "invite": invite, "token": token, "seat": 0 if token else None}


def new_player(seat, name, token, claim=""):
    return {"seat": seat, "name": name.strip()[:16] or f"Player {seat+1}", "token_hash": digest(token),
            "claim_hash": digest(claim) if claim else "", "token": token if claim else "", "online_until": 0, "connection": "", "ready": False, "rematch": False}


def join(room_id, invite, name, claim):
    with transaction() as conn:
        room = load(conn, room_id)
        authorize_invite(room, invite)
        if room["phase"] == "expired":
            fail(410, "This invitation expired. Start a new game.")
        for p in room["players"]:
            if p["claim_hash"] == digest(claim):
                return {"match": public(room), "token": p["token"], "seat": p["seat"]}
        if len(room["players"]) >= 2:
            fail(409, "Both players have joined this game.")
        token = secrets.token_urlsafe(32)
        p = new_player(len(room["players"]), name, token, claim)
        room["players"].append(p)
        save(conn, room)
        return {"match": public(room), "token": token, "seat": p["seat"]}


def snapshot(room_id, token="", invite=""):
    with transaction() as conn:
        room = load(conn, room_id)
        member(room, token) if token else authorize_invite(room, invite)
        save(conn, room)
        return public(room)


def connect(room_id, token, connection):
    with transaction() as conn:
        room = load(conn, room_id)
        p = member(room, token)
        p.update(connection=connection, online_until=time.time() + ONLINE_S, ready=False)
        advance(room)
        save(conn, room)
        return p["seat"]


def disconnect(room_id, token, connection):
    with transaction() as conn:
        room = load(conn, room_id)
        p = member(room, token)
        if p["connection"] == connection:
            p.update(connection="", online_until=0, ready=False)
            room["inputs"][p["seat"]] = []
            advance(room)
            save(conn, room)


def stream(room_id, token, connection, message=None):
    with transaction() as conn:
        room = load(conn, room_id)
        p = member(room, token)
        if p["connection"] != connection:
            fail(409, "This player is connected in another window.")
        if room["phase"] == "expired":
            fail(410, "This invitation expired.")
        if message is not None:
            if not isinstance(message, dict) or message.get("round") != room["round"]:
                fail(409, "This round has changed.")
            kind = message.get("type")
            if kind not in ("ping", "ready", "input", "world", "finish", "rematch"):
                fail(400, "Unsupported game update.")
            p["online_until"] = time.time() + ONLINE_S
            if kind == "ready":
                p["ready"] = True
            elif kind == "input" and room["phase"] == "playing":
                actions = message.get("actions")
                allowed = {a["id"] for a in room["spec"]["actions"]}
                if not isinstance(actions, list) or len(actions) > 9 or any(not isinstance(a, str) or a not in allowed for a in actions):
                    fail(400, "Unsupported controls.")
                room["inputs"][p["seat"]] = list(dict.fromkeys(actions))
            elif kind == "world":
                if p["seat"] != 0:
                    fail(403, "Only the host may update the shared world.")
                world = message.get("world")
                if not isinstance(world, dict):
                    fail(400, "Invalid shared world.")
                try:
                    encoded = json.dumps(world, allow_nan=False)
                except (ValueError, TypeError):
                    fail(400, "Invalid shared world.")
                if len(encoded.encode()) > MAX_WORLD_BYTES:
                    fail(413, "The shared world is too large.")
                if room["phase"] == "playing":
                    room["world"] = world
                    room["world_seq"] += 1
            elif kind == "finish":
                if p["seat"] != 0:
                    fail(403, "Only the host may finish the shared game.")
                result = message.get("result")
                if not isinstance(result, dict) or type(result.get("winner")) not in (int, type(None)) or result.get("winner") not in (0, 1, None):
                    fail(400, "Invalid result.")
                scores = result.get("scores")
                if not isinstance(scores, list) or len(scores) != 2 or any(type(x) not in (int, float) or not math.isfinite(x) or abs(x) > 1e12 for x in scores):
                    fail(400, "Invalid scores.")
                if room["phase"] == "playing":
                    room.update(phase="finished", winner=result.get("winner"), result={"winner": result.get("winner"), "scores": scores, "text": str(result.get("text", "Round complete"))[:160]}, inputs=[[], []])
            elif kind == "rematch" and room["phase"] == "finished":
                p["rematch"] = True
                if len(room["players"]) == 2 and all(player["rematch"] for player in room["players"]):
                    room.update(phase="waiting", round=room["round"]+1, seed=secrets.randbelow(2**31), start_at=None, world=None, world_seq=0, inputs=[[], []], winner=None, result=None)
                    for player in room["players"]:
                        player.update(ready=False, rematch=False)
            advance(room)
        save(conn, room)
        return public(room) | {"world": room["world"], "world_seq": room["world_seq"], "inputs": room["inputs"]}
