"""What the art calls read about the game and its objects: roles in plain words, attachments, sizes on screen.

Never raw strokes and never art payloads: the drawing itself is sent as a picture (render.sketch_svg)."""
from __future__ import annotations

import math
from typing import Any

from app.mind import sanitize
from app.studio.summary import colour_name, shape_of

CONTROL = {"platformer": "runs and jumps", "car": "drives (a motorised vehicle)", "thrust_ship": "flies (a ship)",
           "move_keys": "moves around", "launcher": "gets launched with a slingshot", "melee": "swings an attack",
           "shooter": "shoots"}
ENEMY = {"patrol", "follow", "ai_fighter", "damage"}


def scene_of(doc: dict[str, Any], scene_id: str | None) -> dict[str, Any]:
    scenes = doc.get("scenes") or []
    return next((s for s in scenes if s.get("id") == scene_id), None) or (scenes[0] if scenes else {})


def all_objects(doc: dict[str, Any]) -> list[dict[str, Any]]:
    return [o for s in doc.get("scenes") or [] for o in s.get("objects") or []]


def has_strokes(o: dict[str, Any]) -> bool:
    return bool((o.get("drawing") or {}).get("strokes"))


def is_ground(o: dict[str, Any]) -> bool:
    return (o.get("physics") or {}).get("shape") == "line"


def role_of(o: dict[str, Any]) -> str:
    """What the object does in play, in plain words."""
    btypes = [str(b.get("type")) for b in o.get("behaviors") or [] if not b.get("off")]
    ph = o.get("physics") or {}
    bits: list[str] = []
    if is_ground(o):
        bits.append("ground: solid land along the drawn line")
    if o.get("player"):
        verbs = [CONTROL[b] for b in btypes if b in CONTROL]
        bits.append(f"the player's {('character that ' + ', '.join(verbs)) if verbs else 'object'}")
    elif any(b in CONTROL for b in btypes):
        bits.append("controlled: " + ", ".join(CONTROL[b] for b in btypes if b in CONTROL))
    tags = set(o.get("tags") or [])
    if "enemy" in tags or (ENEMY & set(btypes) and not o.get("player")):
        bits.append("an enemy or danger to the player")
    if "pickup" in btypes:
        bits.append("a pickup, collected when touched")
    if "goal" in btypes:
        bits.append("the goal to reach")
    if "hazard" in btypes:
        bits.append("a hazard, dangerous to touch")
    if "oscillate" in btypes or "rotate" in btypes:
        bits.append("moves by itself (" + ", ".join(b for b in btypes if b in ("oscillate", "rotate")) + ")")
    if o.get("template"):
        bits.append("copies of it are spawned during play")
    if not bits:
        body = ph.get("body", "static")
        bits.append({"static": "solid scenery (a platform, wall or block)" if not ph.get("sensor") else
                     "a zone things pass through", "dynamic": "a loose object that falls and gets pushed",
                     "kinematic": "a moving platform", "none": "decoration only"}.get(body, "scenery"))
    return "; ".join(bits)


def local_of(body: dict[str, Any], other: dict[str, Any]) -> tuple[float, float, float, float]:
    """`other`'s placement in `body`'s local drawing frame: (dx, dy, rotation, scale)."""
    dx, dy = float(other.get("x", 0)) - float(body.get("x", 0)), float(other.get("y", 0)) - float(body.get("y", 0))
    a = math.radians(-float(body.get("rotation", 0) or 0))
    s = float(body.get("scale", 1) or 1)
    lx = (dx * math.cos(a) - dy * math.sin(a)) / s
    ly = (dx * math.sin(a) + dy * math.cos(a)) / s
    rot = float(other.get("rotation", 0) or 0) - float(body.get("rotation", 0) or 0)
    return lx, ly, rot, float(other.get("scale", 1) or 1) / s


def attachments(scene: dict[str, Any], o: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(objects this one is joined TO, e.g. a car's wheels; objects joined to THIS one, e.g. the car of a wheel)."""
    by_id = {x.get("id"): x for x in scene.get("objects") or []}
    mine = [by_id[j.get("to")] for j in o.get("joints") or [] if j.get("to") in by_id]
    theirs = [x for x in scene.get("objects") or [] if any(j.get("to") == o.get("id") for j in x.get("joints") or [])]
    return mine, theirs


def object_brief(doc: dict[str, Any], scene: dict[str, Any], o: dict[str, Any], view_w: float, view_h: float,
                 units_per_px: float) -> str:
    """The object's brief for the draw and review calls."""
    from app.studio.art.render import box_of

    w, h = box_of(o)
    sc = float(o.get("scale", 1) or 1)
    sh = shape_of(o)
    mine, theirs = attachments(scene, o)
    lines = [f"OBJECT {o.get('id')}: kind \"{sanitize.text(o.get('kind'), 24) or 'thing'}\""
             + (f", named \"{sanitize.text(o.get('name'), 32)}\"" if o.get("name") else ""),
             f"What it does in play: {role_of(o)}.",
             f"Physics: {(o.get('physics') or {}).get('body', 'static')} body, shape "
             f"{(o.get('physics') or {}).get('shape', 'auto')}"
             + (", never tips over" if (o.get("physics") or {}).get("fixed_rotation") else "") + ".",
             f"Box (the drawing's size): {round(w)} x {round(h)} world px; on screen about {round(w * sc)} x "
             f"{round(h * sc)} px at normal zoom" + (f" (rotated {round(float(o['rotation']))} deg in the level)"
                                                     if o.get("rotation") else "") + ".",
             f"The maker's strokes: {sh.describe()}; colours: "
             + (", ".join(f"{colour_name(c)} {c}" for c in sh.colours) or "black pen") + "."]
    for other in mine:
        lx, ly, _, s2 = local_of(o, other)
        ow, oh = box_of(other)
        cx, cy = (lx + w / 2) / w * view_w, (ly + h / 2) / h * view_h
        r = max(ow, oh) * s2 / 2 / w * view_w
        lines.append(f"Attached, drawn separately (grey in the picture): {other.get('kind', 'thing')} "
                     f"{other.get('id')} centred at ({round(cx)}, {round(cy)}) in your viewBox, radius about "
                     f"{round(r)}. Do not draw it; leave its space (e.g. a wheel arch) as the drawing implies.")
    for other in theirs:
        lines.append(f"This is attached to {other.get('kind', 'thing')} {other.get('id')} (drawn separately).")
    if (o.get("physics") or {}).get("shape") == "circle" or str(o.get("kind", "")).lower() in ("wheel", "tire",
                                                                                               "tyre", "ball"):
        lines.append("It is round in play and may spin: keep it a circle filling the box, with a visible mark so "
                     "rotation reads.")
    lines.append(f'Use exactly viewBox="0 0 {round(view_w)} {round(view_h)}" (the box, scaled to friendly units). '
                 f"At game size 1 screen pixel is about {units_per_px:.1f} units: outlines of ~3 px = "
                 f"{3 * units_per_px:.0f} units; nothing smaller than ~3 px = {3 * units_per_px:.0f} units.")
    return "\n".join(lines)


def game_text(doc: dict[str, Any], scene_id: str | None = None) -> str:
    """The game, for the direction call: world, theme, and every kind of object with names, counts and roles."""
    scene = scene_of(doc, scene_id)
    world = scene.get("world") or {}
    theme = doc.get("theme") or {}
    pal = theme.get("palette") or {}
    lines = [f'GAME "{sanitize.text(doc.get("title"), 60)}"',
             f"World: kind \"{sanitize.text(world.get('kind'), 60) or 'not set'}\", "
             f"{round(float(world.get('width', 1600)))} x {round(float(world.get('height', 900)))} px, gravity "
             f"{list(world.get('gravity') or [0, 1])}, camera {(world.get('camera') or {}).get('mode', 'fixed')}",
             f"Current theme: {theme.get('name', 'Sketchbook')} (background {(theme.get('background') or {}).get('style', 'paper')}, "
             f"bg {pal.get('bg', '')}, accent {pal.get('accent', '')}, accent2 {pal.get('accent2', '')})"]
    ad = doc.get("art_direction") or None
    if ad and (ad.get("summary") or ad.get("prompt")):
        lines.append(f"Previous art direction: {sanitize.text(ad.get('summary'), 200)} "
                     f"(asked: {sanitize.text(ad.get('prompt'), 200) or '-'})")
    groups: dict[str, list[dict[str, Any]]] = {}
    for o in all_objects(doc):
        if has_strokes(o) or o.get("kind") not in (None, "", "thing"):
            groups.setdefault(str(o.get("kind") or "thing").lower()[:24], []).append(o)
    lines.append("Object kinds (every one needs a `kinds` entry):")
    for kind, objs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        o = objs[0]
        sh = shape_of(o)
        names = sorted({sanitize.text(x.get("name"), 32) for x in objs if x.get("name")})
        lines.append(f"- {kind} x{len(objs)}" + (f" ({', '.join(names[:4])})" if names else "")
                     + f": {round(sh.w)}x{round(sh.h)} px, {role_of(o)}; looks like {sh.describe()}; colours "
                     + (", ".join(f"{colour_name(c)} {c}" for c in sh.colours) or "black pen")
                     + ("" if has_strokes(o) else " (invisible, nothing to draw)"))
    if not groups:
        lines.append("- (nothing drawn yet: still describe the look of the likely kinds for this game: player, "
                     "ground, platform, coin, enemy)")
    return "\n".join(lines)
