"""The Studio copilot (CONTRACTS_V6 §5.3): chat, recognize and theme through app.mind.client, with keyword fallbacks.

    chat(body)       StudioChatBody → StudioChatResult    POST /studio/chat
    recognize(body)  RecognizeBody  → RecognizeResult     POST /studio/recognize
    theme(body)      ThemeBody      → ThemeResult         POST /studio/theme

The model sees the catalog (rendered from shared/spec/studio_catalog.json, sent as a cached content block so it
never drifts from the file), the theme presets, the game summary (never raw strokes), the selection, the last turns,
the message and the canvas snapshot. Its output schemas are flat (no free-form dicts): each edit carries `data_json`,
a JSON object string, parsed and validated here by edits.validate_edits (§5.2). Whenever the model cannot answer
(no key, fake mode without a reply, over budget, failed, refused, truncated) the keyword fallback answers with
`source: "keywords"`. Nothing here raises.
"""
from __future__ import annotations

import base64
import binascii
import logging
import re
import time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.mind import budget, client, moderate, sanitize
from app.mind.client import CallSpec, MindResult
from app.mind.messages import say
from app.studio import assets, catalog, fallback
from app.studio.edits import (
    BG_STYLES, FONTS, MUSIC, PARTICLES, STROKE_STYLES, clean_theme, deep_merge, validate_edits,
)
from app.studio.summary import game_summary, nearby, object_text, shape_of

log = logging.getLogger("dal.v6.copilot")

# kind: effort, max_tokens (thinking + output), timeout (§5.3). Registered here so client.py stays untouched.
# v7: generous chat and recognize timeouts (CONTRACTS_V7 §3): a slow good answer beats a fast keyword one
client.CALLS.setdefault("studio_chat", CallSpec("medium", 16000, 150))
client.CALLS.setdefault("studio_recognize", CallSpec("low", 2500, 30))
client.CALLS.setdefault("studio_theme", CallSpec("low", 2000, 12))
budget.ESTIMATE_USD.setdefault("studio_chat", 0.12)
budget.ESTIMATE_USD.setdefault("studio_recognize", 0.04)
budget.ESTIMATE_USD.setdefault("studio_theme", 0.02)

MAX_IMAGE_BYTES = 3_500_000
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
REPLY_CHARS = 360
SUGGESTION_CHARS = 60
HISTORY_TURNS = 20
HISTORY_CHARS = 600

EditActionLit = Literal[
    "set_world", "set_theme", "set_hud", "set_title", "add_scene", "update_object", "delete_object",
    "duplicate_object", "add_behavior", "update_behavior", "remove_behavior", "add_rule", "update_rule", "remove_rule",
    "add_joint", "set_counters", "set_game_counters", "ask_draw",
]


# ---- model-facing schemas (flat; validated and clamped server side) -----------------------------------------------


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FlatEdit(_M):
    action: EditActionLit
    target: str = Field(description="an object id; '@game' or '@scene' for game or scene rules; empty when the action "
                                    "has no target")
    scene: str = Field(description="a scene id; empty = the scene the maker is looking at")
    data_json: str = Field(description="the edit's data as one JSON object, shaped as the edit table says")


class ChatFlat(_M):
    edits: list[FlatEdit] = Field(description="the changes, in order (at most 40); empty for a question or a chat")
    reply: str = Field(description="one or two short, warm sentences in plain words")
    suggestions: list[str] = Field(description="2 to 4 short things the maker could say next")
    art_prompt: str = Field(default="", description="when this reply changes the game's kind, world look or theme, "
                                                    "or the maker asks for a look: the words to restyle all the art "
                                                    "with (\"hill climb racing on the moon\"); else empty")


class RecognizeFlat(_M):
    question: str = Field(description='a short yes/no question, like "Is this a car?"')
    name: str = Field(description='a short name for it, like "Car"')
    kind: str = Field(description="the kind: an archetype kind when one fits, else one plain word")
    edits: list[FlatEdit] = Field(description="what saying yes would change (target the drawing's id)")


class ThemeFlat(_M):
    preset: str = Field(description="a preset id from the list when one fits the words well; empty for a custom theme")
    name: str = Field(description="the theme's name, 1 to 3 words")
    bg: str = Field(description="#rrggbb background colour")
    ink: str = Field(description="#rrggbb main stroke colour, strong contrast with bg")
    accent: str
    accent2: str
    text: str = Field(description="#rrggbb HUD text colour, strong contrast with bg")
    danger: str
    good: str
    background: Literal["paper", "solid", "gradient", "stars", "grid", "city", "hills", "clouds", "neon_grid",
                        "halftone", "waves", "dunes", "forest", "space"]
    background_colors: list[str] = Field(description="1 to 4 #rrggbb colours, back to front")
    stroke: Literal["ink", "marker", "neon", "pixel", "chalk", "comic", "crayon", "watercolor"]
    outline: str = Field(description="#rrggbb outline behind strokes, or empty for none")
    width_scale: float = Field(description="0.5 to 2.5; 1 = as drawn")
    glow: bool
    halftone: bool
    wobble: float = Field(description="0 to 1 hand-drawn jitter")
    recolor: bool = Field(description="map the maker's colours onto the palette")
    particles: Literal["none", "dust", "sparks", "stars", "bubbles", "confetti", "embers", "snow"]
    font: Literal["hand", "comic", "pixel", "clean", "serif"]
    music: Literal["none", "calm", "upbeat", "spooky", "heroic", "chiptune", "racing"]


# ---- shared helpers -----------------------------------------------------------------------------------------------


def decode_png(value: str | None) -> bytes | None:
    """Base64 PNG (or a data: URL) → bytes, or None when absent, broken, not a PNG or too big."""
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    if s.startswith("data:"):
        head, _, s = s.partition(",")
        if "base64" not in head:
            return None
    if len(s) > MAX_IMAGE_BYTES * 4 // 3 + 16:
        return None
    try:
        data = base64.b64decode(s, validate=False)
    except (binascii.Error, ValueError):
        return None
    return data if data.startswith(PNG_MAGIC) else None


def image_block(png: bytes) -> dict[str, Any]:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                        "data": base64.standard_b64encode(png).decode()}}


def catalog_block() -> dict[str, Any]:
    """The catalog and theme presets: the same for every call, so it is cached after the system prompt."""
    return {"type": "text", "text": catalog.render() + "\n\n" + assets.theme_catalog_text(),
            "cache_control": {"type": "ephemeral"}}


def _deadline(kind: str) -> float:
    return time.monotonic() + client.CALLS[kind].timeout_s


async def _call(kind: str, schema: type[BaseModel], content: list[dict[str, Any]]) -> MindResult[Any]:
    try:
        return await client.call(kind, schema, content, draft_id=None, deadline=_deadline(kind))
    except Exception as e:  # noqa: BLE001 - call() never raises; belt and braces
        return MindResult[schema](kind=kind, status="failed", error=type(e).__name__)  # type: ignore[valid-type]


def clean_reply(text: Any, fallback_key: str = "ai.chat.done") -> str:
    t = sanitize.text(text, REPLY_CHARS)
    if not t or moderate.blocklist_hit([t]):
        return say(fallback_key)
    return t


def clean_suggestions(items: Any) -> list[str]:
    out: list[str] = []
    for s in items or []:
        t = sanitize.text(s, SUGGESTION_CHARS)
        if t and not moderate.blocklist_hit([t]) and t not in out:
            out.append(t)
    return out[:4]


def _flat_edits(edits: list[FlatEdit]) -> list[dict[str, Any]]:
    return [{"action": e.action, "target": e.target or None, "scene": e.scene or None, "data": e.data_json}
            for e in edits]


def _scene_id(doc: dict[str, Any], scene: str) -> str:
    ids = [str(s.get("id")) for s in doc.get("scenes") or []]
    return scene if scene in ids else (ids[0] if ids else "s1")


# ---- chat ---------------------------------------------------------------------------------------------------------


def chat_content(doc: dict[str, Any], scene: str, selection: list[str], message: str,
                 history: list[dict[str, Any]], snapshot: bytes | None) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [catalog_block()]
    if snapshot is not None:
        content.append({"type": "text", "text": "The canvas right now (what the maker sees):"})
        content.append(image_block(snapshot))
    turns = []
    for t in history[-HISTORY_TURNS:]:
        who = "Maker" if t.get("role") == "user" else "You"
        turns.append(f"{who}: {sanitize.text(t.get('text'), HISTORY_CHARS)}")
    text = game_summary(doc, scene, selection)
    text += "\n\nCONVERSATION SO FAR:\n" + ("\n".join(turns) if turns else "(this is the first message)")
    text += f"\n\nTHE MAKER SAYS: {sanitize.text(message, 2000)}"
    text += ("\n\nAnswer with edits from the edit table (data_json = one JSON object), a short warm reply and "
             "2-4 suggestions.")
    content.append({"type": "text", "text": text})
    return content


async def chat(body: dict[str, Any]) -> dict[str, Any]:
    """StudioChatResult for a validated StudioChatBody dict."""
    doc = body["game"]
    scene = _scene_id(doc, str(body.get("scene") or ""))
    selection = [str(s) for s in body.get("selection") or []]
    message = str(body.get("message") or "")
    if moderate.blocklist_hit([message]):
        return {"reply": say("ai.chat.blocked"), "edits": [], "suggestions": clean_suggestions(
            [say("ai.sug.rephrase.1"), say("ai.sug.rephrase.2")]), "source": "keywords"}
    if client.available():
        content = chat_content(doc, scene, selection, message, list(body.get("history") or []),
                               decode_png(body.get("snapshot_png")))
        r = await _call("studio_chat", ChatFlat, content)
        if r.ok and r.value is not None:
            edits, warnings = validate_edits(_flat_edits(r.value.edits), doc, scene)
            if warnings:
                log.info("studio_chat: %d edits kept, dropped/fixed: %s", len(edits), "; ".join(warnings[:8]))
            reply = clean_reply(r.value.reply, "ai.chat.done" if edits else "ai.chat.nothing")
            art = clean_art_prompt(r.value.art_prompt) or derive_art_prompt(message, edits, doc, scene)
            return {"reply": reply, "edits": edits, "suggestions": clean_suggestions(r.value.suggestions),
                    "source": "model", "art_prompt": art}
        log.info("studio_chat: model path unavailable (%s %s); keywords", r.status, r.error or r.stop_reason or "")
        return honest(keyword_chat(doc, scene, selection, message), chat_error(r))
    return {**keyword_chat(doc, scene, selection, message), "error": "off"}


def chat_error(r: MindResult[Any]) -> str:
    """Why the model path gave nothing: timeout | budget | off | failed."""
    if r.status == "skipped":
        return "budget" if r.error == "budget" else ("timeout" if r.error == "deadline" else "off")
    if r.status == "failed" and "timeout" in (r.error or "").lower():
        return "timeout"
    return "failed"


def honest(res: dict[str, Any], error: str) -> dict[str, Any]:
    """The keyword answer, told honestly: what went wrong, and that only the simple part was done."""
    key = {"timeout": "timeout", "budget": "budget"}.get(error, "failed")
    if res["edits"]:
        reply = say(f"ai.chat.err.{key}_partial") + " " + res["reply"]
    else:
        reply = say(f"ai.chat.err.{key}")
    return {**res, "reply": clean_reply(reply), "error": error}


ART_CHARS = 300
LOOK_WORDS = re.compile(
    r"\b(look|looks|looking|style|styled|theme|themed|vibe|aesthetic|art|artwork|graphics|visuals|pretty|beautiful|"
    r"realistic|make it real|in space|on the moon|on mars|underwater|under water|candy|neon|spooky|halloween|pixel|"
    r"cartoon|anime|comic|land|planet|jungle|desert|winter|snowy|lava|volcano|cyberpunk|futuristic|retro|medieval|"
    r"pirate|ocean|forest|reimagine|re-imagine)\b")


def clean_art_prompt(v: Any) -> str | None:
    t = sanitize.text(v, ART_CHARS)
    return t if t and not moderate.blocklist_hit([t]) else None


def derive_art_prompt(message: str, edits: list[dict[str, Any]], doc: dict[str, Any], scene: str) -> str | None:
    """The restyle words when the reply changed the game's kind or theme, or the maker asked for a look."""
    text = re.sub(r"\s+", " ", str(message or "")).strip()
    asked = LOOK_WORDS.search(text.lower()) is not None
    sc = next((x for x in doc.get("scenes") or [] if x.get("id") == scene), {})
    old_kind = str((sc.get("world") or {}).get("kind") or "")
    new_kind = next((str(e["data"]["kind"]) for e in edits if e.get("action") == "set_world"
                     and isinstance(e.get("data"), dict) and e["data"].get("kind")
                     and str(e["data"]["kind"]) != old_kind), "")
    theme = next((e.get("data") or {} for e in edits if e.get("action") == "set_theme"), None)
    if asked:
        return clean_art_prompt(text)
    if not new_kind and theme is None:
        return None
    bits = [new_kind or old_kind]
    if theme is not None:
        name = theme.get("name") or (assets.theme_by_id(str(theme.get("preset") or "")) or {}).get("name")
        if name:
            bits.append(f"{name} style")
    return clean_art_prompt(", ".join(b for b in bits if b)) or None


def keyword_chat(doc: dict[str, Any], scene: str, selection: list[str], message: str) -> dict[str, Any]:
    out = fallback.chat(doc, scene, selection, message)
    edits, _ = validate_edits(out["edits"], doc, scene)
    reply = out["reply"] if edits or not out["edits"] else say("ai.kw.rephrase")
    return {"reply": clean_reply(reply), "edits": edits, "suggestions": clean_suggestions(out["suggestions"]),
            "source": "keywords", "art_prompt": derive_art_prompt(message, edits, doc, scene)}


# ---- recognize ----------------------------------------------------------------------------------------------------


def recognize_content(doc: dict[str, Any], scene: str, object_id: str, png: bytes | None) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [catalog_block()]
    if png is not None:
        content.append({"type": "text", "text": "The new drawing, alone:"})
        content.append(image_block(png))
    sc = next((s for s in doc.get("scenes") or [] if s.get("id") == scene), {})
    obj = next((o for o in sc.get("objects") or [] if o.get("id") == object_id), None)
    lines = [game_summary(doc, scene, [object_id]), "", f"THE NEW DRAWING: {object_id}"]
    if obj is not None:
        lines.append(object_text(obj))
        near = nearby(doc, scene, object_id)
        if near:
            lines.append("Near it:")
            for o, gap in near:
                sh = shape_of(o)
                dx, dy = float(o.get("x", 0)) - float(obj.get("x", 0)), float(o.get("y", 0)) - float(obj.get("y", 0))
                lines.append(f"- {o.get('id')} kind={o.get('kind', 'thing')} {sh.describe()} "
                             f"{round(sh.w)}x{round(sh.h)}, offset ({round(dx)},{round(dy)}), gap {round(gap)}px")
        else:
            lines.append("Nothing is near it.")
    lines.append("\nGuess what it is in this game and what saying yes would set up.")
    content.append({"type": "text", "text": "\n".join(lines)})
    return content


async def recognize(body: dict[str, Any]) -> dict[str, Any]:
    """RecognizeResult for a validated RecognizeBody dict (the object exists in the scene)."""
    doc = body["game"]
    scene = _scene_id(doc, str(body.get("scene") or ""))
    oid = str(body.get("object_id"))
    if client.available():
        r = await _call("studio_recognize", RecognizeFlat, recognize_content(doc, scene, oid,
                                                                             decode_png(body.get("image_png"))))
        if r.ok and r.value is not None:
            v: RecognizeFlat = r.value
            edits, _ = validate_edits(_flat_edits(v.edits), doc, scene)
            kind = catalog.clean_name(v.kind) or "thing"
            name = catalog.safe_text(v.name, 32) or kind.capitalize()
            question = catalog.safe_text(v.question, 120) or say("ai.recognize.is_it", {"what": f"a {kind}"})
            return {"question": question, "name": name, "kind": kind[:24], "edits": edits, "source": "model"}
        log.info("studio_recognize: model path unavailable (%s); keywords", r.status)
    return {**fallback.recognize(), "source": "keywords"}


# ---- theme --------------------------------------------------------------------------------------------------------


def _lum(hex_: str) -> float:
    def ch(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a: str, b: str) -> float:
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def fix_contrast(theme: dict[str, Any]) -> dict[str, Any]:
    """ink and text keep at least 4.5:1 against bg (near-black or near-white when the model picked badly)."""
    pal = theme.get("palette") or {}
    bg = pal.get("bg")
    if not bg:
        return theme
    for k in ("ink", "text"):
        c = pal.get(k)
        if not c or contrast(c, bg) < 4.5:
            pal[k] = "#1f1b18" if _lum(bg) > 0.18 else "#f5f3ff"
    theme["palette"] = pal
    return theme


def theme_from_flat(v: ThemeFlat) -> dict[str, Any] | None:
    if v.preset:
        base = assets.theme_by_id(v.preset)
        if base is not None:
            return base
    raw = {
        "name": v.name,
        "palette": {k: getattr(v, k) for k in ("bg", "ink", "accent", "accent2", "text", "danger", "good")},
        "background": {"style": v.background, "colors": v.background_colors, "parallax": True},
        "stroke": {"style": v.stroke, "outline": v.outline or None, "width_scale": v.width_scale, "glow": v.glow,
                   "fill_closed": True, "halftone": v.halftone, "wobble": v.wobble},
        "recolor": v.recolor, "particles": v.particles, "font": v.font, "music": v.music,
    }
    partial = clean_theme(raw)
    if not partial or "palette" not in partial or "bg" not in partial["palette"]:
        return None
    full = deep_merge(assets.sketchbook(), partial)
    full["id"] = None
    full["name"] = partial.get("name") or "My theme"
    if not (full.get("background") or {}).get("colors"):
        full["background"]["colors"] = [full["palette"]["bg"]]
    return fix_contrast(full)


async def theme(body: dict[str, Any]) -> dict[str, Any]:
    """ThemeResult for a validated ThemeBody dict."""
    text = str(body.get("text") or "")
    game_kind = body.get("game_kind")
    if not moderate.blocklist_hit([text]) and client.available():
        content = [{"type": "text", "text": (
            assets.theme_catalog_text() + "\n\nStroke styles: " + ", ".join(STROKE_STYLES) + "\nBackgrounds: "
            + ", ".join(BG_STYLES) + "\nParticles: " + ", ".join(PARTICLES) + "\nFonts: " + ", ".join(FONTS)
            + "\nMusic: " + ", ".join(MUSIC)
            + (f"\n\nThe game is a {sanitize.text(game_kind, 60)}." if game_kind else "")
            + f"\n\nTHE MAKER WANTS: {sanitize.text(text, 300)}")}]
        r = await _call("studio_theme", ThemeFlat, content)
        if r.ok and r.value is not None:
            t = theme_from_flat(r.value)
            if t is not None:
                return {"theme": t, "source": "model"}
        log.info("studio_theme: model path unavailable (%s); keywords", r.status)
    return {"theme": fix_contrast(fallback.theme(text, game_kind)), "source": "keywords"}

