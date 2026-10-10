"""CREATURE (PLAN_V2 §8.1, §3.10): a creature's name, the child's sentence and its drawing → one archetype, a speed and
"spiky". The answer only pre-selects the Creature Studio chips; the kid can change any of them before saving.

    interpret(name, text, strokes) → Interpretation(spec, behavior, source: "model" | "keywords")

Offline (no key, fake without a reply, over budget, a failed or refused call) the keyword reader below picks the
chips: verbs and animals map to archetypes ("flies", "bat" → flyer; "hops", "frog" → hopper), speed words to
slow/normal/fast, and "spiky", "thorns", "don't jump on it" to spiky. A negated verb ("it doesn't fly") never counts.
When the sentence and the drawing disagree the child's words win (creature.md), so the keywords also run on top of
a model answer only to catch a missed explicit negation; otherwise the model's answer stands.

`behavior_of(spec)` maps the enums to the typed Behavior with numbers from the §5.6 grids (params.json GRIDS):
walker/flyer/chaser speed in c/s, hopper and shooter intervals and the crusher warn time in seconds.
"""
from __future__ import annotations

import base64
import io
import re
import time
from dataclasses import dataclass
from typing import Any, Literal

from app.mind import client, moderate, sanitize
from app.mind import schemas as ms
from app.mind.client import MindResult

IMAGE_PX = 512  # ≤ 512 px creature image (§3.10)
SUMMARY_CHARS = 120

Archetype = Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher", "static"]

# word → archetype; checked in this priority order (a "flying frog" flies, a "hopping cannon" shoots)
_ARCHETYPE_WORDS: list[tuple[str, tuple[str, ...]]] = [
    ("crusher", ("smash", "smashes", "crush", "crushes", "crusher", "thwomp", "squash", "squashes", "drops on",
                 "falls on", "fall on", "slam", "slams", "pound", "pounds", "boulder", "rock", "anvil", "stomper")),
    ("shooter", ("shoot", "shoots", "shooting", "shooter", "spit", "spits", "fire", "fires", "throws", "throw", "cannon",
                 "turret", "laser", "lasers", "blaster", "zaps", "zap", "blows bubbles", "sneezes")),
    ("flyer", ("fly", "flies", "flying", "flyer", "flew", "wing", "wings", "bat", "bird", "bee", "bees", "butterfly",
               "dragon", "ghost", "float", "floats", "floating", "hover", "hovers", "owl", "eagle", "fairy", "ufo",
               "balloon", "cloud", "jellyfish", "drone")),
    ("chaser", ("chase", "chases", "chasing", "chaser", "hunt", "hunts", "hunting", "follows", "follow", "runs after",
                "run after", "comes after", "angry when", "gets angry", "charges", "charge", "rushes", "wolf", "bull")),
    ("hopper", ("hop", "hops", "hopping", "hopper", "jump", "jumps", "jumping", "bounce", "bounces", "bouncy", "boing",
                "frog", "toad", "bunny", "rabbit", "kangaroo", "spring", "springy", "flea", "grasshopper", "slime")),
    ("static", ("sleep", "sleeps", "sleeping", "asleep", "sleepy", "stays", "stay", "still", "statue", "doesn't move",
                "does not move", "never moves", "just sits", "sits", "plant", "flower", "tree", "lazy", "stuck")),
    ("walker", ("walk", "walks", "walking", "walker", "patrol", "patrols", "marches", "march", "wanders", "wander",
                "crawl", "crawls", "rolls", "goes back and forth", "back and forth", "legs", "snail", "bug", "beetle",
                "ant", "spider", "crab", "robot", "zombie", "dino", "dinosaur", "cat", "dog", "pig", "monster")),
]
_FAST = ("fast", "quick", "quickly", "speedy", "zoom", "zooms", "zooming", "super fast", "really fast", "racing",
         "races", "rushes", "dash", "dashes", "sprint", "sprints", "rocket", "lightning", "hyper")
_SLOW = ("slow", "slowly", "lazy", "sleepy", "sneaky", "tired", "snail", "sloth", "turtle", "tortoise", "gentle",
         "creeps", "creep", "sluggish")
_SPIKY = ("spike", "spikes", "spiky", "spikey", "pointy", "thorn", "thorns", "thorny", "prickly", "cactus", "porcupine",
          "hedgehog", "sharp", "needles", "don't jump on", "dont jump on", "do not jump on", "can't stomp", "cant stomp",
          "can't jump on", "cant jump on", "ouch on top")
_NEGATIONS = ("not", "never", "doesn't", "doesnt", "don't", "dont", "can't", "cant", "cannot", "won't", "wont", "no")
_NEGATION_EXEMPT = {"doesn't move", "does not move", "never moves", "don't jump on", "dont jump on", "do not jump on",
                    "can't stomp", "cant stomp", "can't jump on", "cant jump on"}

DOES = {"walker": "walks back and forth", "hopper": "hops toward you", "flyer": "flies around",
        "shooter": "shoots ink blobs", "chaser": "chases you when it sees you", "crusher": "drops down to squash you",
        "static": "stays still"}


@dataclass
class Interpretation:
    spec: dict[str, Any]  # CreatureSpecJson
    behavior: dict[str, Any]  # Behavior
    source: Literal["model", "keywords"]
    result: MindResult[Any] | None = None


def _norm(s: str) -> str:
    return " " + re.sub(r"[^a-z0-9' ]+", " ", (s or "").lower().replace("’", "'")) + " "


def _hits(text: str, words: tuple[str, ...]) -> list[int]:
    """Positions of every non-negated occurrence of any of `words` (whole words or phrases)."""
    out = []
    for w in words:
        for m in re.finditer(r"(?<= )" + re.escape(w) + r"(?= )", text):
            if w in _NEGATION_EXEMPT:
                out.append(m.start())
                continue
            before = text[: m.start()].split()[-2:]
            if any(b in _NEGATIONS for b in before):
                continue
            out.append(m.start())
    return out


def keyword_spec(name: str, text: str) -> dict[str, Any]:
    """The offline chips (CreatureSpecJson) from the name and the sentence."""
    t = _norm(f"{text} {name}")
    arche: str = "walker"
    best: int | None = None
    sentence = _norm(text)
    # the sentence's verbs decide first; the name ("Bat Bob") only when the sentence says nothing
    for src in (sentence, t):
        for a, words in _ARCHETYPE_WORDS:
            pos = _hits(src, words)
            if pos and (best is None or a != "walker"):
                arche, best = a, min(pos)
                break
        if best is not None:
            break
    fast = bool(_hits(t, _FAST))
    slow = bool(_hits(t, _SLOW))
    speed = "fast" if fast and not slow else "slow" if slow and not fast else "normal"
    spiky = bool(_hits(t, _SPIKY))
    nm = sanitize.text(name, 16) or "It"
    return {"archetype": arche, "speed": speed, "spiky": spiky, "summary": summary_line(nm, arche, spiky),
            "safety_ok": moderate.blocklist_hit([name, text]) is None}


def summary_line(name: str, archetype: str, spiky: bool) -> str:
    tail = "Don't jump on it!" if spiky else ("Jump over it!" if archetype in ("crusher", "shooter") else "Jump on it!")
    if archetype == "static":
        tail = "Don't touch it!" if spiky else "Jump on it!"
    return sanitize.text(f"{name} {DOES.get(archetype, 'moves')}. {tail}", SUMMARY_CHARS)


def behavior_of(spec: dict[str, Any]) -> dict[str, Any]:
    """CreatureSpec enums → the typed Behavior with grid numbers (§5.6, §5.7)."""
    a = spec.get("archetype") or "walker"
    speed = spec.get("speed") if spec.get("speed") in ("slow", "normal", "fast") else "normal"
    spiky = bool(spec.get("spiky"))
    if a == "static":
        return {"kind": "static"}
    params: dict[str, Any] = {}
    if a == "walker":
        params = {"speed": sanitize.grid_enum("walker_speed", speed), "ledge_aware": True}
    elif a == "flyer":
        params = {"speed": sanitize.grid_enum("flyer_speed", speed), "pattern": "horizontal", "range": 4}
    elif a == "chaser":
        params = {"speed": sanitize.grid_enum("chaser_speed", speed), "sight": 8}
    elif a == "hopper":
        params = {"interval": sanitize.grid_enum("hopper_interval", speed), "forward": True}
    elif a == "shooter":
        params = {"interval": sanitize.grid_enum("shooter_interval", speed), "facing": "toward_player"}
    elif a == "crusher":
        params = {"warn": sanitize.grid_enum("crusher_warn", speed)}
    return {"kind": "enemy", "archetype": a, "spiky": spiky, "params": params}


def creature_image(strokes: list[dict[str, Any]], px: int = IMAGE_PX) -> bytes | None:
    """The creature's strokes rendered on white, fitted into a px × px PNG (None when there is nothing to draw)."""
    pts = [p for s in strokes or [] if isinstance(s, dict) for p in s.get("pts") or [] if isinstance(p, (list, tuple))]
    if not pts:
        return None
    from PIL import Image, ImageDraw

    from app.mind.render import _draw_stroke  # the same marker look as the PERCEIVE images

    xs = [float(p[0]) for p in pts]
    ys = [float(p[1]) for p in pts]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    span = max(x1 - x0, y1 - y0, 0.5)
    pad = 0.12 * span
    ppc = (px - 8) / (span + 2 * pad)
    img = Image.new("RGB", (px, px), (255, 255, 255))
    d = ImageDraw.Draw(img)
    ox = (px - (x1 - x0) * ppc) / 2 - x0 * ppc
    oy = (px - (y1 - y0) * ppc) / 2 - y0 * ppc

    def to_px(x: float, y: float) -> tuple[float, float]:
        return ox + x * ppc, oy + y * ppc

    for s in strokes:
        try:
            _draw_stroke(d, s, to_px, ppc)
        except Exception:  # noqa: BLE001 - one odd stroke never loses the image
            continue
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def creature(name: str, text: str, image: bytes | None, *, draft_id: str | None = None,
                   deadline: float | None = None) -> MindResult[Any]:
    """§11.3d `creature`: never raises."""
    content: list[dict[str, Any]] = []
    if image:
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                     "data": base64.standard_b64encode(image).decode()}})
    content.append({"type": "text", "text": (
        f"Creature name: {sanitize.text(name, 16) or '(no name)'}\n"
        f"What the child wrote: {sanitize.text(text, 200) or '(nothing)'}\n"
        + ("The drawing is attached." if image else "There is no drawing yet.")
        + "\nMap it to one archetype, a speed and spiky.")})
    dl = deadline if deadline is not None else time.monotonic() + client.CALLS["creature"].timeout_s
    return await client.call("creature", ms.CreatureSpec, content, draft_id=draft_id, deadline=dl)


def _from_model(v: Any, name: str, text: str) -> dict[str, Any]:
    spec = {"archetype": v.archetype, "speed": v.speed, "spiky": bool(v.spiky),
            "summary": sanitize.text(v.summary, SUMMARY_CHARS), "safety_ok": bool(v.safety_ok)}
    # the child's explicit words win over the picture: "it doesn't fly" never yields a flyer
    t = _norm(text)
    for a, words in _ARCHETYPE_WORDS:
        if a == spec["archetype"]:
            neg = any(re.search(r"(?:" + "|".join(re.escape(n) for n in _NEGATIONS) + r") (?:\w+ )?" + re.escape(w) + r"(?= )", t)
                      for w in words if w not in _NEGATION_EXEMPT)
            if neg and not _hits(t, words):
                kw = keyword_spec(name, text)
                spec["archetype"] = kw["archetype"] if kw["archetype"] != a else "walker"
            break
    if not spec["summary"]:
        spec["summary"] = summary_line(sanitize.text(name, 16) or "It", spec["archetype"], spec["spiky"])
    if moderate.blocklist_hit([name, text]):
        spec["safety_ok"] = False
    return spec


async def interpret(name: str, text: str, strokes: list[dict[str, Any]], *, draft_id: str | None = None) -> Interpretation:
    """POST /library/interpret: the model when it can answer, else the keyword chips. Never raises."""
    r: MindResult[Any] | None = None
    if client.available():
        try:
            img = creature_image(strokes)
        except Exception:  # noqa: BLE001
            img = None
        r = await creature(name, text, img, draft_id=draft_id)
        if r.ok and r.value is not None:
            spec = _from_model(r.value, name, text)
            return Interpretation(spec=spec, behavior=behavior_of(spec), source="model", result=r)
    spec = keyword_spec(name, text)
    return Interpretation(spec=spec, behavior=behavior_of(spec), source="keywords", result=r)
