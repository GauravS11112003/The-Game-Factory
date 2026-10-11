"""Blocks: the public, cross-game library (docs/v4/CONTRACTS_V4.md §5, §6). A block is a named, versioned,
immutable recipe made by any profile: an object (art + behaviour, what a game's LibraryType holds) or a rule pack.

GET  /blocks?q=&kind=&sort=new|popular&author_id=&limit=&offset=   → BlockList (the newest version of each listed
                                   block; `popular` = games that use it; `q` matches name, description and tags)
POST /blocks                       BlockCreate → 201 BlockCard   (needs X-DP-Player; the server fills id, version,
                                   author, author_id and created_at)
GET  /blocks/{id}?v=               → BlockCard (the newest version unless `v`)
POST /blocks/{id}/versions         BlockCreate → 201 BlockCard   (the block's author only; version n+1)
POST /blocks/describe              BlockDescribeBody → BlockDescribeResult (Claude when a key is set, keywords otherwise)
POST /games/{id}/blocks            UseBlockBody → UseBlockResult
    object: copied into the game's library as a game-owned type with `block` = {block_id, version}. A game that already
            holds a type copied from this block gets version n+1 of that type (same id and letter), so levels keep
            pinning their own versions; adding the same block version again changes nothing.
    rules (and the rules an object brings): appended to GameRules.logic with ids <block_id>_<rule id> (a pack added
            again replaces its own rules) and saved for new builds, like PUT /games/{id}/rules without apply.
    Records a use (BlockCard.uses, the popular sort) and credits the block's author in that game (credit kind block).

Objects need a drawing and a behaviour; rule packs need at least one rule. Names, authors, descriptions, tags and every
sentence a block can show (npc lines, `say` rules) pass the deterministic blocklist, like library names.
"""
from __future__ import annotations

import logging
import re
import secrets
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app import db_v2
from app.mind import block as mblock
from app.mind import moderate, sanitize
from app.spec.api import BlockCreate, BlockDescribeBody, BlockDescribeResult, UseBlockBody, UseBlockResult
from app.spec.blocks import Block, BlockCard

log = logging.getLogger("dal.v4.blocks")
router = APIRouter()

BLOCK_ID = re.compile(r"^blk_[a-z0-9]{8}$")
ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
KINDS = ("creature", "platform", "hazard", "pickup", "prop", "player", "rules")
NAME_CHARS = 24
AUTHOR_CHARS = 16
TAG_CHARS = 24
MAX_LIMIT = 100
DEFAULT_LIMIT = 24


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def _player(request: Request) -> dict[str, Any] | None:
    """The acting profile (X-DP-Player), or None when absent, wrong, or the collab module is unavailable."""
    try:
        from app.collab.identity import player_from_request

        p = player_from_request(request)
    except Exception:  # noqa: BLE001 - identity is optional for reads
        return None
    return p if isinstance(p, dict) else None


async def _json(request: Request) -> Any:
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        return None


def new_block_id() -> str:
    for _ in range(20):
        bid = "blk_" + "".join(secrets.choice(ID_CHARS) for _ in range(8))
        if not db_v2.block_id_taken(bid):
            return bid
    raise RuntimeError("no free block id")  # pragma: no cover - 36^8 ids


def _tags(tags: list[str]) -> list[str]:
    out: list[str] = []
    for t in tags:
        c = sanitize.text(t, TAG_CHARS).lower()
        if c and c not in out:
            out.append(c)
    return out[:8]


def _shown_texts(doc: dict[str, Any]) -> list[str | None]:
    """Every sentence the block can put on screen (for the blocklist)."""
    out: list[str | None] = [doc.get("name"), doc.get("author"), doc.get("description"), *doc.get("tags", [])]
    b = doc.get("behavior") or {}
    out += [str(x) for x in b.get("lines") or []] + [b.get("name")]
    for r in doc.get("logic") or []:
        out += [a.get("text") for a in r.get("then") or [] if a.get("kind") == "say"]
    return out


def prepare_block(body: BlockCreate, *, block_id: str, player: dict[str, Any]) -> dict[str, Any]:
    """A validated Block dict (version 1 placeholder: insert_block assigns the real one). Raises ValueError(<key>)."""
    raw = body.model_dump(mode="json", by_alias=True)
    name = sanitize.text(raw.get("name"), NAME_CHARS)
    if not name:
        raise ValueError("error.bad_request")
    if raw["kind"] == "rules":
        if not raw.get("logic"):
            raise ValueError("blocks.err.needs_rules")
        raw["behavior"] = None
        raw["collision"] = "none"
        raw["spiky"] = False
    else:
        if not raw.get("art") or not (raw["art"].get("strokes") or []):
            raise ValueError("blocks.err.needs_drawing")
        if not raw.get("behavior"):
            raise ValueError("blocks.err.needs_behavior")
    ids = [r["id"] for r in raw.get("logic") or []]
    if len(ids) != len(set(ids)):
        raise ValueError("blocks.err.duplicate_rule")
    doc = {
        **raw, "id": block_id, "version": 1, "name": name, "description": sanitize.opt_text(raw.get("description"), 300),
        "tags": _tags(raw.get("tags") or []), "author": sanitize.text(player.get("name"), AUTHOR_CHARS) or "someone",
        "author_id": player.get("id"), "created_at": db_v2.now_iso(),
    }
    return Block.model_validate(doc).model_dump(mode="json", by_alias=True)


async def _save(request: Request, *, block_id: str | None) -> JSONResponse:
    player = _player(request)
    if player is None:
        return err(401, "collab.need_profile")
    prev = None
    if block_id is not None:
        prev = db_v2.get_block(block_id)
        if prev is None:
            return err(404, "error.not_found", {"what": "block"})
        if not prev.get("author_id") or prev.get("author_id") != player.get("id"):
            return err(403, "blocks.err.not_author")
    raw = await _json(request)
    if not isinstance(raw, dict):
        return err(400, "error.bad_request", {"field": "block"})
    try:
        body = BlockCreate.model_validate(raw)
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "block", "errors": min(e.error_count(), 99)})
    if body.parent is not None and db_v2.get_block(body.parent.block_id, body.parent.version) is None:
        return err(404, "error.not_found", {"what": "block"})
    try:
        doc = prepare_block(body, block_id=block_id or new_block_id(), player=player)
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "block", "errors": min(e.error_count(), 99)})
    except ValueError as e:
        key = str(e)
        return err(400, key, {"field": "name"} if key == "error.bad_request" else {})
    if moderate.blocklist_hit(_shown_texts(doc)):
        return err(409, "publish.safety_flag")
    stored = db_v2.insert_block(doc)
    card = db_v2.get_block(stored["id"], int(stored["version"]))
    return JSONResponse(BlockCard.model_validate(card).model_dump(mode="json", by_alias=True), status_code=201)


@router.get("/blocks")
def list_blocks(q: str | None = Query(default=None, max_length=80), kind: str | None = None, sort: str = "new",
                author_id: str | None = Query(default=None, max_length=40),
                limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT), offset: int = Query(default=0, ge=0)) -> Any:
    if sort not in ("new", "popular"):
        return err(400, "error.bad_request", {"field": "sort"})
    if kind is not None and kind != "" and kind not in KINDS:
        return err(400, "error.bad_request", {"field": "kind"})
    cards, total = db_v2.list_blocks(q=sanitize.text(q, 80) or None, kind=kind or None, author_id=author_id or None,
                                     sort=sort, limit=limit, offset=offset)
    out = []
    for c in cards:
        try:
            out.append(BlockCard.model_validate(c).model_dump(mode="json", by_alias=True))
        except ValidationError:  # a row from an older contract: skipped, never a broken list
            log.info("block %s skipped: not a valid BlockCard", c.get("id"))
    return {"blocks": out, "total": total}


@router.post("/blocks", status_code=201)
async def create_block(request: Request) -> Any:
    return await _save(request, block_id=None)


@router.post("/blocks/describe")
async def describe_block(request: Request) -> Any:
    raw = await _json(request)
    try:
        body = BlockDescribeBody.model_validate(raw)
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "describe", "errors": min(e.error_count(), 99)})
    if moderate.blocklist_hit([body.name, body.text]):
        return err(409, "publish.safety_flag")
    strokes = [s.model_dump(mode="json", by_alias=True) for s in body.ink]
    res = await mblock.describe(body.name, body.text, strokes)
    try:
        return BlockDescribeResult.model_validate(res).model_dump(mode="json", by_alias=True)
    except ValidationError:  # never expected: the describer validates its parts; the keyword reader as a floor
        log.warning("block describe gave an invalid result; using the keyword reader")
        res = mblock.keyword_object(body.name, body.text)
        return BlockDescribeResult.model_validate(res).model_dump(mode="json", by_alias=True)


@router.get("/blocks/{block_id}")
def get_block(block_id: str, v: int | None = Query(default=None, ge=1)) -> Any:
    if not BLOCK_ID.match(block_id):
        return err(404, "error.not_found", {"what": "block"})
    card = db_v2.get_block(block_id, v)
    if card is None:
        return err(404, "error.not_found", {"what": "block"})
    return BlockCard.model_validate(card).model_dump(mode="json", by_alias=True)


@router.post("/blocks/{block_id}/versions", status_code=201)
async def new_version(block_id: str, request: Request) -> Any:
    if not BLOCK_ID.match(block_id):
        return err(404, "error.not_found", {"what": "block"})
    return await _save(request, block_id=block_id)


# ---- using a block in a game -------------------------------------------------------------------------------------------


def _type_from_block(b: dict[str, Any], game_id: str) -> tuple[dict[str, Any] | None, bool]:
    """(the game's library type for this block version, inserted now?). Raises ValueError for a bad type."""
    from app.routers.v2 import library as lib_api

    ref = {"block_id": b["id"], "version": int(b["version"])}
    existing = next((t for t in db_v2.library_latest(game_id) if (t.get("block") or {}).get("block_id") == b["id"]), None)
    if existing is not None and int((existing.get("block") or {}).get("version") or 0) == ref["version"]:
        return existing, False
    raw = {"name": b["name"], "kind": b["kind"], "behavior": b.get("behavior"), "spiky": bool(b.get("spiky")),
           "collision": b.get("collision"), "art": b.get("art"), "symbol": b.get("symbol"), "author": b.get("author"),
           "block": ref}
    doc = lib_api.prepare_type(raw, game_id, prev=existing)
    if moderate.blocklist_hit([doc["name"], doc["author"]]):
        raise ValueError("publish.safety_flag")
    owner = db_v2.type_owner(doc["id"])
    if owner is not None and owner != game_id:
        raise ValueError("error.bad_request")
    return db_v2.insert_type(doc), True


def _append_rules(b: dict[str, Any], game: dict[str, Any]) -> dict[str, Any]:
    """The game's rules with the block's logic appended (ids <block_id>_<rule id>), saved for new builds."""
    from app.routers.v2 import rules as rules_api

    current = rules_api.current_rules(game)
    prefix = f"{b['id']}_"
    keep = [r for r in current.get("logic") or [] if not str(r.get("id", "")).startswith(prefix)]
    added = [{**r, "id": f"{prefix}{r['id']}"[:40]} for r in b.get("logic") or []]
    rules = rules_api.resolve({"logic": keep + added}, current, bump=True)
    db_v2.set_game_rules(str(game["id"]), rules)
    return rules


def _credit(b: dict[str, Any], game_id: str) -> None:
    """The block's author gets a `block` credit in the game (once per block and game). Never fails the use."""
    try:
        from app.collab import activity

        activity.credit(game_id, b.get("author_id"), "block", b["id"])
    except Exception as e:  # noqa: BLE001
        log.info("block credit skipped: %s", e)


@router.post("/games/{game_id}/blocks")
async def use_block(game_id: str, request: Request) -> Any:
    from app.routers.v2 import library as lib_api

    game = lib_api._game_v2(game_id)
    if game is None:
        return err(404, "error.not_found", {"what": "game"})
    try:
        body = UseBlockBody.model_validate(await _json(request))
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "block", "errors": min(e.error_count(), 99)})
    b = db_v2.get_block(body.block_id, body.version)
    if b is None:
        return err(404, "error.not_found", {"what": "block"})
    library_type: dict[str, Any] | None = None
    rules: dict[str, Any] | None = None
    try:
        if b["kind"] != "rules":
            library_type, _ = _type_from_block(b, game_id)
        if b.get("logic"):
            rules = _append_rules(b, game)
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "block", "errors": min(e.error_count(), 99)})
    except ValueError as e:
        key = str(e)
        return err(409, key) if key == "publish.safety_flag" else err(400, "error.bad_request", {"field": key})
    player = _player(request)
    db_v2.record_block_use(b["id"], int(b["version"]), game_id, type_id=(library_type or {}).get("id"), kind=b["kind"],
                           player_id=(player or {}).get("id"))
    _credit(b, game_id)
    return UseBlockResult.model_validate({"library_type": library_type, "rules": rules}).model_dump(
        mode="json", by_alias=True)
