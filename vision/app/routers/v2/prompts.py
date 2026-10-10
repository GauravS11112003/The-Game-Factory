"""Prompt-to-level (PLAN_V2 §8.3, §11.3e).

POST /prompt-levels {prompt, game_id?, screens, dial?, band?} → 202 {build_id, draft_id, events_url}

The build streams like any other (§3.11) on GET /builds/{build_id}/events: `stage(cv, note_key stage.plan)` while the
plan is made and verified, then the Ink stage with the blue-line draft (`ink` event: the InkDoc the editor opens for
drawing over), the greedy tiers and, with the model on, the designer at the requested band ("medium" →
Challenging·Normal). PERCEIVE is skipped: a draft's strokes carry their roles. Offline, the keyword planner answers.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app import db_v2
from app.build import drafts, runner
from app.build.orchestrator import BuildRequest
from app.mind import client, moderate, sanitize
from app.spec.api import BuildAccepted, PromptLevelBody

router = APIRouter()

PROMPT_CHARS = 400


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


@router.post("/prompt-levels", status_code=202)
async def create_prompt_level(request: Request) -> Any:
    try:
        raw = await request.json()
        body = PromptLevelBody.model_validate(raw)
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "prompt", "errors": min(e.error_count(), 99)})
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request")
    prompt = sanitize.text(body.prompt, PROMPT_CHARS)
    if not prompt:
        return err(400, "error.bad_request", {"field": "prompt"})
    if moderate.blocklist_hit([prompt]):
        return err(409, "publish.safety_flag")
    game = None
    if body.game_id:
        game = db_v2.get_game(body.game_id)
        if game is None or game.get("format") != 2:
            return err(404, "error.not_found", {"what": "game"})
    band = body.band
    if body.dial == "challenging" and band is None:
        band = ((game or {}).get("rules") or {}).get("default_band", "normal")
    draft_id, build_id = drafts.new_draft_id(), drafts.new_build_id()
    drafts.draft_dir(draft_id).mkdir(parents=True, exist_ok=True)
    drafts.save_state(draft_id, drafts.new_state(draft_id, "prompt", model=client.mode(), dial=body.dial, band=band,
                                                 game_id=body.game_id, prompt=prompt))
    runner.start(BuildRequest(build_id=build_id, draft_id=draft_id, kind="prompt", prompt=prompt,
                              screens=int(body.screens), game_id=body.game_id, dial=body.dial, band=band))
    return JSONResponse(BuildAccepted(build_id=build_id, draft_id=draft_id,
                                      events_url=f"/api/v2/builds/{build_id}/events").model_dump(), status_code=202)
