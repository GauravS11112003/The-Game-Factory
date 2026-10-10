"""Builds, the SSE stream and the polling fallback (§3.11, §11.3e).

P0: POST /builds accepts any body and runs the orchestrator stub, which replays
shared/spec/conformance/events/sample_build.jsonl with this build's ids into drafts/<draft_id>/events.jsonl.
GET /builds/{id}/events streams it (Last-Event-ID resume, `: ping` heartbeat); GET /drafts/{id}?since= polls it.
"""
from __future__ import annotations

import asyncio
import time
from contextlib import closing
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app import db_v2
from app.build import drafts
from app.build.events import JsonlEventSink, format_sse, read_events
from app.build.orchestrator import BuildRequest, run_build
from app.spec.api import ApiMessage, BuildAccepted

router = APIRouter()

HEARTBEAT_S = 10.0
POLL_S = 0.1
STREAM_IDLE_LIMIT_S = 120.0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _draft_of(build_id: str) -> str:
    if not drafts.BUILD_RE.match(build_id):
        raise HTTPException(404, ApiMessage(message_key="error.not_found", args={"what": "build"}).model_dump())
    with closing(db_v2.connect()) as conn:
        row = conn.execute("SELECT draft_id FROM builds WHERE id = ?", (build_id,)).fetchone()
    if row is None:
        raise HTTPException(404, ApiMessage(message_key="error.not_found", args={"what": "build"}).model_dump())
    return str(row["draft_id"])


async def _run_and_finish(req: BuildRequest) -> None:
    sink = JsonlEventSink(drafts.events_path(req.draft_id))
    try:
        await run_build(req, sink)
    except Exception as e:  # noqa: BLE001 - a failed build is an event, never a crash
        sink.emit("error", {"message_key": "error.build_failed", "args": {"why": type(e).__name__}, "fatal": True})
        sink.emit("done", {"final_stage": "ink", "total_ms": 0})
    with closing(db_v2.connect()) as conn, conn:
        conn.execute("UPDATE builds SET finished_at = ?, final_stage = ? WHERE id = ?", (_now(), "designed", req.build_id))


@router.post("/builds", status_code=202)
async def create_build(request: Request, background: BackgroundTasks) -> dict[str, str]:
    draft_id, build_id = drafts.new_draft_id(), drafts.new_build_id()
    kind = "paper" if "multipart" in request.headers.get("content-type", "") and "photos" in (await request.form()) else "canvas"
    drafts.draft_dir(draft_id).mkdir(parents=True, exist_ok=True)
    with closing(db_v2.connect()) as conn, conn:
        conn.execute("INSERT INTO builds (id, draft_id, kind, started_at) VALUES (?, ?, ?, ?)", (build_id, draft_id, kind, _now()))
    background.add_task(_run_and_finish, BuildRequest(build_id=build_id, draft_id=draft_id, kind=kind))
    return BuildAccepted(build_id=build_id, draft_id=draft_id, events_url=f"/api/v2/builds/{build_id}/events").model_dump()


@router.get("/builds/{build_id}/events")
async def build_events(
    build_id: str,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    last: int | None = Query(default=None, description="same as Last-Event-ID, for clients that cannot set headers"),
) -> StreamingResponse:
    draft_id = _draft_of(build_id)
    path = drafts.events_path(draft_id)
    since = last if last is not None else int(last_event_id) if (last_event_id or "").isdigit() else 0

    async def stream() -> AsyncIterator[str]:
        seq = since
        last_sent = last_new = time.monotonic()
        while True:
            for env in read_events(path, seq):
                seq = env["seq"]
                last_sent = last_new = time.monotonic()
                yield format_sse(env)
                if env["event"] == "done":
                    return
            now = time.monotonic()
            if now - last_new > STREAM_IDLE_LIMIT_S:
                return
            if now - last_sent >= HEARTBEAT_S:
                last_sent = now
                yield ": ping\n\n"
            await asyncio.sleep(POLL_S)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/drafts/{draft_id}")
def draft_state(draft_id: str, since: int | None = None) -> JSONResponse:
    try:
        path = drafts.events_path(draft_id)
    except ValueError:
        raise HTTPException(404, ApiMessage(message_key="error.not_found", args={"what": "draft"}).model_dump()) from None
    if not path.parent.exists():
        raise HTTPException(404, ApiMessage(message_key="error.not_found", args={"what": "draft"}).model_dump())
    events = read_events(path, since or 0)
    all_events = events if not since else read_events(path)
    state = "done" if any(e["event"] == "done" for e in all_events) else "running"
    if any(e["event"] == "error" and e["data"].get("fatal") for e in all_events):
        state = "failed"
    return JSONResponse({"state": state, "events": events})
