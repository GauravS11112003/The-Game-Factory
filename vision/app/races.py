"""Persistent two-seat races. SQLite transactions serialize joins, starts and results.

Sockets are authenticated with a first-frame ticket, never a credential in the URL.
Live positions are cosmetic. Only a core-verified replay can finish a race; elapsed
time is measured by the server from the shared start, so pausing cannot improve it.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from contextlib import closing, contextmanager
from typing import Any, Iterator

from fastapi import HTTPException

from app import db_v2
from app.mind import sanitize

COUNTDOWN_S = 3
ONLINE_S = 15
RECONNECT_S = 45
RACE_S = 600
INVITE_S = 86400


def fail(status: int, key: str) -> None:
    raise HTTPException(status, {"message_key": f"race.{key}"})


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@contextmanager
def transaction() -> Iterator[Any]:
    with closing(db_v2.connect()) as conn, conn:
        conn.execute("CREATE TABLE IF NOT EXISTS race_matches (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, data TEXT NOT NULL)")
        conn.execute("BEGIN IMMEDIATE")
        yield conn


def load(conn: Any, match_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT data FROM race_matches WHERE id = ?", (match_id,)).fetchone()
    if row is None:
        fail(404, "not_found")
    return json.loads(row[0])


def save(conn: Any, match: dict[str, Any]) -> None:
    conn.execute("UPDATE race_matches SET data = ? WHERE id = ?", (json.dumps(match), match["id"]))


def member(match: dict[str, Any], token: str) -> dict[str, Any]:
    hashed = digest(token)
    for player in match["players"]:
        if secrets.compare_digest(player["ticket_hash"], hashed):
            return player
    fail(403, "bad_ticket")


def invite_valid(match: dict[str, Any], invite: str) -> bool:
    return bool(invite and secrets.compare_digest(match["invite_hash"], digest(invite)))


def advance(match: dict[str, Any], now: float) -> None:
    players = match["players"]
    if match["phase"] == "waiting" and now >= match["expires_at"]:
        match["phase"] = "expired"
    if match["phase"] == "waiting":
        for p in players:
            if p["online_until"] <= now:
                p["ready"] = False
    if match["phase"] == "countdown":
        if now >= match["start_at"]:
            match["phase"] = "playing"
        elif not all(p["online_until"] > now for p in players):
            match["phase"], match["start_at"] = "waiting", None
            for p in players:
                p["ready"] = False
    if match["phase"] != "playing":
        return
    for p in players:
        if p["result"] or p["forfeit"]:
            continue
        if now >= match["start_at"] + RACE_S or now >= max(p["online_until"], match["start_at"]) + RECONNECT_S:
            p["forfeit"] = True
    if all(p["result"] or p["forfeit"] for p in players):
        results = [p for p in players if p["result"]]
        results.sort(key=lambda p: p["result"]["elapsed_ms"])
        match["phase"] = "finished"
        match["winner"] = results[0]["seat"] if results else None
        if len(results) == 2 and results[0]["result"]["elapsed_ms"] == results[1]["result"]["elapsed_ms"]:
            match["winner"] = None


def view(match: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    now = time.time() if now is None else now
    return {k: match[k] for k in ("id", "level_id", "level_version", "title", "phase", "round", "start_at", "expires_at", "winner")} | {
        "server_time": now,
        "players": [{k: p[k] for k in ("seat", "name", "ready", "progress", "result", "forfeit", "rematch")} |
                    {"connected": p["online_until"] > now} for p in match["players"]],
    }


def new_player(seat: int, name: str, ticket: str, claim: str = "") -> dict[str, Any]:
    return {"seat": seat, "name": sanitize.text(name, 16) or f"Player {seat}", "ticket_hash": digest(ticket),
            "claim_hash": digest(claim) if claim else "", "ready": False, "online_until": 0,
            "socket": None, "progress": None, "result": None, "forfeit": False, "rematch": False}


def create(level_id: str, version: int | None, name: str, reserve_host: bool,
           request_key: str = "") -> dict[str, Any]:
    row = db_v2.get_level_row(level_id, version)
    if not row or not row.get("level"):
        fail(404, "not_found")
    level = row["level"]
    if not any(e.get("type") == "goal" for e in level.get("compiled", {}).get("entities", [])):
        fail(422, "unsupported")
    now = time.time()
    ticket, invite = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    match = {"id": "r_" + secrets.token_hex(12), "level_id": level_id, "level_version": row["version"],
             "level": level, "title": sanitize.text(level.get("title"), 60) or "Platformer race",
             "invite_hash": digest(invite), "phase": "waiting", "round": 1, "start_at": None,
             "expires_at": now + INVITE_S, "winner": None,
             "players": [new_player(1, name, ticket)] if reserve_host else []}
    # Creation receipts make retrying a bot command return the SAME match and invitation.
    # These secrets stay in this private database, never in public snapshots.
    match["receipt"] = {"token": ticket if reserve_host else None, "invite": invite}
    with transaction() as conn:
        if request_key:
            prior = conn.execute("SELECT data FROM race_matches WHERE request_key = ?", (request_key,)).fetchone()
            if prior:
                match = json.loads(prior[0])
                return {"match": view(match), **match["receipt"]}
        conn.execute("INSERT INTO race_matches VALUES (?, ?, ?)", (match["id"], request_key or None, json.dumps(match)))
    return {"match": view(match), **match["receipt"]}


def snapshot(match_id: str, token: str = "", invite: str = "") -> dict[str, Any]:
    with transaction() as conn:
        match = load(conn, match_id)
        if token:
            member(match, token)
        elif not invite_valid(match, invite):
            fail(403, "bad_ticket")
        advance(match, time.time())
        save(conn, match)
        return view(match)


def level_for(match_id: str, token: str) -> dict[str, Any]:
    with transaction() as conn:
        match = load(conn, match_id)
        member(match, token)
        return match["level"]


def member_for_ticket(match_id: str, token: str) -> int:
    with transaction() as conn:
        return member(load(conn, match_id), token)["seat"]


def join(match_id: str, invite: str, name: str, claim: str) -> dict[str, Any]:
    with transaction() as conn:
        match = load(conn, match_id)
        if not invite_valid(match, invite):
            fail(403, "bad_ticket")
        advance(match, time.time())
        # The join claim is a random credential held by this browser. Deriving its
        # ticket lets a lost HTTP response be retried without losing the seat.
        ticket = hashlib.sha256(f"{match_id}:{invite}:{claim}".encode()).hexdigest()
        for p in match["players"]:
            if p["claim_hash"] == digest(claim):
                return {"match": view(match), "token": ticket, "seat": p["seat"]}
        if match["phase"] != "waiting":
            fail(409, "closed")
        if len(match["players"]) >= 2:
            fail(409, "full")
        seat = len(match["players"]) + 1
        match["players"].append(new_player(seat, name, ticket, claim))
        save(conn, match)
        return {"match": view(match), "token": ticket, "seat": seat}


def connection(match_id: str, token: str, socket_id: str, *, close: bool = False) -> dict[str, Any]:
    with transaction() as conn:
        match = load(conn, match_id)
        p = member(match, token)
        now = time.time()
        # Expired readiness and forfeits must be applied BEFORE renewing presence.
        advance(match, now)
        if close:
            if p["socket"] == socket_id:
                p["online_until"], p["socket"] = now, None
        else:
            p["online_until"], p["socket"] = now + ONLINE_S, socket_id
        advance(match, now)
        save(conn, match)
        return view(match)


def action(match_id: str, token: str, kind: str, *, socket_id: str = "", round_no: int | None = None,
           progress: dict[str, Any] | None = None) -> dict[str, Any]:
    with transaction() as conn:
        match = load(conn, match_id)
        p = member(match, token)
        now = time.time()
        advance(match, now)
        if socket_id:
            if p["socket"] != socket_id:
                fail(409, "other_tab")
            p["online_until"] = now + ONLINE_S
        if kind != "ping" and round_no != match["round"]:
            fail(409, "old_round")
        if kind == "ready":
            if match["phase"] != "waiting" or p["online_until"] <= now:
                fail(409, "closed")
            p["ready"] = True
            if len(match["players"]) == 2 and all(q["ready"] and q["online_until"] > now for q in match["players"]):
                match["phase"], match["start_at"] = "countdown", now + COUNTDOWN_S
        elif kind == "progress" and progress and match["phase"] == "playing" and not p["result"] and not p["forfeit"]:
            p["progress"] = progress
        elif kind == "forfeit" and match["phase"] == "playing":
            p["forfeit"] = True
        elif kind == "rematch":
            if match["phase"] != "finished":
                fail(409, "closed")
            p["rematch"] = True
            if all(q["rematch"] for q in match["players"]):
                match.update(phase="waiting", round=match["round"] + 1, start_at=None, winner=None, expires_at=now + INVITE_S)
                for q in match["players"]:
                    q.update(ready=False, progress=None, result=None, forfeit=False, rematch=False)
        advance(match, now)
        save(conn, match)
        return view(match)


def finish_context(match_id: str, token: str, round_no: int, received_at: float) -> tuple[dict[str, Any], dict[str, Any]]:
    with transaction() as conn:
        match = load(conn, match_id)
        p = member(match, token)
        advance(match, received_at)
        save(conn, match)
        if round_no != match["round"]:
            fail(409, "old_round")
        if p["result"]:
            return match, p
        if match["phase"] != "playing" or p["forfeit"]:
            fail(409, "closed")
        return match, p


def finish(match_id: str, token: str, round_no: int, received_at: float, verdict: dict[str, Any]) -> dict[str, Any]:
    with transaction() as conn:
        match = load(conn, match_id)
        p = member(match, token)
        if round_no != match["round"]:
            fail(409, "old_round")
        if p["result"]:
            return view(match)
        # Recheck after asynchronous verification: another request may have changed the round.
        if match["phase"] != "playing" or p["forfeit"]:
            fail(409, "closed")
        elapsed_ms = int(round((received_at - match["start_at"]) * 1000))
        if not verdict.get("finished") or not verdict.get("accepted", True) or verdict.get("win_frame", 0) <= 0:
            fail(422, "invalid_run")
        if verdict["win_frame"] * 1000 / 60 > elapsed_ms + 1500:
            fail(422, "invalid_run")
        p["result"] = {"elapsed_ms": elapsed_ms, "time_ms": verdict["time_ms"], "deaths": verdict["deaths"],
                       "coins": verdict["coins"], "verified": True}
        advance(match, time.time())
        save(conn, match)
        return view(match)
