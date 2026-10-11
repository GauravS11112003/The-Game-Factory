"""The v7 art API (docs/v7/CONTRACTS_V7.md §3), mounted under /api/v2.

POST /studio/art/direction   ArtDirectionBody → ArtDirectionResult (sync; the model takes a while: up to ~4 min)
POST /studio/art/jobs        ArtJobBody → 202 {id}   (an in-process asyncio task; ≤ 4 running jobs per IP → 429)
GET  /studio/art/jobs/{id}   → ArtJobStatus (items fill in as they finish; poll every ~1.5 s; kept for an hour)

No identity needed: the doc travels in the body. Errors are calm `{error: {key, args}}` (shared/spec/messages-v6/ai.json).
"""
from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.routers.v2.studio import MAX_ART_BYTES, MAX_CHAT_BYTES, _Bad, _body_json, _dump, err
from app.spec.studio import ArtDirectionBody, ArtDirectionResult, ArtJobBody
from app.studio.art import direction, jobs

log = logging.getLogger("dal.v7.art")
router = APIRouter()
JOB_ID = re.compile(r"^aj_[0-9a-f]{16}$")


@router.post("/studio/art/direction")
async def art_direction(request: Request) -> Any:
    try:
        raw = await _body_json(request, MAX_CHAT_BYTES)
        body = ArtDirectionBody.model_validate(raw)
    except _Bad as b:
        return b.response
    except ValidationError as e:
        return err(400, "ai.err.bad_request", {"field": "direction", "errors": min(e.error_count(), 99)})
    res = await direction.make(_dump(body))
    return _dump(ArtDirectionResult.model_validate(res))


@router.post("/studio/art/jobs", status_code=202)
async def art_job(request: Request) -> Any:
    try:
        raw = await _body_json(request, MAX_ART_BYTES)
        body = ArtJobBody.model_validate(raw)
    except _Bad as b:
        return b.response
    except ValidationError as e:
        return err(400, "ai.err.bad_request", {"field": "art_job", "errors": min(e.error_count(), 99)})
    d = _dump(body)
    scene = next((s for s in d["game"]["scenes"] if s["id"] == d["scene"]), None)
    if scene is None:
        return err(400, "ai.err.bad_request", {"field": "scene"})
    ids = {o["id"] for o in scene["objects"]}
    wanted = [o for o in d["objects"] if o in ids]
    if not wanted and not d["backdrop"]:
        return err(400, "ai.err.bad_object")
    d["objects"] = wanted
    ip = request.client.host if request.client else "?"
    try:
        job_id = jobs.start(d, ip)
    except jobs.Busy:
        return err(429, "ai.err.art_busy", {"limit": jobs.MAX_RUNNING_PER_IP})
    return JSONResponse({"id": job_id}, status_code=202)


@router.get("/studio/art/jobs/{job_id}")
def art_job_status(job_id: str) -> Any:
    st = jobs.status(job_id) if JOB_ID.match(job_id) else None
    if st is None:
        return err(404, "ai.err.not_found", {"what": "art job"})
    return st
