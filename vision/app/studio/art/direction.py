"""The game-wide art direction (CONTRACTS_V7 §3.1): POST /studio/art/direction.

    make(body) → ArtDirectionResult dict {direction, theme, source}

The model writes a rich style guide (palette roles, line, light and shading, materials, detail level, ground,
backdrop, what to avoid) and maps every object kind of the game to what it becomes in this world, plus a matching
StudioTheme. Without the model (off, failed, refused, truncated): keywords pick a world family and a theme preset,
and the guide is written from templates. Never raises.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from app.mind import client, moderate, sanitize
from app.studio import assets, catalog, fallback
from app.studio.art import brief, palette, render
from app.studio.art.calls import DirectionFlat, ThemeLite, call, craft_block, image, text

log = logging.getLogger("dal.v7.art")

GUIDE_CHARS = 6000
SUMMARY_CHARS = 300
KIND_CHARS = 400
MAX_KINDS = 40


def clean_guide(s: Any) -> str:
    """Plain text with line breaks kept, cut at a line boundary under GUIDE_CHARS."""
    t = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(s or "")).replace("\r", "")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    if len(t) <= GUIDE_CHARS:
        return t
    cut = t[:GUIDE_CHARS]
    nl = cut.rfind("\n")
    return (cut[:nl] if nl > GUIDE_CHARS * 0.7 else cut[:GUIDE_CHARS - 1] + "…").strip()


def game_kinds(doc: dict[str, Any]) -> list[str]:
    kinds = []
    for o in brief.all_objects(doc):
        if brief.has_strokes(o) or o.get("kind") not in (None, "", "thing"):
            k = str(o.get("kind") or "thing").lower()[:24]
            if k not in kinds:
                kinds.append(k)
    return kinds[:MAX_KINDS]


def _next_rev(doc: dict[str, Any]) -> int:
    old = doc.get("art_direction") or {}
    try:
        return max(1, int(old.get("rev") or 0) + 1)
    except (TypeError, ValueError):
        return 1


def _prompt_of(body: dict[str, Any]) -> str:
    p = sanitize.text(body.get("prompt"), 300)
    return "" if moderate.blocklist_hit([p]) else p


def _theme_from_lite(v: ThemeLite) -> dict[str, Any] | None:
    from app.studio import copilot

    flat = copilot.ThemeFlat(
        preset=v.preset, name=v.name, bg=v.bg, ink=v.ink, accent=v.accent, accent2=v.accent2, text=v.text,
        danger=v.danger, good=v.good, background=v.background, background_colors=v.background_colors,
        stroke=v.stroke, outline=v.outline, width_scale=1.0, glow=v.glow, halftone=False, wobble=0.0,
        recolor=False, particles=v.particles, font=v.font, music=v.music)
    return copilot.theme_from_flat(flat)


async def make(body: dict[str, Any]) -> dict[str, Any]:
    doc = body["game"]
    prompt = _prompt_of(body)
    rev = _next_rev(doc)
    kinds = game_kinds(doc)
    if client.available():
        content: list[dict[str, Any]] = [craft_block()]
        scene = brief.scene_of(doc, None)
        if render.available() and any(brief.has_strokes(o) for o in scene.get("objects") or []):
            svg, W, H = render.scene_svg(doc, scene)
            png = render.png(svg, width=int(min(1400, max(400, W / 4))) if W > H else None,
                             height=None if W > H else 900)
            if png:
                content += [text("The maker's sketch of the scene (layout and scale; colours are their pens):"),
                            image(png)]
        content.append(text(
            brief.game_text(doc)
            + f"\n\nTHE MAKER WANTS THE LOOK: {prompt or '(nothing said: derive it from the game kind, title and theme)'}"
            + "\n\nTheme presets you may pick for `theme.preset`:\n" + assets.theme_catalog_text()
            + "\n\nWrite the art direction. `kinds` must cover exactly these kinds: "
            + (", ".join(kinds) or "player, ground, platform, coin, enemy") + "."))
        r = await call("studio_art_direction", DirectionFlat, content, attempts=2)
        if r.ok and r.value is not None:
            out = from_flat(r.value, prompt, rev, kinds, doc)
            if out is not None:
                return out
        log.info("art direction: model path unavailable (%s %s); keywords", r.status, r.error or "")
    return keyword_direction(doc, prompt, rev, kinds)


def from_flat(v: DirectionFlat, prompt: str, rev: int, kinds: list[str], doc: dict[str, Any]) -> dict[str, Any] | None:
    guide = clean_guide(v.guide)
    if len(guide) < 200 or moderate.blocklist_hit([guide, v.summary]):
        return None
    pal = palette.clean_list(v.palette, 10)
    fb = keyword_direction(doc, prompt, rev, kinds)
    if len(pal) < 4:
        pal = fb["direction"]["palette"]
    km: dict[str, str] = {}
    for k in v.kinds:
        key = str(k.kind or "").strip().lower()[:24]
        looks = catalog.safe_text(k.looks, KIND_CHARS)
        if key and looks and key not in km and len(km) < MAX_KINDS:
            km[key] = looks
    for k in kinds:  # every kind of the game is covered
        km.setdefault(k, fb["direction"]["kinds"].get(k) or f"render faithfully as what the drawing shows, in this "
                                                              f"style")
    theme = _theme_from_lite(v.theme) or fb["theme"]
    return {"direction": {"rev": rev, "prompt": prompt, "summary": catalog.safe_text(v.summary, SUMMARY_CHARS)
                          or fb["direction"]["summary"], "guide": guide, "palette": pal, "kinds": km},
            "theme": theme, "source": "model"}


# ---- keywords -----------------------------------------------------------------------------------------------------


def keyword_direction(doc: dict[str, Any], prompt: str, rev: int, kinds: list[str]) -> dict[str, Any]:
    scene = brief.scene_of(doc, None)
    world_kind = str((scene.get("world") or {}).get("kind") or "")
    words = f"{prompt} {world_kind} {doc.get('title') or ''}"
    theme = fallback.theme(prompt or world_kind or str(doc.get("title") or ""), world_kind or None) if (
        prompt or world_kind) else (doc.get("theme") or assets.sketchbook())
    fam = palette.family_for(words, theme)
    if prompt and fam is not palette.DEFAULT_FAMILY:
        preset_for = {"space": "deep_space", "desert": "desert_dunes", "ocean": "ocean", "candy": "candy",
                      "neon": "neon_arcade", "spooky": "spooky_night", "forest": "jungle"}.get(fam.key)
        t2 = assets.theme_by_id(preset_for) if preset_for else None
        theme = t2 or theme
    pal_t = (theme.get("palette") or {})
    cols = [pal_t.get(k) for k in ("accent", "accent2", "good", "danger")] + list(fam.sky[:2]) + [
        fam.fill[0], fam.surface, pal_t.get("ink"), fam.fill[-1]]
    pal = palette.clean_list(cols, 10)
    outline = palette.shade(fam.fill[-1], -0.7)
    km = {k: fam.kinds.get(k) or _generic_kind(k, fam) for k in kinds}
    name = theme.get("name") or "Storybook"
    look = prompt or world_kind or str(doc.get("title") or "") or "a bright cartoon game"
    guide = "\n".join([
        f"1. WORLD AND MOOD: {fam.mood} The maker asked for: {look}.",
        f"2. PALETTE ROLES: characters and vehicles use {pal[0] if pal else '#e4572e'} and "
        f"{pal[1] if len(pal) > 1 else '#2e86ab'} as main colours; pickups glow in {pal_t.get('good', '#3bb273')} or "
        f"gold; hazards use {pal_t.get('danger', '#d7263d')}; ground {', '.join(fam.fill)}; sky "
        f"{' to '.join(fam.sky)}; outline {outline}.",
        f"3. LINE: one {outline} outline, about 3 px at game size around every silhouette, 1.5 px inside, round "
        f"joins and caps.",
        "4. LIGHT AND SHADING: light from the top-left at 45 degrees. Soft cel shading: a base tone, one cooler "
        "shadow tone on the lower right, one warm light plane on the upper left, a small white specular highlight; "
        "gradients only for curved surfaces and glows.",
        f"5. MATERIALS AND TEXTURE: {fam.materials} Clean surfaces, no noise.",
        "6. SHAPE LANGUAGE AND DETAIL: chunky, rounded, slightly exaggerated proportions; big readable features; "
        "no detail under 3 px at game size; players brightest, scenery calmer.",
        f"7. GROUND: {fam.ground}",
        f"8. BACKDROP: {fam.backdrop} Lower contrast and saturation than gameplay pieces.",
        "9. AVOID: text and letters, logos, photo-realism, thin hairlines, clutter, pure black fills, a second "
        "light direction.",
    ])
    summary = f"{name} look: {fam.mood.split(':')[0].split('.')[0].lower()}"[:SUMMARY_CHARS]
    return {"direction": {"rev": rev, "prompt": prompt, "summary": summary, "guide": clean_guide(guide),
                          "palette": pal, "kinds": km}, "theme": theme, "source": "keywords"}


def _generic_kind(kind: str, fam: palette.Family) -> str:
    k = kind.lower()
    if k in ("ground", "hill", "hills", "road", "floor", "terrain", "track"):
        return fam.ground.split(":")[0]
    if k in ("wheel", "tire", "tyre"):
        return "a chunky wheel with a dark tyre, deep tread and a bright hub with one coloured bolt"
    if k in ("coin", "gem", "star", "fuel can", "fuel", "pickup"):
        return f"a glowing, symmetric {k} with one bright highlight that pops off the background"
    if k in ("enemy", "monster", "slime", "alien"):
        return f"a goofy, readable {k} with big eyes and a clear danger colour"
    if k == "thing":
        return "render faithfully as what the drawing shows, in this style"
    return f"a polished {k} in this world's style, keeping the drawing's shape and colours"
