"""Levels (PLAN_V2 §11.3e): publish with server-side verification, get (any version), and the remix tree.

POST /levels             {draft_id, tier, author, title?, statuses, level_hash, quest_id?} → {level} | 409 {message_key, args}
                         with X-DP-Player into a game the player doesn't keep: {level, submission: {id, status: "pending",
                         game_id, game_title, level_id, quest_id}} (the level is stored unlisted); 403
                         collab.invite_only for an invite-only game the player is not a member of
GET  /levels/{id}[?version=]  → {level, stats: {plays, clears, clear_rate, best}, children}
GET  /levels/{id}/tree        → the whole remix family (from the root ancestor), each node with author, versions and
                                the objects it changed vs its parent; the requested level is marked `current`
POST /levels/{id}/upgrade     → {level, version, repairs}   §2.6 "Upgrade to v2" for migrated v1-classic levels
POST /levels/{id}/moderate    → {safety, listed, checked}   MODERATE (D27) on the render + title, author and the
                                drawing's words: ok → listed; flag → unlisted; a refusal → held (unlisted). The
                                deterministic blocklist runs first. With the model offline the stored safety stands
                                (`checked: false`).
"""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app import db_v2
from app.build.publish import publish
from app.build.rebuild import DraftError
from app.routers.v2.runs import thumbnail_url
from app.spec.api import PublishBody

router = APIRouter()

TREE_MAX_NODES = 300
TREE_MAX_DEPTH = 16
_LEVEL_ID = r"^[A-Za-z0-9_-]{1,64}$"


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


@router.post("/levels")
async def post_level(request: Request) -> Any:
    try:
        raw = await request.json()
        body = PublishBody.model_validate(raw)
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "publish", "errors": min(e.error_count(), 99)})
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request")
    player = None
    try:  # v3 identity (CONTRACTS_V3): X-DP-Player; absent or wrong → today's anonymous publish
        from app.collab.identity import player_from_request

        player = player_from_request(request)
    except Exception:  # noqa: BLE001
        player = None
    extra: dict[str, Any] = {}
    try:
        level = await publish(body.model_dump(mode="json"), player=player, extra=extra)
    except DraftError as e:
        return err(e.status, e.message_key, e.args)
    return {"level": level, **extra}


@router.post("/levels/{level_id}/moderate")
async def moderate_level(level_id: str) -> Any:
    from app.build.levels_io import ink_doc
    from app.mind import client, moderate, render

    row = db_v2.get_level_row(level_id)
    if row is None or row.get("level") is None:
        return err(404, "error.not_found", {"what": "level"})
    level = row["level"]
    meta = level.get("meta") or {}
    texts = [level.get("title") or "", level.get("author") or "", meta.get("transcript") or ""]
    current = row.get("safety") or meta.get("safety") or "unchecked"
    if moderate.blocklist_hit(texts):
        db_v2.set_level_safety(level_id, "flag", False)
        return {"safety": "flag", "listed": False, "checked": True}
    if not client.available():
        return {"safety": current, "listed": bool(row.get("listed", True)), "checked": False}
    try:
        image = render.moderation_image(ink_doc(level))
    except Exception:  # noqa: BLE001 - a level without drawable ink is judged on its texts
        image = b""
    r = await moderate.moderate(image, texts, draft_id=None,
                                deadline=time.monotonic() + client.CALLS["moderate"].timeout_s) if image else None
    if r is None:
        return {"safety": current, "listed": bool(row.get("listed", True)), "checked": False}
    if r.status == "refused":
        safety, listed = "held", False
    elif r.status == "ok" and r.value is not None:
        safety, listed = ("ok", True) if r.value.safety == "ok" else ("flag", False)
    else:
        return {"safety": current, "listed": bool(row.get("listed", True)), "checked": False}
    db_v2.set_level_safety(level_id, safety, listed)
    return {"safety": safety, "listed": listed, "checked": True}


@router.post("/levels/{level_id}/upgrade")
async def upgrade_level(level_id: str) -> Any:
    """§2.6 "Upgrade to v2": re-run a migrated v1-classic level under v2-standard through the Faithful build (v1
    patrollers become walkers with gravity) and save it as a new version. 409 upgrade.not_needed for levels that are
    not migrated v1-classic levels; 409 upgrade.breaks when the bot cannot finish the result even with repairs."""
    from app.build import levels_io
    from app.build.bridge import CoreError, get_pool
    from app.routers.v2.rules import profile_hash

    row = db_v2.get_level_row(level_id)
    if row is None or row.get("level") is None:
        return err(404, "error.not_found", {"what": "level"})
    if row.get("safety") in ("held", "flag"):
        return err(403, "publish.safety_flag")
    inp = levels_io.upgrade_input(row["level"], profile_hash=profile_hash(levels_io.UPGRADE_PROFILE))
    if inp is None:
        return err(409, "upgrade.not_needed")
    pool = get_pool()
    if pool is None:
        return err(503, "error.worker_down")
    try:
        res = await pool.call("build", inp, 20.0)
    except CoreError as e:
        return err(503 if e.code in ("down", "timeout") else 409,
                   "error.worker_down" if e.code in ("down", "timeout") else "upgrade.breaks")
    built = (res or {}).get("level") if isinstance(res, dict) else None
    report = (res or {}).get("report") or {}
    if not isinstance(built, dict) or not report.get("solvable"):
        return err(409, "upgrade.breaks")
    version, errors = levels_io.save_rebuilt(row, built, report)
    if version is None:
        return err(409, "upgrade.breaks", {"why": "invalid"})
    fresh = db_v2.get_level_row(level_id, version)
    return {"level": (fresh or {}).get("level"), "version": version,
            "repairs": [e for e in (res or {}).get("edits") or [] if isinstance(e, dict) and e.get("class") == "R"
                        and e.get("status") == "applied"]}


@router.get("/levels/{level_id}")
def get_level(level_id: str, version: int | None = None) -> Any:
    row = db_v2.get_level_row(level_id, version)
    if row is None or row.get("level") is None:
        return err(404, "error.not_found", {"what": "level"})
    return {"level": row["level"], "stats": db_v2.level_stats(level_id), "children": db_v2.children_ids(level_id)}


def _changed_objects(row: dict[str, Any]) -> list[dict[str, Any]]:
    """Objects this remix added or changed vs its parent, with their boxes (the tree outlines them in pencil)."""
    from app.build.present import shape_bbox

    ch = row.get("changed") or {}
    if not isinstance(ch, dict):
        return []
    objs = {o.get("id"): o for o in ((row.get("level") or {}).get("objects") or []) if isinstance(o, dict)}
    out = []
    for kind in ("added", "changed"):
        for oid in ch.get(kind) or []:
            o = objs.get(oid)
            if o is None or (o.get("rel") or {}).get("part_of"):
                continue
            bb = shape_bbox(o.get("shape") or {})
            if bb:
                out.append({"id": oid, "kind": kind, "role": o.get("role"), "bbox": [round(float(v), 3) for v in bb]})
    return out[:60]


def _node_summary(row: dict[str, Any], current: str) -> dict[str, Any]:
    return {
        "changed_objects": _changed_objects(row) if row.get("parent_id") else None,
        "id": row["id"], "version": row.get("version"), "versions": db_v2.level_versions(row["id"]),
        "title": row.get("title"), "author": row.get("author"), "created_at": row.get("created_at"),
        "game_id": row.get("game_id"), "parent_id": row.get("parent_id"), "parent_version": row.get("parent_version"),
        "C": row.get("c_casual"), "band": row.get("band"), "screens": row.get("screens"), "safety": row.get("safety"),
        "listed": bool(row.get("listed", True)), "changed": row.get("changed"), "current": row["id"] == current,
        "thumbnail_url": thumbnail_url(row["id"], row.get("version")),
    }


@router.get("/levels/{level_id}/tree")
def get_tree(level_id: str) -> Any:
    row = db_v2.get_level_row(level_id)
    if row is None:
        return err(404, "error.not_found", {"what": "level"})
    root, seen = row, {row["id"]}
    while root.get("parent_id") and len(seen) < TREE_MAX_DEPTH:
        parent = db_v2.get_level_row(root["parent_id"])
        if parent is None or parent["id"] in seen:
            break
        seen.add(parent["id"])
        root = parent
    count = 0
    visited: set[str] = set()

    def node(r: dict[str, Any], depth: int) -> dict[str, Any]:
        nonlocal count
        count += 1
        visited.add(r["id"])
        n = _node_summary(r, level_id)
        kids = []
        if depth < TREE_MAX_DEPTH:
            for cid in db_v2.children_ids(r["id"]):
                if cid in visited or count >= TREE_MAX_NODES:
                    continue
                c = db_v2.get_level_row(cid)
                if c is not None and (c.get("listed", True) or cid == level_id):
                    kids.append(node(c, depth + 1))
        n["children"] = kids
        return n

    return {"root": node(root, 0), "current": level_id, "truncated": count >= TREE_MAX_NODES}
