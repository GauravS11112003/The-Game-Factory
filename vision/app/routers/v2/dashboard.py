"""The workspace home (docs/v4/CONTRACTS_V4.md §6, §7): everything one profile is working on, in one call.

GET /dashboard   (needs X-DP-Player) → Dashboard {games, drafts, blocks, unread}

    games    the profile's games (members: owner, maintainer, contributor), plus games it published levels into
             without a role, most recently changed first. Per game: mode (null rules.mode = platformer), level_count
             (the playable sequence), beatable (levels the bot cleared), to_fix (hard and block flags on the newest
             version of each level; warn flags are design notes), pending_reviews (submissions waiting, keepers only),
             open_quests, cover_level_id (the first level) and updated_at (the newest level version, else the game).
    drafts   drafts the profile started (POST /builds and /prompt-levels with X-DP-Player) that never became a
             published level, newest first.
    blocks   the newest version of every block the profile made, listed or not, newest first.
    unread   unread notifications.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app import db_v2
from app.spec.api import Dashboard, DashboardGame, DraftCard
from app.spec.blocks import BlockCard

log = logging.getLogger("dal.v4.dashboard")
router = APIRouter()

MAX_GAMES = 60
MAX_DRAFTS = 20
MAX_BLOCKS = 50
FIX_SEVERITIES = ("hard", "block")
KEEPERS = ("owner", "maintainer")


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def _flags_to_fix(level: dict[str, Any] | None) -> int:
    flags = ((level or {}).get("design") or {}).get("flags") or []
    return sum(1 for f in flags if isinstance(f, dict) and f.get("severity") in FIX_SEVERITIES)


def game_card(game_id: str, role: str | None) -> dict[str, Any] | None:
    from app.collab import db as cdb
    from app.routers.v2.games import _sequence

    g = db_v2.get_game(game_id)
    if g is None or g.get("format") != 2:
        return None
    seq, _ = _sequence(db_v2.latest_level_summaries(game_id=game_id))
    to_fix = 0
    for s in seq:
        row = db_v2.get_level_row(s["id"], int(s["version"]))
        to_fix += _flags_to_fix((row or {}).get("level"))
    stamps = [str(s.get("created_at") or "") for s in seq if s.get("created_at")]
    pending = 0
    if role in KEEPERS:
        pending = int(cdb.scalar("SELECT COUNT(*) FROM submissions WHERE game_id = ? AND status = 'pending'",
                                 (game_id,), 0))
    quests = int(cdb.scalar("SELECT COUNT(*) FROM quests WHERE game_id = ? AND status = 'open'", (game_id,), 0))
    mode = (g.get("rules") or {}).get("mode") or "platformer"
    return {
        "game_id": game_id, "title": str(g.get("title") or ""), "role": role, "mode": mode, "level_count": len(seq),
        "beatable": sum(1 for s in seq if s.get("verified")), "to_fix": to_fix, "pending_reviews": pending,
        "open_quests": quests, "cover_level_id": seq[0]["id"] if seq else None,
        "updated_at": max(stamps) if stamps else g.get("created_at"),
    }


def player_games(player_id: str) -> list[tuple[str, str | None]]:
    """(game_id, role) for the profile's memberships, then the games it published into without a role."""
    from app.collab import db as cdb
    from app.collab import members

    out: dict[str, str | None] = {m["game_id"]: m["role"] for m in members.games_of(player_id)}
    for r in cdb.rows("SELECT DISTINCT game_id FROM player_levels WHERE player_id = ? AND game_id IS NOT NULL",
                      (player_id,)):
        out.setdefault(str(r["game_id"]), None)
    return list(out.items())[:MAX_GAMES]


def draft_cards(player_id: str) -> list[dict[str, Any]]:
    from app.build import drafts

    out = []
    for d in db_v2.unpublished_drafts(player_id, MAX_DRAFTS):
        state = drafts.load_state(str(d["draft_id"])) if drafts.exists(str(d["draft_id"])) else None
        if (state or {}).get("published"):
            continue
        updated = max(str(d.get("updated_at") or ""), str((state or {}).get("updated_at") or ""))
        out.append({"draft_id": d["draft_id"], "title": d.get("title") or (state or {}).get("title"),
                    "game_id": d.get("game_id"), "kind": d.get("kind") or "canvas", "updated_at": updated})
    out.sort(key=lambda c: c["updated_at"], reverse=True)
    return out


@router.get("/dashboard")
def dashboard(request: Request) -> Any:
    try:
        from app.collab import activity, identity

        player = identity.player_from_request(request)
    except Exception:  # noqa: BLE001 - no collab module, no profiles
        log.exception("dashboard: identity unavailable")
        player = None
    if player is None:
        return err(401, "collab.need_profile")
    pid = str(player["id"])
    games = []
    for gid, role in player_games(pid):
        try:
            card = game_card(gid, role)
            if card is not None:
                games.append(DashboardGame.model_validate(card).model_dump(mode="json"))
        except Exception as e:  # noqa: BLE001 - one broken game never hides the others
            log.info("dashboard game %s skipped: %s", gid, e)
    games.sort(key=lambda g: str(g.get("updated_at") or ""), reverse=True)
    drafts = [DraftCard.model_validate(d).model_dump(mode="json") for d in draft_cards(pid)]
    cards, _ = db_v2.list_blocks(author_id=pid, limit=MAX_BLOCKS, include_unlisted=True)
    blocks = []
    for c in cards:
        try:
            blocks.append(BlockCard.model_validate(c).model_dump(mode="json", by_alias=True))
        except ValidationError:
            continue
    _, unread = activity.notifications(pid, limit=1)
    return Dashboard.model_validate({"games": games, "drafts": drafts, "blocks": blocks, "unread": unread}).model_dump(
        mode="json", by_alias=True)
