"""Colour helpers and the world families behind the fallbacks (model off or failed): a keyword-picked family gives
the art direction's words, the terrain colours and the procedural backdrop's shapes, tinted to the game's palette."""
from __future__ import annotations

import colorsys
import re
from dataclasses import dataclass, field
from typing import Any


def rgb(h: str) -> tuple[float, float, float]:
    try:
        return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]
    except (ValueError, IndexError, TypeError):
        return (0.5, 0.5, 0.5)


def hexc(r: float, g: float, b: float) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}" for c in (r, g, b))


def mix(a: str, b: str, t: float) -> str:
    ra, rb = rgb(a), rgb(b)
    return hexc(*(x + (y - x) * t for x, y in zip(ra, rb)))


def shade(h: str, f: float) -> str:
    """f < 0 darkens toward a cool dark, f > 0 lightens toward a warm light (hue-shifted shading)."""
    return mix(h, "#1b1630", -f) if f < 0 else mix(h, "#fff4dc", f)


def lum(h: str) -> float:
    r, g, b = rgb(h)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def sat(h: str) -> float:
    r, g, b = rgb(h)
    return colorsys.rgb_to_hls(r, g, b)[2]


def is_hex(s: Any) -> bool:
    return isinstance(s, str) and re.match(r"^#[0-9a-fA-F]{6}$", s) is not None


def clean_list(cols: Any, n: int) -> list[str]:
    out: list[str] = []
    for c in cols or []:
        s = str(c).strip().lower()
        if re.match(r"^#[0-9a-f]{3}$", s):
            s = "#" + "".join(ch * 2 for ch in s[1:])
        if is_hex(s) and s not in out:
            out.append(s)
    return out[:n]


@dataclass(frozen=True)
class Family:
    key: str
    words: tuple[str, ...]
    sky: tuple[str, ...]
    fill: tuple[str, ...]
    surface: str
    surface_kind: str  # grass | dust | snow | sand | candy | neon | rock
    far: str  # mountains | craters | dunes | skyline | waves | hills
    mid: str
    near: str
    sky_extra: str  # stars | sun | moon | clouds | none
    mood: str
    materials: str
    ground: str
    backdrop: str
    kinds: dict[str, str] = field(default_factory=dict)


FAMILIES: tuple[Family, ...] = (
    Family("space", ("space", "moon", "lunar", "mars", "planet", "galaxy", "asteroid", "astronaut", "rocket", "alien",
                     "star", "cosmic", "orbit", "sci fi", "scifi", "nebula"),
           ("#0b0a24", "#2a1f5c", "#5b3f8f"), ("#8d8aa3", "#5f5b78", "#3c3854"), "#b9b6cc", "dust",
           "craters", "craters", "rocks", "stars",
           "A cheerful sci-fi moonscape at the edge of a violet galaxy: clean, chunky shapes, soft rim light from a "
           "distant blue planet, a sense of low-gravity fun.",
           "Painted metal and white composite panels with gold-foil accents, glassy bubble cockpits with a bright "
           "specular dot, grey regolith with soft craters.",
           "Grey-violet moon regolith: a pale dusty top band with small pebbles, darker strata below, round "
           "craters and glowing crystals as decorations.",
           "A deep violet-to-indigo sky full of stars, a big ringed planet on the far layer, low crater rims in the "
           "middle distance, dark jagged rocks near.",
           {"car": "a chunky white lunar rover with gold-foil side panels, a dish antenna and a tinted bubble cockpit",
            "wheel": "a fat moon-rover wheel with a grey tyre, deep tread and a bright metal hub",
            "player": "a round little astronaut in a white suit with a big glowing visor",
            "coin": "a glowing cyan energy crystal", "enemy": "a goofy one-eyed purple alien blob",
            "ground": "grey-violet moon regolith"}),
    Family("desert", ("desert", "dune", "sand", "sahara", "egypt", "cactus", "canyon", "western", "cowboy", "safari"),
           ("#ffb36b", "#ffd99a", "#fff1cf"), ("#e3a857", "#c47f3a", "#8f5326"), "#f0c27a", "sand",
           "mountains", "dunes", "rocks", "sun",
           "A warm, sunny desert rally in late afternoon: long shadows, a hazy orange sky, bold and playful.",
           "Sun-bleached paint, dusty rubber, warm sandstone with soft rounded edges.",
           "Golden sand over orange sandstone: a sunlit ripple band on top, warmer darker layers below, rocks and "
           "small cacti as decorations.",
           "A warm gradient sky with a big soft sun, pale far mesas, rolling mid dunes, darker near rock spires.",
           {"car": "a rugged rally buggy with a roll cage and dusty orange paint", "ground": "sun-baked sand dunes"}),
    Family("snow", ("snow", "ice", "winter", "frozen", "arctic", "christmas", "penguin", "glacier", "ski"),
           ("#7fb3e6", "#bcdcf5", "#eaf6ff"), ("#eef6fb", "#b9d6ea", "#7fa6c6"), "#ffffff", "snow",
           "mountains", "hills", "rocks", "clouds",
           "A crisp, bright winter wonderland: cool blues, sparkling highlights, cosy warm accents.",
           "Glossy ice with sharp white highlights, soft rounded snow, knitted and wooden accents.",
           "Thick white snow with a soft blue shadow under its lip over icy blue layers; icicles and snowy "
           "rocks as decorations.",
           "A pale blue sky, distant snowy peaks, rounded snow hills, near frosted pines.",
           {"ground": "deep fresh snow over blue ice"}),
    Family("ocean", ("ocean", "sea", "underwater", "beach", "island", "pirate", "fish", "coral", "mermaid", "shark",
                     "submarine"),
           ("#1d5fa8", "#3fa3d8", "#a8e3f5"), ("#f3d9a0", "#d9b06c", "#a7793f"), "#f8e6b8", "sand",
           "waves", "waves", "rocks", "sun",
           "A bright tropical seaside: turquoise water, sunny highlights, playful pirate-adventure energy.",
           "Wet glossy surfaces, weathered wood, coral and shells with soft gradients.",
           "Pale beach sand with shells over darker wet sand; starfish and shells as decorations.",
           "A turquoise sky, far islands, rolling waves, near coral or palm silhouettes.", {}),
    Family("candy", ("candy", "sweet", "cake", "dessert", "chocolate", "lollipop", "bubblegum", "kawaii", "unicorn",
                     "princess"),
           ("#ff9ccf", "#ffc6e3", "#fff0f8"), ("#a0522d", "#7b3b1f", "#562512"), "#ffd1ea", "candy",
           "hills", "hills", "rocks", "clouds",
           "A sugary candy land: pastel pinks and mint, glossy highlights, cute and bouncy.",
           "Glossy hard candy, soft frosting, chocolate with a sheen, sprinkles as accents.",
           "Chocolate cake ground with a pink frosting drip band on top; sprinkles and candy drops as decorations.",
           "A pastel pink sky with fluffy clouds, far pastel hills, mid lollipop trees, near candy rocks.", {}),
    Family("neon", ("neon", "cyber", "synthwave", "tron", "arcade", "80s", "retro wave", "vaporwave", "city",
                    "future"),
           ("#0b0620", "#2a0b4a", "#6a1b6e"), ("#24124a", "#170b33", "#0b0620"), "#ff3fd8", "neon",
           "skyline", "skyline", "rocks", "stars",
           "A synthwave night: dark purples, glowing magenta and cyan edges, a big striped sunset sun.",
           "Dark glossy panels with glowing edge lines, chrome highlights, emissive accents.",
           "Dark violet ground with a glowing neon edge line and a faint grid texture; small glowing crystals.",
           "A purple night sky with a striped neon sun, far city skyline, mid towers, near dark ridges.", {}),
    Family("spooky", ("spooky", "halloween", "ghost", "haunted", "graveyard", "zombie", "witch", "pumpkin", "night",
                      "vampire"),
           ("#140f24", "#2c1f45", "#4b2f63"), ("#3b2f4a", "#2a2036", "#181222"), "#5f7a46", "grass",
           "mountains", "hills", "rocks", "moon",
           "A cosy-spooky Halloween night: a big moon, purple fog, orange glows; fun, never truly scary.",
           "Gnarled wood, mossy stone, glowing pumpkins and lanterns.",
           "Dark mossy turf over purple-brown soil; little pumpkins and tombstone-shaped rocks (no text).",
           "A deep purple sky with a big moon, far crooked hills, mid dead trees, near dark bushes.", {}),
    Family("lava", ("lava", "volcano", "fire", "hell", "magma", "dragon"),
           ("#2b0f14", "#6b1d1d", "#d4552a"), ("#4a2a26", "#2e1916", "#1a0d0b"), "#ff7a2f", "rock",
           "mountains", "mountains", "rocks", "none",
           "A dramatic volcano world: dark rock, glowing lava cracks, ember-filled air; heroic, not scary.",
           "Cracked basalt, glowing molten seams, scorched metal.",
           "Dark basalt with a glowing orange crack band on top; smoking rocks and embers as decorations.",
           "A red-orange smoky sky, far volcano silhouettes, mid jagged ridges, near dark rocks with glowing seams.",
           {}),
    Family("forest", ("forest", "jungle", "tree", "woods", "nature", "meadow", "grass", "farm", "garden", "park"),
           ("#5fb7f0", "#a9dcf7", "#e8f7ff"), ("#8a5a35", "#6b4226", "#4a2c17"), "#5cb85c", "grass",
           "mountains", "hills", "rocks", "clouds",
           "A bright, friendly storybook meadow on a sunny day: soft clouds, lush greens, adventure feel.",
           "Soft painted wood, leafy greens, rounded stones; clean shapes with a little texture.",
           "Lush green grass tufts over rich brown soil with pebbles; flowers, mushrooms and rocks as decorations.",
           "A clear blue sky with soft clouds, far blue mountains, mid rolling green hills, near tree line.", {}),
)
DEFAULT_FAMILY = FAMILIES[-1]
_BG_FAMILY = {"space": "space", "stars": "space", "dunes": "desert", "waves": "ocean", "neon_grid": "neon",
              "city": "neon", "forest": "forest", "hills": "forest", "clouds": "forest"}
_THEME_FAMILY = {"deep_space": "space", "desert_dunes": "desert", "ocean": "ocean", "candy": "candy",
                 "neon_arcade": "neon", "spooky_night": "spooky", "jungle": "forest", "crayon_kids": "forest"}


def family_for(words: str, theme: dict[str, Any] | None = None) -> Family:
    """The family whose words appear in `words` (the maker's look words first), else from the theme."""
    t = " " + re.sub(r"[^a-z0-9]+", " ", (words or "").lower()) + " "
    best, score = None, 0
    for f in FAMILIES:
        s = sum(2 * len(w.split()) for w in f.words if f" {w} " in t or f" {w}s " in t)
        if s > score:
            best, score = f, s
    if best is not None:
        return best
    th = theme or {}
    key = _THEME_FAMILY.get(str(th.get("id") or "")) or _BG_FAMILY.get(str((th.get("background") or {}).get("style")))
    return next((f for f in FAMILIES if f.key == key), DEFAULT_FAMILY)


def by_key(key: str) -> Family:
    return next((f for f in FAMILIES if f.key == key), DEFAULT_FAMILY)
