"""Whole-canvas game generation with a dedicated art pass and packaged image assets."""
from __future__ import annotations

import asyncio
import base64
import fcntl
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Literal, TextIO

from pydantic import BaseModel, ConfigDict, Field

from app import db_v2
from app.build import drafts
from app.config import get_settings
from app.creative import imagine_assets
from app.mind import budget, client, render, sanitize

GENERATION_TIMEOUT_S = 360
MAX_RESUMES = 2
RESUME_WINDOW_S = 3600
client.CALLS["imagine"] = client.CallSpec("medium", 18000, GENERATION_TIMEOUT_S)
budget.ESTIMATE_USD.setdefault("imagine", 0.28)
TASKS: dict[str, asyncio.Task[Any]] = {}
log = logging.getLogger("dal.v2.imagine")

# The response itself is sandboxed even when its URL is opened outside our iframe.
CSP = ("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
       "img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; "
       "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")


class GameSuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=60)
    description: str = Field(min_length=1, max_length=180)
    prompt: str = Field(min_length=1, max_length=800)
    kind: Literal["mechanic", "world", "feel"]


class MultiplayerAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Literal["left", "right", "up", "down", "jump", "attack", "special", "block", "confirm"]
    label: str = Field(min_length=1, max_length=24)


class MultiplayerSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    mode: Literal["versus", "cooperative"]
    actions: list[MultiplayerAction] = Field(min_length=1, max_length=9)


class ImaginedGame(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    summary: str
    controls: list[str]
    html: str
    multiplayer_spec: MultiplayerSpec | None = None
    changes: list[str] = Field(default_factory=list, max_length=5)
    suggestions: list[GameSuggestion] = Field(default_factory=list, max_length=3)


def content_for(ink: dict[str, Any], game: dict[str, Any] | None, context: str, title: str) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    for index, image in enumerate(render.drawing_images(ink) if ink.get("strokes") else []):
        content.extend([{"type": "text", "text": f"Author canvas, part {index + 1} (read the full scene):"},
                        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                    "data": base64.b64encode(image).decode()}}])
    character = (ink.get("character") or {}).get("strokes") or []
    if character:
        image = render.moderation_image({**ink, "strokes": character})
        content.extend([{"type": "text", "text": "The author's separate character sketch:"},
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                    "data": base64.b64encode(image).decode()}}])
    written = {
        "level_context": (game or {}).get("level_context"),
        "revision_context": (game or {}).get("revision_context"),
        "title": title or None, "game_brief": (game or {}).get("brief"),
        "author_instructions": context,
        "canvas_context": {"world": ink.get("world"), "stroke_count": len(ink.get("strokes") or []),
                           "colors": sorted({stroke.get("color", "black") for stroke in ink.get("strokes") or []})},
        "canvas_notes": [r.get("text") for r in ink.get("typed_rules") or []],
        "character_notes": (ink.get("character") or {}).get("description"),
        "reference_suggestions": ((game or {}).get("rules") or {}).get("guidance"),
        "author_annotations": [{"stroke_id": s.get("id"), "points": s.get("pts"),
                                "label": s.get("label"), "behavior": s.get("rule")}
                               for s in ink.get("strokes") or [] if s.get("label") or s.get("rule")],
    }
    content.append({"type": "text", "text": "FULL AUTHOR CONTEXT\n" + json.dumps(written, ensure_ascii=False) +
                    "\nReference suggestions are optional template defaults, not author requirements. "
                    "Infer the title, world, characters, graphics, controls, mechanics and difficulty from the category and prompt. Any attached sketch is optional creative guidance. Invent a finished world and implement the real game."})
    if (game or {}).get("revision_context"):
        content.append({"type": "text", "text": "Revise the EXISTING playable game in revision_context.html according to the latest request. Preserve all features, art, characters, controls and previous changes unless the author asks to change them. Use conversation for context. Return the complete updated standalone HTML. The summary should briefly explain the changes you actually made."})
        if game["revision_context"].get("canvas_updated"):
            content.append({"type": "text", "text": "The attached canvas is the author's UPDATED sketch for this revision. Compare it with revision_context.previous_canvas to apply added, moved, recolored or removed shapes, character edits, and changed notes to the current game. The updated sketch and latest message take priority over earlier canvas instructions. Preserve unrelated mechanics and previous changes. An empty updated canvas can intentionally remove earlier sketch guidance."})
    elif (game or {}).get("level_context"):
        content.append({"type": "text", "text": "Create the next level of this SAME game. Preserve its characters, art style, core mechanics and controls from level_context.html. Use the new prompt and drawing to create a distinct layout, goal and challenge. Return a complete standalone playable level, not a replacement for Level 1."})
    return content


def check_html(html: str) -> str:
    # This validates a complete code artifact; the CSP and opaque-origin iframe isolate its execution.
    html = html.strip()
    if len(html) < 1000 or len(html) > 300_000 or not re.search(r"<script\b", html, re.I):
        raise ValueError("incomplete_game")
    if not re.search(r"</html\s*>", html, re.I):
        raise ValueError("incomplete_game")
    return html


def read(draft_id: str) -> dict[str, Any] | None:
    if not drafts.DRAFT_RE.match(draft_id):
        return None
    return drafts.read_json(draft_id, "imagined.json")


def save(draft_id: str, state: dict[str, Any]) -> None:
    state["updated_at"] = time.time()
    drafts.write_json(draft_id, "imagined.json", state)


def artifact_path(draft_id: str) -> Path:
    # Keep executable model output outside the application's public uploads mount.
    if not drafts.DRAFT_RE.match(draft_id):
        raise ValueError("draft_id")
    return get_settings().data_dir / "generated-games" / draft_id / "game.html"


def thumbnail_path(draft_id: str) -> Path:
    return artifact_path(draft_id).with_name("thumbnail.png")


def with_thumbnail(state: dict[str, Any] | None) -> dict[str, Any] | None:
    """A generated game's status plus its first-frame picture once a player's browser has captured it."""
    if not state or not state.get("draft_id"):
        return state
    try:
        path = thumbnail_path(state["draft_id"])
        url = f"/api/v2/imagined-games/{state['draft_id']}/thumbnail?v={int(path.stat().st_mtime)}" if path.is_file() else None
    except (OSError, ValueError):
        url = None
    return {**state, "thumbnail_url": url}


# Served only with ?capture=1: posts the game's first drawn frame to the embedding page, which uploads it as the
# thumbnail. It waits for a canvas with more than one color, so a blank or solid loading screen is never kept, and it
# never relies on requestAnimationFrame (browsers pause that in frames the player cannot see).
CAPTURE_SCRIPT = """<script id="draw-play-capture">(function(){
var tries=0,TRIES=20;
function pick(){var best=null;document.querySelectorAll('canvas').forEach(function(c){
if(c.width*c.height>0&&(!best||c.width*c.height>best.width*best.height))best=c;});return best;}
function post(png){parent.postMessage({type:'draw-play:thumbnail',png:png},'*');}
function grab(){tries++;var c=pick();if(c){try{
var s=Math.min(1,640/c.width,480/c.height),o=document.createElement('canvas');
o.width=Math.max(1,Math.round(c.width*s));o.height=Math.max(1,Math.round(c.height*s));
var x=o.getContext('2d');x.drawImage(c,0,0,o.width,o.height);
var d=x.getImageData(0,0,o.width,o.height).data,first=d[0]+','+d[1]+','+d[2]+','+d[3];
for(var i=0;i<d.length;i+=4*97){if(d[i]+','+d[i+1]+','+d[i+2]+','+d[i+3]!==first)return post(o.toDataURL('image/png'));}
}catch(e){return post(null);}}if(tries<TRIES)setTimeout(grab,400);else post(null);}
function start(){setTimeout(grab,700);}
if(document.readyState==='complete')start();else addEventListener('load',start);
})();</script>"""


def with_capture(html: str) -> str:
    at = html.lower().rfind("</body>")
    return html + CAPTURE_SCRIPT if at < 0 else html[:at] + CAPTURE_SCRIPT + html[at:]


async def generate(draft_id: str, ink: dict[str, Any], game: dict[str, Any] | None,
                   context: str, title: str) -> None:
    state = read(draft_id) or {}
    last_progress = 0.0

    async def progress(characters: int) -> None:
        nonlocal last_progress
        now = time.monotonic()
        if now - last_progress < 2:
            return
        last_progress = now
        state.update(phase="writing", output_chars=characters)
        save(draft_id, state)

    async def art_progress(done: int, total: int) -> None:
        state.update(phase="painting", assets_done=done, assets_total=total)
        save(draft_id, state)

    try:
        state.update(status="building", phase="designing", started_at=time.time(), timeout_s=GENERATION_TIMEOUT_S)
        state.pop("message_key", None)
        save(draft_id, state)
        async with asyncio.timeout(GENERATION_TIMEOUT_S + 5):
            deadline = time.monotonic() + GENERATION_TIMEOUT_S
            content = content_for(ink, game, context, title)
            content[-1]["text"] += "\n" + (
                "GRAPHICS SETTING: Better graphics selected. Use the dedicated SVG art pack when supplied; "
                "match its camera, proportions, materials and animation."
                if state.get("better_graphics", False) else
                "GRAPHICS SETTING: Standard graphics. Draw new visuals directly in Canvas. "
                "Do not create a separate SVG asset pack. Preserve supplied artwork on revisions and new levels.")
            if state.get("multiplayer"):
                content.append({"type": "text", "text": (Path(__file__).parents[1] / "mind/prompts/multiplayer.md").read_text()})
            else:
                content.append({"type": "text", "text": "MULTIPLAYER OFF: Generate a single-player game. Return multiplayer_spec=null."})
            source = state.get("art_source_draft") or state.get("revision_of") or state.get("base_draft_id")
            pack = {**imagine_assets.read_pack(source), "cost_usd": 0}
            try:
                if state.get("better_graphics", False):
                    state.update(phase="painting")
                    save(draft_id, state)
                    async with asyncio.timeout(imagine_assets.ART_TIMEOUT_S):
                        pack = await imagine_assets.build(draft_id, content, source_draft=source,
                                                           deadline=time.monotonic() + imagine_assets.ART_TIMEOUT_S,
                                                           progress=art_progress, provider="claude-svg", use_library=False)
            except Exception as error:
                # Recover assets completed before a timeout; art trouble must not strand the game.
                partial = imagine_assets.read_pack(draft_id)
                pack = partial if partial.get("assets") else {**pack, "cost_usd": partial.get("cost_usd", 0)}
                log.info("art pass for %s unavailable: %s", draft_id, type(error).__name__)
            if pack.get("assets"):
                imagine_assets.save_pack(draft_id, pack)
                content.append(imagine_assets.instructions(pack))
            state.update(phase="designing", art={"provider": pack.get("provider", "procedural"),
                                                 "asset_count": len(pack.get("assets", []))})
            save(draft_id, state)
            result = await client.call("imagine", ImaginedGame, content,
                                       draft_id=None, deadline=deadline,
                                       model=os.environ.get("DAL_SONNET_MODEL") or "claude-sonnet-5-5",
                                       on_progress=progress)
        if not result.ok or result.value is None:
            # Provider details are for operators, never the public status response.
            diagnostic = artifact_path(draft_id).with_name("failure.json")
            diagnostic.parent.mkdir(parents=True, exist_ok=True)
            diagnostic.write_text(json.dumps({"status": result.status, "error": result.error,
                                              "latency_s": result.latency_s,
                                              "stop_reason": result.stop_reason}))
            log.warning("game generation %s failed after %.1fs: %s", draft_id, result.latency_s,
                        result.error or result.stop_reason or result.status)
            key = ("imagine.no_key" if result.error == "no_key" else
                   "imagine.budget" if result.error == "budget" else
                   "imagine.refused" if result.status == "refused" else
                   "imagine.timeout" if "timeout" in (result.error or "").lower() or "timed out" in (result.error or "").lower()
                   else "imagine.failed")
            state.update(status="failed", message_key=key)
        else:
            output = result.value
            html = check_html(output.html)
            if state.get("multiplayer"):
                if output.multiplayer_spec is None or "drawPlayMultiplayer" not in html:
                    raise ValueError("missing_multiplayer_adapter")
                if len({action.id for action in output.multiplayer_spec.actions}) != len(output.multiplayer_spec.actions):
                    raise ValueError("duplicate_multiplayer_actions")
                state["multiplayer_spec"] = output.multiplayer_spec.model_dump(mode="json")
            html = imagine_assets.inject(html, pack)
            path = artifact_path(draft_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(html)
            history = state.get("conversation") or [{"role": "user", "content": context}]
            changes = [sanitize.text(change, 160) for change in output.changes if change.strip()]
            suggestions = [{**suggestion.model_dump(),
                            "title": sanitize.text(suggestion.title, 60),
                            "description": sanitize.text(suggestion.description, 180),
                            "prompt": sanitize.text(suggestion.prompt, 800)} for suggestion in output.suggestions]
            state["conversation"] = [*history, {"role": "assistant", "content": sanitize.text(output.summary, 1600),
                                                **({"changes": changes} if changes else {}),
                                                **({"suggestions": suggestions} if suggestions else {})}]
            state.update(status="ready", title=sanitize.text(output.title, 80),
                         summary=sanitize.text(output.summary, 1600),
                         changes=changes, suggestions=suggestions,
                         controls=[sanitize.text(c, 150) for c in output.controls[:10]],
                         play_url=f"/api/v2/imagined-games/{draft_id}/play",
                         model=result.served_by, cost_usd=result.cost_usd + float(pack.get("cost_usd", 0)))
        save(draft_id, state)
    except TimeoutError:
        state.update(status="failed", message_key="imagine.timeout")
        save(draft_id, state)
    except asyncio.CancelledError:
        # A dev reload cancels in-flight tasks. Leave the saved job resumable.
        state.update(status="building", interrupted_at=time.time())
        save(draft_id, state)
        raise
    except Exception:
        state.update(status="failed", message_key="imagine.failed")
        save(draft_id, state)
    finally:
        try:
            if game and game.get("id"):
                db_v2.set_generated_game(game["id"], state, expected_draft=draft_id)
        finally:
            TASKS.pop(draft_id, None)


def _claim(draft_id: str) -> TextIO | None:
    """An OS-held lease survives requests and releases even when a worker crashes."""
    path = artifact_path(draft_id).with_name("generation.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    lease = path.open("a+")
    try:
        fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lease.close()
        return None
    return lease


def running(draft_id: str) -> bool:
    task = TASKS.get(draft_id)
    if task is not None and not task.done():
        return True
    lease = _claim(draft_id)
    if lease is None:
        return True  # A different API process owns the job.
    lease.close()
    return False


def _launch(draft_id: str, ink: dict[str, Any], game: dict[str, Any] | None,
            context: str, title: str, lease: TextIO) -> None:
    def finished(task: asyncio.Task[Any]) -> None:
        if TASKS.get(draft_id) is task:
            TASKS.pop(draft_id, None)
        lease.close()

    try:
        loop = asyncio.get_running_loop()
        task = loop.create_task(generate(draft_id, ink, game, context, title), name=f"imagine {draft_id}")
        TASKS[draft_id] = task
        task.add_done_callback(finished)
    except BaseException:
        lease.close()
        raise


def start(draft_id: str, ink: dict[str, Any], game: dict[str, Any] | None, context: str, title: str) -> bool:
    lease = _claim(draft_id)
    if lease is None:
        return False
    try:
        # Keep the exact model context outside the public uploads mount, including prior HTML.
        request = {"ink": ink, "game": game, "context": context, "title": title}
        drafts._atomic_write(artifact_path(draft_id).with_name("generation-request.json"), json.dumps(request))
    except BaseException:
        lease.close()
        raise
    _launch(draft_id, ink, game, context, title, lease)
    return True


def _saved_request(draft_id: str, state: dict[str, Any]) -> dict[str, Any] | None:
    path = artifact_path(draft_id).with_name("generation-request.json")
    if path.is_file():
        return json.loads(path.read_text())
    # Older drafts predate durable jobs; recover from their original saved input.
    ink = drafts.read_json(draft_id, "original-ink.json")
    if ink is None:
        return None
    game = db_v2.get_game(state["game_id"]) if state.get("game_id") else None
    if state.get("category"):
        game = {**(game or {}), "brief": {**((game or {}).get("brief") or {}), "category": state["category"]}}
    for field, name in (("revision_of", "revision_context"), ("base_draft_id", "level_context")):
        source = state.get(field)
        previous = read(source) if source else None
        if not previous or not artifact_path(source).is_file():
            if field == "revision_of" and source:
                return None
            continue
        game = {**(game or {}), name: {
            "html": imagine_assets.strip_runtime(artifact_path(source).read_text()),
            "summary": previous.get("summary"), "controls": previous.get("controls"),
            "conversation": state.get("conversation"), "request": state.get("context", ""),
            "level_number": state.get("level_number"), "original_title": previous.get("title")}}
        if field == "revision_of" and state.get("canvas_updated"):
            game[name].update(canvas_updated=True, previous_canvas=drafts.read_json(source, "original-ink.json"))
    return {"ink": ink, "game": game, "context": state.get("context", ""),
            "title": "" if state.get("infer_title") else state.get("title", "")}


def recover(draft_id: str) -> bool:
    """Resume a recently interrupted job once per process-independent lease."""
    lease = _claim(draft_id)
    if lease is None:
        return True
    try:
        state = read(draft_id)
        if not state or state.get("retried_as") or state.get("revised_as"):
            return False
        if state.get("status") != "building" and state.get("message_key") != "imagine.interrupted":
            return False
        if state.get("resume_count", 0) >= MAX_RESUMES or time.time() - state.get("updated_at", 0) > RESUME_WINDOW_S:
            return False
        game = db_v2.get_game(state["game_id"]) if state.get("game_id") else None
        if game and state.get("level_id") and not any(level["draft_id"] == draft_id for level in game["generated_levels"]):
            return False
        request = _saved_request(draft_id, state)
        if request is None:
            return False
        state.update(status="building", phase="designing", resume_count=state.get("resume_count", 0) + 1,
                     started_at=time.time(), resumed_at=time.time())
        state.pop("message_key", None)
        save(draft_id, state)
        if state.get("game_id"):
            db_v2.set_generated_game(state["game_id"], state, expected_draft=draft_id)
        drafts._atomic_write(artifact_path(draft_id).with_name("generation-request.json"), json.dumps(request))
        _launch(draft_id, **request, lease=lease)
        lease = None  # The background task owns it until completion or cancellation.
        return True
    except Exception:
        log.exception("could not resume game %s", draft_id)
        return False
    finally:
        if lease is not None:
            lease.close()
