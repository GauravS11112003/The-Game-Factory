"""Server-side validation of StudioEdit lists (CONTRACTS_V6 §5.2, §5.3).

`validate_edits(raw, doc, scene)` walks the edits in order against a light model of the game (which objects,
behaviours, rules and scenes exist, plus what earlier edits in the same list create), and returns only clean edits:

- every shape is checked, unknown keys are dropped, numbers are clamped (catalog min/max, spec bounds);
- behaviour, event and action types must be catalog entries; their params go through catalog.clean_params;
- targets must exist or be created earlier in the list (update_object with a new id creates an invisible box);
- `id` fields the model chooses (behaviours, rules, scenes, ask_draw) are renamed when they collide, and behaviours
  and rules always get an id (b<n>, r<n>) so later rules can name them;
- edits aimed at an object the same reply asks the maker to draw (ask_draw) are folded into that ask's `object`;
- at most 40 edits and 3 ask_draw per reply; `drawing.strokes` is never accepted (the copilot never draws).

Nothing here raises on bad input: a bad edit is dropped with a short warning.
"""
from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from app.mind import sanitize
from app.spec.studio import BehaviorDef, HudDef, JointDef, ObjectDef, RuleDef
from app.studio import assets, catalog
from app.studio.catalog import boolean, clean_hex, clean_id, clean_name, clean_target, clean_vec, num, safe_text

MAX_EDITS = 40
MAX_ASKS = 3
MAX_BEHAVIORS = 12
MAX_OBJECT_RULES = 24
MAX_SCOPE_RULES = 48
MAX_JOINTS = 8
MAX_TAGS = 8
MAX_COUNTERS = 24
COORD = 40000.0

ACTIONS = (
    "set_world", "set_theme", "set_hud", "set_title", "add_scene", "update_object", "delete_object",
    "duplicate_object", "add_behavior", "update_behavior", "remove_behavior", "add_rule", "update_rule", "remove_rule",
    "add_joint", "set_counters", "set_game_counters", "ask_draw",
)
PHYSICS_ENUMS = {"body": ("none", "static", "dynamic", "kinematic"), "shape": ("auto", "box", "circle", "line")}
PHYSICS_NUMS = {"density": (0.05, 50), "friction": (0, 2), "bounce": (0, 1.5), "gravity_scale": (-5, 5)}
BG_STYLES = ("paper", "solid", "gradient", "stars", "grid", "city", "hills", "clouds", "neon_grid", "halftone",
             "waves", "dunes", "forest", "space")
STROKE_STYLES = ("ink", "marker", "neon", "pixel", "chalk", "comic", "crayon", "watercolor")
PALETTE_KEYS = ("bg", "ink", "accent", "accent2", "text", "danger", "good")
PARTICLES = ("none", "dust", "sparks", "stars", "bubbles", "confetti", "embers", "snow")
FONTS = ("hand", "comic", "pixel", "clean", "serif")
MUSIC = ("none", "calm", "upbeat", "spooky", "heroic", "chiptune", "racing")
OPS = (">=", "<=", "==", "!=", ">", "<")


# ---- the model of the game the edits are checked against ---------------------------------------------------------


@dataclass
class Obj:
    behaviors: list[tuple[str, str]] = field(default_factory=list)  # (id, type)
    rules: list[str] = field(default_factory=list)
    joints: int = 0
    created: bool = False


@dataclass
class Scene:
    objects: dict[str, Obj] = field(default_factory=dict)
    rules: list[str] = field(default_factory=list)
    width: float = 1600
    height: float = 900


@dataclass
class Ctx:
    scene: str
    scenes: dict[str, Scene]
    game_rules: list[str]
    asks: dict[str, dict[str, Any]] = field(default_factory=dict)  # ask id → the ask_draw edit (folded into)
    warnings: list[str] = field(default_factory=list)

    def sc(self, scene_id: str | None) -> tuple[str, Scene]:
        sid = scene_id if scene_id in self.scenes else self.scene
        return sid, self.scenes[sid]

    def all_object_ids(self) -> set[str]:
        return {oid for s in self.scenes.values() for oid in s.objects}

    def warn(self, msg: str) -> None:
        if len(self.warnings) < 60:
            self.warnings.append(msg)


def _obj_state(o: dict[str, Any]) -> Obj:
    return Obj(behaviors=[(str(b.get("id")), str(b.get("type"))) for b in o.get("behaviors") or []],
               rules=[str(r.get("id")) for r in o.get("rules") or []], joints=len(o.get("joints") or []))


def make_ctx(doc: dict[str, Any], scene: str) -> Ctx:
    scenes: dict[str, Scene] = {}
    for s in doc.get("scenes") or []:
        w = s.get("world") or {}
        scenes[str(s.get("id"))] = Scene(objects={str(o.get("id")): _obj_state(o) for o in s.get("objects") or []},
                                         rules=[str(r.get("id")) for r in s.get("rules") or []],
                                         width=float(w.get("width") or 1600), height=float(w.get("height") or 900))
    if not scenes:
        scenes["s1"] = Scene()
    cur = scene if scene in scenes else next(iter(scenes))
    return Ctx(scene=cur, scenes=scenes, game_rules=[str(r.get("id")) for r in doc.get("rules") or []])


def _fresh(prefix: str, taken: set[str] | list[str]) -> str:
    t = set(taken)
    n = len(t) + 1
    while f"{prefix}{n}" in t:
        n += 1
    return f"{prefix}{n}"


def _unique(want: Any, prefix: str, taken: set[str] | list[str]) -> str:
    """The model's id when it is valid and free, else a fresh <prefix><n> (never trust colliding ids)."""
    t = set(taken)
    i = clean_id(want)
    if i and i not in t:
        return i
    if i and re.match(rf"^{re.escape(prefix)}\d+$", i):  # "r1" taken → the next free r<n>
        return _fresh(prefix, t)
    if i:  # valid but taken: keep the word, add a number
        base = i[:36]
        n = 2
        while f"{base}{n}" in t:
            n += 1
        return f"{base}{n}"
    return _fresh(prefix, t)


# ---- pieces -------------------------------------------------------------------------------------------------------


def clean_physics(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for k, opts in PHYSICS_ENUMS.items():
        if k in raw and str(raw[k]) in opts:
            out[k] = str(raw[k])
    for k, (lo, hi) in PHYSICS_NUMS.items():
        if k in raw:
            v = num(raw[k], lo, hi)
            if v is not None:
                out[k] = v
    for k in ("fixed_rotation", "sensor"):
        if k in raw:
            b = boolean(raw[k])
            if b is not None:
                out[k] = b
    if out.get("shape") == "line":
        out["body"] = "static"  # line forces a static body (§2)
    return out


def clean_behavior(raw: Any, taken: list[str]) -> dict[str, Any] | None:
    """A BehaviorDef with a fresh-or-kept id; None for an unknown type."""
    if not isinstance(raw, dict):
        return None
    t = str(raw.get("type") or "").strip().lower()
    entry = catalog.behaviors().get(t)
    if entry is None:
        return None
    b: dict[str, Any] = {"id": _unique(raw.get("id"), "b", taken), "type": t,
                         "params": catalog.clean_params(entry, raw.get("params"))}
    if boolean(raw.get("off")):
        b["off"] = True
    try:
        return BehaviorDef.model_validate(b).model_dump(mode="json", exclude_none=True)
    except ValidationError:
        return None


def _clean_call(raw: Any, table: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    if isinstance(raw, str):
        raw = {"type": raw}
    if not isinstance(raw, dict):
        return None
    t = str(raw.get("type") or "").strip().lower()
    entry = table.get(t)
    if entry is None:
        return None
    params = catalog.clean_params(entry, raw.get("params"))
    given = raw.get("params") if isinstance(raw.get("params"), dict) else {}
    for p in entry.get("params", []):  # a speech bubble whose words were blocked is dropped, not emptied
        if p.get("type") == "string" and p["name"] in given and p["name"] not in params:
            return None
    return {"type": t, "params": params}


def clean_condition(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    counter = clean_name(raw.get("counter"))
    if counter is None:
        return None
    subject = clean_target(raw.get("subject") or "self") or "self"
    op = str(raw.get("op") or ">=").strip()
    return {"subject": subject, "counter": counter, "op": op if op in OPS else ">=",
            "value": num(raw.get("value"), -1e9, 1e9, 0.0)}


def clean_rule_parts(raw: dict[str, Any], *, partial: bool) -> dict[str, Any] | None:
    """The fields of a RuleDef (all of them unless `partial`)."""
    out: dict[str, Any] = {}
    if "when" in raw or not partial:
        when = _clean_call(raw.get("when"), catalog.events())
        if when is None:
            return None
        out["when"] = when
    if "conditions" in raw and isinstance(raw.get("conditions"), list):
        out["conditions"] = [c for c in (clean_condition(c) for c in raw["conditions"][:8]) if c][:4]
    elif not partial:
        out["conditions"] = []
    if "then" in raw or not partial:
        acts = raw.get("then") if isinstance(raw.get("then"), list) else [raw.get("then")] if raw.get("then") else []
        then = [a for a in (_clean_call(a, catalog.actions()) for a in acts[:12]) if a][:8]
        if not then:
            return None
        out["then"] = then
    for k in ("once", "off"):
        if k in raw:
            b = boolean(raw[k])
            if b is not None:
                out[k] = b
    if "text" in raw:
        t = safe_text(raw.get("text"), 200)
        if t:
            out["text"] = t
    return out


def clean_rule(raw: Any, taken: list[str]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    parts = clean_rule_parts(raw, partial=False)
    if parts is None:
        return None
    rule = {"id": _unique(raw.get("id"), "r", taken), **parts}
    try:
        return RuleDef.model_validate(rule).model_dump(mode="json", exclude_none=True)
    except ValidationError:
        return None


def clean_joint(raw: Any, owner: str | None) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    jt = str(raw.get("type") or "").strip().lower()
    to = clean_id(raw.get("to"))
    if jt not in ("wheel", "hinge", "rope", "weld", "spring") or to is None or to == owner:
        return None
    j: dict[str, Any] = {"type": jt, "to": to}
    for k in ("at", "to_at"):
        if k in raw:
            v = clean_vec(raw[k], 4000)
            if v is not None:
                j[k] = v
    if "motor" in raw:
        j["motor"] = bool(boolean(raw["motor"]))
    if "speed" in raw:
        j["speed"] = num(raw["speed"], -5000, 5000, 0.0)
    if raw.get("length") is not None:
        ln = num(raw["length"], 0, 20000)
        if ln is not None:
            j["length"] = ln
    if "stiffness" in raw:
        j["stiffness"] = num(raw["stiffness"], 0, 1, 0.5)
    try:
        return JointDef.model_validate(j).model_dump(mode="json", exclude_none=True)
    except ValidationError:
        return None


def clean_counters(raw: Any, *, allow_null: bool) -> dict[str, float | None]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, float | None] = {}
    for k, v in list(raw.items())[:MAX_COUNTERS]:
        name = clean_name(k)
        if name is None:
            continue
        if v is None:
            if allow_null:
                out[name] = None
            continue
        x = num(v, -1e9, 1e9)
        if x is not None:
            out[name] = x
    return out


def clean_tags(raw: Any) -> list[str]:
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for t in raw:
        n = clean_name(t)
        if n and n not in out:
            out.append(n)
    return out[:MAX_TAGS]


def clean_object_fields(raw: Any, ctx: Ctx, owner: str | None, obj: Obj | None) -> dict[str, Any]:
    """The fields of a partial ObjectDef an edit may set (never drawing.strokes). Behaviours and rules get ids
    that are unique on the object; lists replace the object's lists (§5.2)."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    if "name" in raw:
        n = safe_text(raw.get("name"), 32)
        if n is not None or raw.get("name") in ("", None):
            out["name"] = n or ""
    if "kind" in raw:
        k = safe_text(raw.get("kind"), 24)
        if k:
            out["kind"] = k.lower()
    for k in ("x", "y"):
        if k in raw:
            v = num(raw[k], -COORD, COORD)
            if v is not None:
                out[k] = v
    if "rotation" in raw:
        v = num(raw["rotation"], -3600, 3600)
        if v is not None:
            out["rotation"] = v
    if "scale" in raw:
        v = num(raw["scale"], 0.05, 20)
        if v is not None:
            out["scale"] = v
    if "layer" in raw:
        v = num(raw["layer"], -10, 10)
        if v is not None:
            out["layer"] = int(round(v))
    if "physics" in raw:
        p = clean_physics(raw["physics"])
        if p:
            out["physics"] = p
    if "behaviors" in raw and isinstance(raw["behaviors"], list):
        taken: list[str] = []
        bs = []
        for b in raw["behaviors"][:MAX_BEHAVIORS * 2]:
            cb = clean_behavior(b, taken)
            if cb is None:
                ctx.warn(f"unknown behaviour {(b or {}).get('type') if isinstance(b, dict) else b!r} dropped")
                continue
            taken.append(cb["id"])
            bs.append(cb)
        out["behaviors"] = bs[:MAX_BEHAVIORS]
    if "rules" in raw and isinstance(raw["rules"], list):
        taken = []
        rs = []
        for r in raw["rules"][:MAX_OBJECT_RULES * 2]:
            cr = clean_rule(r, taken)
            if cr is None:
                ctx.warn("a rule with an unknown event or action was dropped")
                continue
            taken.append(cr["id"])
            rs.append(cr)
        out["rules"] = rs[:MAX_OBJECT_RULES]
    if "counters" in raw:
        c = clean_counters(raw["counters"], allow_null=True)
        if c:
            out["counters"] = c
    if "tags" in raw:
        out["tags"] = clean_tags(raw["tags"])
    if "joints" in raw and isinstance(raw["joints"], list):
        out["joints"] = [j for j in (clean_joint(j, owner) for j in raw["joints"][:MAX_JOINTS * 2]) if j][:MAX_JOINTS]
    for k in ("template", "hidden"):
        if k in raw:
            b = boolean(raw[k])
            if b is not None:
                out[k] = b
    if "player" in raw:
        p = num(raw["player"], 0, 2)
        if p is not None:
            out["player"] = int(round(p))
    if isinstance(raw.get("drawing"), dict):
        d = raw["drawing"]
        dw = {k: num(d[k], 0, COORD) for k in ("w", "h") if k in d and num(d[k], 0, COORD) is not None}
        if dw:
            out["drawing"] = dw  # strokes are never accepted
    return out


def _sync_obj(obj: Obj, fields: dict[str, Any]) -> None:
    if "behaviors" in fields:
        obj.behaviors = [(b["id"], b["type"]) for b in fields["behaviors"]]
    if "rules" in fields:
        obj.rules = [r["id"] for r in fields["rules"]]
    if "joints" in fields:
        obj.joints = len(fields["joints"])


def clean_world(raw: Any, ctx: Ctx, scene: Scene | None = None) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    if "kind" in raw:
        out["kind"] = sanitize.text(raw.get("kind"), 60)
    if "width" in raw and num(raw["width"], 320, 40000) is not None:
        out["width"] = num(raw["width"], 320, 40000)
    if "height" in raw and num(raw["height"], 240, 20000) is not None:
        out["height"] = num(raw["height"], 240, 20000)
    if "gravity" in raw:
        g = raw["gravity"]
        if isinstance(g, (int, float)) and not isinstance(g, bool):
            g = [0, g]
        v = clean_vec(g, 5)
        if v is not None:
            out["gravity"] = v
    if "edges" in raw and str(raw["edges"]) in ("none", "walls", "wrap", "floor"):
        out["edges"] = str(raw["edges"])
    if "players" in raw and num(raw["players"], 1, 2) is not None:
        out["players"] = int(round(num(raw["players"], 1, 2) or 1))
    cam = raw.get("camera")
    if isinstance(cam, dict):
        c: dict[str, Any] = {}
        if str(cam.get("mode")) in ("fixed", "follow", "auto_scroll"):
            c["mode"] = str(cam["mode"])
        if "target" in cam:
            t = clean_id(cam.get("target"))
            if t is None or t in ctx.all_object_ids() or t in ctx.asks:
                c["target"] = t
        if str(cam.get("axis")) in ("x", "y", "xy"):
            c["axis"] = str(cam["axis"])
        if "speed" in cam and num(cam["speed"], 0, 2000) is not None:
            c["speed"] = num(cam["speed"], 0, 2000)
        if "zoom" in cam and num(cam["zoom"], 0.15, 5) is not None:
            c["zoom"] = num(cam["zoom"], 0.15, 5)
        if c:
            out["camera"] = c
    if scene is not None:
        scene.width = float(out.get("width", scene.width))
        scene.height = float(out.get("height", scene.height))
    return out


def clean_theme(raw: Any) -> dict[str, Any] | None:
    """`{preset: id}` (an id from themes.json), or a partial StudioTheme. A preset that themes.json does not have
    (the built-in palettes) or a preset with overrides is expanded into full values the client can merge."""
    if not isinstance(raw, dict):
        return None
    partial: dict[str, Any] = {}
    if "name" in raw:
        n = safe_text(raw.get("name"), 40)
        if n:
            partial["name"] = n
    if "id" in raw:
        i = clean_id(raw.get("id"))
        partial["id"] = i
    if isinstance(raw.get("palette"), dict):
        pal = {k: clean_hex(raw["palette"].get(k)) for k in PALETTE_KEYS if k in raw["palette"]}
        pal = {k: v for k, v in pal.items() if v}
        if pal:
            partial["palette"] = pal
    if isinstance(raw.get("background"), dict):
        b = raw["background"]
        bg: dict[str, Any] = {}
        if str(b.get("style")) in BG_STYLES:
            bg["style"] = str(b["style"])
        if isinstance(b.get("colors"), list):
            cols = [c for c in (clean_hex(c) for c in b["colors"][:6]) if c]
            if cols:
                bg["colors"] = cols
        if "parallax" in b and boolean(b["parallax"]) is not None:
            bg["parallax"] = boolean(b["parallax"])
        if bg:
            partial["background"] = bg
    if isinstance(raw.get("stroke"), dict):
        s = raw["stroke"]
        st: dict[str, Any] = {}
        if str(s.get("style")) in STROKE_STYLES:
            st["style"] = str(s["style"])
        if "outline" in s:
            st["outline"] = clean_hex(s.get("outline"))
        if "width_scale" in s and num(s["width_scale"], 0.25, 4) is not None:
            st["width_scale"] = num(s["width_scale"], 0.25, 4)
        if "wobble" in s and num(s["wobble"], 0, 1) is not None:
            st["wobble"] = num(s["wobble"], 0, 1)
        for k in ("glow", "fill_closed", "halftone"):
            if k in s and boolean(s[k]) is not None:
                st[k] = boolean(s[k])
        if st:
            partial["stroke"] = st
    if "recolor" in raw and boolean(raw["recolor"]) is not None:
        partial["recolor"] = boolean(raw["recolor"])
    for k, opts in (("particles", PARTICLES), ("font", FONTS), ("music", MUSIC)):
        if str(raw.get(k)) in opts:
            partial[k] = str(raw[k])
    preset = raw.get("preset")
    if preset:
        base = assets.theme_by_id(str(preset))
        if base is None:
            return partial or None
        if not partial and str(base.get("id")) in assets.preset_ids():
            return {"preset": str(base["id"])}
        return deep_merge(base, partial)
    return partial or None


def deep_merge(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(a)
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def clean_hud(raw: Any, ctx: Ctx) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    items = []
    for it in (raw.get("items") or [])[:16] if isinstance(raw.get("items"), list) else []:
        if not isinstance(it, dict):
            continue
        counter = clean_name(it.get("counter"))
        if counter is None:
            continue
        subject = str(it.get("subject") or "game").strip()
        if subject not in ("game", "player1", "player2") and not clean_id(subject):
            subject = "game"
        item: dict[str, Any] = {"subject": subject, "counter": counter,
                                "style": it.get("style") if it.get("style") in ("number", "bar", "hearts", "icons")
                                else "number"}
        label = safe_text(it.get("label"), 24)
        if label:
            item["label"] = label
        if it.get("max") is not None and num(it["max"], 0, 1e9) is not None:
            item["max"] = num(it["max"], 0, 1e9)
        items.append(item)
    hud: dict[str, Any] = {"items": items[:8], "timer": bool(boolean(raw.get("timer")))}
    title = safe_text(raw.get("title"), 40)
    hud["title"] = title
    try:
        return HudDef.model_validate(hud).model_dump(mode="json")
    except ValidationError:
        return None


# ---- the edits ----------------------------------------------------------------------------------------------------


def _rule_scope(ctx: Ctx, target: str | None, scene_id: str | None) -> tuple[str, list[str], int] | None:
    """(normalised target, the scope's rule ids, its max rules) for @game, @scene or an object id."""
    if target in (None, "", "@game", "game"):
        return "@game", ctx.game_rules, MAX_SCOPE_RULES
    if target in ("@scene", "scene"):
        _, sc = ctx.sc(scene_id)
        return "@scene", sc.rules, MAX_SCOPE_RULES
    _, sc = ctx.sc(scene_id)
    obj = sc.objects.get(str(target))
    if obj is None:
        return None
    return str(target), obj.rules, MAX_OBJECT_RULES


def _fold_into_ask(ctx: Ctx, ask_id: str, action: str, data: dict[str, Any]) -> bool:
    """Edits aimed at an object the maker has not drawn yet go into the ask's `object` settings."""
    ask = ctx.asks[ask_id]
    obj = ask["data"].setdefault("object", {})
    dummy = Obj(behaviors=[(b["id"], b["type"]) for b in obj.get("behaviors", [])],
                rules=[r["id"] for r in obj.get("rules", [])])
    if action == "update_object":
        fields = clean_object_fields(data, ctx, ask_id, dummy)
        for k, v in fields.items():
            if k == "physics":
                obj["physics"] = {**obj.get("physics", {}), **v}
            elif k == "counters":
                obj["counters"] = {**obj.get("counters", {}), **v}
            else:
                obj[k] = v
        return True
    if action == "add_behavior":
        if len(obj.get("behaviors", [])) >= MAX_BEHAVIORS:
            return False
        b = clean_behavior(data, [i for i, _ in dummy.behaviors])
        if b is None:
            return False
        obj.setdefault("behaviors", []).append(b)
        return True
    if action == "add_rule":
        r = clean_rule(data, dummy.rules)
        if r is None:
            return False
        obj.setdefault("rules", []).append(r)
        return True
    if action == "add_joint":
        j = clean_joint(data, ask_id)
        if j is None:
            return False
        obj.setdefault("joints", []).append(j)
        return True
    if action == "set_counters":
        c = clean_counters(data.get("counters"), allow_null=False)
        if not c:
            return False
        obj["counters"] = {**obj.get("counters", {}), **c}
        return True
    return False


def _edit(ctx: Ctx, action: str, target: str | None, scene_id: str | None, data: dict[str, Any]) -> dict[str, Any] | None:
    """One clean edit (a dict with action/target/scene/data), or None to drop it (or when it was folded)."""
    sid, sc = ctx.sc(scene_id)

    def out(t: str | None, d: dict[str, Any]) -> dict[str, Any]:
        return {"action": action, "target": t, "scene": sid if sid != ctx.scene else None, "data": d}

    if action == "set_world":
        w = clean_world(data, ctx, sc)
        return out(None, w) if w else None
    if action == "set_theme":
        th = clean_theme(data)
        return out(None, th) if th else None
    if action == "set_hud":
        hud = clean_hud(data, ctx)
        return out(None, hud) if hud is not None else None
    if action == "set_title":
        t = safe_text(data.get("title"), 60)
        return out(None, {"title": t}) if t else None
    if action == "set_game_counters":
        c = clean_counters(data.get("counters"), allow_null=True)
        return out(None, {"counters": c}) if c else None
    if action == "add_scene":
        new_id = _unique(data.get("id"), "s", set(ctx.scenes))
        d: dict[str, Any] = {"id": new_id,
                             "name": safe_text(data.get("name"), 40) or f"Level {len(ctx.scenes) + 1}"}
        new = Scene()
        if data.get("copy_from") in ctx.scenes:
            d["copy_from"] = data["copy_from"]
            src = ctx.scenes[data["copy_from"]]
            new = Scene(objects={k: copy.deepcopy(v) for k, v in src.objects.items()}, rules=list(src.rules),
                        width=src.width, height=src.height)
        if isinstance(data.get("world"), dict):
            w = clean_world(data["world"], ctx, new)
            if w:
                d["world"] = w
        ctx.scenes[new_id] = new
        return {"action": action, "target": None, "scene": None, "data": d}
    if action == "ask_draw":
        if len(ctx.asks) >= MAX_ASKS:
            ctx.warn("more than 3 ask_draw in one reply")
            return None
        taken = ctx.all_object_ids() | set(ctx.asks)
        aid = _unique(data.get("id"), "drawing", taken)
        prompt = safe_text(data.get("prompt"), 120)
        obj = clean_object_fields(data.get("object") or {}, ctx, aid, None)
        if not prompt:
            prompt = f"Draw the {obj.get('kind') or obj.get('name') or 'missing piece'}"
        e = out(None, {"id": aid, "prompt": prompt, "object": obj})
        ctx.asks[aid] = e
        return e

    # rules: @game / @scene / an object
    if action in ("add_rule", "update_rule", "remove_rule"):
        if target in ctx.asks and target not in sc.objects and action == "add_rule":
            if not _fold_into_ask(ctx, target, action, data):
                ctx.warn(f"add_rule for {target}: dropped")
            return None
        scope = _rule_scope(ctx, target, scene_id)
        if scope is None:
            ctx.warn(f"{action}: no object {target!r}")
            return None
        t, rules, cap = scope
        if action == "add_rule":
            if len(rules) >= cap:
                return None
            r = clean_rule(data, rules)
            if r is None:
                ctx.warn("add_rule: unknown event or action")
                return None
            rules.append(r["id"])
            return out(t, r)
        rid = str(data.get("id") or "")
        if rid not in rules:
            ctx.warn(f"{action}: no rule {rid!r} on {t}")
            return None
        if action == "remove_rule":
            rules.remove(rid)
            return out(t, {"id": rid})
        parts = clean_rule_parts(data, partial=True)
        if not parts:
            return None
        return out(t, {"id": rid, **parts})

    # everything else is about one object
    oid = clean_id(target)
    if oid is None:
        ctx.warn(f"{action}: bad target {target!r}")
        return None
    obj = sc.objects.get(oid)
    if obj is None and oid in ctx.asks:
        if not _fold_into_ask(ctx, oid, action, data):
            ctx.warn(f"{action} for {oid} (still to be drawn): dropped")
        return None

    if action == "update_object":
        creating = obj is None
        fields = clean_object_fields(data, ctx, oid, obj)
        if creating:
            if len(sc.objects) >= 600:
                return None
            dr = fields.get("drawing") or {}
            fields["drawing"] = {"w": dr.get("w") or 120.0, "h": dr.get("h") or 120.0}
            fields.setdefault("x", round(sc.width / 2, 1))
            fields.setdefault("y", round(sc.height / 2, 1))
            try:
                ObjectDef.model_validate({"id": oid, **{k: v for k, v in fields.items() if k != "counters"},
                                          "counters": {k: v for k, v in (fields.get("counters") or {}).items()
                                                       if v is not None}})
            except ValidationError as e:
                ctx.warn(f"update_object {oid}: {e.error_count()} problems")
                return None
            obj = Obj(created=True)
            sc.objects[oid] = obj
        elif not fields:
            return None
        _sync_obj(obj, fields)
        return out(oid, fields)

    if obj is None:
        ctx.warn(f"{action}: no object {oid!r}")
        return None

    if action == "delete_object":
        del sc.objects[oid]
        return out(oid, {})
    if action == "duplicate_object":
        d = {}
        for k in ("x", "y", "dx", "dy"):
            if k in data and num(data[k], -COORD, COORD) is not None:
                d[k] = num(data[k], -COORD, COORD)
        if "count" in data and num(data["count"], 1, 50) is not None:
            d["count"] = int(round(num(data["count"], 1, 50) or 1))
        return out(oid, d)
    if action == "add_behavior":
        if len(obj.behaviors) >= MAX_BEHAVIORS:
            return None
        b = clean_behavior(data, [i for i, _ in obj.behaviors])
        if b is None:
            ctx.warn(f"add_behavior: unknown type {data.get('type')!r}")
            return None
        obj.behaviors.append((b["id"], b["type"]))
        return out(oid, b)
    if action in ("update_behavior", "remove_behavior"):
        bid, btype = str(data.get("id") or ""), str(data.get("type") or "").lower()
        found = next(((i, t) for i, t in obj.behaviors if bid and i == bid), None) or next(
            ((i, t) for i, t in obj.behaviors if btype and t == btype), None)
        if found is None:
            ctx.warn(f"{action}: {oid} has no behaviour {bid or btype!r}")
            return None
        if action == "remove_behavior":
            obj.behaviors.remove(found)
            return out(oid, {"id": found[0]})
        d = {"id": found[0]}
        entry = catalog.behaviors().get(found[1]) or {}
        if "params" in data:
            ps = catalog.clean_params(entry, data.get("params"))
            if ps:
                d["params"] = ps
        if "off" in data and boolean(data["off"]) is not None:
            d["off"] = boolean(data["off"])
        return out(oid, d) if len(d) > 1 else None
    if action == "add_joint":
        if obj.joints >= MAX_JOINTS:
            return None
        j = clean_joint(data, oid)
        if j is None:
            return None
        obj.joints += 1
        return out(oid, j)
    if action == "set_counters":
        c = clean_counters(data.get("counters"), allow_null=True)
        return out(oid, {"counters": c}) if c else None
    return None


def parse_data(raw: Any) -> dict[str, Any] | None:
    """`data` as a dict: a dict as is, a JSON object string parsed (the model-facing schema sends `data_json`)."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return {}
        s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s)
        try:
            v = json.loads(s)
        except json.JSONDecodeError:
            return None
        return v if isinstance(v, dict) else None
    if raw is None:
        return {}
    return None


def validate_edits(raw: list[Any], doc: dict[str, Any], scene: str) -> tuple[list[dict[str, Any]], list[str]]:
    """(clean StudioEdit dicts, warnings) for the edits in order. Never raises."""
    ctx = make_ctx(doc, scene)
    clean: list[dict[str, Any]] = []
    items = [e for e in (raw or [])[:MAX_EDITS * 2] if isinstance(e, dict)]
    # asks first (stable), so edits aimed at a still-to-be-drawn object fold into its ask wherever they appear
    items.sort(key=lambda e: 0 if e.get("action") == "ask_draw" else 1)
    for e in items:
        if len(clean) >= MAX_EDITS:
            ctx.warn("more than 40 edits")
            break
        action = str(e.get("action") or "")
        if action not in ACTIONS:
            ctx.warn(f"unknown action {action!r}")
            continue
        data = parse_data(e.get("data", e.get("data_json")))
        if data is None:
            ctx.warn(f"{action}: data is not a JSON object")
            continue
        target = e.get("target")
        target = str(target).strip() if target not in (None, "") else None
        scene_id = str(e.get("scene")).strip() if e.get("scene") else None
        try:
            ce = _edit(ctx, action, target, scene_id, data)
        except Exception as ex:  # noqa: BLE001 - one odd edit never breaks the reply
            ctx.warn(f"{action}: {type(ex).__name__}")
            ce = None
        if ce is not None:
            clean.append(ce)
    return clean, ctx.warnings
