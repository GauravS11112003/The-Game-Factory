"""BLOCK DESCRIBE (docs/v4/CONTRACTS_V4.md §6, POST /blocks/describe): a block's name, the maker's words and their
drawing → a block draft (kind, typed Behavior, spiky, collision, rules) the Block Studio pre-fills.

    describe(name, text, strokes, rpc=…) → BlockDescribeResult dict (source: model | keywords)

The model answers through a flat schema (no unions: unused fields carry sentinels) and code builds the typed Behavior
with numbers from the param grids, so the model never writes raw numbers. Offline (no key, fake without a reply,
over budget, a failed or refused call) the keyword reader below decides, in this order:

    rule packs      "press space to flip gravity", "collect 5 stars to win" (rules through the core's parse_logic)
    talkers         quoted words or "says / talks" → an npc whose lines are the quoted text
    the player      "this is me", "my hero"
    portals        "portal", "teleports", "warp" (a colour word names the pair)
    pickups         "a star that makes you fast" → pickup with an effect: speed, jump, flip, heart, score, freeze,
                    low_gravity ("for 8 seconds", "comes back")
    zones           wind, water, ice, low gravity, conveyor, slow (mud, honey)
    saws            "spinning saw", "blade"
    platforms       moving ("goes up and down 5 blocks"), crumble, falling, spring, or plain (one-way when "jump
                    through")
    creatures       app.mind.creature's keyword chips (walker, hopper, flyer, shooter, chaser, crusher, static)
    hazards         spikes, lava, fire, "hurts"
    anything else  a prop that stays still

Every clause of the text that no vocabulary word explains comes back in `unknown`, in the maker's own words: the
studio shows them as "I could not make: explodes when you touch it" instead of pretending.
"""
from __future__ import annotations

import base64
import re
import time
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from app.mind import budget, client, moderate, sanitize
from app.mind import creature as mcreature
from app.mind import logic as mlogic
from app.mind.client import CallSpec, MindResult
from app.spec.behavior import Behavior

client.CALLS.setdefault("block_describe", CallSpec("low", 3000, 15))
budget.ESTIMATE_USD.setdefault("block_describe", 0.02)

SUMMARY_CHARS = 120
LINE_CHARS = 90
MAX_LINES = 6
MAX_UNKNOWN = 6
KINDS = ("creature", "platform", "hazard", "pickup", "prop", "player", "rules")
ZONES = ("wind", "water", "ice", "low_gravity", "conveyor", "slow")
EFFECTS = ("none", "speed", "jump", "flip", "heart", "score", "freeze", "low_gravity")
_BEHAVIOR = TypeAdapter(Behavior)

Rpc = Callable[[str, dict[str, Any], float | None], Awaitable[Any]]


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FlatBehavior(_M):
    kind: Literal["static", "enemy", "move", "spring", "crumble", "falling", "saw", "portal", "zone", "pickup", "npc"]
    archetype: Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher", "none"] = Field(
        description="enemy: how it moves; otherwise none")
    speed: Literal["slow", "normal", "fast", "none"] = Field(description="enemy, move, saw, crumble; otherwise none")
    dir: Literal["up", "down", "left", "right", "none"] = Field(description="move, spring, saw, zone push; otherwise none")
    cells: int = Field(description="move, saw: how far it travels in cells; otherwise 0")
    strength: Literal["small", "normal", "big", "none"] = Field(description="spring, zone; otherwise none")
    zone: Literal["wind", "water", "ice", "low_gravity", "conveyor", "slow", "none"] = Field(
        description="zone: its effect; otherwise none")
    effect: Literal["none", "speed", "jump", "flip", "heart", "score", "freeze", "low_gravity"] = Field(
        description="pickup: what collecting it does; otherwise none")
    item: str = Field(description='pickup: a short lowercase item name ("star"); otherwise empty')
    seconds: float = Field(description="pickup: how long the effect lasts; otherwise 0")
    respawns: bool = Field(description="pickup: it comes back after a while; otherwise false")
    pair: str = Field(description='portal: a short pair label ("a", "blue"); otherwise empty')
    lines: list[str] = Field(description="npc: what it says, one line each, in the maker's words; otherwise empty")


class BlockSpecFlat(_M):
    kind: Literal["creature", "platform", "hazard", "pickup", "prop", "player", "rules"]
    behavior: FlatBehavior
    spiky: bool
    collision: Literal["solid", "one_way", "none"]
    rules: list[mlogic.FlatRule] = Field(description="rules kind: the rule pack; objects: rules that come with it")
    summary: str
    unknown: list[str] = Field(description="parts of the text that cannot be made, in the maker's words")
    safety_ok: bool


# ---- words ---------------------------------------------------------------------------------------------------------------

_hits = mcreature._hits  # whole words and phrases, a negated word never counts ("it doesn't fly")
_norm = mcreature._norm

# a strong cue makes a rule pack on its own; a weak one only when no object (not even a pickup) is named
_RULE_CUES = ("press", "presses", "pressing", "to win", "you win", "win the", "you lose", "game over", "all coins",
              "all the coins", "every second", "reverse controls", "controls are reversed")
_WEAK_RULE_CUES = ("when you", "whenever", "if you", "flips gravity", "flip gravity", "flip the gravity")
_NPC = ("says", "say", "said", "talks", "talk", "talking", "tells", "tell", "speaks", "speak", "chats", "chat", "npc",
        "shopkeeper", "villager", "greets", "asks", "sings")
_PORTAL = ("portal", "portals", "teleport", "teleports", "teleporter", "warp", "warps", "wormhole", "magic door",
           "beams you", "beam you")
_PICKUP_NOUNS = ("star", "stars", "gem", "gems", "coin", "coins", "apple", "apples", "mushroom", "potion", "heart",
                 "hearts", "feather", "crystal", "candy", "fruit", "banana", "cherry", "diamond", "orb", "battery",
                 "shell", "cookie", "cake", "ring", "jewel", "pearl", "carrot", "lollipop", "pickup", "power up",
                 "powerup", "item", "treasure", "berry", "donut", "pizza", "token")
_PICKUP_VERBS = ("collect", "collects", "collected", "pick up", "picks up", "grab", "grabs", "get it", "eat it",
                 "eat this", "eats it", "drink it", "drink", "power up", "powerup", "boost", "bonus", "touch it to")
_EFFECTS: list[tuple[str, tuple[str, ...]]] = [
    ("flip", ("flip", "flips", "upside down", "reverse gravity", "gravity flips", "flip gravity", "walk on the ceiling",
              "ceiling")),
    ("freeze", ("freeze", "freezes", "frozen", "stops enemies", "stop enemies", "stops time", "stop time",
                "time stop", "enemies stop")),
    ("low_gravity", ("low gravity", "float", "floaty", "floats", "moon", "lighter", "less gravity")),
    ("heart", ("heart", "hearts", "heal", "heals", "health", "life", "extra life", "lives")),
    ("jump", ("jump higher", "jump high", "higher", "super jump", "big jump", "jumps higher", "jump power", "bouncy",
              "high jump")),
    ("speed", ("fast", "faster", "speed", "speedy", "zoom", "zooms", "quick", "quicker", "run fast", "turbo", "dash",
               "sprint")),
    ("score", ("points", "point", "score", "worth")),
]
_ZONES: list[tuple[str, tuple[str, ...]]] = [
    ("water", ("water", "underwater", "swim", "swims", "swimming", "pool", "lake", "sea", "ocean", "river", "pond")),
    ("ice", ("ice", "icy", "slippery", "skate", "skating", "frozen floor", "frozen ground")),
    ("wind", ("wind", "windy", "fan", "blows", "blow", "breeze", "gust", "updraft", "tornado", "air current")),
    ("conveyor", ("conveyor", "belt", "treadmill", "escalator", "moving floor", "moving walkway")),
    ("low_gravity", ("low gravity", "moon", "zero gravity", "no gravity", "floaty", "outer space")),
    ("slow", ("mud", "muddy", "honey", "sticky", "swamp", "goo", "gooey", "tar", "quicksand", "molasses", "slows you",
              "slow you", "makes you slow", "slows you down")),
]
_SAW = ("saw", "saws", "buzzsaw", "blade", "blades", "spinning", "spins", "spinny", "sawblade")
_MOVING = ("moves", "moving", "move", "slides", "sliding", "goes back and forth", "back and forth", "up and down",
           "side to side", "left and right", "elevator", "lift", "goes up", "goes down", "travels", "glides")
_CRUMBLE = ("crumble", "crumbles", "crumbling", "breaks", "breaking", "break", "cracks", "cracked", "crack", "fragile",
            "falls apart", "shatters", "shatter", "breaks when")
_FALLING = ("falls", "falling", "drops", "drop", "fall down", "falls down")
_SPRING = ("spring", "springs", "springy", "trampoline", "jump pad", "bounce pad", "launch pad", "launcher",
           "springboard", "boing", "bouncy", "bounce", "bounces", "launches")
_SPRING_NOUNS = ("spring", "trampoline", "jump pad", "bounce pad", "launch pad", "launcher", "springboard")
_PLATFORM_NOUNS = ("platform", "platforms", "floor", "ground", "block", "blocks", "bridge", "ledge", "brick", "bricks",
                   "wall", "step", "steps", "stairs", "log", "plank", "shelf", "tile", "tiles", "slab")
_ONE_WAY = ("jump through", "jump up through", "one way", "one-way", "pass through", "thin", "cloud", "stand on")
_HAZARD = ("spike", "spikes", "spiky", "lava", "fire", "flame", "flames", "hot", "burns", "burn", "hurts", "hurt",
           "ouch", "poison", "poisonous", "thorn", "thorns", "acid", "danger", "dangerous", "deadly", "kills", "kill",
           "trap", "needles", "electric", "sharp", "cactus")
_CREATURE_NOUNS = ("monster", "enemy", "enemies", "creature", "animal", "guy", "baddie", "bad guy", "villain", "beast",
                   "alien", "critter", "pet")
_ON_YOU = ("on you", "on your head", "on the player", "on top of you")
_PLAYER = ("this is me", "it's me", "its me", "my hero", "main character", "play as", "i play", "you play as",
           "my character", "the hero you play")
_PROP = ("decoration", "decorations", "just for looks", "background", "pretty", "scenery", "sign")
_RESPAWN = ("comes back", "come back", "respawns", "respawn", "grows back", "again")
_BIG = ("super", "big", "huge", "really high", "mega", "giant", "strong", "very")
_SMALL = ("small", "tiny", "little", "low", "weak", "gentle", "soft", "light")
_COLOURS = ("red", "blue", "green", "yellow", "orange", "purple", "pink", "black", "white", "gold")
_NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
            "ten": 10, "twelve": 12, "fifteen": 15, "twenty": 20, "a few": 3}
_FILLER = {"it", "its", "it's", "is", "a", "an", "the", "and", "my", "very", "really", "so", "cool", "awesome", "this",
           "that", "he", "she", "they", "thing", "one", "of", "to", "be", "was", "has", "with", "like", "kind", "sort",
           "super", "i", "me", "you", "your", "can", "just", "also", "too", "then", "but", "when", "we", "our"}

# what an object description may say (rule cues are left out: an object's "when you touch it, it explodes" is not
# something the keyword reader makes, so it is reported as unknown)
_ALL_WORDS: tuple[str, ...] = tuple(dict.fromkeys(
    _NPC + _PORTAL + _PICKUP_NOUNS + _PICKUP_VERBS + sum((w for _, w in _EFFECTS), ()) +
    sum((w for _, w in _ZONES), ()) + _SAW + _MOVING + _CRUMBLE + _FALLING + _SPRING + _PLATFORM_NOUNS + _ONE_WAY +
    _HAZARD + _CREATURE_NOUNS + _ON_YOU + _PLAYER + _PROP + _RESPAWN + _BIG + _SMALL + _COLOURS +
    sum((w for _, w in mcreature._ARCHETYPE_WORDS), ()) + mcreature._FAST + mcreature._SLOW + mcreature._SPIKY +
    ("up", "down", "left", "right", "seconds", "second", "blocks", "cells", "squares", "spaces", "loop", "around")))
_NUM = r"(\d+(?:\.\d+)?|" + "|".join(sorted(_NUMBERS, key=len, reverse=True)) + r")"
_CELLS_RE = re.compile(_NUM + r"\s*(?:blocks?|cells?|squares?|spaces?|tiles?)\b")
_SECONDS_RE = re.compile(_NUM + r"\s*(?:seconds?|secs?)\b")
_QUOTES_RE = re.compile(r"[\"“”«»]([^\"“”«»]{1,120})[\"“”«»]|‘([^‘’]{1,120})’")
_SAYS_RE = re.compile(r"\b(?:says|say|said|tells you|tells|asks|sings|shouts|yells)\s+(.+?)(?:[.!?;]|$)", re.I)
_CLAUSES = re.compile(r"[.,;!?\n]+|\band then\b|\bbut\b|\band\b")
_KEEP_AND = re.compile(r"\b(back|up|left|side) (and|to) (forth|down|right|side)\b", re.I)  # one phrase, not two clauses


def _has(t: str, words: tuple[str, ...]) -> bool:
    return bool(_hits(t, words))


def _number(s: str) -> float | None:
    s = s.strip().lower()
    if s in _NUMBERS:
        return float(_NUMBERS[s])
    try:
        return float(s)
    except ValueError:
        return None


def _cells(text: str, default: int, lo: int, hi: int) -> int:
    m = _CELLS_RE.search(text.lower())
    n = _number(m.group(1)) if m else None
    return sanitize.clamp(n if n is not None else default, lo, hi)


def _seconds(text: str, default: float, lo: float, hi: float) -> float:
    m = _SECONDS_RE.search(text.lower())
    n = _number(m.group(1)) if m else None
    return round(max(lo, min(hi, n if n is not None else default)), 2)


def _speed(t: str) -> str:
    fast, slow = _has(t, mcreature._FAST), _has(t, mcreature._SLOW)
    return "fast" if fast and not slow else "slow" if slow and not fast else "normal"


def _dir(t: str, default: str, allowed: tuple[str, ...] = ("up", "down", "left", "right")) -> str:
    if _has(t, ("up and down", "vertical", "vertically")) and "up" in allowed:
        return "up"
    if _has(t, ("left and right", "back and forth", "side to side", "sideways", "horizontal")) and "right" in allowed:
        return "right"
    for d in ("up", "down", "left", "right"):
        if d in allowed and _has(t, (d, f"{d}wards", f"{d}ward")):
            return d
    return default


def _strength(t: str) -> str:
    return "big" if _has(t, _BIG) else "small" if _has(t, _SMALL) else "normal"


def _item(t: str, name: str) -> str:
    """The pickup's item name for rules: a pickup noun of the text, else the block's own name, else "star"."""
    for w in _PICKUP_NOUNS:
        if w not in ("pickup", "power up", "powerup", "item", "treasure", "token") and _has(t, (w,)):
            return w[:-1] if w.endswith("s") and w[:-1] in _PICKUP_NOUNS else w
    return mlogic.clean_name(name) or "star"


def npc_lines(text: str) -> list[str]:
    """The npc's lines: quoted words first, else what follows "says"."""
    lines = [sanitize.text(a or b, LINE_CHARS) for a, b in _QUOTES_RE.findall(text or "")]
    if not lines:
        lines = [sanitize.text(m.group(1).strip(" \"'"), LINE_CHARS) for m in _SAYS_RE.finditer(text or "")]
    return [ln for ln in lines if ln and not moderate.blocklist_hit([ln])][:MAX_LINES]


def unknown_parts(text: str) -> list[str]:
    """Clauses of the text that no vocabulary word explains (in the maker's words, quotes left out)."""
    body = _KEEP_AND.sub(lambda m: f"{m.group(1)}\x01{m.group(2)}\x01{m.group(3)}", _QUOTES_RE.sub(" ", text or ""))
    out: list[str] = []
    for raw in _CLAUSES.split(body):
        clause = sanitize.text(raw.replace("\x01", " "), 80).strip(" -")
        words = re.findall(r"[a-z0-9']+", clause.lower())
        if len([w for w in words if w not in _FILLER]) < 1 or len(words) < 2:
            continue
        t = _norm(clause)
        if _hits(t, _ALL_WORDS) or _CELLS_RE.search(clause.lower()) or _SECONDS_RE.search(clause.lower()):
            continue
        if clause not in out:
            out.append(clause)
    return out[:MAX_UNKNOWN]


def _sentences(text: str) -> list[str]:
    return [s for s in (sanitize.text(x, 200) for x in re.split(r"[.!?;\n]+", text or "")) if s]


# ---- the keyword reader ---------------------------------------------------------------------------------------------------


def _result(kind: str, behavior: dict[str, Any] | None, *, spiky: bool = False, collision: str = "none",
            logic: list[dict[str, Any]] | None = None, summary: str, unknown: list[str],
            source: str = "keywords") -> dict[str, Any]:
    return {"kind": kind, "behavior": behavior, "spiky": bool(spiky), "collision": collision, "logic": logic or [],
            "summary": sanitize.text(summary, SUMMARY_CHARS), "unknown": unknown[:MAX_UNKNOWN], "source": source}


# creature words that name a thing (verbs a rule also uses, "jump", "fire", "float", are left out)
_RULE_SAFE = {"jump", "jumps", "jumping", "fire", "fires", "throw", "throws", "spring", "springy", "follow", "follows",
              "stay", "stays", "still", "float", "floats", "floating", "hover", "hovers", "charge", "charges", "rushes",
              "sit", "sits", "stuck", "fly", "flies", "flying", "bounce", "bounces", "zap", "zaps", "walk", "walks"}
_THING_WORDS = (_NPC + _PORTAL + _SAW + _PLATFORM_NOUNS + _CREATURE_NOUNS + sum((w for _, w in _ZONES), ())
                + tuple(w for _, words in mcreature._ARCHETYPE_WORDS for w in words if w not in _RULE_SAFE))


def _is_rule_pack(t: str) -> bool:
    if _has(t, _THING_WORDS):
        return False
    if _has(t, _RULE_CUES) or re.search(r"\bevery \d+ seconds?\b", t):
        return True
    return _has(t, _WEAK_RULE_CUES) and not _has(t, _PICKUP_NOUNS)


def keyword_object(name: str, text: str) -> dict[str, Any]:
    """The offline draft for objects (everything except rule packs). Never raises."""
    nm = sanitize.text(name, 16) or "It"
    t = _norm(text)
    tn = _norm(f"{text} {name}")
    unknown = unknown_parts(text)

    # talkers: quoted words or a talking verb
    if _QUOTES_RE.search(text or "") or _has(t, _NPC):
        lines = npc_lines(text)
        if not lines:
            lines = ["Hi!"]
        return _result("prop", {"kind": "npc", "lines": lines, "name": sanitize.opt_text(name, 16)},
                       summary=f"{nm} says something when you touch it.", unknown=unknown)
    if _has(t, _PLAYER):
        return _result("player", {"kind": "static"}, summary=f"{nm} is the hero you play.", unknown=unknown)
    if _has(tn, _PORTAL):
        pair = next((c for c in _COLOURS if _has(t, (c,))), "a")
        return _result("prop", {"kind": "portal", "pair": pair},
                       summary="Step in to jump to the other portal with the same colour.", unknown=unknown)
    if _has(tn, _PICKUP_NOUNS) or _has(t, _PICKUP_VERBS):
        effect = next((e for e, words in _EFFECTS if _has(t, words)), "none")
        item = _item(tn, name)
        secs = _seconds(text, 5.0, 1.0, 60.0)
        b = {"kind": "pickup", "item": item, "effect": effect, "seconds": secs,
             "respawn_s": 5.0 if _has(t, _RESPAWN) else None}
        what = {"none": "collect it", "speed": f"go fast for {secs:g} seconds",
                "jump": f"jump higher for {secs:g} seconds", "flip": "flip gravity", "heart": "get a heart back",
                "score": "score 10 points", "freeze": f"freeze enemies for {secs:g} seconds",
                "low_gravity": f"float for {secs:g} seconds"}[effect]
        return _result("pickup", b, summary=f"Grab the {item} to {what}.", unknown=unknown)
    zone = next((z for z, words in _ZONES if _has(t, words)), None)
    if zone is not None:
        strength = {"big": 1.5, "small": 0.5}.get(_strength(t), 1.0)
        d = "right"  # only wind and conveyors push
        if zone in ("wind", "conveyor"):
            d = _dir(t, "up" if zone == "wind" and _has(t, ("fan", "updraft")) else "right")
        b = {"kind": "zone", "effect": zone, "dir": d, "strength": strength}
        what = {"wind": f"Wind pushes you {d} here.", "water": "You swim in this water.",
                "ice": "The ground here is slippery.", "low_gravity": "You float in here.",
                "conveyor": f"The floor carries you {d}.", "slow": "You move slowly in here."}[zone]
        return _result("prop", b, summary=what, unknown=unknown)
    hazard_noun = _has(t, _HAZARD)
    if _has(t, _SAW):
        d = _dir(t, "none", ("up", "down", "left", "right"))
        moves = d != "none" or _has(t, _MOVING)
        b = {"kind": "saw", "radius": 1.0, "dir": d if moves and d != "none" else ("right" if moves else "none"),
             "cells": _cells(text, 4, 1, 20) if moves else 0, "speed": sanitize.grid_enum("saw_speed", _speed(tn))}
        return _result("hazard", b, spiky=True, summary="A spinning saw. Don't touch it!", unknown=unknown)
    creature_cue = (_has(t, _CREATURE_NOUNS) or _has(t, _ON_YOU)
                    or any(_has(t, w) for a, w in mcreature._ARCHETYPE_WORDS if a not in ("static",)))
    platform_cue = _has(tn, _PLATFORM_NOUNS) or _has(t, _ONE_WAY) or _has(tn, _SPRING_NOUNS)
    motion = ("spring" if _has(t, _SPRING) else "crumble" if _has(t, _CRUMBLE) else
              "move" if _has(t, _MOVING) else "falling" if _has(t, _FALLING) and not _has(t, _ON_YOU) else None)
    if motion is not None and (platform_cue or hazard_noun or not creature_cue):
        kind = "hazard" if hazard_noun and not platform_cue else "platform"
        one_way = _has(t, _ONE_WAY)
        if motion == "spring":
            s = _strength(t)
            b = {"kind": "spring", "dir": _dir(t, "up", ("up", "left", "right")),
                 "strength": sanitize.grid_enum("spring_strength", s, default="normal")}
            return _result(kind, b, spiky=kind == "hazard", collision="solid" if kind == "platform" else "none",
                           summary="Land on it to bounce up high!", unknown=unknown)
        if motion == "crumble":
            b = {"kind": "crumble", "delay_s": sanitize.grid_enum("crumble_delay", _speed(tn)), "respawn_s": 3.0}
            return _result(kind, b, collision="one_way" if one_way else "solid",
                           summary="It crumbles away soon after you step on it.", unknown=unknown)
        if motion == "falling":
            return _result(kind, {"kind": "falling", "delay_s": 0.4}, collision="one_way" if one_way else "solid",
                           summary="It falls when you stand on it. Keep moving!", unknown=unknown)
        d = _dir(t, "right")
        b = {"kind": "move", "dir": d, "cells": _cells(text, 4, 2, 20),
             "speed": sanitize.grid_enum("platform_speed", _speed(tn)), "mode": "loop" if _has(t, ("loop", "around")) else "pingpong"}
        across = "up and down" if d in ("up", "down") else "left and right"
        if kind == "hazard":
            return _result("hazard", b, spiky=True, summary=f"It moves {across}. Don't touch it!", unknown=unknown)
        return _result("platform", b, collision="solid" if _has(t, ("solid",)) else "one_way",
                       summary=f"A platform that moves {across}.", unknown=unknown)
    one_way = _has(t, _ONE_WAY)
    if platform_cue and (not creature_cue or one_way and not _has(t, _CREATURE_NOUNS)):  # "a cloud you jump through"
        return _result("platform", {"kind": "static"}, spiky=_has(t, mcreature._SPIKY),
                       collision="one_way" if one_way else "solid",
                       summary="A platform you can jump up through." if one_way else "A solid platform to stand on.",
                       unknown=unknown)
    if _has(t, _PROP) and not creature_cue:
        return _result("prop", {"kind": "static"}, summary=f"{nm} is there to look nice.", unknown=unknown)
    if creature_cue or (_has(_norm(name), sum((w for _, w in mcreature._ARCHETYPE_WORDS), ())) and not hazard_noun):
        spec = mcreature.keyword_spec(name, text)
        return _result("creature", mcreature.behavior_of(spec), spiky=bool(spec["spiky"]), summary=spec["summary"],
                       unknown=unknown)
    if hazard_noun:
        return _result("hazard", {"kind": "static"}, spiky=True, summary="Ouch! Touching it hurts.", unknown=unknown)
    return _result("prop", {"kind": "static"}, summary=f"{nm} stays still.", unknown=unknown)


async def keyword_describe(name: str, text: str, *, rpc: Rpc | None = None) -> dict[str, Any]:
    """The offline BlockDescribeResult. Rule packs go through the core's keyword parser. Never raises."""
    t = _norm(text)
    if text and _is_rule_pack(t):
        sentences = _sentences(text)
        out = await mlogic.keyword_parse(sentences, [], rpc=rpc)
        n = len(out.rules)
        summary = f"{n} rule{'s' if n != 1 else ''} for your game." if n else "Rules for your game."
        return _result("rules", None, logic=out.rules, summary=summary, unknown=out.unknown)
    return keyword_object(name, text)


# ---- the model --------------------------------------------------------------------------------------------------------------


def behavior_of_flat(fb: FlatBehavior, name: str, spiky: bool) -> dict[str, Any] | None:
    """A flat model behaviour → the typed Behavior (grid numbers, clamps), or None when it does not validate."""
    k = fb.kind
    speed = fb.speed if fb.speed in ("slow", "normal", "fast") else "normal"
    d4 = fb.dir if fb.dir in ("up", "down", "left", "right") else None
    b: dict[str, Any]
    if k == "static":
        b = {"kind": "static"}
    elif k == "enemy":
        b = mcreature.behavior_of({"archetype": fb.archetype if fb.archetype != "none" else "walker", "speed": speed,
                                   "spiky": spiky})
    elif k == "move":
        b = {"kind": "move", "dir": d4 or "right", "cells": sanitize.clamp(fb.cells or 4, 2, 20),
             "speed": sanitize.grid_enum("platform_speed", speed), "mode": "pingpong"}
    elif k == "spring":
        b = {"kind": "spring", "dir": d4 if d4 in ("up", "left", "right") else "up",
             "strength": sanitize.grid_enum("spring_strength", fb.strength if fb.strength != "none" else "normal")}
    elif k == "crumble":
        b = {"kind": "crumble", "delay_s": sanitize.grid_enum("crumble_delay", speed), "respawn_s": 3.0}
    elif k == "falling":
        b = {"kind": "falling", "delay_s": 0.4}
    elif k == "saw":
        b = {"kind": "saw", "radius": 1.0, "dir": fb.dir, "cells": sanitize.clamp(fb.cells, 0, 20) if d4 else 0,
             "speed": sanitize.grid_enum("saw_speed", speed)}
    elif k == "portal":
        pair = re.sub(r"[^a-z0-9]+", "", fb.pair.lower())[:8] or "a"
        b = {"kind": "portal", "pair": pair}
    elif k == "zone":
        if fb.zone not in ZONES:
            return None
        b = {"kind": "zone", "effect": fb.zone, "dir": d4 or "right",
             "strength": {"big": 1.5, "small": 0.5}.get(fb.strength, 1.0)}
    elif k == "pickup":
        b = {"kind": "pickup", "item": mlogic.clean_name(fb.item) or mlogic.clean_name(name) or "star",
             "effect": fb.effect if fb.effect in EFFECTS else "none",
             "seconds": round(max(1.0, min(60.0, fb.seconds or 5.0)), 2), "respawn_s": 5.0 if fb.respawns else None}
    elif k == "npc":
        lines = [ln for ln in (sanitize.text(x, LINE_CHARS) for x in fb.lines) if ln and not moderate.blocklist_hit([ln])]
        b = {"kind": "npc", "lines": lines[:MAX_LINES] or ["Hi!"], "name": sanitize.opt_text(name, 16)}
    else:
        return None
    try:
        return _BEHAVIOR.validate_python(b).model_dump(mode="json")
    except ValidationError:
        return None


def from_model(v: BlockSpecFlat, name: str, text: str) -> dict[str, Any] | None:
    """The model's draft, cleaned; None when it cannot be used (the keyword reader answers instead)."""
    if not v.safety_ok:
        return None
    kind = v.kind if v.kind in KINDS else None
    if kind is None:
        return None
    logic, _ = mlogic.sanitize_rules(v.rules, max(1, len(v.rules)), [])
    unknown = [u for u in (sanitize.text(x, 80) for x in v.unknown) if u][:MAX_UNKNOWN]
    summary = sanitize.text(v.summary, SUMMARY_CHARS)
    if kind == "rules":
        if not logic:
            return None
        return _result("rules", None, logic=logic, summary=summary or "Rules for your game.", unknown=unknown,
                       source="model")
    behavior = behavior_of_flat(v.behavior, name, bool(v.spiky))
    if behavior is None:
        return None
    collision = v.collision if v.collision in ("solid", "one_way", "none") else "none"
    return _result(kind, behavior, spiky=bool(v.spiky), collision=collision, logic=logic,
                   summary=summary or (sanitize.text(name, 16) or "It"), unknown=unknown, source="model")


async def describe_call(name: str, text: str, image: bytes | None, *, deadline: float | None = None) -> MindResult[Any]:
    content: list[dict[str, Any]] = []
    if image:
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                     "data": base64.standard_b64encode(image).decode()}})
    content.append({"type": "text", "text": (
        f"Block name: {sanitize.text(name, 24) or '(no name)'}\n"
        f"What the maker wrote: {sanitize.text(text, 300) or '(nothing)'}\n"
        + ("Their drawing is attached." if image else "There is no drawing.")
        + "\nMake the block draft.")})
    dl = deadline if deadline is not None else time.monotonic() + client.CALLS["block_describe"].timeout_s
    try:
        return await client.call("block_describe", BlockSpecFlat, content, draft_id=None, deadline=dl)
    except Exception as e:  # noqa: BLE001 - call() never raises; belt and braces
        return MindResult[BlockSpecFlat](kind="block_describe", status="failed", error=type(e).__name__)


async def describe(name: str, text: str, strokes: list[dict[str, Any]] | None = None, *,
                   rpc: Rpc | None = None) -> dict[str, Any]:
    """POST /blocks/describe: the model when it can answer, else the keyword reader. Never raises."""
    if client.available():
        try:
            img = mcreature.creature_image(strokes or [])
        except Exception:  # noqa: BLE001
            img = None
        r = await describe_call(name, text, img)
        if r.ok and r.value is not None:
            out = from_model(r.value, name, text)
            if out is not None:
                return out
    return await keyword_describe(name, text, rpc=rpc)
