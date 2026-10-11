"""Creative API (docs/v3/CONTRACTS_V3.md, "Creative API"; mounted under /api/v2). Art never blocks the UI and never
changes gameplay: every answer here is a job the tray polls, and the art ends up in the draft's `skin`.

GET  /creative/status                    → {provider: firefly|claude-svg|none, budget_left_usd}
POST /creative/jobs                      multipart crop, doc_id, stroke_ids (JSON), game_id?, hint?, bbox_cells (JSON)
                                         → 202 {job_id, cached, job}  (same crop + style + provider → the cached job)
GET  /creative/jobs?doc_id=              → {jobs: Job[]}
GET  /creative/jobs/{job_id}             → Job
POST /creative/jobs/{job_id}/reroll      {} → 202 {job_id}   (3 variations land in Job.variants)
POST /creative/jobs/{job_id}/choose      {variant: n} → Job
POST /creative/jobs/{job_id}/pin         {game_id, name, strokes?, kind?} → {type_id}   (library type with this art)
POST /creative/backdrop                  {doc_id, game_id?, theme?, screens} → 202 {job_id}
POST /creative/style                     {game_id, description} | multipart image (+ game_id, description?)
                                         → {style_id, image_url}
GET  /creative/style?game_id=            → {style, text}   (the game's current style; extra, for the bible screen)
PUT  /drafts/{draft_id}/skin             LevelSkin | null → {ok: true}   (draft state `skin`, copied on publish)

Errors are `{message_key, args}` with `creative.*` keys (shared/spec/messages.json).
"""
from __future__ import annotations

import importlib
import json
import logging
import re
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.datastructures import UploadFile

from app import db_v2
from app.creative import cutout, jobs
from app.creative import settings as cs
from app.creative import style as cstyle
from app.creative.jobs import CreativeError
from app.mind import moderate, sanitize
from app.spec.level import LevelSkin

log = logging.getLogger("dal.v3.creative.api")
router = APIRouter()

GAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NAME_CHARS = 16
MAX_STYLE_BYTES = 12 * 1024 * 1024
# role_guess → library kind (CONTRACTS: pinned art goes to the game's creature library)
ROLE_KIND = {"enemy": "creature", "player": "player", "platform": "platform", "hazard": "hazard", "coin": "pickup",
             "key": "pickup", "door": "prop", "goal": "prop", "spring": "prop", "decoration": "prop"}


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def _cerr(e: CreativeError) -> JSONResponse:
    return err(e.status, e.key, e.args_)


def _player(request: Request) -> dict[str, Any] | None:
    """Lane 4's identity (X-DP-Player) when that module exists; None for anonymous requests."""
    try:
        m = importlib.import_module("app.collab.identity")
        fn = getattr(m, "player_from_request", None)
        p = fn(request) if callable(fn) else None
    except Exception:  # noqa: BLE001 - identity is optional for art
        return None
    return p if isinstance(p, dict) else None


def _player_name(request: Request) -> str | None:
    p = _player(request)
    return sanitize.opt_text((p or {}).get("name"), 24)


def _collab_hook(name: str, *args: Any) -> None:
    """Lane 4's activity hooks (app.collab.activity.on_creature_pinned / on_art): guarded, never fails art."""
    try:
        m = importlib.import_module("app.collab.activity")
        fn = getattr(m, name, None)
        if callable(fn):
            fn(*args)
    except Exception as e:  # noqa: BLE001
        log.info("collab hook %s skipped: %s", name, e)


_JOB_IN_URL = re.compile(r"/(aj_[0-9a-f]{12})_")


def _art_ref(url: Any) -> str | None:
    """The job id inside a generated art URL (the stable credit ref), else the URL itself."""
    if not isinstance(url, str) or not url:
        return None
    m = _JOB_IN_URL.search(url)
    return m.group(1) if m else url[:300]


async def _json(request: Request) -> Any:
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        return None


def _json_field(v: Any, default: Any) -> Any:
    if v is None or isinstance(v, UploadFile):
        return default
    if isinstance(v, (list, dict)):
        return v
    try:
        return json.loads(str(v))
    except (TypeError, ValueError):
        return default


def _str_field(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _game_id(v: Any) -> str | None:
    g = _str_field(v)
    return g if g and GAME_RE.match(g) else None


# ---- status and jobs ---------------------------------------------------------------------------------------------


@router.get("/creative/status")
def creative_status() -> Any:
    s = cs.get()
    prov = cs.provider(s)
    return {
        "provider": prov,
        "budget_left_usd": jobs.budget_left(),
        "x_budget_usd": s.budget_usd,
        "x_background_removal": "photoshop" if (prov == "firefly" and s.remove_bg_api) else "local",
    }


@router.post("/creative/jobs", status_code=202)
async def post_job(request: Request) -> Any:
    if not request.headers.get("content-type", "").startswith("multipart/"):
        return err(400, "error.bad_request", {"field": "crop"})
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        return err(400, "error.upload_failed")
    crop = form.get("crop")
    if not isinstance(crop, UploadFile):
        return err(400, "creative.bad_crop")
    data = await crop.read()
    doc_id = _str_field(form.get("doc_id"))
    if not doc_id or not jobs.DOC_RE.match(doc_id):
        return err(400, "error.bad_request", {"field": "doc_id"})
    raw_game = form.get("game_id")
    game_id = _game_id(raw_game)
    if _str_field(raw_game) and game_id is None:
        return err(400, "error.bad_request", {"field": "game_id"})
    try:
        job, cached = jobs.create_object_job(
            data, doc_id=doc_id, stroke_ids=_json_field(form.get("stroke_ids"), []),
            bbox_cells=_json_field(form.get("bbox_cells"), None), game_id=game_id,
            hint=_str_field(form.get("hint")), by=_player_name(request), provider=_str_field(form.get("provider")))
    except CreativeError as e:
        return _cerr(e)
    return JSONResponse({"job_id": job["job_id"], "cached": cached, "job": jobs.public(job)}, status_code=202)


@router.get("/creative/jobs")
def list_jobs(doc_id: str = Query(default="")) -> Any:
    if not jobs.DOC_RE.match(doc_id or ""):
        return err(400, "error.bad_request", {"field": "doc_id"})
    return {"jobs": [jobs.public(j) for j in jobs.list_doc(doc_id)]}


@router.get("/creative/jobs/{job_id}")
def get_job(job_id: str) -> Any:
    job = jobs.load(job_id)
    if job is None:
        return err(404, "error.not_found", {"what": "job"})
    return jobs.public(job)


@router.post("/creative/jobs/{job_id}/reroll", status_code=202)
async def post_reroll(job_id: str) -> Any:
    try:
        job = jobs.reroll(job_id)
    except CreativeError as e:
        return _cerr(e)
    return JSONResponse({"job_id": job["job_id"]}, status_code=202)


@router.post("/creative/jobs/{job_id}/choose")
async def post_choose(job_id: str, request: Request) -> Any:
    body = await _json(request)
    if not isinstance(body, dict) or "variant" not in body:
        return err(400, "error.bad_request", {"field": "variant"})
    try:
        job = jobs.choose(job_id, body.get("variant"))
    except CreativeError as e:
        return _cerr(e)
    return jobs.public(job)


# ---- pin to the game's library -----------------------------------------------------------------------------------


def _shift_strokes(strokes: list[Any]) -> list[dict[str, Any]]:
    """Kid strokes (any frame) moved so their bbox starts at (0, 0); anything malformed is dropped."""
    good = [s for s in strokes if isinstance(s, dict) and isinstance(s.get("pts"), list) and s["pts"]]
    try:
        xs = [float(p[0]) for s in good for p in s["pts"]]
        ys = [float(p[1]) for s in good for p in s["pts"]]
    except (TypeError, ValueError, IndexError, KeyError):
        return []
    if not xs:
        return []
    x0, y0 = min(xs), min(ys)
    out = []
    for s in good:
        out.append({**s, "pts": [[round((float(p[0]) - x0) * 64) / 64, round((float(p[1]) - y0) * 64) / 64]
                                 for p in s["pts"]]})
    return out


@router.post("/creative/jobs/{job_id}/pin")
async def post_pin(job_id: str, request: Request) -> Any:
    from app.routers.v2.library import prepare_type

    job = jobs.load(job_id)
    if job is None:
        return err(404, "error.not_found", {"what": "job"})
    if job.get("status") != "done" or not job.get("url"):
        return err(409, "creative.not_ready")
    body = await _json(request)
    if not isinstance(body, dict):
        return err(400, "error.bad_request")
    game_id = _game_id(body.get("game_id"))
    game = db_v2.get_game(game_id) if game_id else None
    if game is None or game.get("format") != 2:
        return err(404, "error.not_found", {"what": "game"})
    name = sanitize.text(body.get("name"), NAME_CHARS) or sanitize.text(job.get("label"), NAME_CHARS)
    bbox = job.get("bbox_cells")
    size = [1.0, 1.0]
    if isinstance(bbox, list) and len(bbox) == 4:
        size = [round(max(0.5, bbox[2] - bbox[0]), 4), round(max(0.5, bbox[3] - bbox[1]), 4)]
    strokes = _shift_strokes(body.get("strokes") or []) if isinstance(body.get("strokes"), list) else []
    if not strokes:
        try:
            crop = jobs._crop_path(job).read_bytes()  # noqa: SLF001 - same lane
            strokes = cutout.trace_strokes(crop, (size[0], size[1]))
        except (OSError, CreativeError):
            strokes = []
    if not strokes:
        return err(409, "creative.bad_crop")
    kind = body.get("kind") if body.get("kind") in ("creature", "platform", "hazard", "pickup", "prop", "player") \
        else ROLE_KIND.get(str(job.get("role_guess") or ""), "creature")
    author = _player_name(request) or sanitize.opt_text(job.get("by"), 16) or "someone"
    raw = {
        "name": name, "kind": kind, "author": author,
        "art": {"strokes": strokes, "x_skin": {"url": job["url"], "provider": job.get("provider"),
                                               "label": job.get("label") or "", "credit": job.get("credit"),
                                               "job_id": job["job_id"]}},
    }
    if isinstance(body.get("behavior"), dict):
        raw["behavior"] = body["behavior"]
    try:
        doc = prepare_type(raw, game_id, prev=None)  # type: ignore[arg-type]
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "library", "errors": min(e.error_count(), 99)})
    except ValueError as e:
        return err(400, "error.bad_request", {"field": str(e)})
    if moderate.blocklist_hit([doc["name"], doc["author"]]):
        return err(409, "publish.safety_flag")
    stored = db_v2.insert_type(doc)
    job["x_pinned"] = {"game_id": game_id, "type_id": stored["id"], "version": stored.get("version")}
    jobs.save(job)
    player = _player(request)
    if player and player.get("id"):
        _collab_hook("on_creature_pinned", player["id"], game_id, stored["id"])
    return {"type_id": stored["id"], "version": stored.get("version"), "name": stored.get("name")}


# ---- backdrop and style ------------------------------------------------------------------------------------------


@router.post("/creative/backdrop", status_code=202)
async def post_backdrop(request: Request) -> Any:
    body = await _json(request)
    if not isinstance(body, dict):
        return err(400, "error.bad_request")
    doc_id = _str_field(body.get("doc_id"))
    if not doc_id or not jobs.DOC_RE.match(doc_id):
        return err(400, "error.bad_request", {"field": "doc_id"})
    game_id = _game_id(body.get("game_id"))
    theme = sanitize.text(body.get("theme"), 200)
    if not theme and game_id:  # the bible's pitch describes the world when the kid named no theme
        theme = sanitize.text((cstyle.bible_of(game_id) or {}).get("pitch"), 200)
    try:
        job, cached = jobs.create_backdrop_job(doc_id=doc_id, game_id=game_id, theme=theme or None,
                                               screens=body.get("screens"), by=_player_name(request), provider=body.get("provider"))
    except CreativeError as e:
        return _cerr(e)
    return JSONResponse({"job_id": job["job_id"], "cached": cached}, status_code=202)


@router.post("/creative/style")
async def post_style(request: Request) -> Any:
    player = _player(request)
    by = sanitize.opt_text((player or {}).get("name"), 24)
    ctype = request.headers.get("content-type", "")
    try:
        if ctype.startswith("multipart/"):
            form = await request.form()
            game_id = _game_id(form.get("game_id"))
            if game_id is None:
                return err(400, "error.bad_request", {"field": "game_id"})
            img = form.get("image")
            desc = _str_field(form.get("description"))
            if isinstance(img, UploadFile):
                data = await img.read(MAX_STYLE_BYTES + 1)
                rec = await cstyle.create_from_upload(game_id, data, description=desc, by=by)
            elif desc:
                rec = await cstyle.create_from_description(game_id, desc, by=by)
            else:
                return err(400, "error.bad_request", {"field": "image"})
        else:
            body = await _json(request)
            if not isinstance(body, dict):
                return err(400, "error.bad_request")
            game_id = _game_id(body.get("game_id"))
            if game_id is None:
                return err(400, "error.bad_request", {"field": "game_id"})
            if moderate.blocklist_hit([body.get("description")]):
                return err(409, "publish.safety_flag")
            rec = await cstyle.create_from_description(game_id, str(body.get("description") or ""), by=by)
    except cstyle.StyleError as e:
        return err(e.status, e.key)
    cstyle.record_in_bible(game_id, rec, (player or {}).get("id"))
    out = cstyle.public(rec) or {}
    return {**out, "style_id": rec["style_id"], "image_url": rec.get("image_url")}


@router.get("/creative/style")
def get_style(game_id: str = Query(default="")) -> Any:
    if not GAME_RE.match(game_id or ""):
        return err(400, "error.bad_request", {"field": "game_id"})
    info = cstyle.resolve(game_id)
    return {"style": cstyle.public((info or {}).get("record")), "text": (info or {}).get("text") or ""}


# ---- the draft's skin --------------------------------------------------------------------------------------------


@router.put("/drafts/{draft_id}/skin")
async def put_skin(draft_id: str, request: Request) -> Any:
    from app.build import drafts

    if not drafts.DRAFT_RE.match(draft_id) or not drafts.exists(draft_id):
        return err(404, "error.not_found", {"what": "draft"})
    raw = await _json(request)
    if isinstance(raw, dict) and "provider" not in raw and "skin" in raw:  # {skin: {...}} is accepted too
        raw = raw["skin"]
    skin: dict[str, Any] | None = None
    if raw is not None:
        try:
            skin = LevelSkin.model_validate(raw).model_dump(mode="json", by_alias=True)
        except ValidationError as e:
            return err(400, "error.bad_request", {"field": "skin", "errors": min(e.error_count(), 99)})
    async with drafts.lock(draft_id):
        state = drafts.load_state(draft_id)
        if state is None:
            return err(404, "error.not_found", {"what": "draft"})
        if skin is None:
            state.pop("skin", None)
        else:
            state["skin"] = skin
        drafts.save_state(draft_id, state)
    player = _player(request)
    if skin is not None and player and player.get("id"):  # the kid kept generated art on a level
        game_id = state.get("game_id") if isinstance(state.get("game_id"), str) else None
        refs = [_art_ref((skin.get("backdrop") or {}).get("url"))]
        refs += [_art_ref(o.get("url")) for o in skin.get("objects") or [] if o.get("mode") == "life"]
        for ref in list(dict.fromkeys(r for r in refs if r))[:40]:
            _collab_hook("on_art", player["id"], game_id, ref)
    return {"ok": True}
