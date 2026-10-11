"""The v6 Studio API (docs/v6/CONTRACTS_V6.md §5.1), mounted under /api/v2.

POST /studio/games                    {template?, title?, doc?} → 201 GameDoc (id sg_<12>, author from X-DP-Player)
GET  /studio/games/{id}               → GameDoc (anyone with the link)
PUT  /studio/games/{id}               GameDoc → GameDoc (author only; validated; ≤ 4 MB; bumps updated_at)
GET  /studio/games?mine=1|published=1 → {games: StudioGameCard[]} newest first
POST /studio/games/{id}/publish       {published} → StudioGameCard (author only)
PUT  /studio/games/{id}/thumbnail     PNG bytes (≤ 600 KB) → 204 (author only)
GET  /studio/games/{id}/thumbnail.png → the PNG
POST /studio/games/{id}/remix         → 201 GameDoc copy owned by the caller
POST /studio/games/{id}/blocks/{bid}/use  → {new} records a block use and credits its author (v6 §9)
GET  /studio/templates                → {templates: StudioGameCard[]}
GET  /studio/templates/{id}           → GameDoc
GET  /studio/themes                   → {themes: StudioTheme[]}
POST /studio/chat                     StudioChatBody → StudioChatResult
POST /studio/recognize                RecognizeBody → RecognizeResult
POST /studio/theme                    ThemeBody → ThemeResult

Errors are calm `{error: {key, args}}` with keys in shared/spec/messages-v6/ai.json. The server owns a game's id,
author, created_at and updated_at; everything else in the GameDoc is the maker's.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import ValidationError

from app.mind import moderate, sanitize
from app.spec.studio import (
    GameDoc, RecognizeBody, RecognizeResult, StudioChatBody, StudioChatResult, StudioGameCard, ThemeBody, ThemeResult,
)
from app.studio import assets, copilot, store

log = logging.getLogger("dal.v6.studio")
router = APIRouter()

GAME_ID = re.compile(r"^sg_[a-z0-9]{12}$")
TEMPLATE_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
MAX_DOC_BYTES = 4 * 1024 * 1024
MAX_THUMB_BYTES = 600 * 1024
MAX_CHAT_BYTES = 9 * 1024 * 1024  # a 4 MB game plus a canvas snapshot
MAX_SMALL_BYTES = 64 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
AUTHOR_CHARS = 32
TITLE_CHARS = 60


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"error": {"key": key, "args": args or {}}}, status_code=status)


def _player(request: Request) -> dict[str, Any] | None:
    """The acting profile (X-DP-Player), or None when absent, wrong, or the collab module is unavailable."""
    try:
        from app.collab.identity import player_from_request

        p = player_from_request(request)
    except Exception:  # noqa: BLE001 - identity is optional for reads
        return None
    return p if isinstance(p, dict) else None


class _Bad(Exception):
    def __init__(self, response: JSONResponse):
        super().__init__("bad request")
        self.response = response


async def _body_json(request: Request, limit: int, *, optional: bool = False) -> Any:
    """The JSON body, or _Bad with 413 too_big / 400 bad_request."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > limit:
        raise _Bad(err(413, "ai.err.too_big", {"limit": _size(limit)}))
    raw = await request.body()
    if len(raw) > limit:
        raise _Bad(err(413, "ai.err.too_big", {"limit": _size(limit)}))
    if not raw.strip():
        if optional:
            return {}
        raise _Bad(err(400, "ai.err.bad_request", {"field": "body"}))
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise _Bad(err(400, "ai.err.bad_request", {"field": "body"})) from None


def _size(n: int) -> str:
    return f"{n // (1024 * 1024)} MB" if n >= 1024 * 1024 else f"{n // 1024} KB"


def _dump(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True)


def _validate_doc(raw: Any, game_id: str) -> dict[str, Any]:
    """A GameDoc dict with the server's id; _Bad(400 bad_game) when it does not validate."""
    if not isinstance(raw, dict):
        raise _Bad(err(400, "ai.err.bad_request", {"field": "doc"}))
    raw = {**raw, "id": game_id}
    try:
        return _dump(GameDoc.model_validate(raw))
    except ValidationError as e:
        raise _Bad(err(400, "ai.err.bad_game", {"errors": min(e.error_count(), 99)})) from None


def _shown_texts(doc: dict[str, Any]) -> list[str | None]:
    """Everything a published game shows as words (the blocklist checks them)."""
    out: list[str | None] = [doc.get("title"), (doc.get("hud") or {}).get("title")]
    out += [i.get("label") for i in (doc.get("hud") or {}).get("items") or []]
    rules = list(doc.get("rules") or [])
    for s in doc.get("scenes") or []:
        out.append(s.get("name"))
        rules += s.get("rules") or []
        for o in s.get("objects") or []:
            out += [o.get("name"), o.get("kind")]
            rules += o.get("rules") or []
    for r in rules:
        out.append(r.get("text"))
        out += [str((a.get("params") or {}).get("text")) for a in r.get("then") or [] if a.get("type") == "say"]
    return out


def card(row: dict[str, Any]) -> dict[str, Any]:
    thumb = f"/api/v2/studio/games/{row['id']}/thumbnail.png?v={row.get('updated_at') or ''}" if row.get(
        "has_thumb") else None
    return _dump(StudioGameCard.model_validate({
        "id": row["id"], "title": row.get("title") or "", "author": row.get("author"), "kind": row.get("kind") or "",
        "theme_name": row.get("theme_name") or "Sketchbook", "scenes": int(row.get("scenes") or 0),
        "objects": int(row.get("objects") or 0), "published": bool(row.get("published")),
        "updated_at": row.get("updated_at"), "thumbnail_url": thumb}))


def _card_of(game_id: str) -> dict[str, Any] | None:
    row = store.get_row(game_id)
    if row is None:
        return None
    doc = row.get("doc") or {}
    scenes = doc.get("scenes") or []
    return card({**row, "theme_name": (doc.get("theme") or {}).get("name"), "scenes": len(scenes),
                 "objects": sum(len(s.get("objects") or []) for s in scenes)})


def _owned(request: Request, game_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """(player, row) for a write; _Bad with 401 / 404 / 403."""
    player = _player(request)
    if player is None:
        raise _Bad(err(401, "ai.err.need_profile"))
    row = store.get_row(game_id) if GAME_ID.match(game_id) else None
    if row is None:
        raise _Bad(err(404, "ai.err.not_found", {"what": "game"}))
    if not row.get("author_id") or row["author_id"] != player.get("id"):
        raise _Bad(err(403, "ai.err.not_author"))
    return player, row


def _new_doc(base: dict[str, Any], player: dict[str, Any], title: Any = None) -> dict[str, Any]:
    now = store.now_iso()
    doc = dict(base)
    doc["id"] = store.new_id()
    doc["author"] = sanitize.text(player.get("name"), AUTHOR_CHARS) or None
    doc["created_at"] = now
    doc["updated_at"] = now
    t = sanitize.text(title, TITLE_CHARS) if title is not None else ""
    if t:
        doc["title"] = t
    return _dump(GameDoc.model_validate(doc))


# ---- games --------------------------------------------------------------------------------------------------------


@router.post("/studio/games", status_code=201)
async def create_game(request: Request) -> Any:
    player = _player(request)
    if player is None:
        return err(401, "ai.err.need_profile")
    try:
        raw = await _body_json(request, MAX_DOC_BYTES + MAX_SMALL_BYTES, optional=True)
        if not isinstance(raw, dict):
            return err(400, "ai.err.bad_request", {"field": "body"})
        if raw.get("doc") is not None:
            base = _validate_doc(raw["doc"], "sg_new")
        elif raw.get("template"):
            tid = str(raw["template"])
            base = assets.template(tid) if TEMPLATE_ID.match(tid) else None
            if base is None:
                return err(404, "ai.err.not_found", {"what": "template"})
        else:
            base = assets.blank()
    except _Bad as b:
        return b.response
    title = raw.get("title")
    if title is not None and not isinstance(title, str):
        return err(400, "ai.err.bad_request", {"field": "title"})
    if moderate.blocklist_hit([title]):
        return err(409, "ai.err.safety")
    base.pop("x_remix_of", None)
    doc = _new_doc(base, player, title)
    store.insert(doc, author=doc.get("author"), author_id=player.get("id"))
    return JSONResponse(doc, status_code=201)


@router.get("/studio/games")
def list_games(request: Request, mine: int = 0, published: int = 0,
               limit: int = Query(default=store.LIST_LIMIT, ge=1, le=store.LIST_LIMIT)) -> Any:
    if mine:
        player = _player(request)
        if player is None:
            return err(401, "ai.err.need_profile")
        rows = store.list_cards(author_id=str(player.get("id")), published=True if published else None, limit=limit)
    else:
        rows = store.list_cards(published=True, limit=limit)
    out = []
    for r in rows:
        try:
            out.append(card(r))
        except ValidationError:  # never expected; a broken row is skipped, never a broken list
            log.info("studio game %s skipped in a listing", r.get("id"))
    return {"games": out}


@router.get("/studio/games/{game_id}")
def get_game(game_id: str) -> Any:
    row = store.get_row(game_id) if GAME_ID.match(game_id) else None
    if row is None or row.get("doc") is None:
        return err(404, "ai.err.not_found", {"what": "game"})
    return row["doc"]


@router.put("/studio/games/{game_id}")
async def save_game(game_id: str, request: Request) -> Any:
    try:
        _, row = _owned(request, game_id)
        raw = await _body_json(request, MAX_DOC_BYTES)
        doc = _validate_doc(raw, game_id)
    except _Bad as b:
        return b.response
    old = row.get("doc") or {}
    doc["author"] = old.get("author", row.get("author"))
    doc["created_at"] = old.get("created_at") or row.get("created_at")
    doc["updated_at"] = store.now_iso()
    if old.get("x_remix_of"):
        doc["x_remix_of"] = old["x_remix_of"]
    if moderate.blocklist_hit([doc.get("title")]):
        return err(409, "ai.err.safety")
    store.update_doc(game_id, doc)
    return doc


@router.post("/studio/games/{game_id}/publish")
async def publish_game(game_id: str, request: Request) -> Any:
    try:
        _, row = _owned(request, game_id)
        raw = await _body_json(request, MAX_SMALL_BYTES, optional=True)
    except _Bad as b:
        return b.response
    if not isinstance(raw, dict) or not isinstance(raw.get("published", True), bool):
        return err(400, "ai.err.bad_request", {"field": "published"})
    want = bool(raw.get("published", True))
    if want and moderate.blocklist_hit(_shown_texts(row.get("doc") or {})):
        return err(409, "ai.err.safety")
    store.set_published(game_id, want)
    return _card_of(game_id)


@router.put("/studio/games/{game_id}/thumbnail", status_code=204, response_class=Response)
async def put_thumbnail(game_id: str, request: Request) -> Response:
    try:
        _owned(request, game_id)
    except _Bad as b:
        return b.response
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_THUMB_BYTES:
        return err(413, "ai.err.too_big", {"limit": _size(MAX_THUMB_BYTES)})
    data = await request.body()
    if len(data) > MAX_THUMB_BYTES:
        return err(413, "ai.err.too_big", {"limit": _size(MAX_THUMB_BYTES)})
    if not data.startswith(PNG_MAGIC):
        png = copilot.decode_png(data.decode("ascii", errors="ignore")) if data[:1] in (b"i", b"d") else None
        if png is None or len(png) > MAX_THUMB_BYTES:
            return err(400, "ai.err.bad_png")
        data = png
    store.set_thumbnail(game_id, data)
    return Response(status_code=204)


@router.get("/studio/games/{game_id}/thumbnail.png")
def get_thumbnail(game_id: str) -> Any:
    png = store.get_thumbnail(game_id) if GAME_ID.match(game_id) else None
    if png is None:
        return err(404, "ai.err.not_found", {"what": "thumbnail"})
    return Response(png, media_type="image/png", headers={"Cache-Control": "public, max-age=300"})


@router.post("/studio/games/{game_id}/remix", status_code=201)
async def remix_game(game_id: str, request: Request) -> Any:
    player = _player(request)
    if player is None:
        return err(401, "ai.err.need_profile")
    row = store.get_row(game_id) if GAME_ID.match(game_id) else None
    if row is None or row.get("doc") is None:
        return err(404, "ai.err.not_found", {"what": "game"})
    base = dict(row["doc"])
    base["x_remix_of"] = game_id
    doc = _new_doc(base, player)
    store.insert(doc, author=doc.get("author"), author_id=player.get("id"))
    return JSONResponse(doc, status_code=201)


# ---- templates and themes -----------------------------------------------------------------------------------------


@router.post("/studio/games/{game_id}/blocks/{block_id}/use")
async def use_block(game_id: str, block_id: str, request: Request) -> Any:
    """The Studio dropped an object or theme block into this game (the doc change itself comes with the next save):
    count the use (BlockCard.uses, the popular sort) and credit the block's author in this game."""
    from app import db_v2

    player = _player(request)
    if player is None:
        return err(401, "ai.err.need_profile")
    if not GAME_ID.match(game_id) or store.get_row(game_id) is None:
        return err(404, "ai.err.not_found", {"what": "game"})
    b = db_v2.get_block(block_id, None) if TEMPLATE_ID.match(block_id) else None
    if b is None or b.get("kind") not in ("object", "theme"):
        return err(404, "ai.err.not_found", {"what": "block"})
    new = db_v2.record_block_use(b["id"], int(b["version"]), game_id, type_id=None, kind=b["kind"],
                                 player_id=player.get("id"))
    if new and b.get("author_id") and b.get("author_id") != player.get("id"):
        try:
            from app.collab import activity

            activity.credit(game_id, b.get("author_id"), "block", b["id"])
        except Exception as e:  # noqa: BLE001 - a credit never fails the use
            log.info("studio block credit skipped: %s", e)
    return {"new": new}


@router.get("/studio/templates")
def list_templates() -> Any:
    out = []
    for tid, doc in assets.templates():
        scenes = doc.get("scenes") or []
        thumb = f"/api/v2/studio/templates/{tid}/thumbnail.png" if assets.template_thumbnail(tid) else None
        out.append(card({"id": tid, "title": doc.get("title"), "author": doc.get("author") or "draw.play",
                         "kind": store.kind_of(doc), "theme_name": (doc.get("theme") or {}).get("name"),
                         "scenes": len(scenes), "objects": sum(len(s.get("objects") or []) for s in scenes),
                         "published": True, "updated_at": doc.get("updated_at"), "has_thumb": False})
                   | {"thumbnail_url": thumb})
    return {"templates": out}


@router.get("/studio/templates/{template_id}")
def get_template(template_id: str) -> Any:
    doc = assets.template(template_id) if TEMPLATE_ID.match(template_id) else None
    if doc is None:
        return err(404, "ai.err.not_found", {"what": "template"})
    return doc


@router.get("/studio/templates/{template_id}/thumbnail.png")
def get_template_thumbnail(template_id: str) -> Any:
    p = assets.template_thumbnail(template_id) if TEMPLATE_ID.match(template_id) else None
    if p is None:
        return err(404, "ai.err.not_found", {"what": "thumbnail"})
    return FileResponse(p, media_type="image/png")


@router.get("/studio/themes")
def list_themes() -> Any:
    return {"themes": assets.themes()}


# ---- the copilot --------------------------------------------------------------------------------------------------


@router.post("/studio/chat")
async def studio_chat(request: Request) -> Any:
    try:
        raw = await _body_json(request, MAX_CHAT_BYTES)
        body = StudioChatBody.model_validate(raw)
    except _Bad as b:
        return b.response
    except ValidationError as e:
        return err(400, "ai.err.bad_request", {"field": "chat", "errors": min(e.error_count(), 99)})
    res = await copilot.chat(_dump(body))
    try:
        return _dump(StudioChatResult.model_validate(res))
    except ValidationError:  # never expected: every edit was validated; the keyword reply as a floor
        log.warning("studio chat gave an invalid result; using keywords")
        d = _dump(body)
        return _dump(StudioChatResult.model_validate(copilot.keyword_chat(d["game"], d["scene"], d["selection"],
                                                                          d["message"])))


@router.post("/studio/recognize")
async def studio_recognize(request: Request) -> Any:
    try:
        raw = await _body_json(request, MAX_CHAT_BYTES)
        body = RecognizeBody.model_validate(raw)
    except _Bad as b:
        return b.response
    except ValidationError as e:
        return err(400, "ai.err.bad_request", {"field": "recognize", "errors": min(e.error_count(), 99)})
    d = _dump(body)
    scene = next((s for s in d["game"]["scenes"] if s["id"] == d["scene"]), None)
    if scene is None or not any(o["id"] == d["object_id"] for o in scene["objects"]):
        return err(400, "ai.err.bad_object")
    res = await copilot.recognize(d)
    return _dump(RecognizeResult.model_validate(res))


@router.post("/studio/theme")
async def studio_theme(request: Request) -> Any:
    try:
        raw = await _body_json(request, MAX_SMALL_BYTES)
        body = ThemeBody.model_validate(raw)
    except _Bad as b:
        return b.response
    except ValidationError as e:
        return err(400, "ai.err.bad_request", {"field": "theme", "errors": min(e.error_count(), 99)})
    res = await copilot.theme(_dump(body))
    return _dump(ThemeResult.model_validate(res))
