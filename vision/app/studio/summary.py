"""The game summary the copilot reads (CONTRACTS_V6 §5.3) and the shape guesses behind it.

Never raw strokes: per object its id, name, kind, position, size, body, behaviours with their non-default params,
rules as short sentences, counters, tags, player, joints, the colours it is drawn in (hex + a plain colour name, so
"the blue blobs" can be found) and a rough guess of what the strokes look like ("1 long line", "1 box + 2 circles").
The keyword fallback uses the same shape guesses to re-purpose drawings.
"""
from __future__ import annotations

import colorsys
import json
import math
from dataclasses import dataclass, field
from typing import Any

from app.studio import catalog

MAX_DETAILED_OBJECTS = 150
MAX_RULES_LISTED = 30


# ---- colours ------------------------------------------------------------------------------------------------------


def colour_name(hex_: str) -> str:
    """A plain colour word for #rrggbb ("blue", "dark green", "black")."""
    try:
        r, g, b = (int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5))
    except (ValueError, TypeError, IndexError):
        return "black"
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if l < 0.16:
        return "black"
    if l > 0.9 and s < 0.5:
        return "white"
    if s < 0.18:
        return "gray"
    deg = h * 360
    if deg < 15 or deg >= 340:
        name = "pink" if l > 0.7 else "red"
    elif deg < 40:
        name = "brown" if l < 0.4 else "orange"
    elif deg < 70:
        name = "brown" if l < 0.3 else "yellow"
    elif deg < 165:
        name = "green"
    elif deg < 200:
        name = "teal" if l < 0.5 else "cyan"
    elif deg < 255:
        name = "blue"
    elif deg < 290:
        name = "purple"
    else:
        name = "pink"
    return name


COLOUR_WORDS = {
    "red": {"red", "pink"}, "pink": {"pink", "red", "purple"}, "orange": {"orange", "brown"},
    "yellow": {"yellow"}, "gold": {"yellow", "orange"}, "green": {"green", "teal"}, "teal": {"teal", "cyan", "green"},
    "cyan": {"cyan", "teal", "blue"}, "blue": {"blue", "cyan", "teal"}, "purple": {"purple", "pink"},
    "violet": {"purple"}, "brown": {"brown", "orange"}, "black": {"black"}, "grey": {"gray"}, "gray": {"gray"},
    "white": {"white", "gray"},
}


# ---- shapes -------------------------------------------------------------------------------------------------------


@dataclass
class Shape:
    """What an object's strokes look like, in world pixels."""

    w: float
    h: float
    strokes: int = 0
    closed: int = 0
    round: int = 0
    boxy: int = 0
    lines: int = 0
    colours: list[str] = field(default_factory=list)  # distinct stroke colours, most used first
    colour_names: list[str] = field(default_factory=list)

    @property
    def area(self) -> float:
        return self.w * self.h

    @property
    def is_long(self) -> bool:
        """A ground or terrain line: much wider than tall."""
        return self.w >= 300 and self.w >= 3.2 * max(self.h, 1)

    @property
    def is_round(self) -> bool:
        return self.strokes > 0 and self.round == self.strokes and 0.6 <= self.w / max(self.h, 1) <= 1.6

    @property
    def is_box(self) -> bool:
        return self.strokes > 0 and self.boxy >= 1 and self.round == 0 and self.lines == 0 and self.strokes <= 2

    def describe(self) -> str:
        if self.strokes == 0:
            return "invisible box" if self.w and self.h else "empty"
        if self.is_long and self.lines >= max(1, self.strokes - 1):
            return "a long line" if self.lines == 1 else f"{self.lines} long lines"
        bits = []
        if self.boxy:
            bits.append("1 box" if self.boxy == 1 else f"{self.boxy} boxes")
        if self.round:
            bits.append("1 circle" if self.round == 1 else f"{self.round} circles")
        other_closed = self.closed - self.boxy - self.round
        if other_closed > 0:
            bits.append("1 closed shape" if other_closed == 1 else f"{other_closed} closed shapes")
        if self.lines:
            bits.append("1 line" if self.lines == 1 else f"{self.lines} lines")
        rest = self.strokes - self.closed - self.lines
        if rest > 0:
            bits.append("1 scribble" if rest == 1 else f"{rest} scribbles")
        return " + ".join(bits)


def _stroke_kind(points: list[Any], closed_flag: bool) -> tuple[bool, bool, bool, bool]:
    """(closed, round, boxy, line) guesses for one stroke."""
    pts = [(float(p[0]), float(p[1])) for p in points if isinstance(p, (list, tuple)) and len(p) >= 2]
    if len(pts) < 2:
        return False, False, False, False
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    size = max(w, h, 1.0)
    gap = math.dist(pts[0], pts[-1])
    closed = closed_flag or (len(pts) >= 4 and gap <= 0.18 * size)
    if not closed:
        # straightness: the end-to-end distance against the path length
        path = sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)) or 1.0
        is_line = size >= 40 and (gap / path >= 0.85 or w >= 3 * max(h, 1))
        return False, False, False, is_line
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    radii = [math.dist((cx, cy), p) for p in pts]
    mean = sum(radii) / len(radii) or 1.0
    cv = math.sqrt(sum((r - mean) ** 2 for r in radii) / len(radii)) / mean
    aspect = w / max(h, 1.0)
    is_round = cv < 0.16 and 0.65 <= aspect <= 1.55
    area = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        area += x0 * y1 - x1 * y0
    fill = abs(area) / 2 / max(w * h, 1.0)
    is_box = not is_round and fill >= 0.8
    return True, is_round, is_box, False


def shape_of(obj: dict[str, Any]) -> Shape:
    d = obj.get("drawing") or {}
    scale = float(obj.get("scale") or 1)
    strokes = d.get("strokes") or []
    w, h = float(d.get("w") or 0), float(d.get("h") or 0)
    if (not w or not h) and strokes:
        xs = [float(p[0]) for s in strokes for p in s.get("points") or []]
        ys = [float(p[1]) for s in strokes for p in s.get("points") or []]
        if xs:
            w, h = max(xs) - min(xs), max(ys) - min(ys)
    sh = Shape(w=round(w * scale, 1), h=round(h * scale, 1), strokes=len(strokes))
    counts: dict[str, int] = {}
    for s in strokes:
        c = str(s.get("color") or "#1f1b18").lower()
        counts[c] = counts.get(c, 0) + len(s.get("points") or [])
        closed, rnd, box, line = _stroke_kind(s.get("points") or [], bool(s.get("closed")))
        sh.closed += closed
        sh.round += rnd
        sh.boxy += box
        sh.lines += line
        if s.get("fill"):
            f = str(s["fill"]).lower()
            counts[f] = counts.get(f, 0) + 1
    sh.colours = [c for c, _ in sorted(counts.items(), key=lambda kv: -kv[1])][:4]
    sh.colour_names = list(dict.fromkeys(colour_name(c) for c in sh.colours))
    return sh


# ---- the summary --------------------------------------------------------------------------------------------------


def _fmt(v: Any) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, str):
        return json.dumps(v)
    return json.dumps(v, separators=(",", ":")) if isinstance(v, (list, dict)) else str(v)


def _nondefault(entry: dict[str, Any] | None, params: dict[str, Any]) -> dict[str, Any]:
    if entry is None:
        return params
    defaults = catalog.defaults(entry)
    return {k: v for k, v in params.items() if defaults.get(k, object()) != v}


def behaviour_text(b: dict[str, Any]) -> str:
    entry = catalog.behaviors().get(str(b.get("type")))
    ps = _nondefault(entry, b.get("params") or {})
    inner = ", ".join(f"{k}={_fmt(v)}" for k, v in ps.items())
    off = " (off)" if b.get("off") else ""
    return f"{b.get('id')}:{b.get('type')}" + (f"({inner})" if inner else "") + off


def _call(kind: str, d: dict[str, Any]) -> str:
    ps = d.get("params") or {}
    inner = ", ".join(f"{k}={_fmt(v)}" for k, v in ps.items())
    return f"{d.get('type')}" + (f"({inner})" if inner else "")


def rule_text(r: dict[str, Any]) -> str:
    when = _call("event", r.get("when") or {})
    conds = " and ".join(f"{c.get('subject', 'self')}.{c.get('counter')} {c.get('op', '>=')} {_fmt(c.get('value', 0))}"
                         for c in r.get("conditions") or [])
    then = "; ".join(_call("action", a) for a in r.get("then") or [])
    flags = "".join([" [once]" if r.get("once") else "", " [off]" if r.get("off") else ""])
    return f"{r.get('id')}: when {when}" + (f" if {conds}" if conds else "") + f" -> {then}{flags}"


def _physics_text(p: dict[str, Any]) -> str:
    bits = [f"{p.get('body', 'static')}/{p.get('shape', 'auto')}"]
    if p.get("sensor"):
        bits.append("passable")
    if p.get("fixed_rotation"):
        bits.append("never tips")
    gs = p.get("gravity_scale", 1)
    if gs not in (1, 1.0, None):
        bits.append(f"gravity x{_fmt(float(gs))}")
    for k, d in (("density", 1.0), ("friction", 0.4), ("bounce", 0.0)):
        if p.get(k) is not None and float(p[k]) != d:
            bits.append(f"{k} {_fmt(float(p[k]))}")
    return " ".join(bits)


def object_text(o: dict[str, Any], *, detailed: bool = True) -> str:
    sh = shape_of(o)
    head = (f"- {o.get('id')}" + (f' "{o["name"]}"' if o.get("name") else "") + f" kind={o.get('kind', 'thing')}"
            f" at ({_fmt(round(float(o.get('x', 0))))},{_fmt(round(float(o.get('y', 0))))})"
            f" size {_fmt(round(sh.w))}x{_fmt(round(sh.h))}")
    if o.get("rotation"):
        head += f" rot {_fmt(float(o['rotation']))}"
    head += f" | looks like: {sh.describe()}"
    if sh.colours:
        head += " | colours: " + ", ".join(f"{colour_name(c)} {c}" for c in sh.colours)
    lines = [head]
    if not detailed:
        return head
    flags = []
    if o.get("player"):
        flags.append(f"player {o['player']}")
    if o.get("template"):
        flags.append("TEMPLATE (not placed; copies are spawned)")
    if o.get("hidden"):
        flags.append("hidden at start")
    if o.get("tags"):
        flags.append("tags " + ",".join(o["tags"]))
    body = "  body " + _physics_text(o.get("physics") or {}) + ("; " + "; ".join(flags) if flags else "")
    lines.append(body)
    if o.get("behaviors"):
        lines.append("  behaviours: " + "; ".join(behaviour_text(b) for b in o["behaviors"]))
    if o.get("counters"):
        lines.append("  counters: " + ", ".join(f"{k}={_fmt(float(v))}" for k, v in o["counters"].items()))
    if o.get("joints"):
        lines.append("  joints: " + "; ".join(
            f"{j.get('type')} to {j.get('to')} at {_fmt(list(j.get('at') or [0, 0]))}" + (" motor" if j.get("motor") else "")
            for j in o["joints"]))
    for r in (o.get("rules") or [])[:12]:
        lines.append("  rule " + rule_text(r))
    return "\n".join(lines)


def world_text(w: dict[str, Any]) -> str:
    cam = w.get("camera") or {}
    cam_s = cam.get("mode", "fixed")
    if cam.get("target"):
        cam_s += f" on {cam['target']}"
    if cam_s.startswith("auto_scroll"):
        cam_s += f" axis {cam.get('axis')} speed {_fmt(float(cam.get('speed', 0)))}"
    if cam.get("zoom") not in (None, 1, 1.0):
        cam_s += f" zoom {_fmt(float(cam['zoom']))}"
    return (f"kind {json.dumps(w.get('kind', ''))}, {_fmt(float(w.get('width', 1600)))}x{_fmt(float(w.get('height', 900)))}"
            f", gravity {_fmt(list(w.get('gravity') or [0, 1]))}, camera {cam_s}, edges {w.get('edges', 'walls')}, "
            f"players {w.get('players', 1)}")


def game_summary(doc: dict[str, Any], scene_id: str, selection: list[str] | None = None) -> str:
    """The text the copilot reads about the game: everything that matters, nothing that is just ink."""
    theme = doc.get("theme") or {}
    hud = doc.get("hud") or {}
    lines = [f'GAME "{doc.get("title", "")}" (id {doc.get("id")})',
             f"Theme: {theme.get('name', 'Sketchbook')}" + (f" (preset {theme['id']})" if theme.get("id") else "")
             + f", background {(theme.get('background') or {}).get('style', 'paper')}, strokes "
             f"{(theme.get('stroke') or {}).get('style', 'marker')}"]
    ad = doc.get("art_direction") or None
    if isinstance(ad, dict) and (ad.get("summary") or ad.get("prompt")):  # one line; never the guide or any art
        lines.append(f"Art style: {str(ad.get('summary') or '')[:160]}" + (f" (asked: {str(ad.get('prompt'))[:120]})"
                                                                          if ad.get("prompt") else ""))
    lines.append(f"Look: {'finished art' if doc.get('look', 'game') == 'game' else 'raw sketch'}")
    items = hud.get("items") or []
    hud_s = ", ".join(f"{i.get('subject', 'game')}.{i.get('counter')} as {i.get('style', 'number')}" for i in items)
    lines.append("HUD: " + (hud_s or "nothing") + (" + timer" if hud.get("timer") else ""))
    counters = doc.get("counters") or {}
    lines.append("Game counters: " + (", ".join(f"{k}={_fmt(float(v))}" for k, v in counters.items()) or "none"))
    grules = doc.get("rules") or []
    lines.append("Game rules (@game): " + ("none" if not grules else ""))
    lines += ["  " + rule_text(r) for r in grules[:MAX_RULES_LISTED]]
    scenes = doc.get("scenes") or []
    for s in scenes:
        if s.get("id") != scene_id:
            lines.append(f'Other scene {s.get("id")} "{s.get("name")}": {len(s.get("objects") or [])} objects, '
                         f"world {(s.get('world') or {}).get('kind', '')!r}")
    scene = next((s for s in scenes if s.get("id") == scene_id), scenes[0] if scenes else {})
    lines.append("")
    lines.append(f'CURRENT SCENE {scene.get("id")} "{scene.get("name", "")}" (the maker is looking at it)')
    lines.append("World: " + world_text(scene.get("world") or {}))
    srules = scene.get("rules") or []
    lines.append("Scene rules (@scene): " + ("none" if not srules else ""))
    lines += ["  " + rule_text(r) for r in srules[:MAX_RULES_LISTED]]
    objects = scene.get("objects") or []
    lines.append(f"Objects ({len(objects)}):" + ("" if objects else " none yet: the canvas is empty"))
    sel = set(selection or [])
    ordered = sorted(objects, key=lambda o: (o.get("id") not in sel, 0))
    for i, o in enumerate(ordered):
        detailed = i < MAX_DETAILED_OBJECTS
        lines.append(object_text(o, detailed=detailed))
        if i >= MAX_DETAILED_OBJECTS * 2:
            lines.append(f"- … and {len(objects) - i - 1} more objects")
            break
    if selection:
        present = [s for s in selection if any(o.get("id") == s for o in objects)]
        lines.append("")
        lines.append("SELECTED (\"this\", \"it\", \"these\" mean these): " + (", ".join(present) or "nothing"))
    else:
        lines.append("")
        lines.append("SELECTED: nothing")
    return "\n".join(lines)


def nearby(doc: dict[str, Any], scene_id: str, object_id: str, limit: int = 6) -> list[tuple[dict[str, Any], float]]:
    """Objects whose box is within about one object size of `object_id`'s box, nearest first."""
    scene = next((s for s in doc.get("scenes") or [] if s.get("id") == scene_id), None)
    if scene is None:
        return []
    objs = scene.get("objects") or []
    me = next((o for o in objs if o.get("id") == object_id), None)
    if me is None:
        return []
    ms = shape_of(me)
    reach = max(ms.w, ms.h, 60) * 1.2
    out = []
    for o in objs:
        if o is me or o.get("template"):
            continue
        s = shape_of(o)
        dx = max(0.0, abs(float(o.get("x", 0)) - float(me.get("x", 0))) - (s.w + ms.w) / 2)
        dy = max(0.0, abs(float(o.get("y", 0)) - float(me.get("y", 0))) - (s.h + ms.h) / 2)
        gap = math.hypot(dx, dy)
        if gap <= reach:
            out.append((o, gap))
    out.sort(key=lambda t: t[1])
    return out[:limit]
