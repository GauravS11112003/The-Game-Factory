"""Studio templates and themes (CONTRACTS_V6 §4.3, §4.4, §5.1).

Lane R writes `shared/studio/templates/*.json` (full GameDocs) and `shared/studio/themes.json`
(`{"themes": [StudioTheme, ...]}`). Both are read at request time (cached by file mtime), so new files show up
without a restart. Until themes.json exists the API serves the built-in Sketchbook theme; the keyword matcher then
falls back to the built-in palettes below (one per preset named in §4.3), which also carry the keywords used to map
"spooky halloween" or "like Geometry Dash" onto a preset when themes.json has no keywords of its own.
"""
from __future__ import annotations

import copy
import json
import logging
import re
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from app.config import SHARED_DIR
from app.spec.studio import GameDoc, StudioTheme

log = logging.getLogger("dal.v6.studio.assets")

STUDIO_DIR = SHARED_DIR / "studio"
TEMPLATES_DIR = STUDIO_DIR / "templates"
THEMES_PATH = STUDIO_DIR / "themes.json"
DEFAULT_THEME_ID = "sketchbook"


def _t(tid: str, name: str, pal: tuple[str, ...], bg: str, bg_colors: list[str], stroke: dict[str, Any],
       particles: str, font: str, music: str, words: str, recolor: bool = False) -> dict[str, Any]:
    keys = ("bg", "ink", "accent", "accent2", "text", "danger", "good")
    return {
        "theme": {"id": tid, "name": name, "palette": dict(zip(keys, pal)),
                  "background": {"style": bg, "colors": bg_colors, "parallax": True},
                  "stroke": {"style": "marker", "outline": None, "width_scale": 1, "glow": False, "fill_closed": True,
                             "halftone": False, "wobble": 0, **stroke},
                  "recolor": recolor, "particles": particles, "font": font, "music": music},
        "keywords": [w.strip() for w in words.split(",") if w.strip()],
    }


BUILTIN: list[dict[str, Any]] = [
    _t("sketchbook", "Sketchbook",
       ("#f6f1e7", "#1f1b18", "#e4572e", "#2e86ab", "#1f1b18", "#d7263d", "#3bb273"), "paper", ["#f6f1e7"],
       {}, "dust", "hand", "upbeat", "sketch, sketchbook, paper, pencil, notebook, doodle, default theme, plain paper, hand drawn"),
    _t("neon_arcade", "Neon Arcade",
       ("#0b0a1a", "#f5f3ff", "#ff2bd6", "#00e5ff", "#f5f3ff", "#ff3864", "#39ff14"), "neon_grid",
       ["#0b0a1a", "#2a0b4a", "#ff2bd6"], {"style": "neon", "glow": True}, "sparks", "clean", "chiptune",
       "neon, arcade, synthwave, synth, cyber, cyberpunk, tron, glow, glowing, geometry dash, 80s, retro wave, "
       "vaporwave, disco, laser, electric", recolor=True),
    _t("pixel_retro", "Pixel Retro",
       ("#1d2b53", "#fff1e8", "#ff004d", "#29adff", "#fff1e8", "#ff004d", "#00e436"), "solid", ["#1d2b53"],
       {"style": "pixel"}, "stars", "pixel", "chiptune",
       "pixel, pixels, pixel art, retro, 8-bit, 8 bit, 16-bit, nes, gameboy, game boy, old school, minecraft, blocky",
       recolor=True),
    _t("comic_pop", "Comic Pop",
       ("#fff6d6", "#111111", "#ff3b30", "#1e90ff", "#111111", "#ff3b30", "#2ecc71"), "halftone",
       ["#fff6d6", "#ffd23f"], {"style": "comic", "outline": "#111111", "halftone": True, "width_scale": 1.2},
       "sparks", "comic", "heroic", "comic, comics, cartoon, pop art, superhero, super hero, manga, anime, bold, kapow"),
    _t("chalkboard", "Chalkboard",
       ("#23362b", "#f2f2ec", "#ffd166", "#7fd1ff", "#f2f2ec", "#ff6b6b", "#a7f070"), "solid", ["#23362b"],
       {"style": "chalk"}, "dust", "hand", "calm", "chalk, chalkboard, blackboard, school, classroom, teacher",
       recolor=True),
    _t("crayon_kids", "Crayon Kids",
       ("#fffaf0", "#2b2b2b", "#ff7f11", "#4361ee", "#2b2b2b", "#e63946", "#2a9d8f"), "paper", ["#fffaf0"],
       {"style": "crayon", "wobble": 0.4}, "confetti", "hand", "upbeat",
       "crayon, crayons, kids, kid, child, children, colorful, colourful, rainbow, fun, playful, toddler, happy"),
    _t("watercolor_dream", "Watercolor Dream",
       ("#f4f1ea", "#3d405b", "#e07a5f", "#81b29a", "#3d405b", "#c44536", "#81b29a"), "clouds",
       ["#f4f1ea", "#d8e2dc", "#ffe5d9"], {"style": "watercolor"}, "bubbles", "serif", "calm",
       "watercolor, watercolour, dreamy, dream, soft, painting, painted, pastel, gentle, peaceful, cozy, cosy"),
    _t("blueprint", "Blueprint",
       ("#0f3b6e", "#e8f1ff", "#ffd23f", "#8fd3ff", "#e8f1ff", "#ff6b6b", "#7ee081"), "grid", ["#0f3b6e", "#2d5d93"],
       {"style": "ink"}, "sparks", "clean", "calm",
       "blueprint, engineer, engineering, technical, schematic, robot, robots, machine, factory, invention",
       recolor=True),
    _t("desert_dunes", "Desert Dunes",
       ("#f3d9a4", "#4a2c17", "#d96c06", "#2a9d8f", "#4a2c17", "#b23a48", "#6a994e"), "dunes",
       ["#f9e7c2", "#f3d9a4", "#e0b872", "#c98f4a"], {}, "dust", "hand", "racing",
       "desert, dunes, sand, sandy, sahara, egypt, cactus, wild west, western, cowboy, canyon, safari, hill climb, "
       "rally, offroad, off road"),
    _t("deep_space", "Deep Space",
       ("#05060f", "#e6e9ff", "#ffb703", "#8ecae6", "#e6e9ff", "#ff4d6d", "#80ed99"), "space",
       ["#05060f", "#1b1340", "#3a1c71"], {"glow": True}, "stars", "clean", "heroic",
       "space, outer space, galaxy, stars, starry, cosmic, planet, planets, asteroid, asteroids, alien, aliens, "
       "rocket, astronaut, nebula, star wars, sci-fi, scifi, ufo, moon"),
    _t("spooky_night", "Spooky Night",
       ("#14101f", "#f1e9ff", "#ff7518", "#9d4edd", "#f1e9ff", "#ff2e63", "#7bd389"), "forest",
       ["#14101f", "#2b1d3f", "#3c2a54"], {"style": "chalk"}, "embers", "serif", "spooky",
       "spooky, halloween, ghost, ghosts, haunted, scary, horror, night, zombie, zombies, vampire, witch, pumpkin, "
       "graveyard, creepy, skeleton, bats", recolor=True),
    _t("candy", "Candy",
       ("#fff0f6", "#5a2a4a", "#ff5fa2", "#49c6e5", "#5a2a4a", "#ff4d6d", "#57cc99"), "gradient",
       ["#fff0f6", "#ffd6e8"], {"outline": "#5a2a4a"}, "confetti", "comic", "upbeat",
       "candy, sweet, sweets, pink, cute, kawaii, sugar, cake, dessert, unicorn, princess, bubblegum, lollipop",
       recolor=True),
    _t("jungle", "Jungle",
       ("#e8f5d0", "#1b3a1b", "#f4a259", "#2a9d8f", "#1b3a1b", "#bc4b51", "#5b8e7d"), "forest",
       ["#e8f5d0", "#a7c957", "#6a994e", "#386641"], {}, "dust", "hand", "heroic",
       "jungle, forest, tropical, rainforest, nature, tree, trees, monkey, adventure, woods, explorer, dinosaur"),
    _t("ocean", "Ocean",
       ("#d9f2ff", "#0b3954", "#ff9f1c", "#2ec4b6", "#0b3954", "#e71d36", "#2ec4b6"), "waves",
       ["#d9f2ff", "#8fd3fe", "#3a86ff"], {}, "bubbles", "clean", "calm",
       "ocean, sea, underwater, under water, beach, water, fish, shark, pirate, pirates, island, mermaid, surf, "
       "submarine, coral"),
    _t("noir_ink", "Noir Ink",
       ("#f2f2f2", "#0a0a0a", "#c1121f", "#6c757d", "#0a0a0a", "#c1121f", "#495057"), "solid", ["#f2f2f2"],
       {"style": "ink"}, "none", "serif", "calm",
       "noir, black and white, ink, monochrome, detective, mono, minimal, minimalist, grayscale, greyscale, shadow"),
]


def norm(s: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(s or "").lower())


_cache: dict[str, tuple[float, Any]] = {}


def _read_json(path: Path) -> Any:
    """Parsed JSON cached by mtime; None when missing or broken."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    hit = _cache.get(str(path))
    if hit is not None and hit[0] == mtime:
        return hit[1]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("studio asset %s unreadable: %s", path.name, e)
        data = None
    _cache[str(path)] = (mtime, data)
    return data


# ---- themes -------------------------------------------------------------------------------------------------------


def builtin_theme(theme_id: str = DEFAULT_THEME_ID) -> dict[str, Any] | None:
    key = norm(theme_id)
    for b in BUILTIN:
        if norm(b["theme"]["id"]) == key or norm(b["theme"]["name"]) == key:
            return copy.deepcopy(b["theme"])
    return None


def sketchbook() -> dict[str, Any]:
    return builtin_theme(DEFAULT_THEME_ID) or {}


def file_themes() -> list[dict[str, Any]]:
    """Valid themes from themes.json (an invalid one is skipped, never a broken list)."""
    data = _read_json(THEMES_PATH)
    raw = data.get("themes") if isinstance(data, dict) else data if isinstance(data, list) else None
    out: list[dict[str, Any]] = []
    for t in raw or []:
        try:
            th = StudioTheme.model_validate(t).model_dump(mode="json", by_alias=True)
        except ValidationError:
            log.info("theme %s skipped: not a valid StudioTheme", (t or {}).get("id") if isinstance(t, dict) else t)
            continue
        if th.get("id"):
            out.append(th)
    return out


def themes() -> list[dict[str, Any]]:
    """GET /studio/themes: themes.json, or the built-in Sketchbook while it does not exist."""
    return file_themes() or [sketchbook()]


def theme_by_id(theme_id: str) -> dict[str, Any] | None:
    """A preset by id or name: themes.json first, then the built-in palettes."""
    key = norm(theme_id)
    if not key:
        return None
    for t in file_themes():
        if norm(t.get("id")) == key or norm(t.get("name")) == key:
            return copy.deepcopy(t)
    return builtin_theme(theme_id)


def preset_ids() -> list[str]:
    """Ids a `set_theme {preset}` edit may name: the client resolves them from themes.json."""
    return [str(t["id"]) for t in file_themes()]


def _keywords_for(theme: dict[str, Any]) -> list[str]:
    words: list[str] = []
    for k in ("x_keywords", "keywords"):
        v = theme.get(k)
        if isinstance(v, list):
            words += [str(w).lower() for w in v if isinstance(w, str)]
    key_id, key_name = norm(theme.get("id")), norm(theme.get("name"))
    for b in BUILTIN:
        if norm(b["theme"]["id"]) in (key_id, key_name) or norm(b["theme"]["name"]) in (key_id, key_name):
            words += b["keywords"]
    name = str(theme.get("name") or "").lower()
    if name:
        words.append(name)
        words += [w for w in re.findall(r"[a-z]+", name) if len(w) > 3]
    return list(dict.fromkeys(words))


def candidates() -> list[dict[str, Any]]:
    """The presets the keyword matcher chooses from: themes.json when present, else the built-in palettes."""
    ft = file_themes()
    return ft if ft else [copy.deepcopy(b["theme"]) for b in BUILTIN]


def match_theme(text: str) -> tuple[dict[str, Any] | None, int]:
    """(the best preset for the words in `text`, its score); (None, 0) when no keyword matches."""
    t = " " + re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()) + " "
    best: dict[str, Any] | None = None
    best_score = 0
    for theme in candidates():
        score = 0
        for w in _keywords_for(theme):
            ww = re.sub(r"[^a-z0-9]+", " ", w).strip()
            if not ww:
                continue
            if f" {ww} " in t:
                score += 2 * len(ww.split())
            elif len(ww) > 3 and f" {ww}s " in t:
                score += 1
        if score > best_score:
            best, best_score = theme, score
    return best, best_score


def theme_catalog_text() -> str:
    """The presets as one line each, for the copilot's prompts."""
    rows = []
    for t in candidates():
        bg = (t.get("background") or {}).get("style", "")
        st = (t.get("stroke") or {}).get("style", "")
        pal = t.get("palette") or {}
        rows.append(f"- {t.get('id')}: {t.get('name')} (background {bg}, strokes {st}, bg {pal.get('bg', '')}, "
                    f"ink {pal.get('ink', '')}, accent {pal.get('accent', '')})")
    src = "themes.json" if file_themes() else "built-in palettes (no themes.json yet: set_theme with full values)"
    return f"# THEME PRESETS ({src})\n" + "\n".join(rows)


# ---- templates ----------------------------------------------------------------------------------------------------

_BLANK: dict[str, Any] = {
    "format": "drawplay-studio", "version": 1, "id": "tpl_blank", "title": "Blank canvas", "author": "draw.play",
    "hud": {"items": [], "timer": False, "title": None}, "rules": [], "counters": {},
    "scenes": [{"id": "s1", "name": "Level 1", "world": {}, "objects": [], "rules": []}],
}


def _template_files() -> list[Path]:
    try:
        return sorted(p for p in TEMPLATES_DIR.glob("*.json") if p.is_file())
    except OSError:
        return []


def templates() -> list[tuple[str, dict[str, Any]]]:
    """[(id, GameDoc dict)] for every valid template; the id is the doc's id (the file stem when it has none)."""
    out: list[tuple[str, dict[str, Any]]] = []
    seen: set[str] = set()
    for p in _template_files():
        data = _read_json(p)
        if not isinstance(data, dict):
            continue
        doc = dict(data)
        doc.setdefault("id", p.stem)
        try:
            g = GameDoc.model_validate(doc).model_dump(mode="json", by_alias=True)
        except ValidationError as e:
            log.info("template %s skipped: %d errors", p.name, e.error_count())
            continue
        tid = str(g["id"])
        if tid in seen:
            continue
        seen.add(tid)
        out.append((tid, g))
    return out


def template(template_id: str) -> dict[str, Any] | None:
    """A template by doc id or file stem (a deep copy)."""
    key = str(template_id or "")
    for p in _template_files():
        data = _read_json(p)
        if not isinstance(data, dict):
            continue
        if key in (p.stem, str(data.get("id") or "")):
            doc = dict(data)
            doc.setdefault("id", p.stem)
            try:
                return GameDoc.model_validate(doc).model_dump(mode="json", by_alias=True)
            except ValidationError:
                return None
    return None


def template_thumbnail(template_id: str) -> Path | None:
    """`<stem>.png` next to a template, when lane R ships one."""
    key = str(template_id or "")
    for p in _template_files():
        data = _read_json(p)
        if key in (p.stem, str((data or {}).get("id") or "") if isinstance(data, dict) else ""):
            png = p.with_suffix(".png")
            return png if png.is_file() else None
    return None


def blank() -> dict[str, Any]:
    """The blank template (shared/studio/templates/blank.json, else a built-in copy with the Sketchbook theme)."""
    doc = template("blank") or template("tpl_blank")
    if doc is not None:
        return doc
    raw = copy.deepcopy(_BLANK)
    raw["theme"] = sketchbook()
    return GameDoc.model_validate(raw).model_dump(mode="json", by_alias=True)
