"""Starting builds in the background and knowing which are still running (PLAN_V2 §3.11).

A build is an asyncio task owned by this process (not tied to the HTTP request that started it). The registry
keeps a reference to every running task (so it is never garbage-collected mid-build) and lets the polling
endpoint tell "running" from "died with the process" (uvicorn --reload).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from app import db_v2
from app.build import drafts
from app.build.events import JsonlEventSink, read_events
from app.build.orchestrator import BuildRequest, run_build

log = logging.getLogger("dal.v2.runner")

_TASKS: dict[str, asyncio.Task[Any]] = {}


def running(build_id: str) -> bool:
    t = _TASKS.get(build_id)
    return t is not None and not t.done()


def draft_running(draft_id: str) -> bool:
    return any(running(b["id"]) for b in db_v2.builds_of_draft(draft_id))


def start(req: BuildRequest) -> str:
    """Register the build (first_seq = the next event seq on the draft) and run it in the background."""
    sink = JsonlEventSink(drafts.events_path(req.draft_id))
    db_v2.insert_build(req.build_id, req.draft_id, req.kind, sink.next_seq())

    async def go() -> None:
        try:
            await run_build(req, sink)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - run_build never raises; this is a last line of defence
            log.exception("build %s crashed", req.build_id)
            if not sink.closed():
                sink.emit("error", {"message_key": "error.build_failed", "args": {}, "fatal": True})
                sink.emit("done", {"final_stage": "ink", "total_ms": 0})
        finally:
            _TASKS.pop(req.build_id, None)

    _TASKS[req.build_id] = asyncio.create_task(go(), name=f"build {req.build_id}")
    return req.build_id


async def preempt(draft_id: str) -> bool:
    """Make room for a new build on a draft (Redesign, "Why is this hard?"). A running build that has already
    shipped its Designed stage is only waiting for late suggestions: it is cancelled (its `done` lands before the
    new `hello`, so streams never interleave). A build still before Designed blocks: returns False."""
    live = [b for b in db_v2.builds_of_draft(draft_id) if running(b["id"])]
    if not live:
        return True
    state = drafts.load_state(draft_id) or {}
    if state.get("stage") != "designed":
        return False
    tasks = [_TASKS[b["id"]] for b in live if b["id"] in _TASKS]
    for t in tasks:
        t.cancel()
    if tasks:
        await asyncio.wait(tasks, timeout=3)
    return True


def close_dead(build_id: str) -> bool:
    """A build with no `done`, no task in this process and no finish time died with the process (uvicorn
    --reload, a crash). Close its stream for every client: a fatal `error.build_failed` and `done`."""
    if running(build_id):
        return False
    row = db_v2.get_build(build_id)
    if row is None or row.get("finished_at"):
        return False
    path = drafts.events_path(str(row["draft_id"]))
    if any(e.get("event") == "done" for e in read_events(path, int(row.get("first_seq") or 1) - 1)):
        return False
    sink = JsonlEventSink(path)
    sink.emit("error", {"message_key": "error.build_failed", "args": {"why": "restarted"}, "fatal": True})
    sink.emit("done", {"final_stage": "ink", "total_ms": 0})
    db_v2.finish_build(build_id, "ink", 0.0)
    return True
