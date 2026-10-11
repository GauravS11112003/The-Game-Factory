"""Two-player races and Photon app-card landing pages, mounted at /api/v2."""
from __future__ import annotations

import asyncio
import html
import json
import os
import secrets
import time
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from app import races
from app.build.bridge import CoreError, get_pool
from app.spec.runs import Replay
from app.routers.v2.runs import rate_limited

router = APIRouter()


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Create(Body):
    level_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,100}$")
    version: int | None = Field(default=None, ge=1)
    name: str = Field(default="", max_length=16)
    reserve_host: bool = True


class Join(Body):
    invite: str = Field(min_length=32, max_length=100)
    name: str = Field(min_length=1, max_length=16)
    claim: str = Field(min_length=32, max_length=100)


class RoundAction(Body):
    round: int = Field(ge=1)


class RaceReplay(Replay):
    frames: int = Field(ge=0, le=36000)
    input: str = Field(max_length=150000)
    core: str = Field(max_length=80)
    level_id: str = Field(max_length=100)
    level_hash: str = Field(min_length=1, max_length=100)
    profile_hash: str = Field(min_length=1, max_length=100)


class Finish(RoundAction):
    replay: RaceReplay


class Progress(Body):
    frame: int = Field(ge=0, le=36000)
    x: float = Field(ge=-10, le=10000, allow_inf_nan=False)
    y: float = Field(ge=-100, le=1000, allow_inf_nan=False)
    deaths: int = Field(ge=0, le=10000)


def ticket(authorization: str = "") -> str:
    if not authorization.startswith("Bearer "):
        races.fail(403, "bad_ticket")
    return authorization[7:]


def base_url(request: Request) -> str:
    configured = os.environ.get("DAL_PUBLIC_URL", "").rstrip("/")
    if configured:
        parts = urlsplit(configured)
        if parts.scheme not in ("http", "https") or not parts.netloc or parts.query or parts.fragment or parts.username:
            races.fail(503, "configuration")
        return configured
    # Local development is reached through the web proxy. Production must set DAL_PUBLIC_URL.
    return ""


def urls(request: Request, match_id: str, invite: str) -> dict[str, str]:
    base = base_url(request)
    return {"invite_url": f"{base}/#/race/{match_id}?{urlencode({'invite': invite})}",
            "card_url": f"{base}/api/v2/matches/{match_id}/card?{urlencode({'invite': invite})}"}


@router.get("/matches/config")
def config() -> dict[str, str | None]:
    return {"imessage_number": os.environ.get("DAL_SPECTRUM_NUMBER") or None}


@router.post("/matches", status_code=201)
def create(body: Create, request: Request, x_race_request: str = Header(default="", max_length=200)) -> dict:
    if rate_limited(request.client.host if request.client else "unknown"):
        raise HTTPException(429, {"message_key": "error.rate_limited"})
    # Idempotent service requests require a separate server credential; browser requests cannot replay bot receipts.
    request_key = ""
    if x_race_request:
        expected = os.environ.get("DAL_SPECTRUM_SERVICE_SECRET", "")
        provided = request.headers.get("X-Spectrum-Service", "")
        if not expected or not secrets.compare_digest(expected, provided):
            races.fail(403, "bad_ticket")
        request_key = "spectrum:" + x_race_request
    result = races.create(body.level_id, body.version, body.name, body.reserve_host, request_key)
    return result | urls(request, result["match"]["id"], result["invite"])


@router.get("/matches/{match_id}")
def snapshot(match_id: str, authorization: str = Header(default=""), x_race_invite: str = Header(default="")) -> dict:
    return races.snapshot(match_id, ticket(authorization) if authorization else "", x_race_invite)


@router.post("/matches/{match_id}/join")
def join(match_id: str, body: Join) -> dict:
    return races.join(match_id, body.invite, body.name, body.claim)


@router.get("/matches/{match_id}/level")
def level(match_id: str, authorization: str = Header(default="")) -> dict:
    return {"level": races.level_for(match_id, ticket(authorization))}


@router.post("/matches/{match_id}/ready")
def ready(match_id: str, body: RoundAction, authorization: str = Header(default="")) -> dict:
    return races.action(match_id, ticket(authorization), "ready", round_no=body.round)


@router.post("/matches/{match_id}/rematch")
def rematch(match_id: str, body: RoundAction, authorization: str = Header(default="")) -> dict:
    return races.action(match_id, ticket(authorization), "rematch", round_no=body.round)


@router.post("/matches/{match_id}/finish")
async def finish(match_id: str, body: Finish, authorization: str = Header(default="")) -> dict:
    received_at, token = time.time(), ticket(authorization)
    match, player = races.finish_context(match_id, token, body.round, received_at)
    if player["result"]:
        return races.snapshot(match_id, token)
    replay = body.replay.model_dump(mode="json")
    if replay["level_id"] != match["level_id"] or replay["level_version"] != match["level_version"] or replay["frames"] > 36000:
        races.fail(422, "invalid_run")
    pool = get_pool()
    if pool is None:
        races.fail(503, "verification_unavailable")
    try:
        verdict = await pool.call("verify_run", {"level": match["level"], "replay": replay})
    except CoreError:
        races.fail(503, "verification_unavailable")
    return races.finish(match_id, token, body.round, received_at, verdict)


@router.get("/matches/{match_id}/card", response_class=HTMLResponse)
def card(match_id: str, invite: str, request: Request) -> HTMLResponse:
    match = races.snapshot(match_id, invite=invite)
    target = urls(request, match_id, invite)["invite_url"]
    title = html.escape(match["title"])
    escaped = html.escape(target, quote=True)
    return HTMLResponse(f'''<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · Two-player race</title><meta property="og:title" content="{title}">
<meta property="og:description" content="Race a friend. Tap to join, play, and rematch.">
<meta name="referrer" content="no-referrer"></head><body>
<h1>{title}</h1><p>Race a friend in draw.play.</p><a href="{escaped}">Join race</a>
<script>location.replace({json.dumps(target).replace('<', chr(92) + 'u003c')})</script></body></html>''',
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                 "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"})


@router.websocket("/matches/{match_id}/socket")
async def socket(ws: WebSocket, match_id: str) -> None:
    await ws.accept()
    token, socket_id = "", secrets.token_hex(16)
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=5)
        if len(raw) > 1024:
            await ws.close(code=1009)
            return
        auth = json.loads(raw)
        if not isinstance(auth, dict) or auth.get("type") != "authenticate" or not isinstance(auth.get("token"), str) or len(auth["token"]) > 100:
            await ws.close(code=1008)
            return
        token = auth["token"]
        state = races.connection(match_id, token, socket_id)
        await ws.send_json({"type": "state", "match": state, "seat": races.member_for_ticket(match_id, token)})
        last_action = 0.0
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=0.5)
                if len(raw) > 4096:
                    await ws.close(code=1009)
                    return
                msg = json.loads(raw)
                if not isinstance(msg, dict):
                    await ws.close(code=1008)
                    return
                kind = msg.get("type")
                if kind not in ("ping", "progress", "forfeit"):
                    continue
                now = time.monotonic()
                if now - last_action < 0.1:
                    continue
                last_action = now
                progress = Progress.model_validate(msg.get("progress")).model_dump() if kind == "progress" else None
                state = races.action(match_id, token, kind, socket_id=socket_id, round_no=msg.get("round"), progress=progress)
            except asyncio.TimeoutError:
                state = races.snapshot(match_id, token)
            await ws.send_json({"type": "state", "match": state})
    except HTTPException as exc:
        await ws.send_json({"type": "error", **exc.detail})
        await ws.close(code=1008)
    except (ValueError, TypeError):
        await ws.close(code=1008)
    except WebSocketDisconnect:
        pass
    finally:
        if token:
            try:
                races.connection(match_id, token, socket_id, close=True)
            except HTTPException:
                pass
