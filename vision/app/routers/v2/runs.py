"""Runs, boards, attempts and thumbnails (PLAN_V2 §8.4, §11.3e). The replay is the proof of a run: the worker
re-simulates it on the exact level version it was recorded on (`verify_run`), and only the server's numbers are kept.

POST /levels/{id}/runs        {player, replay, claimed, vs_run_id?} → {run_id, verified, rank, pb, stamps, vs?} | 422
GET  /levels/{id}/runs        ?board=any|collector&limit=10 → {runs: [...], creator}  (each player's best; runs on the
                              current version first, older-version runs after them, labelled `older`)
GET  /runs/{run_id}           → {run, replay, sprite_url}                    (ghosts and "beat my level" links)
POST /levels/{id}/attempts    {attempts, deaths, clears} → 204                 (clear rate; the hot sort)
PUT  /levels/{id}/thumbnail   PNG body → 204                                   (/uploads/thumbs/<id>.png)
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import time
from collections import deque
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from app import db_v2
from app.build.bridge import CoreError, get_pool
from app.config import get_settings
from app.mind import moderate, sanitize
from app.spec.api import AttemptsBody
from app.spec.runs import RunSubmit

log = logging.getLogger("dal.v2.runs")
router = APIRouter()

_LEVEL_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_RUN_ID = re.compile(r"^run_[0-9a-f]{10}$")
MAX_THUMB_BYTES = 3 * 1024 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MAX_ATTEMPTS_PER_POST = 10_000
FRAME_MS = 1000 / 60
FPS = 60
# §8.4 limits (params.json RUNS): 30 runs per minute per IP, logs over 20 minutes are rejected
RUNS_PER_MINUTE = int((sanitize.params().get("RUNS") or {}).get("per_minute_per_ip", 30))
MAX_LOG_MINUTES = float((sanitize.params().get("RUNS") or {}).get("max_log_minutes", 20))
_RECENT: dict[str, deque[float]] = {}


def rate_limited(ip: str) -> bool:
    now = time.monotonic()
    q = _RECENT.setdefault(ip, deque())
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= RUNS_PER_MINUTE:
        return True
    q.append(now)
    if len(_RECENT) > 5000:  # forget idle addresses
        for k in [k for k, v in _RECENT.items() if not v or now - v[-1] > 60][:2500]:
            _RECENT.pop(k, None)
    return False


def claim_mismatch(claimed: dict[str, Any], verdict: dict[str, Any]) -> str | None:
    """The first claimed number that differs from the server's re-simulation (§8.4: every one must match exactly).
    Time is compared in frames, so client and server rounding of milliseconds never matters."""
    frames = int(verdict.get("frames") or 0)
    if int(round(int(claimed.get("time_ms") or 0) * FPS / 1000)) != frames:
        return "time"
    for k in ("deaths", "coins", "big_coins"):
        if int(claimed.get(k) or 0) != int(verdict.get(k) or 0):
            return k
    return None


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def ms_of(frames: int) -> int:
    return int(round(int(frames) * FRAME_MS))


def thumbs_dir() -> Any:
    d = get_settings().uploads_dir / "thumbs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _big_coins(level: dict[str, Any]) -> int:
    return sum(1 for e in ((level.get("compiled") or {}).get("entities") or []) if e.get("type") == "big_coin")


def _run_row_out(r: dict[str, Any], latest: int | None = None) -> dict[str, Any]:
    v = int(r["level_version"])
    return {"run_id": r["id"], "player": r["player"], "frames": int(r["frames"]), "time_ms": ms_of(r["frames"]),
            "deaths": int(r["deaths"]), "coins": int(r["coins"]), "big_coins": int(r["big_coins"]),
            "level_version": v, "board": r["board"], "created_at": r["created_at"],
            "older": bool(latest is not None and v < latest)}


@router.post("/levels/{level_id}/runs")
async def post_run(level_id: str, request: Request) -> Any:
    if not _LEVEL_ID.match(level_id):
        return err(404, "error.not_found", {"what": "level"})
    try:
        body = RunSubmit.model_validate(await request.json())
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "run", "errors": min(e.error_count(), 99)})
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request")
    ip = request.client.host if request.client else "?"
    if rate_limited(ip):
        return err(429, "error.rate_limited")
    replay = body.replay.model_dump(mode="json")
    if replay.get("level_id") not in (level_id, "", None):
        return err(422, "run.rejected", {"why": "level_id"})
    if int(replay.get("frames") or 0) > MAX_LOG_MINUTES * 60 * FPS:
        return err(422, "run.rejected", {"why": "too_long"})
    row = db_v2.get_level_row(level_id, int(replay.get("level_version") or 0) or None)
    if row is None or row.get("level") is None:
        return err(404, "error.not_found", {"what": "level"})
    level = row["level"]
    # the level hash is checked by the core (A-2): a replay may name the recomputed gameplay hash or the stored one,
    # so an honest run is never rejected because a stored hash is out of date
    player = sanitize.text(body.player, 16)
    if not player or moderate.blocklist_hit([player]):
        return err(422, "run.rejected", {"why": "name"})
    pool = get_pool()
    if pool is None:
        return err(503, "error.worker_down")
    try:
        claimed = body.claimed.model_dump(mode="json")
        verdict = await pool.call("verify_run", {"level": level, "replay": replay, "claimed": claimed})
    except CoreError as e:
        if e.code in ("down", "timeout"):
            return err(503, "error.worker_down")
        return err(422, "run.rejected", {"why": e.code})
    if not isinstance(verdict, dict) or not verdict.get("finished"):
        why = str((verdict or {}).get("reason") or "not_finished") if isinstance(verdict, dict) else "not_finished"
        return err(422, "run.rejected", {"why": why if why != "ok" else "not_finished"})
    # every claimed number must match the re-simulation (time compared in frames, so ms rounding never matters)
    bad = claim_mismatch(claimed, verdict)
    if bad is not None:
        return err(422, "run.rejected", {"why": f"claim_{bad}"})
    frames = int(verdict.get("frames") or 0)
    big_total = _big_coins(level)
    board = "collector" if big_total > 0 and int(verdict.get("big_coins") or 0) >= big_total else "any"
    run_id = f"run_{secrets.token_hex(5)}"
    prev_best = db_v2.player_best_frames(level_id, player)
    db_v2.insert_run({
        "id": run_id, "level_id": level_id, "level_version": int(row.get("version") or 1),
        "level_hash": str(replay.get("level_hash") or ""), "player": player, "frames": frames,
        "deaths": int(verdict.get("deaths") or 0), "coins": int(verdict.get("coins") or 0),
        "big_coins": int(verdict.get("big_coins") or 0), "board": board,
        "replay": json.dumps(replay, separators=(",", ":")), "verified": 1, "created_at": db_v2.now_iso(),
    })
    run_version = int(row.get("version") or 1)
    latest = db_v2.latest_version(level_id) or run_version
    ranked = _ordered(db_v2.board_runs(level_id, "any", 100), latest)
    rank = next((i + 1 for i, r in enumerate(ranked) if str(r["player"]).lower() == player.lower()), None)
    out: dict[str, Any] = {"run_id": run_id, "verified": True, "rank": rank, "pb": prev_best is None or frames < prev_best,
                           "stamps": list(verdict.get("stamps") or []), "vs": None,
                           "time_ms": int(verdict.get("time_ms") or ms_of(frames)), "deaths": int(verdict.get("deaths") or 0),
                           "coins": int(verdict.get("coins") or 0), "big_coins": int(verdict.get("big_coins") or 0),
                           "board": board, "older": run_version < latest}
    if body.vs_run_id:
        other = db_v2.get_run(body.vs_run_id)
        if other is not None and other.get("level_id") == level_id:
            diff = ms_of(abs(int(other["frames"]) - frames))
            out["vs"] = {"beat": frames < int(other["frames"]), "by_ms": diff}
    return out


def _ordered(rows: list[dict[str, Any]], latest: int | None) -> list[dict[str, Any]]:
    """Runs on the current version first (fastest first), then runs "on an older version" (§8.4)."""
    return sorted(rows, key=lambda r: (latest is not None and int(r["level_version"]) < latest, int(r["frames"]),
                                       int(r["deaths"]), str(r["created_at"]), str(r["id"])))


@router.get("/levels/{level_id}/runs")
def get_runs(level_id: str, board: str = Query(default="any"), limit: int = Query(default=10, ge=1, le=100)) -> Any:
    if not _LEVEL_ID.match(level_id):
        return err(404, "error.not_found", {"what": "level"})
    if board not in ("any", "collector"):
        return err(400, "error.bad_request", {"field": "board"})
    latest = db_v2.latest_version(level_id)
    rows = _ordered(db_v2.board_runs(level_id, board, 100), latest)[:limit]
    creator = None
    lvl = db_v2.get_level_row(level_id)
    if lvl is not None and lvl.get("author"):
        best = db_v2.best_run_of(level_id, str(lvl["author"]))
        creator = _run_row_out(best, latest) if best is not None else None
    return {"runs": [_run_row_out(r, latest) for r in rows], "board": board, "creator": creator,
            "level_version": latest}


@router.get("/runs/{run_id}")
def get_run(run_id: str) -> Any:
    if not _RUN_ID.match(run_id):
        return err(404, "error.not_found", {"what": "run"})
    r = db_v2.get_run(run_id)
    if r is None:
        return err(404, "error.not_found", {"what": "run"})
    try:
        replay = json.loads(r["replay"])
    except (TypeError, json.JSONDecodeError):
        return err(404, "error.not_found", {"what": "run"})
    return {"run": _run_row_out(r, db_v2.latest_version(str(r["level_id"]))), "replay": replay,
            "level_id": r["level_id"], "sprite_url": _sprite_url(str(r["level_id"]), int(r["level_version"]))}


def _sprite_url(level_id: str, version: int) -> str | None:
    """The runner's ghost is drawn with the level's own character sprite when it has one (§8.4)."""
    row = db_v2.get_level_row(level_id, version)
    sp = (((row or {}).get("level") or {}).get("compiled") or {}).get("sprites") or {}
    player = sp.get("player") if isinstance(sp, dict) else None
    return player.get("url") if isinstance(player, dict) else None


@router.post("/levels/{level_id}/attempts", response_class=Response)
async def post_attempts(level_id: str, request: Request) -> Response:
    if not _LEVEL_ID.match(level_id) or db_v2.get_level_row(level_id) is None:
        return err(404, "error.not_found", {"what": "level"})
    try:
        raw = await request.body()
        body = AttemptsBody.model_validate(json.loads(raw or b"{}"))
    except (ValidationError, ValueError):
        return err(400, "error.bad_request", {"field": "attempts"})
    a = min(MAX_ATTEMPTS_PER_POST, body.attempts)
    d = min(MAX_ATTEMPTS_PER_POST, body.deaths)
    c = min(a, body.clears)  # a clear is always an attempt
    if a or d or c:
        db_v2.add_attempts(level_id, a, d, c)
        try:  # v3 collab (lane 4): "played 10/100 times" and "someone beat your level" notifications; never fails a post
            from app.collab.activity import on_attempts
            on_attempts(request, level_id, a, c)
        except Exception:  # noqa: BLE001
            pass
    return Response(status_code=204)


@router.put("/levels/{level_id}/thumbnail", response_class=Response)
async def put_thumbnail(level_id: str, request: Request) -> Response:
    if not _LEVEL_ID.match(level_id) or db_v2.get_level_row(level_id) is None:
        return err(404, "error.not_found", {"what": "level"})
    data = await request.body()
    if len(data) > MAX_THUMB_BYTES or not data.startswith(PNG_MAGIC):
        return err(400, "error.bad_request", {"field": "thumbnail"})
    path = thumbs_dir() / f"{level_id}.png"
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    return Response(status_code=204)


def thumbnail_url(level_id: str, version: Any = None) -> str | None:
    """The server PNG when one was uploaded (the client renders its own thumbnail otherwise)."""
    try:
        p = get_settings().uploads_dir / "thumbs" / f"{level_id}.png"
        if not p.exists():
            return None
        return f"{get_settings().public_uploads}/thumbs/{level_id}.png?v={int(p.stat().st_mtime)}"
    except OSError:
        return None
