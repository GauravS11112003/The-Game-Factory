"""Levels API (PLAN.md section 9). Owned by lane D (Backend + UI).

POST /api/levels            {draft_id, author, title?, solvable, game_id?, parent_id?} -> {level}
                            moves draft files to uploads/<level_id>/; creates a game if none applies
GET  /api/levels/{id}       -> {level, author, likes, game, parent, children: [{id, title, author}], next_level_id}
GET  /api/levels/{id}/tree  -> root -> nested children with author, title, created_at
POST /api/levels/{id}/like  -> {likes}
GET  /api/fixtures          -> {fixtures: [name, ...]}
GET  /api/fixtures/{name}   -> shared/fixtures/levels/<name>.json so the UI can test-play fixtures
"""
from __future__ import annotations

import json
import re
import secrets
import shutil
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlmodel import Session

from app.config import FIXTURES_DIR, get_settings
from app.db import (
    children_of,
    count_levels_in_game,
    create_game,
    game_dict,
    get_game,
    get_level_row,
    get_session,
    next_level_in_game,
    save_level,
    tree_of,
)
from app.models import Level
from app.routers.scan import draft_dir, draft_public_prefix, load_draft

router = APIRouter(prefix="/api", tags=["levels"])

FIXTURE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class PublishBody(BaseModel):
    draft_id: str
    author: str
    title: str | None = None
    solvable: bool | None = None
    game_id: str | None = None
    parent_id: str | None = None


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


@router.post("/levels")
def publish_level(body: PublishBody, session: Session = Depends(get_session)) -> dict[str, Any]:
    settings = get_settings()
    draft, meta = load_draft(body.draft_id)
    safety = meta.get("safety") or {}
    if safety.get("ok") is False:
        reason = safety.get("reason") or "the drawing was flagged by the safety check"
        raise HTTPException(status_code=422, detail=f"This level can't be published: {reason}")

    author = body.author.strip() or "anonymous"
    title = (body.title or "").strip() or draft.title or "Untitled level"

    parent_id = (body.parent_id or "").strip() or draft.parent_id or meta.get("parent_hint")
    parent = get_level_row(session, parent_id) if parent_id else None
    if parent_id and parent is None:
        raise HTTPException(status_code=422, detail=f"Parent level {parent_id} was not found")

    game_id = (body.game_id or "").strip() or draft.game_id or meta.get("game_hint") or (parent.game_id if parent else None)
    if game_id and get_game(session, game_id) is None:
        raise HTTPException(status_code=422, detail=f"Game {game_id} was not found")

    level_id = new_id("lvl")
    while (settings.uploads_dir / level_id).exists() or get_level_row(session, level_id) is not None:
        level_id = new_id("lvl")

    # Rewrite every draft URL before touching the filesystem so a bad draft never loses its files.
    old_prefix = draft_public_prefix(body.draft_id)
    new_prefix = f"{settings.public_uploads}/{level_id}"
    level = Level.model_validate(json.loads(draft.model_dump_json().replace(old_prefix, new_prefix)))
    level.id = level_id
    level.author = author
    level.title = title
    level.created_at = now_iso()
    level.parent_id = parent_id or None
    level.meta.solvable = body.solvable

    if game_id is None:
        game_id = new_id("game")
        create_game(session, game_id=game_id, title=title, author=author, created_at=level.created_at)
    level.game_id = game_id
    if parent is not None and parent.game_id == game_id:
        # A remix hangs under its parent in the tree; it takes the parent's slot so
        # "next level" continues the game rather than extending the sequence.
        level.order_index = parent.order_index
    else:
        level.order_index = count_levels_in_game(session, game_id)
    level = Level.model_validate(level.model_dump(mode="json"))

    src = draft_dir(body.draft_id)
    dest = settings.uploads_dir / level_id
    shutil.move(str(src), str(dest))
    for stale in ("draft.json",):
        (dest / stale).unlink(missing_ok=True)
    (dest / "level.json").write_text(level.model_dump_json(indent=2) + "\n")

    save_level(session, level, likes=0)
    return {"level": level.model_dump(mode="json")}


@router.get("/levels/{level_id}")
def get_level_endpoint(level_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    row = get_level_row(session, level_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Level not found")
    game = get_game(session, row.game_id) if row.game_id else None
    parent = get_level_row(session, row.parent_id) if row.parent_id else None
    nxt = next_level_in_game(session, row)
    return {
        "level": json.loads(row.json_text),
        "author": row.author,
        "likes": row.likes,
        "solvable": row.solvable,
        "game": game_dict(game) if game else None,
        "parent": {"id": parent.id, "title": parent.title, "author": parent.author} if parent else None,
        "children": [{"id": c.id, "title": c.title, "author": c.author} for c in children_of(session, level_id)],
        "next_level_id": nxt.id if nxt else None,
    }


@router.get("/levels/{level_id}/tree")
def get_tree(level_id: str, session: Session = Depends(get_session)) -> dict[str, Any]:
    tree = tree_of(session, level_id)
    if tree is None:
        raise HTTPException(status_code=404, detail="Level not found")
    return tree


@router.post("/levels/{level_id}/like")
def like_level(level_id: str, session: Session = Depends(get_session)) -> dict[str, int]:
    row = get_level_row(session, level_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Level not found")
    row.likes += 1
    session.add(row)
    session.commit()
    session.refresh(row)
    return {"likes": row.likes}


@router.get("/fixtures")
def list_fixtures() -> dict[str, list[str]]:
    return {"fixtures": sorted(p.stem for p in (FIXTURES_DIR / "levels").glob("*.json"))}


@router.get("/fixtures/{name}")
def get_fixture(name: str) -> Response:
    if not FIXTURE_NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="Fixture not found")
    path = FIXTURES_DIR / "levels" / f"{name}.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Fixture not found")
    return Response(content=path.read_bytes(), media_type="application/json")
