"""Create and play an imaginative game without passing the sketch through fixed role classification."""
from typing import Any, Literal
import json
import time
import hashlib
import hmac
import secrets

from fastapi import APIRouter, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from app import db_v2
from app.collab import identity, members
from app.build import drafts, imagine
from app.creative import imagine_assets
from app.mind import client, moderate, sanitize, render
from app.spec.ink import InkDoc

router = APIRouter()


class ImagineBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ink: InkDoc | None = None
    category: Literal["action", "adventure", "rpg", "strategy", "simulation", "puzzle", "racing", "sports", "platformer", "survival", "custom"] | None = None
    game_id: str | None = None
    append_level: bool = False
    level_id: str | None = None
    multiplayer: bool | None = None
    better_graphics: bool | None = None
    context: str = Field(default="", max_length=8000)
    title: str = Field(default="", max_length=80)


@router.post("/imagined-games", status_code=202)
async def create(body: ImagineBody) -> Any:
    return await start_generation(body)


async def start_generation(body: ImagineBody, revision: dict[str, Any] | None = None,
                           conversation: list[dict[str, Any]] | None = None,
                           art_source_draft: str | None = None, canvas_updated: bool = False) -> Any:
    game = db_v2.get_game(body.game_id) if body.game_id else None
    if body.game_id and not game:
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    if (body.append_level or body.level_id) and not game:
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    if body.level_id and not any(level["level_id"] == body.level_id for level in game["generated_levels"]):
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    if not client.available():
        return JSONResponse({"message_key": "imagine.no_key"}, status_code=503)
    context = sanitize.text(body.context, 8000)
    title = sanitize.text(body.title, 80)
    if body.ink is None and not context.strip():
        return JSONResponse({"message_key": "imagine.prompt_required"}, status_code=400)
    if moderate.blocklist_hit([context, title]):
        return JSONResponse({"message_key": "imagine.refused"}, status_code=409)
    draft_id = drafts.new_draft_id()
    ink = body.ink.model_dump(mode="json") if body.ink else {
        "v": 2, "source": "prompt", "world": {"screens": 1, "w": 48},
        "strokes": [], "components": [], "character": None, "typed_rules": [],
        "rules_ink": [], "sheets": [], "noise": {"count": 0}, "parent": None,
    }
    if body.category:
        game = {**(game or {}), "brief": {**((game or {}).get("brief") or {}), "category": body.category}}
    drafts.write_json(draft_id, "original-ink.json", ink)
    state = {"draft_id": draft_id, "game_id": body.game_id, "status": "building",
             "title": title or (game or {}).get("title") or "", "context": context,
             "category": body.category or ((game or {}).get("brief") or {}).get("category"),
             "infer_title": not bool(title), "publication": "draft",
             "started_at": time.time(), "timeout_s": imagine.GENERATION_TIMEOUT_S, "phase": "designing"}
    previous_graphics = revision or ((game or {}).get("generated") if body.append_level or body.level_id else None) or {}
    if body.level_id and game and not revision:
        previous_graphics = next((level for level in game["generated_levels"] if level["level_id"] == body.level_id), {})
    state["better_graphics"] = (body.better_graphics if body.better_graphics is not None
                                else bool(previous_graphics.get("better_graphics", False)))
    state["multiplayer"] = body.multiplayer if body.multiplayer is not None else bool(previous_graphics.get("multiplayer", False))
    if art_source_draft:
        state["art_source_draft"] = art_source_draft
    if canvas_updated:
        state["canvas_updated"] = True
    state["conversation"] = conversation if conversation is not None else [{"role": "user", "content": context}]
    state["original_context"] = (revision.get("original_context", revision.get("context", "")) if revision else context)
    if revision:
        state.update(revision_of=revision["draft_id"], base_draft_id=revision.get("base_draft_id"))
        game = {**(game or {}), "revision_context": {
            "html": imagine_assets.strip_runtime(imagine.artifact_path(revision["draft_id"]).read_text()),
            "conversation": state["conversation"], "summary": revision.get("summary"),
            "controls": revision.get("controls"), "request": context,
            "canvas_updated": canvas_updated,
            "previous_canvas": drafts.read_json(revision["draft_id"], "original-ink.json") if canvas_updated else None}}
    if body.game_id:
        # New levels inherit the original playable game, never overwrite it.
        base = game.get("generated")
        if body.append_level and base:
            state["base_draft_id"] = base["draft_id"]
        elif body.level_id:
            previous = next(level for level in game["generated_levels"] if level["level_id"] == body.level_id)
            state["base_draft_id"] = previous.get("base_draft_id")
        db_v2.reserve_generated_level(game["id"], state, append=body.append_level, level_id=body.level_id)
        if state.get("base_draft_id"):
            base_state = imagine.read(state["base_draft_id"])
            base_path = imagine.artifact_path(state["base_draft_id"])
            if base_state and base_path.is_file():
                game = {**game, "level_context": {"level_number": state["level_number"],
                        "original_title": base_state.get("title"), "summary": base_state.get("summary"),
                        "controls": base_state.get("controls"), "html": imagine_assets.strip_runtime(base_path.read_text())}}
    imagine.save(draft_id, state)
    token = secrets.token_urlsafe(32)
    token_path = imagine.artifact_path(draft_id).with_name("creator.sha256")
    token_path.parent.mkdir(parents=True, exist_ok=True)
    source_token = imagine.artifact_path(revision["draft_id"]).with_name("creator.sha256") if revision else None
    token_path.write_text(source_token.read_text() if source_token and source_token.is_file()
                          else hashlib.sha256(token.encode()).hexdigest())
    imagine.start(draft_id, ink, game, context, title)
    return JSONResponse({**state, **({} if source_token and source_token.is_file() else {"publish_token": token})}, status_code=202)


@router.post("/imagined-games/{draft_id}/retry", status_code=202)
async def retry(draft_id: str, request: Request) -> Any:
    state = imagine.read(draft_id)
    ink = drafts.read_json(draft_id, "original-ink.json") if state else None
    if not state or not ink:
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    if state.get("revision_of") and not can_publish(draft_id, state, request):
        return JSONResponse({"message_key": "imagine.publish_denied"}, status_code=403)
    next_state = imagine.read(state["retried_as"]) if state.get("retried_as") else None
    if next_state and next_state["status"] in {"building", "ready"}:
        return JSONResponse(next_state, status_code=202)
    if imagine.running(draft_id):
        return JSONResponse(state, status_code=202)
    game = db_v2.get_game(state["game_id"]) if state.get("game_id") else None
    if state.get("level_id") and game and not any(level["draft_id"] == draft_id for level in game["generated_levels"]):
        return JSONResponse({"message_key": "imagine.publish_stale"}, status_code=409)
    revision = imagine.read(state["revision_of"]) if state.get("revision_of") else None
    result = await start_generation(ImagineBody(ink=InkDoc.model_validate(ink), game_id=game["id"] if game else None,
                                     level_id=state.get("level_id"), category=state.get("category"), context=state.get("context", ""),
                                     better_graphics=state.get("better_graphics", False), multiplayer=state.get("multiplayer", False),
                                     title="" if state.get("infer_title") else state.get("title", "")),
                                    revision=revision, conversation=state.get("conversation"), art_source_draft=draft_id,
                                    canvas_updated=state.get("canvas_updated", False))
    if isinstance(result, JSONResponse) and result.status_code == 202:
        state["retried_as"] = json.loads(result.body)["draft_id"]
        imagine.save(draft_id, state)
    return result


def can_publish(draft_id: str, state: dict[str, Any], request: Request, token: str = "") -> bool:
    token_path = imagine.artifact_path(draft_id).with_name("creator.sha256")
    token = token or request.headers.get("X-DP-Draft", "")
    valid_token = bool(token and token_path.is_file() and hmac.compare_digest(
        token_path.read_text(), hashlib.sha256(token.encode()).hexdigest()))
    player = identity.player_from_request(request)
    is_owner = bool(player and state.get("game_id") and members.owner_of(state["game_id"]) == player["id"])
    return valid_token or is_owner


class RefineGameBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(default="", max_length=8000)
    ink: InkDoc | None = None
    multiplayer: bool | None = None
    better_graphics: bool | None = None
    token: str = Field(default="", max_length=200)


@router.post("/imagined-games/{draft_id}/refine", status_code=202)
async def refine(draft_id: str, body: RefineGameBody, request: Request) -> Response:
    state = imagine.read(draft_id)
    if not state:
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    if not can_publish(draft_id, state, request, body.token):
        return JSONResponse({"message_key": "imagine.publish_denied"}, status_code=403)
    message = sanitize.text(body.message, 8000).strip()
    graphics_changed = body.better_graphics is not None and body.better_graphics != state.get("better_graphics", False)
    multiplayer_changed = body.multiplayer is not None and body.multiplayer != state.get("multiplayer", False)
    if not message and body.ink is None and not graphics_changed and not multiplayer_changed:
        return JSONResponse({"message_key": "imagine.prompt_required"}, status_code=400)
    if not message and multiplayer_changed:
        message = "Build this game for two remote human players." if body.multiplayer else "Make this game single player."
    if not message and graphics_changed:
        message = "Improve the graphics with detailed SVG artwork." if body.better_graphics else "Keep the existing game and skip the extra graphics pass."
    message = message or "Apply my canvas changes to the current game."
    updated_ink = body.ink.model_dump(mode="json") if body.ink is not None else None
    if state.get("revised_as"):
        child = imagine.read(state["revised_as"])
        if (child and child.get("context") == message
                and (body.multiplayer is None or body.multiplayer == child.get("multiplayer", False))
                and (body.better_graphics is None or body.better_graphics == child.get("better_graphics", False))
                and bool(child.get("canvas_updated")) == (updated_ink is not None)
                and (updated_ink is None or drafts.read_json(child["draft_id"], "original-ink.json") == updated_ink)):
            return JSONResponse(child, status_code=202)
        return JSONResponse({"message_key": "imagine.publish_stale"}, status_code=409)
    if state["status"] != "ready" or not imagine.artifact_path(draft_id).is_file():
        return JSONResponse({"message_key": "imagine.publish_not_ready"}, status_code=409)
    game = db_v2.get_game(state["game_id"]) if state.get("game_id") else None
    if game and not any(level["draft_id"] == draft_id for level in game["generated_levels"]):
        return JSONResponse({"message_key": "imagine.publish_stale"}, status_code=409)
    ink = updated_ink if updated_ink is not None else drafts.read_json(draft_id, "original-ink.json")
    if ink is None:
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    history = state.get("conversation") or [{"role": "user", "content": state.get("context", "")},
                                             {"role": "assistant", "content": state.get("summary", "")}]
    result = await start_generation(ImagineBody(ink=InkDoc.model_validate(ink), game_id=state.get("game_id"),
        level_id=state.get("level_id"), category=state.get("category"), context=message, title=state.get("title", ""),
        better_graphics=body.better_graphics, multiplayer=body.multiplayer),
        revision=state, conversation=[*history, {"role": "user", "content": message,
            **({"canvas_updated": True} if updated_ink is not None else {})}], canvas_updated=updated_ink is not None)
    if isinstance(result, JSONResponse) and result.status_code == 202:
        state["revised_as"] = json.loads(result.body)["draft_id"]
        imagine.save(draft_id, state)
    return result


@router.get("/imagined-games/{draft_id}")
async def status(draft_id: str, request: Request) -> Response:
    state = imagine.read(draft_id)
    if not state:
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    allowed = can_publish(draft_id, state, request)
    if state["status"] == "building" or state.get("message_key") == "imagine.interrupted":
        if imagine.running(draft_id):
            # The lease also covers jobs owned by another API process.
            state["status"] = "building"
            state.pop("message_key", None)
        elif allowed and imagine.recover(draft_id):
            state = imagine.read(draft_id) or state
        elif state["status"] == "building":
            # Report an orphan without writing over a worker that may just have claimed it.
            state.update(status="failed", message_key="imagine.interrupted")
    return JSONResponse({**state, "can_publish": allowed}, headers={"Cache-Control": "no-store"})


@router.get("/imagined-games/{draft_id}/play")
def play(draft_id: str) -> Response:
    state = imagine.read(draft_id)
    if not state or state["status"] != "ready":
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    path = imagine.artifact_path(draft_id)
    if not path.is_file():
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    return HTMLResponse(path.read_text(), headers={"Content-Security-Policy": imagine.CSP,
                                                  "X-Content-Type-Options": "nosniff",
                                                  "Cache-Control": "no-cache"})


class PublishGameBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(default="", max_length=200)


@router.post("/imagined-games/{draft_id}/publish")
async def publish(draft_id: str, body: PublishGameBody, request: Request) -> Response:
    state = imagine.read(draft_id)
    if not state or not state.get("game_id"):
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    if not can_publish(draft_id, state, request, body.token):
        return JSONResponse({"message_key": "imagine.publish_denied"}, status_code=403)
    if state["status"] != "ready" or not imagine.artifact_path(draft_id).is_file():
        return JSONResponse({"message_key": "imagine.publish_not_ready"}, status_code=409)
    game = db_v2.get_game(state["game_id"])
    if state.get("level_number", 1) > 1 and not (game or {}).get("published_generated"):
        return JSONResponse({"message_key": "imagine.publish_initial"}, status_code=409)
    published = {**state, "publication": "published"}
    if not db_v2.publish_generated_game(state["game_id"], published):
        return JSONResponse({"message_key": "imagine.publish_stale"}, status_code=409)
    imagine.save(draft_id, published)
    return JSONResponse(published)


@router.get("/imagined-games/{draft_id}/inputs")
def inputs(draft_id: str) -> Response:
    state = imagine.read(draft_id)
    ink = drafts.read_json(draft_id, "original-ink.json") if state else None
    if not state or not ink:
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    images = render.drawing_images(ink) if ink.get("strokes") else []
    canvases = [f"/api/v2/imagined-games/{draft_id}/canvas?section={i}" for i in range(len(images))]
    if (ink.get("character") or {}).get("strokes"):
        canvases.append(f"/api/v2/imagined-games/{draft_id}/canvas?character=true")
    return JSONResponse({"prompt": state.get("original_context", state.get("context", "")), "category": state.get("category"), "ink": ink,
                         "canvases": canvases, "multiplayer": state.get("multiplayer", False), "better_graphics": state.get("better_graphics", False)})


@router.get("/imagined-games/{draft_id}/canvas")
def canvas(draft_id: str, section: int = Query(default=0, ge=0), character: bool = False) -> Response:
    state = imagine.read(draft_id)
    ink = drafts.read_json(draft_id, "original-ink.json") if state else None
    if not state or not ink:
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    if character:
        strokes = (ink.get("character") or {}).get("strokes")
        if not strokes:
            return JSONResponse({"message_key": "error.not_found"}, status_code=404)
        return Response(render.moderation_image({**ink, "strokes": strokes}), media_type="image/png")
    if not ink.get("strokes"):
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    images = render.drawing_images(ink)
    if section >= len(images):
        return JSONResponse({"message_key": "error.not_found"}, status_code=404)
    return Response(images[section], media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})
