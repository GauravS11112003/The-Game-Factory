"""Written rules (docs/v4/CONTRACTS_V4.md §2.4): sentences → RuleV4s from the fixed vocabulary.

POST /logic/parse   LogicParseBody {sentences, game_id?, entity_ids} → LogicParseResult {rules, mode, unknown, source}

Claude (app.mind.logic) when a key is set; otherwise, or when the call fails, the core's keyword parser (worker
`parse_logic`); when the core cannot answer either, no rules and every sentence in `unknown` (source keywords).
Rule ids are r1, r2, … in sentence order. A sentence that names the kind of game sets `mode`.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app import db_v2
from app.mind import logic as mlogic
from app.mind import moderate
from app.spec.api import LogicParseBody, LogicParseResult

router = APIRouter()


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


@router.post("/logic/parse")
async def parse_logic(request: Request) -> Any:
    try:
        body = LogicParseBody.model_validate(await request.json())
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "sentences", "errors": min(e.error_count(), 99)})
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request")
    if body.game_id:
        g = db_v2.get_game(body.game_id)
        if g is None or g.get("format") != 2:
            return err(404, "error.not_found", {"what": "game"})
    if moderate.blocklist_hit(list(body.sentences)):
        return err(409, "publish.safety_flag")
    out = await mlogic.parse(list(body.sentences), list(body.entity_ids))
    return LogicParseResult.model_validate(out.as_result()).model_dump(mode="json", by_alias=True)
