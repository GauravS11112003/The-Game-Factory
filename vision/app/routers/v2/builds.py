"""Builds, the SSE stream and the polling fallback (PLAN_V2 §3.11, §11.3e).

POST /api/v2/builds
    multipart: `ink` (InkDoc JSON, canvas; a form field or a .json file) **or** `photos` / `photos[]` (1-6 images,
    paper), plus optional `typed_rules` (JSON list of {text, target?}), `parent_id`, `game_id`, `pack_id`,
    `dial` (faithful | polished | challenging, default polished) and `band` (normal | hard).
    application/json: the same fields as an object.
    → 202 {build_id, draft_id, events_url}

GET /api/v2/builds/{build_id}/events   text/event-stream, `Last-Event-ID` (or `?last=`) resume, `: ping` every 10 s
GET /api/v2/drafts/{draft_id}?since=   {state: running | done | failed, events} (all events when `since` is omitted)

v4: every new draft is also recorded in the `drafts` table {draft_id, player_id (X-DP-Player), game_id, kind, title}
so GET /dashboard can list the profile's unpublished drafts.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError
from starlette.datastructures import UploadFile

from app import db_v2
from app.build import drafts, runner
from app.build.events import format_sse, read_events, read_events_from
from app.build.orchestrator import BuildRequest
from app.mind import client, moderate, sanitize
from app.spec.api import BuildAccepted
from app.spec.ink import InkDoc

log = logging.getLogger("dal.v2.builds")
router = APIRouter()

HEARTBEAT_S = 10.0
POLL_S = 0.1
STREAM_IDLE_LIMIT_S = 120.0
DEAD_CHECK_S = 5.0
MAX_PHOTOS = 6
MAX_PHOTO_BYTES = 15 * 1024 * 1024
MAX_INK_BYTES = 8 * 1024 * 1024
IMAGE_MAGIC = (b"\xff\xd8\xff", b"\x89PNG", b"RIFF", b"GIF8")


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def record_draft(request: Request, draft_id: str, *, game_id: str | None, kind: str, title: str | None) -> None:
    """v4 (CONTRACTS_V4 §6): remember who started the draft (X-DP-Player when present) for the dashboard's drafts
    list. Never fails a build."""
    player_id = None
    try:
        from app.collab.identity import player_from_request

        player_id = (player_from_request(request) or {}).get("id")
    except Exception:  # noqa: BLE001 - anonymous drafts are recorded too
        player_id = None
    try:
        db_v2.record_draft(draft_id, player_id=player_id, game_id=game_id, kind=kind, title=title)
    except Exception as e:  # noqa: BLE001
        log.info("draft %s not recorded: %s", draft_id, e)


def _json_field(v: Any, what: str) -> Any:
    if v is None or v == "":
        return None
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        raise ValueError(what) from None


async def _read_body(request: Request) -> tuple[dict[str, Any], list[bytes]]:
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("application/json"):
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("body")
        return body, []
    form = await request.form()
    fields: dict[str, Any] = {}
    photos: list[bytes] = []
    for key, value in form.multi_items():
        if key in ("photos", "photos[]"):
            if isinstance(value, UploadFile):
                data = await value.read()
                if len(data) > MAX_PHOTO_BYTES:
                    raise ValueError("photo_too_big")
                photos.append(data)
            continue
        if isinstance(value, UploadFile):
            data = await value.read()
            if key == "ink" and len(data) > MAX_INK_BYTES:
                raise ValueError("ink_too_big")
            fields[key] = data.decode("utf-8", "replace")
        else:
            fields[key] = value
    return fields, photos


@router.post("/builds", status_code=202)
async def create_build(request: Request) -> Any:
    try:
        fields, photos = await _read_body(request)
        ink = _json_field(fields.get("ink"), "ink")
        typed = _json_field(fields.get("typed_rules"), "typed_rules") or []
    except ValueError as e:
        return err(400, "error.bad_request", {"field": str(e)})
    except Exception:  # noqa: BLE001 - malformed multipart
        return err(400, "error.upload_failed")
    if (ink is None) == (not photos):
        return err(400, "error.bad_request", {"field": "ink_or_photos"})
    if photos:
        if len(photos) > MAX_PHOTOS:
            return err(400, "error.bad_request", {"field": "photos"})
        if any(not p.startswith(IMAGE_MAGIC) for p in photos):
            return err(400, "error.upload_failed")
    if ink is not None:
        try:
            ink = InkDoc.model_validate(ink).model_dump(mode="json", by_alias=True, exclude_none=False)
        except ValidationError as e:
            return err(400, "error.bad_request", {"field": "ink", "errors": min(e.error_count(), 99)})
    if not isinstance(typed, list) or any(not isinstance(r, dict) or not isinstance(r.get("text", ""), str) for r in typed):
        return err(400, "error.bad_request", {"field": "typed_rules"})
    dial = str(fields.get("dial") or "polished")
    if dial not in ("faithful", "polished", "challenging"):
        return err(400, "error.bad_request", {"field": "dial"})
    band = fields.get("band") or None
    if band not in (None, "normal", "hard"):
        return err(400, "error.bad_request", {"field": "band"})
    mode = fields.get("mode") or None  # v4: the editor's game mode for this level (CONTRACTS_V4 §2.4)
    if mode not in (None, "platformer", "topdown", "runner", "flappy"):
        return err(400, "error.bad_request", {"field": "mode"})
    parent_id = fields.get("parent_id") or None
    game_id = fields.get("game_id") or None
    if parent_id and db_v2.get_level_row(str(parent_id)) is None:
        return err(404, "error.not_found", {"what": "level"})
    if game_id and db_v2.get_game(str(game_id)) is None:
        return err(404, "error.not_found", {"what": "game"})
    if dial == "challenging" and band is None:
        rules = (db_v2.get_game(str(game_id)) or {}).get("rules") if game_id else None
        band = (rules or {}).get("default_band", "normal")

    draft_id, build_id = drafts.new_draft_id(), drafts.new_build_id()
    kind = "paper" if photos else "canvas"
    drafts.draft_dir(draft_id).mkdir(parents=True, exist_ok=True)
    title = sanitize.text(fields.get("title"), 40) or None  # the kid's own title (F-3); blocklisted titles are dropped
    if title and moderate.blocklist_hit([title]):
        title = None
    state = drafts.new_state(draft_id, kind, model=client.mode(), dial=dial, band=band, game_id=game_id,
                             parent_id=parent_id, pack_id=fields.get("pack_id") or None, title=title)
    if mode:
        state["mode"] = mode  # logic_input() sends it as BuildInput.mode unless the model's rules name one
    drafts.save_state(draft_id, state)
    record_draft(request, draft_id, game_id=game_id, kind=kind, title=title)
    runner.start(BuildRequest(
        build_id=build_id, draft_id=draft_id, kind=kind, ink=ink, photos=photos, typed_rules=typed,
        parent_id=parent_id, game_id=game_id, pack_id=fields.get("pack_id") or None, dial=dial, band=band,
    ))
    return JSONResponse(BuildAccepted(build_id=build_id, draft_id=draft_id,
                                      events_url=f"/api/v2/builds/{build_id}/events").model_dump(), status_code=202)


@router.get("/builds/{build_id}/events")
async def build_events(
    build_id: str,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    last: int | None = Query(default=None, description="same as Last-Event-ID, for clients that cannot set headers"),
) -> Any:
    if not drafts.BUILD_RE.match(build_id):
        return err(404, "error.not_found", {"what": "build"})
    row = db_v2.get_build(build_id)
    if row is None:
        return err(404, "error.not_found", {"what": "build"})
    draft_id = str(row["draft_id"])
    path = drafts.events_path(draft_id)
    first = int(row.get("first_seq") or 1)
    resume = last if last is not None else int(last_event_id) if (last_event_id or "").strip().isdigit() else 0
    since = max(resume, first - 1)

    async def stream() -> AsyncIterator[str]:
        offset = 0
        last_sent = last_new = time.monotonic()
        while True:
            events, offset = read_events_from(path, offset)
            for env in events:
                seq = int(env.get("seq", 0))
                if seq <= since:
                    continue
                last_sent = last_new = time.monotonic()
                yield format_sse(env)
                if env.get("event") == "done":
                    return
            now = time.monotonic()
            if now - last_new > DEAD_CHECK_S and not runner.running(build_id) and runner.close_dead(build_id):
                continue  # the closing error + done are now in the file; the next read sends them
            if now - last_new > STREAM_IDLE_LIMIT_S and not runner.running(build_id):
                return
            if now - last_sent >= HEARTBEAT_S:
                last_sent = now
                yield ": ping\n\n"
            await asyncio.sleep(POLL_S)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def draft_run_state(draft_id: str, events: list[dict[str, Any]]) -> str:
    """running | done | failed for the draft's latest build."""
    builds = db_v2.builds_of_draft(draft_id)
    latest = builds[-1] if builds else None
    first = int((latest or {}).get("first_seq") or 1)
    mine = [e for e in events if int(e.get("seq", 0)) >= first]
    if any(e.get("event") == "error" and (e.get("data") or {}).get("fatal") for e in mine):
        return "failed"
    if any(e.get("event") == "done" for e in mine):
        return "done"
    if latest is not None and not runner.running(latest["id"]):
        runner.close_dead(latest["id"])  # no `done` and no task in this process: it died with a reload or crash
        return "failed"
    return "running"


@router.get("/drafts/{draft_id}")
def draft_state(draft_id: str, since: int | None = None) -> Any:
    try:
        path = drafts.events_path(draft_id)
    except ValueError:
        return err(404, "error.not_found", {"what": "draft"})
    if not path.parent.exists():
        return err(404, "error.not_found", {"what": "draft"})
    all_events = read_events(path)
    events = [e for e in all_events if int(e.get("seq", 0)) > since] if since else all_events
    return JSONResponse({"state": draft_run_state(draft_id, all_events), "events": events})
