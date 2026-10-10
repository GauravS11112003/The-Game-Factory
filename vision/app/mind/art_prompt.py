"""ART calls (v3, docs/v3/CONTRACTS_V3.md "Creative API"): the model side of "Bring to life".

    art_prompt(crop, hint, style_text)  → ArtIdea {label, role_guess, prompt, negative_prompt}   (Firefly path)
    art_svg(crop, ...)                  → SvgArt {label, svg}                                       (claude-svg path)
    art_backdrop(theme, ...)            → SvgArt {label, svg}                                       (claude-svg backdrop)

All go through app.mind.client.call (effort low, structured output, never raises) with draft_id=None: art has its own
daily budget (DAL_ART_BUDGET_USD, app.creative.jobs) and must not eat a draft's $0.40. The call kinds are registered
here (client.CALLS / budget.ESTIMATE_USD) so client.py stays untouched; the system prompts are prompts/art_*.md.

Offline (no key, fake mode without a reply, over budget, refused) `art_prompt` falls back to a template built from the
hint, so Firefly still gets a sensible prompt; the SVG calls simply return no value.
"""
from __future__ import annotations

import base64
import time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from app.mind import budget, client, sanitize
from app.mind.client import CallSpec, MindResult

# kinds: effort, max_tokens (caps thinking + output), timeout
client.CALLS.setdefault("art_prompt", CallSpec("low", 2000, 20))
client.CALLS.setdefault("art_svg", CallSpec("low", 16000, 90))
client.CALLS.setdefault("art_backdrop", CallSpec("low", 16000, 90))
budget.ESTIMATE_USD.setdefault("art_prompt", 0.02)
budget.ESTIMATE_USD.setdefault("art_svg", 0.12)
budget.ESTIMATE_USD.setdefault("art_backdrop", 0.15)

RoleGuess = Literal["player", "enemy", "platform", "hazard", "coin", "key", "door", "goal", "spring", "decoration",
                    "unknown"]
ROLE_GUESSES: tuple[str, ...] = ("player", "enemy", "platform", "hazard", "coin", "key", "door", "goal", "spring",
                                 "decoration", "unknown")
LABEL_CHARS = 32
PROMPT_CHARS = 600
SPRITE_SUFFIX = "single object on a plain white background, 2D game sprite, side view"
DEFAULT_NEGATIVE = ("text, letters, watermark, signature, frame, border, multiple objects, scenery, landscape, "
                    "ground shadow, cropped, photo, realistic photograph")

# a role chip (or a word a kid types) → (role_guess, a noun Firefly understands)
_HINT_ROLES: dict[str, tuple[str, str]] = {
    "player": ("player", "hero character"), "hero": ("player", "hero character"), "me": ("player", "hero character"),
    "enemy": ("enemy", "cute monster"), "monster": ("enemy", "cute monster"), "creature": ("enemy", "cute creature"),
    "platform": ("platform", "floating stone platform"), "ground": ("platform", "grassy ground block"),
    "wall": ("platform", "brick wall block"), "ceiling": ("platform", "stone ceiling block"),
    "spikes": ("hazard", "row of sharp spikes"), "lava": ("hazard", "bubbling lava pool"),
    "saw": ("hazard", "spinning saw blade"), "hazard": ("hazard", "dangerous trap"),
    "coin": ("coin", "shiny gold coin"), "big_coin": ("coin", "big shiny gold star coin"),
    "key": ("key", "golden key"), "door": ("door", "wooden door"), "goal": ("goal", "finish flag on a pole"),
    "flag": ("goal", "finish flag on a pole"), "spring": ("spring", "bouncy spring"),
    "checkpoint": ("goal", "checkpoint flag"), "decoration": ("decoration", "decoration"),
}


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ArtIdea(_M):
    label: str
    role_guess: RoleGuess
    prompt: str
    negative_prompt: str


class SvgArt(_M):
    label: str
    svg: str


def _image_block(png: bytes) -> dict[str, Any]:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                        "data": base64.standard_b64encode(png).decode()}}


def _hint_role(hint: str) -> tuple[str, str] | None:
    h = (hint or "").strip().lower().replace(" ", "_")
    return _HINT_ROLES.get(h)


def fallback_idea(hint: str | None, style_text: str | None) -> dict[str, Any]:
    """The template idea when the model cannot answer: the hint names the object, the style text styles it."""
    h = sanitize.text(hint, LABEL_CHARS)
    hr = _hint_role(h)
    if hr is not None:
        role, noun = hr
        label = noun
    else:
        role, noun = "unknown", h or "friendly game object"
        label = h or "my drawing"
    style = sanitize.text(style_text, 200) or "bright, friendly cartoon style, bold outlines, flat colours"
    return {"label": sanitize.text(label, LABEL_CHARS), "role_guess": role,
            "prompt": compose_prompt(f"a {noun}, shaped exactly like the drawing", style),
            "negative_prompt": DEFAULT_NEGATIVE, "source": "template"}


def compose_prompt(prompt: str, style_text: str | None) -> str:
    """The model's (or template's) object prompt + the game style + the contract's sprite suffix, once."""
    p = sanitize.text(prompt, PROMPT_CHARS).rstrip(". ")
    st = sanitize.text(style_text, 200)
    parts = [p]
    if st and st.lower() not in p.lower():
        parts.append(st)
    if "white background" not in p.lower():
        parts.append(SPRITE_SUFFIX)
    return ", ".join(x for x in parts if x)[:1000]


async def art_prompt(crop_png: bytes, *, hint: str | None, style_text: str | None,
                     deadline: float | None = None) -> tuple[dict[str, Any], MindResult[Any] | None]:
    """{label, role_guess, prompt, negative_prompt, source: model|template} and the MindResult (for the ledger).
    Never raises."""
    if not client.available():
        return fallback_idea(hint, style_text), None
    content = [_image_block(crop_png), {"type": "text", "text": (
        f"Hint from the child: {sanitize.text(hint, 60) or '(none)'}\n"
        f"Game style: {sanitize.text(style_text, 300) or '(none: bright, friendly cartoon)'}\n"
        "The child's drawing of ONE game object is attached. Name it and write the Firefly prompt.")}]
    dl = deadline if deadline is not None else time.monotonic() + client.CALLS["art_prompt"].timeout_s
    try:
        r = await client.call("art_prompt", ArtIdea, content, draft_id=None, deadline=dl)
    except Exception:  # noqa: BLE001 - call() never raises; belt and braces
        return fallback_idea(hint, style_text), None
    if not r.ok or r.value is None:
        return fallback_idea(hint, style_text), r
    v = r.value
    fb = fallback_idea(hint, style_text)
    role = v.role_guess if v.role_guess in ROLE_GUESSES else "unknown"
    hr = _hint_role(hint or "")
    if hr is not None:  # a role chip the kid picked wins over the model's guess
        role = hr[0]
    idea = {
        "label": sanitize.text(v.label, LABEL_CHARS) or fb["label"],
        "role_guess": role,
        "prompt": compose_prompt(v.prompt, style_text) if sanitize.text(v.prompt, 10) else fb["prompt"],
        "negative_prompt": sanitize.text(v.negative_prompt, 400) or DEFAULT_NEGATIVE,
        "source": "model",
    }
    return idea, r


async def art_svg(crop_png: bytes, *, hint: str | None, style_text: str | None, view_w: int, view_h: int,
                  colors: list[str] | None = None, variation: str | None = None,
                  deadline: float | None = None) -> MindResult[Any]:
    """Claude draws the sprite as SVG (claude-svg provider). Never raises; value is SvgArt or None."""
    text = (
        f"Hint from the child: {sanitize.text(hint, 60) or '(none)'}\n"
        f"Game style: {sanitize.text(style_text, 300) or '(none: bright, friendly cartoon)'}\n"
        f"Ink colours the child used: {', '.join(colors or []) or '(unknown)'}\n"
        f'Use exactly viewBox="0 0 {view_w} {view_h}" (the drawing\'s proportions).\n'
        + (f"Variation: {sanitize.text(variation, 120)}\n" if variation else "")
        + "Draw this object as a clean game sprite SVG."
    )
    content = [_image_block(crop_png), {"type": "text", "text": text}]
    dl = deadline if deadline is not None else time.monotonic() + client.CALLS["art_svg"].timeout_s
    try:
        return await client.call("art_svg", SvgArt, content, draft_id=None, deadline=dl)
    except Exception as e:  # noqa: BLE001
        return MindResult[SvgArt](kind="art_svg", status="failed", error=f"{type(e).__name__}")


async def art_backdrop(*, theme: str | None, style_text: str | None, view_w: int, view_h: int, screens: int,
                       deadline: float | None = None) -> MindResult[Any]:
    """Claude paints a wide, horizontally tileable parallax backdrop as SVG. Never raises."""
    text = (
        f"Theme: {sanitize.text(theme, 200) or '(none: a sunny meadow with hills)'}\n"
        f"Game style: {sanitize.text(style_text, 300) or '(none: bright, friendly cartoon)'}\n"
        f"The level is {screens} screen(s) wide. Use exactly viewBox=\"0 0 {view_w} {view_h}\".\n"
        "Paint the backdrop SVG."
    )
    content = [{"type": "text", "text": text}]
    dl = deadline if deadline is not None else time.monotonic() + client.CALLS["art_backdrop"].timeout_s
    try:
        return await client.call("art_backdrop", SvgArt, content, draft_id=None, deadline=dl)
    except Exception as e:  # noqa: BLE001
        return MindResult[SvgArt](kind="art_backdrop", status="failed", error=f"{type(e).__name__}")
