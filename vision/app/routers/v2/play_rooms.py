"""Generated-game invitations and authenticated shared-world sockets."""
from __future__ import annotations
import asyncio
import json
import os
import secrets
import time
from urllib.parse import urlencode, urlsplit
from fastapi import APIRouter, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field
from app import play_rooms as rooms
from app import room_publishing as publishing
from app.build import imagine
from app.creative.imagine_assets import strip_runtime
from app.routers.v2.matches import base_url, card_page, ticket
from app.routers.v2.runs import rate_limited

router = APIRouter()

class Create(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft_id: str = Field(pattern=r"^d_[a-f0-9]{8}$")
    name: str = Field(default="Player 1", max_length=16)
    reserve_host: bool = True

class Join(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invite: str = Field(min_length=32, max_length=100)
    name: str = Field(min_length=1, max_length=16)
    claim: str = Field(min_length=32, max_length=100)

class Resume(BaseModel):
    model_config = ConfigDict(extra="forbid")
    handoff: str = Field(min_length=32, max_length=100)
    claim: str = Field(min_length=32, max_length=100)

class ImportedBuild(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    spec: imagine.MultiplayerSpec
    html: str = Field(min_length=1000, max_length=publishing.MAX_BUILD_BYTES)
    request_key: str = Field(pattern=r"^[a-f0-9]{64}$")

@router.post("/play-rooms/import", status_code=201)
async def import_build(request: Request):
    expected = os.environ.get("DAL_REMOTE_PUBLISH_SECRET", "")
    supplied = request.headers.get("X-Draw-Play-Publish", "")
    if not expected or not secrets.compare_digest(expected, supplied):
        rooms.fail(403, "Online publishing access is unavailable.")
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > publishing.MAX_BUILD_BYTES + 1_000_000:
            rooms.fail(413, "This game's artwork is too large to share.")
        raw.extend(chunk)
    try:
        body = ImportedBuild.model_validate_json(raw)
        if len(body.html.encode()) > publishing.MAX_BUILD_BYTES or "drawPlayMultiplayer" not in body.html:
            raise ValueError("multiplayer_adapter")
        imagine.check_html(strip_runtime(body.html))
    except ValueError:
        rooms.fail(422, "This game needs a multiplayer repair before sharing.")
    created = await asyncio.to_thread(rooms.import_build, body.title, body.spec.model_dump(), body.html,
                                      "import:" + body.request_key)
    return publishing.links(created, base_url(request))

@router.post("/play-rooms/{room_id}/publish")
def publish(room_id: str, authorization: str = Header(default="")):
    return publishing.publish(room_id, ticket(authorization))

@router.post("/play-rooms", status_code=201)
def create(body: Create, request: Request, x_race_request: str = Header(default="", max_length=200)):
    if rate_limited(request.client.host if request.client else "unknown"):
        rooms.fail(429, "Try again in a moment.")
    key = ""
    if x_race_request:
        expected = os.environ.get("DAL_SPECTRUM_SERVICE_SECRET", "")
        if not expected or not secrets.compare_digest(expected, request.headers.get("X-Spectrum-Service", "")):
            rooms.fail(403, "Messaging access is unavailable.")
        key = "spectrum:" + x_race_request
    result = rooms.create(body.draft_id, body.name, body.reserve_host, key)
    room_id, invite = result["match"]["id"], result["invite"]
    return result | {"invite_url": f"{base_url(request)}/#/room/{room_id}?{urlencode({'invite': invite})}",
                     "card_url": f"{base_url(request)}/api/v2/play-rooms/{room_id}/card?{urlencode({'invite': invite})}"}

@router.get("/play-rooms/{room_id}")
def snapshot(room_id: str, authorization: str = Header(default=""), x_race_invite: str = Header(default="")):
    return rooms.snapshot(room_id, ticket(authorization) if authorization else "", x_race_invite)

@router.post("/play-rooms/{room_id}/join")
def join(room_id: str, body: Join):
    return rooms.join(room_id, body.invite, body.name, body.claim)

@router.post("/play-rooms/{room_id}/handoff")
def handoff(room_id: str, authorization: str = Header(default="")):
    return rooms.handoff(room_id, ticket(authorization))

@router.post("/play-rooms/{room_id}/resume")
def resume(room_id: str, body: Resume):
    return rooms.resume(room_id, body.handoff, body.claim)

@router.get("/play-rooms/{room_id}/game")
def game(room_id: str, authorization: str = Header(default="")):
    rooms.snapshot(room_id, ticket(authorization))
    return HTMLResponse(rooms.artifact_path(room_id).read_text(), headers={"Content-Security-Policy": imagine.CSP, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

@router.get("/play-rooms/{room_id}/card")
def card(room_id: str, invite: str, request: Request):
    room = rooms.snapshot(room_id, invite=invite)
    url = f"{base_url(request)}/#/room/{room_id}?{urlencode({'invite': invite, 'surface': 'messages'})}"
    return card_page(room["title"], "Play this new game together", url, f"Join {room['title']}")

@router.websocket("/play-rooms/{room_id}/socket")
async def socket(websocket: WebSocket, room_id: str):
    origin = websocket.headers.get("origin")
    expected = os.environ.get("DAL_PUBLIC_URL", "")
    allowed = {f"https://{websocket.headers.get('host')}", f"http://{websocket.headers.get('host')}"}
    if expected:
        parsed = urlsplit(expected)
        allowed.add(f"{parsed.scheme}://{parsed.netloc}")
    if not expected and origin:
        origin_host = urlsplit(origin).hostname
        request_host = urlsplit("http://" + websocket.headers.get("host", "")).hostname
        # Vite's development proxy changes the API port/host. Production sets DAL_PUBLIC_URL.
        if origin_host == request_host or {origin_host, request_host} <= {"localhost", "127.0.0.1", "::1"}:
            allowed.add(origin)
    if origin and origin not in allowed:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    token, connection = "", secrets.token_urlsafe(16)
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), 5)
        if len(raw) > 1000:
            raise ValueError("auth")
        auth = json.loads(raw)
        if not isinstance(auth, dict) or auth.get("type") != "auth" or not isinstance(auth.get("token"), str) or len(auth["token"]) > 100:
            raise ValueError("auth")
        token = auth["token"]
        seat = await asyncio.to_thread(rooms.connect, room_id, token, connection)
        await websocket.send_json({"type": "authenticated", "seat": seat})
        last_sent = 0.0
        window, count = time.monotonic(), 0
        while True:
            message = None
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), 0.1)
                if len(raw.encode()) > 60_000:
                    raise ValueError("size")
                message = json.loads(raw)
                if time.monotonic() - window > 1:
                    window, count = time.monotonic(), 0
                count += 1
                if count > 40:
                    raise ValueError("rate")
            except TimeoutError:
                pass
            state = await asyncio.to_thread(rooms.stream, room_id, token, connection, message)
            if time.monotonic() - last_sent >= 0.09:
                await websocket.send_json({"type": "state", "room": state})
                last_sent = time.monotonic()
    except (WebSocketDisconnect, RuntimeError):
        pass
    except (HTTPException, ValueError, TypeError, AttributeError, TimeoutError, RecursionError):
        try:
            await websocket.close(code=1008)
        except RuntimeError:
            pass
    finally:
        if token:
            try:
                await asyncio.to_thread(rooms.disconnect, room_id, token, connection)
            except HTTPException:
                pass
