"""Collaboration API (docs/v3/CONTRACTS_V3.md, lane 4). Prefix /api/v2/collab.

Acting as someone = header `X-DP-Player: <player_id>.<token>` (app.collab.identity). Errors are {message_key, args}.

POST   /players                         {name, avatar_png?} → 201 {player, token}
GET    /players/me                      → {player, badges, stats, games, levels, unread}
PUT    /players/me                      {name?, avatar_png?} → {player}
GET    /players/{id}                    → {player, badges, stats, levels, games}
GET    /games/{id}/bible                → bible + viewer
PUT    /games/{id}/bible                {pitch, mechanics_text, style_id?, style_prompt?, starter_type_ids[], open_for}
                                        (keepers; fields left out keep their value) → bible + viewer
GET    /games/{id}/members              → {members, author, viewer}
POST   /games/{id}/members              {player_id, role: maintainer|contributor} (owner) → {members, viewer}
DELETE /games/{id}/members/{player_id}  (owner, or yourself) → {members, viewer}
POST   /games/{id}/join                 → membership (contributor; open_for everyone)
GET    /games/{id}/submissions?status=  → {submissions}
GET    /submissions/{id}                → submission (with comments)
POST   /submissions/{id}/review         {decision: accept|changes|decline, note} (keepers) → submission
POST   /submissions/{id}/comments       {text} → 201 comment
POST   /submissions/{id}/vote           {value: 1 | 0} → {votes}
GET    /games/{id}/quests?status=       → {quests}
POST   /games/{id}/quests               {title, description, kind: level|creature|art|fix, reward_badge?} (keepers)
                                        → 201 {quest, quests}
POST   /quests/{id}/claim               → quest
POST   /quests/{id}/done                {player_id?} (keepers; creature/art quests, or by hand) → quest
GET    /games/{id}/credits              → {contributors: [{player, role, levels, creatures, art, quests, reviews,
                                          total}], authors}
GET    /activity?game_id=&limit=&before= → {items}
GET    /notifications?unread=&limit=    → {items, unread}
POST   /notifications/read              {ids?} → {ok, unread}
GET    /jams                            → {jams}
POST   /jams                            {title, theme, starts_at, ends_at, game_id?} → 201 {jam, jams}

Permissions: keepers (owner, maintainers) review, post quests, edit the bible and publish straight into the game;
the owner manages members (maintainers do, in a game without an owner); anyone with a profile joins, comments, votes
and claims quests when the game is open_for everyone, members only when it is invite-only.
"""
from __future__ import annotations

import logging
import re
import time
from collections import deque
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from app.collab import activity, bible, identity, members, quests, seed_owner, submissions
from app.collab import db as cdb
from app.collab.errors import CollabError
from app.collab.identity import IdentityError

log = logging.getLogger("dal.v3.collab")
router = APIRouter(prefix="/collab")

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PLAYERS_PER_MINUTE = 10
_RECENT: dict[str, deque[float]] = {}


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def _fail(e: CollabError | IdentityError) -> JSONResponse:
    return err(e.status, e.key, e.args_)


def _boot() -> None:
    cdb.ensure()
    try:
        seed_owner.ensure_seed_collab()
    except Exception:  # noqa: BLE001
        log.exception("collab seeds")


async def _body(request: Request) -> dict[str, Any] | None:
    try:
        raw = await request.body()
        if not raw:
            return {}
        import json

        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) else None


def _me(request: Request) -> dict[str, Any] | None:
    return identity.player_from_request(request)


def _game(game_id: str) -> dict[str, Any] | None:
    return members.game(game_id) if _ID.match(game_id or "") else None


def _rate_limited(ip: str) -> bool:
    now = time.monotonic()
    q = _RECENT.setdefault(ip, deque())
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= PLAYERS_PER_MINUTE:
        return True
    q.append(now)
    if len(_RECENT) > 5000:
        for k in [k for k, v in _RECENT.items() if not v or now - v[-1] > 60][:2500]:
            _RECENT.pop(k, None)
    return False


# ---- players ------------------------------------------------------------------------------------------------------------


@router.post("/players")
async def create_player(request: Request) -> Any:
    _boot()
    ip = request.client.host if request.client else "?"
    if _rate_limited(ip):
        return err(429, "error.rate_limited")
    body = await _body(request)
    if body is None:
        return err(400, "error.bad_request")
    try:
        player, token = identity.create_player(body.get("name"), body.get("avatar_png"))
    except IdentityError as e:
        return _fail(e)
    return JSONResponse({"player": player, "token": token}, status_code=201)


@router.get("/players/me")
def get_me(request: Request) -> Any:
    _boot()
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    _, unread = activity.notifications(me["id"], limit=1)
    return {"player": me, "badges": activity.badges_of(me["id"]), "stats": activity.player_stats(me["id"]),
            "games": members.games_of(me["id"]), "levels": activity.player_levels(me["id"], include_unlisted=True),
            "submissions": submissions.list_for_player(me["id"]), "unread": unread}


@router.put("/players/me")
async def update_me(request: Request) -> Any:
    _boot()
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    body = await _body(request)
    if body is None:
        return err(400, "error.bad_request")
    try:
        player = identity.update_player(me["id"], name=body.get("name"), avatar_png=body.get("avatar_png"))
    except IdentityError as e:
        return _fail(e)
    return {"player": player}


@router.get("/players/{player_id}")
def get_player(player_id: str) -> Any:
    _boot()
    p = identity.get_player(player_id)
    if p is None:
        return err(404, "error.not_found", {"what": "player"})
    return {"player": p, "badges": activity.badges_of(p["id"]), "stats": activity.player_stats(p["id"]),
            "levels": activity.player_levels(p["id"]), "games": members.games_of(p["id"])}


# ---- bible --------------------------------------------------------------------------------------------------------------


@router.get("/games/{game_id}/bible")
def get_bible(game_id: str, request: Request) -> Any:
    _boot()
    if _game(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    return {**bible.bible_or_default(game_id), "owner_id": members.owner_of(game_id),
            "viewer": members.viewer(game_id, _me(request))}


@router.put("/games/{game_id}/bible")
async def put_bible(game_id: str, request: Request) -> Any:
    _boot()
    if _game(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    members.claim_if_ownerless(game_id, me)
    if not members.is_keeper(game_id, me["id"]):
        return err(403, "collab.not_keeper")
    body = await _body(request)
    if body is None:
        return err(400, "error.bad_request", {"field": "bible"})
    try:
        b = bible.put_bible(game_id, body, me["id"])
    except ValueError as e:
        if str(e) == "safety":
            return err(409, "publish.safety_flag")
        return err(400, "error.bad_request", {"field": str(e)})
    activity.record("bible_updated", game_id=game_id, player_id=me["id"],
                    data={"game_title": members.game_title(game_id)})
    return {**b, "owner_id": members.owner_of(game_id), "viewer": members.viewer(game_id, me)}


# ---- members ------------------------------------------------------------------------------------------------------------


@router.get("/games/{game_id}/members")
def get_members(game_id: str, request: Request) -> Any:
    _boot()
    g = _game(game_id)
    if g is None:
        return err(404, "error.not_found", {"what": "game"})
    return {"members": members.list_members(game_id), "author": g.get("author"),
            "viewer": members.viewer(game_id, _me(request))}


@router.post("/games/{game_id}/members")
async def add_member(game_id: str, request: Request) -> Any:
    _boot()
    if _game(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    members.claim_if_ownerless(game_id, me)
    if not members.can_manage_members(game_id, me["id"]):
        return err(403, "collab.not_owner")
    body = await _body(request)
    if body is None:
        return err(400, "error.bad_request", {"field": "member"})
    role = body.get("role") or "contributor"
    if role not in ("maintainer", "contributor"):
        return err(400, "error.bad_request", {"field": "role"})
    target = identity.get_player(str(body.get("player_id") or ""))
    if target is None:
        return err(404, "error.not_found", {"what": "player"})
    if members.role_of(game_id, target["id"]) == "owner":
        return err(409, "collab.owner_stays")
    now_role = members.set_role(game_id, target["id"], role, added_by=me["id"], allow_downgrade=True)
    data = {"game_id": game_id, "game_title": members.game_title(game_id), "role": now_role, "by": me["id"]}
    if target["id"] != me["id"]:
        activity.notify(target["id"], "member", data)
    activity.record("member_added", game_id=game_id, player_id=target["id"], data={**data, "by": target["id"]})
    return {"members": members.list_members(game_id), "viewer": members.viewer(game_id, me)}


@router.delete("/games/{game_id}/members/{player_id}")
def remove_member(game_id: str, player_id: str, request: Request) -> Any:
    _boot()
    if _game(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    if player_id != me["id"] and not members.can_manage_members(game_id, me["id"]):
        return err(403, "collab.not_owner")
    role = members.role_of(game_id, player_id)
    if role is None:
        return err(404, "collab.no_member")
    if role == "owner":
        return err(409, "collab.owner_stays")
    members.remove(game_id, player_id)
    return {"members": members.list_members(game_id), "viewer": members.viewer(game_id, me)}


@router.post("/games/{game_id}/join")
def join_game(game_id: str, request: Request) -> Any:
    _boot()
    if _game(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    members.claim_if_ownerless(game_id, me)
    if members.role_of(game_id, me["id"]) is None:
        if members.open_for(game_id) == "invite":
            return err(403, "collab.invite_only")
        members.set_role(game_id, me["id"], "contributor", added_by="join")
        activity.record("joined", game_id=game_id, player_id=me["id"],
                        data={"game_title": members.game_title(game_id)})
    m = members.membership(game_id, me["id"]) or {}
    return {**m, "viewer": members.viewer(game_id, me)}


# ---- submissions --------------------------------------------------------------------------------------------------------


@router.get("/games/{game_id}/submissions")
def list_submissions(game_id: str, request: Request, status: str | None = Query(default=None)) -> Any:
    _boot()
    if _game(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    if status is not None and status not in submissions.STATUSES:
        return err(400, "error.bad_request", {"field": "status"})
    me = _me(request)
    return {"submissions": submissions.list_for_game(game_id, status, viewer_id=(me or {}).get("id")),
            "viewer": members.viewer(game_id, me)}


@router.get("/submissions/{sub_id}")
def get_submission(sub_id: str, request: Request) -> Any:
    _boot()
    s = submissions.get(sub_id) if _ID.match(sub_id) else None
    if s is None:
        return err(404, "error.not_found", {"what": "submission"})
    me = _me(request)
    return {**submissions.out(s, with_comments=True, viewer_id=(me or {}).get("id")),
            "viewer": members.viewer(s["game_id"], me)}


@router.post("/submissions/{sub_id}/review")
async def review_submission(sub_id: str, request: Request) -> Any:
    _boot()
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    body = await _body(request)
    if body is None:
        return err(400, "error.bad_request", {"field": "review"})
    try:
        return submissions.review(sub_id, me, body.get("decision"), body.get("note"))
    except CollabError as e:
        return _fail(e)


@router.post("/submissions/{sub_id}/comments")
async def comment_submission(sub_id: str, request: Request) -> Any:
    _boot()
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    body = await _body(request)
    if body is None:
        return err(400, "error.bad_request", {"field": "comment"})
    try:
        return JSONResponse(submissions.comment(sub_id, me, body.get("text")), status_code=201)
    except CollabError as e:
        return _fail(e)


@router.post("/submissions/{sub_id}/vote")
async def vote_submission(sub_id: str, request: Request) -> Any:
    _boot()
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    body = await _body(request)
    if body is None:
        return err(400, "error.bad_request", {"field": "vote"})
    try:
        votes = submissions.vote(sub_id, me, body.get("value", 1))
    except CollabError as e:
        return _fail(e)
    return {"votes": votes}


# ---- quests -------------------------------------------------------------------------------------------------------------


@router.get("/games/{game_id}/quests")
def list_quests(game_id: str, request: Request, status: str | None = Query(default=None)) -> Any:
    _boot()
    if _game(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    if status is not None and status not in quests.STATUSES:
        return err(400, "error.bad_request", {"field": "status"})
    return {"quests": quests.list_for_game(game_id, status), "viewer": members.viewer(game_id, _me(request))}


@router.post("/games/{game_id}/quests")
async def create_quest(game_id: str, request: Request) -> Any:
    _boot()
    if _game(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    members.claim_if_ownerless(game_id, me)
    if not members.is_keeper(game_id, me["id"]):
        return err(403, "collab.not_keeper")
    body = await _body(request)
    if body is None:
        return err(400, "error.bad_request", {"field": "quest"})
    try:
        q = quests.create(game_id, body, me["id"])
    except CollabError as e:
        return _fail(e)
    return JSONResponse({"quest": q, "quests": quests.list_for_game(game_id)}, status_code=201)


@router.post("/quests/{quest_id}/claim")
def claim_quest(quest_id: str, request: Request) -> Any:
    _boot()
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    try:
        return quests.claim(quest_id, me)
    except CollabError as e:
        return _fail(e)


@router.post("/quests/{quest_id}/done")
async def finish_quest(quest_id: str, request: Request) -> Any:
    _boot()
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    q = quests.get(quest_id)
    if q is None:
        return err(404, "error.not_found", {"what": "quest"})
    if not members.is_keeper(q["game_id"], me["id"]):
        return err(403, "collab.not_keeper")
    if q["status"] == "done":
        return err(409, "collab.quest_closed")
    body = await _body(request) or {}
    who = identity.get_player(str(body.get("player_id") or "")) if body.get("player_id") else None
    pid = (who or {}).get("id") or q.get("claimed_by") or me["id"]
    quests.complete(quest_id, str(pid))
    return quests.out(quests.get(quest_id) or q)


# ---- credits, activity, notifications --------------------------------------------------------------------------------


@router.get("/games/{game_id}/credits")
def get_credits(game_id: str) -> Any:
    _boot()
    if _game(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    return activity.game_credits(game_id)


@router.get("/activity")
def get_activity(game_id: str | None = Query(default=None), limit: int = Query(default=50, ge=1, le=100),
                 before: int | None = Query(default=None, ge=1)) -> Any:
    _boot()
    if game_id is not None and not _ID.match(game_id):
        return err(400, "error.bad_request", {"field": "game_id"})
    return {"items": activity.feed(game_id, limit=limit, before=before)}


@router.get("/notifications")
def get_notifications(request: Request, unread: bool = Query(default=False),
                      limit: int = Query(default=50, ge=1, le=100)) -> Any:
    _boot()
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    items, n = activity.notifications(me["id"], limit=limit, unread_only=unread)
    return {"items": items, "unread": n}


@router.post("/notifications/read")
async def read_notifications(request: Request) -> Any:
    _boot()
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    body = await _body(request) or {}
    ids = body.get("ids") if isinstance(body.get("ids"), list) else None
    activity.mark_read(me["id"], ids)
    _, n = activity.notifications(me["id"], limit=1)
    return {"ok": True, "unread": n}


# ---- jams ---------------------------------------------------------------------------------------------------------------


@router.get("/jams")
def get_jams() -> Any:
    _boot()
    return {"jams": quests.list_jams()}


@router.post("/jams")
async def create_jam(request: Request) -> Any:
    _boot()
    me = _me(request)
    if me is None:
        return err(401, "collab.need_profile")
    body = await _body(request)
    if body is None:
        return err(400, "error.bad_request", {"field": "jam"})
    try:
        j = quests.create_jam(body, me)
    except CollabError as e:
        return _fail(e)
    return JSONResponse({"jam": j, "jams": quests.list_jams()}, status_code=201)
