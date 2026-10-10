"""The object library per game (PLAN_V2 §8.1, §11.3e). Types are immutable per version (D21); levels pin
{type_id, version}, so editing a type is a new version and published levels never change silently.

GET  /games/{id}/library            → {types}                 the latest version of every type of the game
POST /games/{id}/library            LibraryType → 201 type    a new type (id optional), or version n+1 of one of its own
GET  /library/{type_id}?v=          → type (+ x_versions)      a pinned version, or the latest
POST /library/{type_id}/versions    LibraryType (partial ok) → 201 type   version n+1 (unchanged fields carried over)
POST /library/{type_id}/update-levels[?v=]  → {updated: [{level_id, version}], broken: [{level_id, reason_key}]}
                                    "Update levels to vN": every level of the game that pins an older version of the
                                    type is rebuilt with vN and re-verified by the bot; the ones that still play are
                                    saved as a new level version, the ones that break are listed and keep their own
                                    version (published levels never change silently)
POST /library/interpret             {name, text, ink} → {spec, behavior, source: model|keywords}   (Creature Studio chips)
POST /scan/library-sheet            multipart photo → {drafts}  (lane C's OMR; names offline are "Creature N")

The server assigns `game_id`, `version` and `created_at`, and the circled paper `letter`: unique per game, the first
free letter of the name. Names (≤ 16 chars) and authors pass the deterministic blocklist.
"""
from __future__ import annotations

import asyncio
import importlib
import logging
import re
import secrets
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.datastructures import UploadFile

from app import db_v2
from app.mind import creature as mcreature
from app.mind import messages, moderate, sanitize
from app.spec.api import InterpretBody
from app.spec.library import LibraryType

log = logging.getLogger("dal.v2.library")
router = APIRouter()

TYPE_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
NAME_CHARS = 16
MAX_SHEET_BYTES = 15 * 1024 * 1024
DEFAULT_COLLISION = {"creature": "none", "platform": "solid", "hazard": "none", "pickup": "none", "prop": "none",
                     "player": "none"}


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def _game_v2(game_id: str) -> dict[str, Any] | None:
    g = db_v2.get_game(game_id)
    return g if g is not None and g.get("format") == 2 else None


def used_letters(game_id: str, *, except_id: str | None = None) -> set[str]:
    return {str(t.get("letter", "")).upper() for t in db_v2.library_latest(game_id) if t.get("id") != except_id}


def pick_letter(name: str, wanted: str | None, used: set[str]) -> str:
    """The circled paper tag: the requested letter when free, else the first free letter of the name, else A-Z."""
    w = (wanted or "").strip().upper()
    if len(w) == 1 and w.isalpha() and w not in used:
        return w
    for ch in (name or "").upper():
        if ch.isalpha() and ch.isascii() and ch not in used:
            return ch
    for ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        if ch not in used:
            return ch
    return (name[:1] or "X").upper()


def _size_of(strokes: list[dict[str, Any]]) -> list[float]:
    pts = [p for s in strokes for p in s.get("pts") or [] if isinstance(p, (list, tuple)) and len(p) >= 2]
    if not pts:
        return [1.0, 1.0]
    xs = [float(p[0]) for p in pts]
    ys = [float(p[1]) for p in pts]
    return [round(max(0.5, max(xs) - min(xs)), 4), round(max(0.5, max(ys) - min(ys)), 4)]


def prepare_type(raw: dict[str, Any], game_id: str, *, prev: dict[str, Any] | None) -> dict[str, Any]:
    """Fill the server-owned fields and defaults; raises ValueError(<field>) for a missing drawing or a bad id."""
    base = dict(prev or {})
    base.update({k: v for k, v in raw.items() if v is not None})
    tid = str(base.get("id") or "").strip() or f"lt_{secrets.token_hex(4)}"
    if not TYPE_ID.match(tid):
        raise ValueError("id")
    name = sanitize.text(base.get("name"), NAME_CHARS)
    if not name:
        n = len(db_v2.library_latest(game_id)) + 1
        name = sanitize.text(messages.say("library.creature_n", {"n": n}, f"Creature {n}"), NAME_CHARS)
    kind = base.get("kind") if base.get("kind") in DEFAULT_COLLISION else "creature"
    art = dict(base.get("art") or {})
    strokes = [s for s in art.get("strokes") or [] if isinstance(s, dict)]
    if not strokes:
        raise ValueError("art")
    if not art.get("size_cells"):
        art["size_cells"] = _size_of(strokes)
    art["strokes"] = strokes
    behavior = base.get("behavior")
    if not isinstance(behavior, dict) or not behavior.get("kind"):
        behavior = mcreature.behavior_of({"archetype": "walker" if kind == "creature" else "static", "speed": "normal",
                                          "spiky": bool(base.get("spiky"))}) if kind in ("creature", "hazard") else {"kind": "static"}
    if kind == "creature" and behavior.get("kind") == "enemy":
        behavior = {**behavior, "spiky": bool(base.get("spiky", behavior.get("spiky", False)))}
    used = used_letters(game_id, except_id=tid)
    doc = {
        "id": tid, "game_id": game_id, "version": 1, "name": name,
        "letter": pick_letter(name, (prev or {}).get("letter") if raw.get("letter") is None else raw.get("letter"), used),
        "kind": kind, "behavior": behavior, "spiky": bool(base.get("spiky", False)),
        "collision": base.get("collision") if base.get("collision") in ("solid", "one_way", "none") else DEFAULT_COLLISION[kind],
        "art": art, "symbol": base.get("symbol"), "author": sanitize.text(base.get("author"), 16) or "someone",
        "created_at": db_v2.now_iso(),
    }
    return LibraryType.model_validate(doc).model_dump(mode="json", by_alias=True)


async def _insert(raw: Any, game_id: str, prev: dict[str, Any] | None) -> JSONResponse:
    if not isinstance(raw, dict):
        return err(400, "error.bad_request", {"field": "library"})
    try:
        doc = prepare_type(raw, game_id, prev=prev)
    except ValueError as e:
        if isinstance(e, ValidationError):
            return err(400, "error.bad_request", {"field": "library", "errors": min(e.error_count(), 99)})
        return err(400, "error.bad_request", {"field": str(e)})
    if moderate.blocklist_hit([doc["name"], doc["author"]]):
        return err(409, "publish.safety_flag")
    owner = db_v2.type_owner(doc["id"])
    if owner is not None and owner != game_id:
        return err(409, "error.bad_request", {"field": "id"})
    stored = db_v2.insert_type(doc)
    return JSONResponse(stored, status_code=201)


@router.get("/games/{game_id}/library")
def get_library(game_id: str) -> Any:
    if _game_v2(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    return {"types": db_v2.library_latest(game_id)}


@router.post("/games/{game_id}/library", status_code=201)
async def add_type(game_id: str, request: Request) -> Any:
    if _game_v2(game_id) is None:
        return err(404, "error.not_found", {"what": "game"})
    try:
        raw = await request.json()
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request")
    prev = None
    if isinstance(raw, dict) and raw.get("id"):
        prev = db_v2.get_type(str(raw["id"]))
        if prev is not None and prev.get("game_id") != game_id:
            return err(409, "error.bad_request", {"field": "id"})
    return await _insert(raw, game_id, prev)


@router.get("/library/{type_id}")
def get_type(type_id: str, v: int | None = Query(default=None, ge=1)) -> Any:
    if not TYPE_ID.match(type_id):
        return err(404, "error.not_found", {"what": "library"})
    t = db_v2.get_type(type_id, v)
    if t is None:
        return err(404, "error.not_found", {"what": "library"})
    return {**t, "x_versions": db_v2.type_versions(type_id)}


@router.post("/library/{type_id}/versions", status_code=201)
async def new_version(type_id: str, request: Request) -> Any:
    if not TYPE_ID.match(type_id):
        return err(404, "error.not_found", {"what": "library"})
    prev = db_v2.get_type(type_id)
    if prev is None:
        return err(404, "error.not_found", {"what": "library"})
    try:
        raw = await request.json()
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request")
    if not isinstance(raw, dict):
        return err(400, "error.bad_request", {"field": "library"})
    raw = {**raw, "id": type_id}
    return await _insert(raw, str(prev["game_id"]), prev)


def _pins(level: dict[str, Any], type_id: str) -> set[int]:
    out: set[int] = set()
    for s in ((level.get("ink") or {}).get("strokes") or []) + list(level.get("objects") or []):
        lib = s.get("lib") if isinstance(s, dict) else None
        if isinstance(lib, dict) and lib.get("type_id") == type_id:
            out.add(int(lib.get("version") or 1))
    return out


def _repin(level: dict[str, Any], type_id: str, version: int) -> None:
    for s in ((level.get("ink") or {}).get("strokes") or []) + list(level.get("objects") or []):
        lib = s.get("lib") if isinstance(s, dict) else None
        if isinstance(lib, dict) and lib.get("type_id") == type_id:
            lib["version"] = version


@router.post("/library/{type_id}/update-levels")
async def update_levels(type_id: str, v: int | None = Query(default=None, ge=1)) -> Any:
    import copy

    from app.build import levels_io
    from app.build.bridge import CoreError, get_pool

    if not TYPE_ID.match(type_id):
        return err(404, "error.not_found", {"what": "library"})
    t = db_v2.get_type(type_id, v)
    if t is None:
        return err(404, "error.not_found", {"what": "library"})
    pool = get_pool()
    if pool is None:
        return err(503, "error.worker_down")
    target = int(t["version"])
    updated: list[dict[str, Any]] = []
    broken: list[dict[str, Any]] = []
    for row in db_v2.game_level_rows(str(t["game_id"]))[:40]:
        level = row["level"]
        pins = _pins(level, type_id)
        if not pins or pins == {target}:
            continue
        new = copy.deepcopy(level)
        _repin(new, type_id, target)
        lib = [x for x in levels_io.embedded_library(new, row.get("game_id")) if x.get("id") != type_id] + [t]
        try:
            res = await pool.call("build", levels_io.rebuild_input(new, library=lib), 15.0)
        except CoreError as e:
            if e.code == "down":
                return err(503, "error.worker_down")
            broken.append({"level_id": row["id"], "reason_key": "library.update_breaks", "x_error": e.code})
            continue
        built = (res or {}).get("level") if isinstance(res, dict) else None
        report = (res or {}).get("report") or {}
        if not isinstance(built, dict) or not report.get("solvable"):
            broken.append({"level_id": row["id"], "reason_key": "library.update_breaks", "x_title": row.get("title")})
            continue
        out = copy.deepcopy(built)
        for k in ("id", "game_id", "parent_id", "order_index", "title", "author", "license", "source"):
            if k in level:
                out[k] = copy.deepcopy(level[k])
        out.pop("ink_ref", None)
        if not out.get("ink"):
            out["ink"] = new.get("ink")
        version = db_v2.next_level_version(row["id"])
        meta = dict(out.get("meta") or {})
        meta.update({k: (level.get("meta") or {}).get(k) for k in ("safety", "transcript", "intent")
                     if (level.get("meta") or {}).get(k) is not None})
        out.update({"version": version, "created_at": db_v2.now_iso(), "embedded_library": lib, "meta": meta})
        if levels_io.validate({**out, "meta": {**meta, "level_hash": meta.get("level_hash") or "x"}}):
            broken.append({"level_id": row["id"], "reason_key": "library.update_breaks", "x_error": "invalid"})
            continue
        levels_io.store(out, report=report, listed=bool(row.get("listed", True)), safety=meta.get("safety"),
                        changed=row.get("changed"), parent_version=row.get("parent_version"))
        updated.append({"level_id": row["id"], "version": version})
    return {"type_id": type_id, "version": target, "updated": updated, "broken": broken}


@router.post("/library/interpret")
async def interpret(request: Request) -> Any:
    try:
        body = InterpretBody.model_validate(await request.json())
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "interpret", "errors": min(e.error_count(), 99)})
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request")
    strokes = [s.model_dump(mode="json", by_alias=True) for s in body.ink]
    res = await mcreature.interpret(body.name, body.text, strokes)
    return {"spec": res.spec, "behavior": res.behavior, "source": res.source}


def lane_c(name: str) -> Any:
    """A lane C function by name, wherever it lives (checkbox OMR and sheet readers land in P5)."""
    for mod in ("app.cv.checkbox", "app.cv.sheets_v2", "app.cv.omr", "app.cv.scan_v2", "app.template.generate_v2"):
        try:
            m = importlib.import_module(mod)
        except Exception:  # noqa: BLE001
            continue
        fn = getattr(m, name, None)
        if callable(fn):
            return fn
    return None


async def read_upload(request: Request, max_bytes: int = MAX_SHEET_BYTES) -> bytes | None:
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("multipart/"):
        form = await request.form()
        for key in ("photo", "photos", "photos[]", "image", "file"):
            v = form.get(key)
            if isinstance(v, UploadFile):
                data = await v.read()
                return data if 0 < len(data) <= max_bytes else None
        return None
    data = await request.body()
    return data if 0 < len(data) <= max_bytes else None


def _as_dict(x: Any) -> Any:
    if hasattr(x, "model_dump"):
        return x.model_dump(mode="json", by_alias=True)
    if hasattr(x, "__dataclass_fields__"):
        from dataclasses import asdict

        return asdict(x)
    return x


@router.post("/scan/library-sheet")
async def scan_library_sheet(request: Request) -> Any:
    """Lane C's OMR reads the boxes (no model); the name lines are then transcribed by the handwriting call, so a
    creature arrives named "Grumpo" instead of "Creature 1" whenever the model can read it."""
    from app.mind import handwriting

    data = await read_upload(request)
    if not data:
        return err(400, "error.upload_failed")
    detail = lane_c("read_library_sheet_detail")
    fn = detail or lane_c("read_library_sheet")
    if fn is None:
        return err(501, "error.not_implemented", {"route": "POST /api/v2/scan/library-sheet"})
    try:
        res = await asyncio.to_thread(fn, data)
    except Exception as e:  # noqa: BLE001 - the reader's MessageRef when it has one
        msg = _as_dict(getattr(e, "message", None))
        log.info("library sheet: %s", e)
        return err(422, msg.get("key") if isinstance(msg, dict) and msg.get("key") else "error.no_drawing",
                   (msg or {}).get("args") if isinstance(msg, dict) else {})
    drafts = list(getattr(res, "drafts", None) or []) if detail is not None else list(res or [])
    name_imgs: dict[int, bytes] = {}
    for b in getattr(res, "boxes", None) or []:
        d = getattr(b, "draft", None)
        if d is not None and getattr(d, "name_has_ink", False) and getattr(b, "name_jpeg", None):
            name_imgs[int(getattr(d, "box", getattr(b, "index", 0)))] = b.name_jpeg
    out = []
    for i, d in enumerate(drafts, start=1):
        d = _as_dict(d)
        if not isinstance(d, dict):
            continue
        if not sanitize.text(d.get("name"), NAME_CHARS):
            d["name"] = messages.say("library.creature_n", {"n": i}, f"Creature {i}")
        out.append(d)
    keys = [int(d.get("box", 0)) for d in out if int(d.get("box", 0)) in name_imgs]
    if keys:
        texts = await handwriting.read_lines([name_imgs[k] for k in keys], "creature name lines a child wrote",
                                             max_chars=NAME_CHARS)
        for k, t in zip(keys, texts or []):
            if t:
                for d in out:
                    if int(d.get("box", 0)) == k:
                        d["name"] = t
                        d["name_source"] = "model"
    used: set[str] = set()
    gid = getattr(res, "game_id", None)
    if not isinstance(gid, str) and request.headers.get("content-type", "").startswith("multipart/"):
        fg = (await request.form()).get("game_id")  # the screen's game when the sheet's QR was unreadable
        gid = fg if isinstance(fg, str) and TYPE_ID.match(fg) else None
    if isinstance(gid, str) and _game_v2(gid) is not None:
        used = used_letters(gid)
    for d in out:  # the letter the kid will circle on drawing sheets: unique in the game
        d["letter"] = pick_letter(str(d.get("name") or ""), d.get("letter"), used)
        used.add(d["letter"])
    body: dict[str, Any] = {"drafts": out}
    if isinstance(gid, str):
        body["game_id"] = gid
    warns = [_as_dict(w) for w in getattr(res, "warnings", None) or []]
    if warns:
        body["warnings"] = warns
    return body
