"""Games API (PLAN.md section 9). Owned by lane D (Backend + UI).

GET  /api/games               -> {games: [{id, title, author, created_at, level_count, authors, likes, cover}]}
                                 cover is the first level's JSON (its backdrop_url is the card image)
GET  /api/games/{id}          -> {game, levels: [{...summary, level}]} ordered by order_index
POST /api/games/{id}/levels   {level_id} -> appends; sets order_index -> {level, order_index}
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from app.db import (
    game_dict,
    get_game,
    get_level_row,
    get_session,
    levels_in_game,
    list_games_with_counts,
    save_level,
)

router = APIRouter(prefix="/api", tags=["games"])


class AddLevelBody(BaseModel):
    level_id: str


@router.get("/games")
def list_games(session: Session = Depends(get_session)) -> dict[str, Any]:
    return {"games": list_games_with_counts(session)}


@router.get("/games/{game_id}")
def get_game_endpoint(game_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    game = get_game(session, game_id)
    if game is None:
        raise HTTPException(status_code=404, detail="Game not found")
    levels = [{**row.summary(), "level": json.loads(row.json_text)} for row in levels_in_game(session, game_id)]
    return {"game": game_dict(game), "levels": levels}


@router.post("/games/{game_id}/levels")
def add_level_to_game(game_id: str, body: AddLevelBody, session: Session = Depends(get_session)) -> dict[str, Any]:
    game = get_game(session, game_id)
    if game is None:
        raise HTTPException(status_code=404, detail="Game not found")
    row = get_level_row(session, body.level_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Level not found")
    others = [r for r in levels_in_game(session, game_id) if r.id != row.id]
    level = row.to_level()
    level.game_id = game_id
    level.order_index = len(others)
    saved = save_level(session, level, likes=row.likes)
    return {"level": saved.to_level().model_dump(mode="json"), "order_index": saved.order_index}
