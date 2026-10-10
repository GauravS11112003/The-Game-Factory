"""Games (PLAN_V2 §11.3e): the home feed, creating a game, and a game with its ordered levels.

GET  /games?sort=new|hot|hard|cleared → {games: [{id, title, author, created_at, level_count, authors, plays, clears,
                                          clear_rate, mean_C, band, cover}]}
     new: newest first · hot: most plays in the last 7 days · hard: highest mean casual C · cleared: most clears
POST /games {title, author} → {game}   (rules: the default GameRules, version 1)
GET  /games/{id} → {game, levels: [summary + level], remixes: [summary]}   (the playable sequence in order; remixes of
                   a level in the same game hang under it and are listed separately). Each sequence summary carries
                   `unlock_after` (a level id to clear first, or null) and `bonus` (§9: Starter World's L5)

v2 games live in the shared `games` table with format = 2 (§11.3h); their levels in `levels_v2`.
"""
from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app import db_v2
from app.build.orchestrator import default_rules
from app.mind import moderate, sanitize
from app.routers.v2.runs import thumbnail_url
from app.spec.api import GameCreate

router = APIRouter()

SORTS = ("new", "hot", "hard", "cleared")


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def _band_of(c: float | None) -> str | None:
    if c is None:
        return None
    # §4.5 bands (casual C): trivial < 0.05 ≤ easy < 0.3 ≤ normal < 1.0 ≤ hard < 3.0 ≤ expert
    if c < 0.05:
        return "trivial"
    if c < 0.3:
        return "easy"
    if c < 1.0:
        return "normal"
    if c < 3.0:
        return "hard"
    return "expert"


def _summary(r: dict[str, Any], *, stats: bool = False) -> dict[str, Any]:
    out = {"id": r["id"], "version": r.get("version"), "title": r.get("title"), "author": r.get("author"),
           "created_at": r.get("created_at"), "order_index": r.get("order_index"), "parent_id": r.get("parent_id"),
           "game_id": r.get("game_id"), "C": r.get("c_casual"), "band": r.get("band"), "score": r.get("score"),
           "screens": r.get("screens"), "par_ms": r.get("par_ms"), "fastest_ms": r.get("fastest_ms"),
           "safety": r.get("safety"), "verified": bool(r.get("verified")) if r.get("verified") is not None else None,
           "thumbnail_url": thumbnail_url(r["id"], r.get("version"))}
    if stats:
        st = db_v2.level_stats(r["id"])
        out["stats"] = st
        out["clear_rate"] = st.get("clear_rate")
        out["best_ms"] = st.get("best")
    return out


FEED_LEVELS_PER_GAME = 8
FEED_LOOSE_LEVELS = 40


def _sort_levels(rows: list[dict[str, Any]], sort: str) -> list[dict[str, Any]]:
    """Levels outside any game, in the feed's order (new · hot · hard · cleared)."""
    if sort == "new":
        return sorted(rows, key=lambda r: (str(r.get("created_at") or ""), r["id"]), reverse=True)
    if sort == "hard":
        return sorted(rows, key=lambda r: (-(float(r.get("C") or 0.0)), str(r.get("created_at") or "")))
    if sort == "cleared":
        return sorted(rows, key=lambda r: (-int((r.get("stats") or {}).get("clears") or 0), -(r.get("clear_rate") or 0.0)))
    return sorted(rows, key=lambda r: (-int((r.get("stats") or {}).get("plays") or 0), str(r.get("created_at") or "")))


def _unlocks(game_id: str) -> dict[str, dict[str, Any]]:
    """{level_id: {unlock_after, bonus}} for the seeded games (§9: Starter World's L5 unlocks after L4)."""
    try:
        from app.seed_v2 import sequence_meta

        return sequence_meta(game_id)
    except Exception:  # noqa: BLE001 - a missing index never breaks the feed
        return {}


def _with_unlock(summary: dict[str, Any], meta: dict[str, dict[str, Any]], level: dict[str, Any] | None = None) -> dict[str, Any]:
    m = meta.get(summary["id"]) or {}
    after = m.get("unlock_after") or (level or {}).get("x_unlock_after")
    summary["unlock_after"] = after if isinstance(after, str) else None
    summary["bonus"] = bool(m.get("bonus") or (level or {}).get("x_bonus"))
    return summary


def _sequence(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    ids = {r["id"] for r in rows}
    seq = [r for r in rows if r.get("parent_id") is None or r["parent_id"] not in ids]
    remixes = [r for r in rows if r.get("parent_id") is not None and r["parent_id"] in ids]
    return seq, remixes


@router.get("/games")
def list_games(sort: str = Query(default="new")) -> Any:
    if sort not in SORTS:
        return err(400, "error.bad_request", {"field": "sort"})
    out = []
    for g in db_v2.list_games_v2():
        rows = db_v2.latest_level_summaries(game_id=g["id"])
        seq, _ = _sequence(rows)
        act = db_v2.game_activity(g["id"])
        unlocks = _unlocks(g["id"])
        cs = [float(r["c_casual"]) for r in seq if r.get("c_casual") is not None]
        mean_c = round(sum(cs) / len(cs), 4) if cs else None
        authors: list[str] = []
        for r in rows:
            if r.get("author") and r["author"] not in authors:
                authors.append(r["author"])
        out.append({
            "id": g["id"], "title": g["title"], "author": g["author"], "created_at": g["created_at"],
            "level_count": len(seq), "authors": authors, "plays": int(act["plays"]), "clears": int(act["clears"]),
            "recent_plays": int(act["recent_plays"]),
            "clear_rate": round(act["clears"] / act["plays"], 4) if act["plays"] else None,
            "mean_C": mean_c, "band": _band_of(mean_c), "cover": _summary(seq[0]) if seq else None,
            "levels": [_with_unlock(_summary(r, stats=True), unlocks) for r in seq[:FEED_LEVELS_PER_GAME]],
        })
    if sort == "hot":
        out.sort(key=lambda g: (-g["recent_plays"], -g["plays"], g["created_at"] or ""))
    elif sort == "hard":
        out.sort(key=lambda g: (-(g["mean_C"] or -1.0), g["created_at"] or ""))
    elif sort == "cleared":
        out.sort(key=lambda g: (-g["clears"], -(g["clear_rate"] or 0.0)))
    # levels drawn outside any game (#/draw without a game) are listed after the games
    loose = [_summary(r, stats=True) for r in db_v2.latest_level_summaries(no_game=True)]
    return {"games": out, "levels": _sort_levels(loose, sort)[:FEED_LOOSE_LEVELS], "sort": sort}


@router.post("/games")
async def create_game(request: Request) -> Any:
    try:
        body = GameCreate.model_validate(await request.json())
    except ValidationError:
        return err(400, "error.bad_request", {"field": "game"})
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request")
    title = sanitize.text(body.title, 40)
    author = sanitize.text(body.author, 16)
    if not title or not author:
        return err(400, "error.bad_request", {"field": "title" if not title else "author"})
    if moderate.blocklist_hit([title, author]):
        return err(409, "publish.safety_flag")
    game = db_v2.create_game(f"game_{secrets.token_hex(4)}", title, author, default_rules())
    return JSONResponse({"game": game}, status_code=201)


@router.get("/games/{game_id}")
def get_game(game_id: str) -> Any:
    g = db_v2.get_game(game_id)
    if g is None or g.get("format") != 2:
        return err(404, "error.not_found", {"what": "game"})
    rows = db_v2.latest_level_summaries(game_id=game_id)
    seq, remixes = _sequence(rows)
    levels = []
    unlocks = _unlocks(game_id)
    for r in seq:
        full = db_v2.get_level_row(r["id"])
        lv = (full or {}).get("level")
        levels.append({**_with_unlock(_summary(r, stats=True), unlocks, lv), "level": lv})
    return {"game": g, "levels": levels, "remixes": [_summary(r, stats=True) for r in remixes]}


# Game rules (GET/PUT, check) live in rules.py and the object library in library.py.
