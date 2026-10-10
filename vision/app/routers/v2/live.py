"""Live drawing (docs/v3/CONTRACTS_V3.md "Live drawing", lane 6): WebSocket /api/v2/live/{room}.

Two or more people draw on one level canvas at the same time. Each room keeps an append-only op log, in memory and in
DAL_DATA_DIR/live/<room>.jsonl so a server reload never loses a session; the log is replayed (as the compacted stroke
set) to everyone who joins, every op is broadcast to everyone else, and presence (one colour per player, throttled
cursors carrying the stroke being drawn) is shared. The room id is the editor doc id.

Identity: `?player=<player_id>.<token>` (the X-DP-Player format) resolved through app.collab.identity when lane 4's
module is there; otherwise, or when the token does not resolve, `?name=` is taken as a display name (a guest).
`?cid=` is a per-tab id so a guest keeps their colour across reconnects.

JSON text frames. Client → server (`n` is the client's op counter, echoed in ack / reject):
  stroke_add    {n, stroke | strokes: [...]}      upsert by stroke id (a move or recolour re-sends the whole stroke)
  stroke_remove {n, id | ids: [...]}
  meta          {n, screens?, title?}
  cursor        {x, y, pen?: {k, color, from, pts: [[x, y, w], ...]}}   x = null: the pointer left the canvas
  chat          {text}                            emoji reactions in the UI
  pencil        {mode?: bool, to?: key, take?: true}   pass-the-pencil mode: only the holder may change the drawing
  ping          {}
Server → client:
  hello     {conn, key, player, color, room, pencil, limits}   to the newcomer
  sync      {strokes, screens, title, seq, fresh}                 the room state; sent after hello on every (re)connect
  presence  {players: [{conn, key, player, color, cursor}], pencil}
  stroke_add {strokes, stroke?, by, key, seq} · stroke_remove {ids, id?, by, key, seq} · meta {screens?, title?, by, seq}
  ack       {n, seq}           to the sender once its op is in the log
  reject    {n, code}          to the sender: the op was not applied (bad_stroke, too_many_points, not_your_turn, ...)
  cursor    {conn, x, y, pen?} · chat {conn, key, player, color, text} · pencil {mode, holder} · pong {} · error {code}
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import math
import os
import re
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, WebSocket
from fastapi.responses import JSONResponse, Response
from starlette.requests import Request

from app.config import SHARED_DIR, get_settings

log = logging.getLogger("dal.live")
router = APIRouter()


def _world() -> tuple[int, int, int]:
    try:
        w = json.loads((SHARED_DIR / "spec" / "params.json").read_text())["WORLD"]
        return int(w["screen_w"]), int(w["h"]), int(w["max_screens"])
    except Exception:  # noqa: BLE001
        return 48, 27, 6


SCREEN_W, WORLD_H, MAX_SCREENS = _world()

ROOM_RE = re.compile(r"^[A-Za-z0-9_-]{3,64}$")
ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,48}$")
COLORS = {"black", "red", "green", "blue", "pencil", "draft"}
KINDS = {"line", "dot", "blob"}
ORIGINS = {"kid", "parent", "designer", "library", "draft", "migrated"}
# Avatar colours: none of them is a marker colour, so a cursor never reads as ink.
PALETTE = ("#E8762B", "#8E5BD9", "#1FA39A", "#E0559B", "#C99A06", "#3FA7E0", "#6FA82A", "#A0662F", "#D94F70", "#4C6EDB")

MAX_FRAME = 4_000_000  # bytes of one text frame (a first-join seed of a big drawing is the largest)
MAX_POINTS = 5000  # points per stroke
MAX_BATCH = 2000  # strokes per stroke_add / ids per stroke_remove
MAX_STROKES = 8000  # strokes per room
MAX_PEN_PTS = 400  # points per cursor pen chunk
MAX_EXTRA_JSON = 8000  # bytes of a stroke's rule / lib
MAX_QUEUE = 2000  # queued frames per connection before a slow client is dropped
COMPACT_LINES = 2000  # a log longer than this is rewritten as one snapshot line when a room loads
X_MIN, X_MAX = -16.0, SCREEN_W * MAX_SCREENS + 16.0
Y_MIN, Y_MAX = -16.0, WORLD_H + 16.0


def _live_dir() -> Path:
    d = get_settings().data_dir / "live"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---- validation ------------------------------------------------------------------------------------------------------


class Bad(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _num(v: Any, lo: float, hi: float, code: str = "bad_stroke") -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise Bad(code)
    if v < lo or v > hi:
        raise Bad(code)
    return round(float(v), 5)


def clean_stroke(raw: Any) -> dict[str, Any]:
    """A stroke as the editor makes it (InkStroke), with only the known keys kept and every number checked."""
    if not isinstance(raw, dict):
        raise Bad("bad_stroke")
    sid = raw.get("id")
    if not isinstance(sid, str) or not ID_RE.match(sid):
        raise Bad("bad_stroke")
    color, kind, origin = raw.get("color"), raw.get("kind"), raw.get("origin", "kid")
    if color not in COLORS or kind not in KINDS or origin not in ORIGINS:
        raise Bad("bad_stroke")
    pts = raw.get("pts")
    if not isinstance(pts, list) or not pts:
        raise Bad("bad_stroke")
    if len(pts) > MAX_POINTS:
        raise Bad("too_many_points")
    if kind == "dot" and len(pts) != 1:
        raise Bad("bad_stroke")
    out_pts: list[list[float]] = []
    for p in pts:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            raise Bad("bad_stroke")
        out_pts.append([_num(p[0], X_MIN, X_MAX), _num(p[1], Y_MIN, Y_MAX)])
    w = raw.get("w")
    if not isinstance(w, list) or len(w) not in (1, len(out_pts)):
        raise Bad("bad_stroke")
    out_w = [_num(x, 0.0, 8.0) for x in w]
    sheet = raw.get("sheet", 0)
    if isinstance(sheet, bool) or not isinstance(sheet, int):
        raise Bad("bad_stroke")
    out: dict[str, Any] = {
        "id": sid, "color": color, "kind": kind, "pts": out_pts, "w": out_w, "closed": bool(raw.get("closed", False)),
        "sheet": max(0, min(MAX_SCREENS - 1, sheet)), "origin": origin,
    }
    for k in ("stamp", "label"):
        v = raw.get(k)
        if v is not None:
            if not isinstance(v, str) or len(v) > 40:
                raise Bad("bad_stroke")
            out[k] = v
    for k in ("rule", "lib"):
        v = raw.get(k)
        if v is not None:
            if not isinstance(v, dict) or len(json.dumps(v)) > MAX_EXTRA_JSON:
                raise Bad("bad_stroke")
            out[k] = v
    t = raw.get("t")
    if t is not None:
        out["t"] = _num(t, -1e12, 1e12)
    return out


def _clean_title(v: Any) -> str:
    if not isinstance(v, str):
        raise Bad("bad_meta")
    return re.sub(r"[\x00-\x1f\x7f]", "", v)[:60]


def _clean_pen(v: Any) -> dict[str, Any] | None:
    if not isinstance(v, dict):
        return None
    color = v.get("color")
    pts = v.get("pts")
    frm = v.get("from", 0)
    k = v.get("k", 0)
    if color not in COLORS or not isinstance(pts, list) or len(pts) > MAX_PEN_PTS:
        return None
    if isinstance(frm, bool) or not isinstance(frm, int) or frm < 0 or frm > MAX_POINTS:
        return None
    if not isinstance(k, (int, str)) or isinstance(k, bool) or len(str(k)) > 24:
        return None
    out: list[list[float]] = []
    try:
        for p in pts:
            if not isinstance(p, (list, tuple)) or len(p) not in (2, 3):
                return None
            q = [_num(p[0], X_MIN, X_MAX, "x"), _num(p[1], Y_MIN, Y_MAX, "x")]
            if len(p) == 3:
                q.append(_num(p[2], 0.0, 8.0, "x"))
            out.append(q)
    except Bad:
        return None
    return {"k": k, "color": color, "from": frm, "pts": out}


# ---- rate limits -----------------------------------------------------------------------------------------------------


class Bucket:
    """Token bucket. `take` drops when empty (cursors, chat); `pace` lets a burst run into debt and returns how long to
    wait, so a flood of ops is slowed down instead of being dropped (dropping an op would split the room's copies)."""

    def __init__(self, rate: float, burst: float) -> None:
        self.rate = rate
        self.burst = burst
        self.tokens = burst
        self.at = time.monotonic()

    def _refill(self) -> None:
        now = time.monotonic()
        self.tokens = min(self.burst, self.tokens + (now - self.at) * self.rate)
        self.at = now

    def take(self, cost: float = 1.0) -> bool:
        self._refill()
        if self.tokens < cost:
            return False
        self.tokens -= cost
        return True

    def pace(self, cost: float = 1.0) -> float:
        self._refill()
        self.tokens -= cost
        return 0.0 if self.tokens >= 0 else -self.tokens / self.rate


# ---- identity --------------------------------------------------------------------------------------------------------


def _player_dict(p: Any) -> dict[str, Any] | None:
    if p is None:
        return None
    if isinstance(p, tuple) and p:  # (player, ...) shapes
        p = p[0]
    if hasattr(p, "model_dump"):
        p = p.model_dump()
    elif not isinstance(p, dict) and hasattr(p, "__dict__"):
        p = {k: v for k, v in vars(p).items() if not k.startswith("_")}
    if not isinstance(p, dict):
        return None
    if isinstance(p.get("player"), dict):
        p = p["player"]
    pid = p.get("id")
    if not isinstance(pid, str) or not pid:
        return None
    name = p.get("name") if isinstance(p.get("name"), str) else ""
    avatar = p.get("avatar_url") if isinstance(p.get("avatar_url"), str) else None
    return {"id": pid, "name": (name or "Player")[:24], "avatar_url": avatar}


async def _resolve_player(ws: WebSocket, token: str) -> dict[str, Any] | None:
    """The lane 4 profile behind an X-DP-Player token, or None (no collab module yet, or the token does not match)."""
    if not token or len(token) > 256:
        return None
    try:
        from app.collab import identity as ident  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - lane 4 not there yet
        return None
    try:
        fn = getattr(ident, "player_from_token", None)
        if callable(fn):
            r = fn(token)
        else:
            fn = getattr(ident, "player_from_request", None)
            if not callable(fn):
                return None
            headers = [(k, v) for k, v in ws.scope.get("headers", []) if k.lower() != b"x-dp-player"]
            headers.append((b"x-dp-player", token.encode("utf-8", "replace")))
            r = fn(Request({**ws.scope, "type": "http", "method": "GET", "headers": headers}))
        if inspect.isawaitable(r):
            r = await r
        return _player_dict(r)
    except Exception:  # noqa: BLE001
        log.debug("live: player token did not resolve", exc_info=True)
        return None


def _guest(name: str, cid: str) -> tuple[str, dict[str, Any]]:
    clean = re.sub(r"[\x00-\x1f\x7f]", "", name or "").strip()[:24] or "Guest"
    tag = re.sub(r"[^A-Za-z0-9_-]", "", cid or "")[:32] or os.urandom(6).hex()
    return f"g:{tag}", {"id": f"guest_{tag}", "name": clean, "avatar_url": None}


# ---- rooms -----------------------------------------------------------------------------------------------------------


def _dumps(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


@dataclass(eq=False)
class Conn:
    ws: WebSocket
    id: str
    key: str
    player: dict[str, Any]
    color: str = PALETTE[0]
    cursor: list[float] | None = None
    queue: asyncio.Queue[str | None] = field(default_factory=asyncio.Queue)
    ops: Bucket = field(default_factory=lambda: Bucket(40.0, 120.0))
    cursors: Bucket = field(default_factory=lambda: Bucket(30.0, 30.0))
    chats: Bucket = field(default_factory=lambda: Bucket(2.0, 6.0))
    dead: bool = False

    def send_text(self, text: str) -> None:
        if self.dead:
            return
        if self.queue.qsize() >= MAX_QUEUE:
            self.dead = True
            log.info("live: dropping slow client %s", self.id)
            asyncio.get_running_loop().create_task(_close(self.ws, 1013))
            return
        self.queue.put_nowait(text)

    def send(self, obj: dict[str, Any]) -> None:
        self.send_text(_dumps(obj))

    def public(self) -> dict[str, Any]:
        return {"conn": self.id, "key": self.key, "player": self.player, "color": self.color, "cursor": self.cursor}


async def _close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:  # noqa: BLE001
        pass


class Room:
    def __init__(self, room_id: str) -> None:
        self.id = room_id
        self.path = _live_dir() / f"{room_id}.jsonl"
        self.strokes: dict[str, dict[str, Any]] = {}
        self.screens: int | None = None
        self.title: str | None = None
        self.seq = 0
        self.conns: dict[str, Conn] = {}
        self.colors: dict[str, str] = {}
        self.pencil_mode = False
        self.holder: str | None = None
        self._fh: Any = None
        self._load()

    # -- the op log --
    def _apply(self, op: str, body: dict[str, Any]) -> None:
        if op == "snapshot":
            self.strokes = {s["id"]: s for s in body.get("strokes", []) if isinstance(s, dict) and "id" in s}
            self.screens = body.get("screens")
            self.title = body.get("title")
        elif op == "stroke_add":
            for s in body.get("strokes", []):
                self.strokes.pop(s["id"], None)  # re-insert so the dict order follows the last change
                self.strokes[s["id"]] = s
        elif op == "stroke_remove":
            for sid in body.get("ids", []):
                self.strokes.pop(sid, None)
        elif op == "meta":
            if "screens" in body:
                self.screens = body["screens"]
            if "title" in body:
                self.title = body["title"]

    def _load(self) -> None:
        if not self.path.exists():
            return
        lines = 0
        try:
            with self.path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    lines += 1
                    try:
                        rec = json.loads(line)
                        self._apply(str(rec.get("op")), rec)
                        self.seq = max(self.seq, int(rec.get("seq", 0)))
                    except Exception:  # noqa: BLE001 - a torn last line after a crash
                        continue
        except OSError:
            log.warning("live: could not read %s", self.path)
            return
        if lines > COMPACT_LINES:
            self._compact()

    def _compact(self) -> None:
        rec = {"seq": self.seq, "t": time.time(), "op": "snapshot", "strokes": list(self.strokes.values()),
               "screens": self.screens, "title": self.title}
        tmp = self.path.with_suffix(".jsonl.tmp")
        try:
            tmp.write_text(_dumps(rec) + "\n", encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError:
            log.warning("live: could not compact %s", self.path)

    def record(self, op: str, body: dict[str, Any], by: str) -> int:
        self.seq += 1
        self._apply(op, body)
        try:
            if self._fh is None:
                self._fh = self.path.open("a", encoding="utf-8")
            self._fh.write(_dumps({"seq": self.seq, "t": round(time.time(), 3), "by": by, "op": op, **body}) + "\n")
            self._fh.flush()
        except OSError:
            log.warning("live: could not append to %s", self.path)
        return self.seq

    def close_log(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None

    # -- presence --
    def color_for(self, key: str) -> str:
        used = {c.color for c in self.conns.values() if c.key != key}
        mine = self.colors.get(key)
        if mine and mine not in used:
            return mine
        free = [c for c in PALETTE if c not in used and c not in self.colors.values()] or [c for c in PALETTE if c not in used]
        color = free[0] if free else PALETTE[len(self.colors) % len(PALETTE)]
        self.colors[key] = color
        return color

    def keys(self) -> list[str]:
        out: list[str] = []
        for c in self.conns.values():
            if c.key not in out:
                out.append(c.key)
        return out

    def pencil(self) -> dict[str, Any]:
        return {"mode": self.pencil_mode, "holder": self.holder}

    def broadcast(self, obj: dict[str, Any], exclude: Conn | None = None) -> None:
        text = _dumps(obj)
        for c in list(self.conns.values()):
            if c is not exclude:
                c.send_text(text)

    def presence(self) -> None:
        self.broadcast({"type": "presence", "players": [c.public() for c in self.conns.values()], "pencil": self.pencil()})

    def leave(self, conn: Conn) -> None:
        self.conns.pop(conn.id, None)
        if self.pencil_mode and self.holder == conn.key and conn.key not in self.keys():
            keys = self.keys()
            self.holder = keys[0] if keys else None
            if not keys:
                self.pencil_mode = False
            self.broadcast({"type": "pencil", **self.pencil()})
        self.presence()

    def state(self) -> dict[str, Any]:
        return {"type": "sync", "strokes": list(self.strokes.values()), "screens": self.screens, "title": self.title,
                "seq": self.seq, "fresh": self.seq == 0}


class Rooms:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self.next_conn = 0

    def get(self, room_id: str) -> Room:
        r = self.rooms.get(room_id)
        if r is None:
            r = Room(room_id)
            self.rooms[room_id] = r
        return r

    def peek(self, room_id: str) -> Room | None:
        return self.rooms.get(room_id)

    def release(self, r: Room) -> None:
        if not r.conns and self.rooms.get(r.id) is r:
            r.close_log()
            del self.rooms[r.id]

    def conn_id(self) -> str:
        self.next_conn += 1
        return f"c{self.next_conn}"


ROOMS = Rooms()


# ---- message handling ------------------------------------------------------------------------------------------------


class TooFast(Exception):
    pass


async def _pace(conn: Conn, cost: float) -> None:
    wait = conn.ops.pace(cost)
    if wait > 10.0:
        raise TooFast()
    if wait > 0:
        await asyncio.sleep(wait)


def _may_edit(room: Room, conn: Conn) -> bool:
    return not room.pencil_mode or room.holder in (None, conn.key) or room.holder not in room.keys()


async def _handle(room: Room, conn: Conn, msg: dict[str, Any]) -> None:
    kind = msg.get("type")
    n = msg.get("n") if isinstance(msg.get("n"), int) and not isinstance(msg.get("n"), bool) else None

    def reject(code: str) -> None:
        conn.send({"type": "reject", "n": n, "code": code})

    if kind == "stroke_add":
        raw = msg.get("strokes") if isinstance(msg.get("strokes"), list) else [msg.get("stroke")]
        await _pace(conn, max(1.0, len(raw) / 50))
        if not _may_edit(room, conn):
            return reject("not_your_turn")
        if not raw or len(raw) > MAX_BATCH:
            return reject("too_many_strokes")
        try:
            strokes = [clean_stroke(s) for s in raw]
        except Bad as e:
            return reject(e.code)
        new = sum(1 for s in strokes if s["id"] not in room.strokes)
        if len(room.strokes) + new > MAX_STROKES:
            return reject("room_full")
        seq = room.record("stroke_add", {"strokes": strokes}, conn.key)
        conn.send({"type": "ack", "n": n, "seq": seq})
        out: dict[str, Any] = {"type": "stroke_add", "strokes": strokes, "by": conn.id, "key": conn.key, "seq": seq}
        if len(strokes) == 1:
            out["stroke"] = strokes[0]
        room.broadcast(out, exclude=conn)
    elif kind == "stroke_remove":
        raw = msg.get("ids") if isinstance(msg.get("ids"), list) else [msg.get("id")]
        await _pace(conn, max(1.0, len(raw) / 50))
        if not _may_edit(room, conn):
            return reject("not_your_turn")
        if len(raw) > MAX_BATCH:
            return reject("too_many_strokes")
        ids = [i for i in raw if isinstance(i, str) and i in room.strokes]
        if not ids:
            conn.send({"type": "ack", "n": n, "seq": room.seq})
            return
        seq = room.record("stroke_remove", {"ids": ids}, conn.key)
        conn.send({"type": "ack", "n": n, "seq": seq})
        out = {"type": "stroke_remove", "ids": ids, "by": conn.id, "key": conn.key, "seq": seq}
        if len(ids) == 1:
            out["id"] = ids[0]
        room.broadcast(out, exclude=conn)
    elif kind == "meta":
        await _pace(conn, 1.0)
        if not _may_edit(room, conn):
            return reject("not_your_turn")
        body: dict[str, Any] = {}
        try:
            if "screens" in msg:
                s = msg["screens"]
                if isinstance(s, bool) or not isinstance(s, int):
                    raise Bad("bad_meta")
                body["screens"] = max(1, min(MAX_SCREENS, s))
            if "title" in msg:
                body["title"] = _clean_title(msg["title"])
        except Bad as e:
            return reject(e.code)
        if not body:
            conn.send({"type": "ack", "n": n, "seq": room.seq})
            return
        seq = room.record("meta", body, conn.key)
        conn.send({"type": "ack", "n": n, "seq": seq})
        room.broadcast({"type": "meta", **body, "by": conn.id, "key": conn.key, "seq": seq}, exclude=conn)
    elif kind == "cursor":
        if not conn.cursors.take():
            return
        x, y = msg.get("x"), msg.get("y")
        try:
            conn.cursor = None if x is None or y is None else [_num(x, X_MIN, X_MAX, "x"), _num(y, Y_MIN, Y_MAX, "x")]
        except Bad:
            return
        out = {"type": "cursor", "conn": conn.id, "x": conn.cursor[0] if conn.cursor else None,
               "y": conn.cursor[1] if conn.cursor else None}
        pen = _clean_pen(msg.get("pen"))
        if pen:
            out["pen"] = pen
        room.broadcast(out, exclude=conn)
    elif kind == "chat":
        text = msg.get("text")
        if not isinstance(text, str):
            return
        text = re.sub(r"[\x00-\x1f\x7f]", "", text).strip()[:40]
        if not text:
            return
        if not conn.chats.take():
            conn.send({"type": "error", "code": "slow_down"})
            return
        room.broadcast({"type": "chat", "conn": conn.id, "key": conn.key, "player": conn.player, "color": conn.color,
                        "text": text}, exclude=conn)
    elif kind == "pencil":
        await _pace(conn, 1.0)
        holder_here = room.holder in room.keys()
        mine = room.holder == conn.key or not holder_here
        changed = False
        if msg.get("mode") is True and not room.pencil_mode:
            room.pencil_mode, room.holder, changed = True, conn.key, True
        elif msg.get("mode") is False and room.pencil_mode:
            if not mine:
                return conn.send({"type": "error", "code": "not_your_turn"})
            room.pencil_mode, room.holder, changed = False, None, True
        if isinstance(msg.get("to"), str) and room.pencil_mode:
            if not mine:
                return conn.send({"type": "error", "code": "not_your_turn"})
            if msg["to"] in room.keys():
                room.holder, changed = msg["to"], True
        if msg.get("take") is True and room.pencil_mode and not holder_here:
            room.holder, changed = conn.key, True
        if changed:
            room.broadcast({"type": "pencil", **room.pencil(), "by": conn.id})
    elif kind == "ping":
        conn.send({"type": "pong"})
    else:
        conn.send({"type": "error", "code": "unknown_type"})


async def _writer(conn: Conn) -> None:
    try:
        while True:
            text = await conn.queue.get()
            if text is None:
                return
            await conn.ws.send_text(text)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - the socket closed under us; the reader notices too
        conn.dead = True


@router.websocket("/live/{room}")
async def live_socket(ws: WebSocket, room: str) -> None:
    if not ROOM_RE.match(room):
        await ws.close(code=1008)
        return
    token = ws.query_params.get("player") or ""
    name = ws.query_params.get("name") or ""
    cid = ws.query_params.get("cid") or ""
    await ws.accept()
    player = await _resolve_player(ws, token)
    if player is not None:
        key = f"p:{player['id']}"
    else:
        key, player = _guest(name, cid)
    r = ROOMS.get(room)
    conn = Conn(ws=ws, id=ROOMS.conn_id(), key=key, player=player)
    conn.color = r.color_for(key)
    r.conns[conn.id] = conn
    writer = asyncio.create_task(_writer(conn), name=f"live writer {room}/{conn.id}")
    conn.send({"type": "hello", "conn": conn.id, "key": key, "player": player, "color": conn.color, "room": room,
               "pencil": r.pencil(), "limits": {"max_points": MAX_POINTS, "max_batch": MAX_BATCH, "max_strokes": MAX_STROKES}})
    conn.send(r.state())
    r.presence()
    try:
        while not conn.dead:
            frame = await ws.receive()
            if frame.get("type") == "websocket.disconnect":
                break
            text = frame.get("text")
            if text is None:
                data = frame.get("bytes")
                text = data.decode("utf-8", "replace") if isinstance(data, (bytes, bytearray)) else None
            if text is None:
                continue
            if len(text) > MAX_FRAME:
                conn.send({"type": "error", "code": "too_big"})
                continue
            try:
                msg = json.loads(text)
            except ValueError:
                conn.send({"type": "error", "code": "bad_json"})
                continue
            if isinstance(msg, dict):
                await _handle(r, conn, msg)
    except TooFast:
        conn.send({"type": "error", "code": "too_fast"})
        await asyncio.sleep(0.05)
        await _close(ws, 1008)
    except Exception as e:  # noqa: BLE001 - WebSocketDisconnect, a reset, ...
        if type(e).__name__ not in ("WebSocketDisconnect", "ClientDisconnected", "ConnectionClosed"):
            log.warning("live: %s/%s closed: %r", room, conn.id, e)
    finally:
        conn.dead = True
        r.leave(conn)
        writer.cancel()
        ROOMS.release(r)


# ---- HTTP helpers for the share sheet ----------------------------------------------------------------------------------


def _lan_hosts() -> list[str]:
    """This machine's LAN address, so a phone can open the share link when the host browses on localhost."""
    out: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))  # no packet is sent: this only picks the outbound interface
            ip = s.getsockname()[0]
        finally:
            s.close()
        if ip and not ip.startswith("127."):
            out.append(ip)
    except OSError:
        pass
    return out


@router.get("/live/{room}/info")
def live_info(room: str) -> JSONResponse:
    if not ROOM_RE.match(room):
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    r = ROOMS.peek(room)
    on_disk = (_live_dir() / f"{room}.jsonl").exists()
    players: list[dict[str, Any]] = []
    if r is not None:
        seen: set[str] = set()
        for c in r.conns.values():
            if c.key not in seen:
                seen.add(c.key)
                players.append({"key": c.key, "player": c.player, "color": c.color})
    return JSONResponse({
        "room": room, "exists": r is not None or on_disk, "players": players,
        "strokes": len(r.strokes) if r is not None else None, "title": r.title if r is not None else None,
        "lan_hosts": _lan_hosts(),
    })


@router.get("/live/{room}/qr.svg")
def live_qr(room: str, url: str = Query(..., max_length=600)) -> Response:
    if not ROOM_RE.match(room) or not re.match(r"^https?://", url) or room not in url:
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    try:
        import qrcode
        import qrcode.image.svg

        img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathFillImage, box_size=10, border=2)
        svg = img.to_string(encoding="unicode")
    except Exception:  # noqa: BLE001
        log.warning("live: QR generation failed", exc_info=True)
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    return Response(svg if isinstance(svg, (str, bytes)) else str(svg), media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=3600"})
