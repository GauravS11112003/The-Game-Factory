"""The Studio catalog (shared/spec/studio_catalog.json, CONTRACTS_V6 §1, §3) as the backend sees it.

Lookups by type, the param clamps every copilot edit goes through (unknown params dropped, numbers clamped to min/max,
choices and keys checked, names cleaned), and `render()`, the compact text the copilot's prompts include.
"""
from __future__ import annotations

import json
import math
import re
from functools import lru_cache
from typing import Any

from app.config import SHARED_DIR
from app.mind import moderate, sanitize

CATALOG_PATH = SHARED_DIR / "spec" / "studio_catalog.json"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
NAME_RE = re.compile(r"^[a-z][a-z0-9 _]{0,23}$")
TARGET_RE = re.compile(r"^[A-Za-z0-9_# -]{1,40}$")  # ids, copies (<template>#<n>), keywords and tags
TARGET_WORDS = ("self", "other", "player", "player1", "player2", "any", "game")
VEC_LIMIT = 20000.0
STRING_CHARS = 120

DROP = object()  # a param value that cannot be used (the param is left out)


@lru_cache(maxsize=1)
def load() -> dict[str, Any]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def _by_type(section: str, key: str = "type") -> dict[str, dict[str, Any]]:
    return {str(e[key]): e for e in load().get(section, [])}


@lru_cache(maxsize=1)
def behaviors() -> dict[str, dict[str, Any]]:
    return _by_type("behaviors")


@lru_cache(maxsize=1)
def events() -> dict[str, dict[str, Any]]:
    return _by_type("events")


@lru_cache(maxsize=1)
def actions() -> dict[str, dict[str, Any]]:
    return _by_type("actions")


@lru_cache(maxsize=1)
def archetypes() -> dict[str, dict[str, Any]]:
    return _by_type("archetypes", "kind")


@lru_cache(maxsize=1)
def worlds() -> dict[str, dict[str, Any]]:
    return _by_type("worlds", "kind")


@lru_cache(maxsize=1)
def key_names() -> tuple[str, ...]:
    return tuple(load().get("keys", {}).get("names", []))


# ---- cleaning -----------------------------------------------------------------------------------------------------


def num(v: Any, lo: float | None = None, hi: float | None = None, default: float | None = None) -> float | None:
    """A finite float clamped to [lo, hi], or `default`."""
    if isinstance(v, bool):
        v = 1.0 if v else 0.0
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(x):
        return default
    if lo is not None:
        x = max(lo, x)
    if hi is not None:
        x = min(hi, x)
    return round(x, 4)


def boolean(v: Any) -> bool | None:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ("true", "yes", "on", "1"):
            return True
        if s in ("false", "no", "off", "0", ""):
            return False
    return None


def clean_name(v: Any) -> str | None:
    """A counter, tag or item name ("health", "red gems"): ^[a-z][a-z0-9 _]{0,23}$."""
    s = re.sub(r"[^a-z0-9 _]+", "", str(v if v is not None else "").lower().replace("-", " "))
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^[^a-z]+", "", s)[:24].strip()
    return s if NAME_RE.match(s) else None


def clean_id(v: Any) -> str | None:
    s = str(v if v is not None else "").strip()
    return s if ID_RE.match(s) else None


def clean_target(v: Any) -> str | None:
    s = str(v if v is not None else "").strip()
    if not s:
        return None
    if s.lower() in TARGET_WORDS:
        return s.lower()
    return s if TARGET_RE.match(s) else None


def clean_hex(v: Any) -> str | None:
    s = str(v if v is not None else "").strip()
    if re.match(r"^#[0-9a-fA-F]{3}$", s):
        s = "#" + "".join(ch * 2 for ch in s[1:])
    return s.lower() if HEX_RE.match(s) else None


def clean_vec(v: Any, limit: float = VEC_LIMIT) -> list[float] | None:
    if isinstance(v, dict):
        v = [v.get("x"), v.get("y")]
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        return None
    x, y = num(v[0], -limit, limit), num(v[1], -limit, limit)
    return None if x is None or y is None else [x, y]


def safe_text(v: Any, n: int) -> str | None:
    """Plain text that passes the blocklist, or None."""
    t = sanitize.text(v, n)
    if not t or moderate.blocklist_hit([t]):
        return None
    return t


def clean_value(p: dict[str, Any], v: Any) -> Any:
    """One param value checked against its catalog entry; DROP when it cannot be used."""
    t = p.get("type")
    lo, hi = p.get("min"), p.get("max")
    if t in ("number", "int"):
        x = num(v, lo, hi)
        if x is None:
            return DROP
        return int(round(x)) if t == "int" else x
    if t == "bool":
        b = boolean(v)
        return DROP if b is None else b
    if t == "choice":
        s = str(v).strip().lower() if v is not None else ""
        opts = [str(o) for o in p.get("options", [])]
        return s if s in opts else DROP
    if t == "key":
        s = str(v).strip().lower() if v is not None else ""
        return s if s in key_names() else DROP
    if t == "target":
        if v in ("", None) and p.get("default") == "":
            return ""
        s = clean_target(v)
        return DROP if s is None else s
    if t in ("object", "template"):
        s = str(v if v is not None else "").strip()
        if s == "" or (t == "template" and s == "default"):
            return s
        return s if ID_RE.match(s) else DROP
    if t == "tag":
        return clean_name(v) or DROP
    if t == "counter":
        if v in ("", None):
            return "" if p.get("default") == "" else DROP
        return clean_name(v) or DROP
    if t == "vec":
        return clean_vec(v) or DROP
    if t == "string":
        name = p.get("name")
        if name == "color":
            return clean_hex(v) or DROP
        s = safe_text(v, STRING_CHARS)
        return DROP if s is None else s
    return DROP


def clean_params(entry: dict[str, Any], raw: Any) -> dict[str, Any]:
    """Params for a behaviour, event or action: unknown ones dropped, the rest clamped (missing ones are left out;
    the runtime and the inspector use the catalog default)."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for p in entry.get("params", []):
        name = p["name"]
        if name in raw:
            v = clean_value(p, raw[name])
            if v is not DROP:
                out[name] = v
    return out


def defaults(entry: dict[str, Any]) -> dict[str, Any]:
    return {p["name"]: p.get("default") for p in entry.get("params", [])}


# ---- the compact rendering the model reads --------------------------------------------------------------------------


def _param(p: dict[str, Any]) -> str:
    t = p.get("type")
    d = p.get("default")
    if t == "choice":
        return f"{p['name']}=({'|'.join(str(o) for o in p.get('options', []))}) def {d}"
    ds = json.dumps(d) if not isinstance(d, str) else (f'"{d}"' if d == "" else d)
    rng = ""
    if p.get("min") is not None or p.get("max") is not None:
        rng = f" [{_n(p.get('min'))}..{_n(p.get('max'))}]"
    kind = "" if t in ("number", "bool") else f":{t}"
    return f"{p['name']}{kind}={ds}{rng}"


def _n(v: Any) -> str:
    if v is None:
        return ""
    return str(int(v)) if float(v).is_integer() else str(v)


def _entry(e: dict[str, Any]) -> str:
    params = ", ".join(_param(p) for p in e.get("params", []))
    meaning = e.get("help") or e.get("label") or ""
    return f"- {e['type']}: {meaning}" + (f" | {params}" if params else "")


def _archetype(a: dict[str, Any]) -> str:
    bits = [f"physics {json.dumps(a.get('physics', {}), separators=(',', ':'))}"]
    bl = []
    for b in a.get("behaviors", []):
        ps = ",".join(f"{k}={v}" for k, v in (b.get("params") or {}).items())
        bl.append(f"{b['type']}({ps})" if ps else b["type"])
    if bl:
        bits.append("behaviours " + " + ".join(bl))
    if a.get("counters"):
        bits.append("counters " + json.dumps(a["counters"], separators=(",", ":")))
    if a.get("tags"):
        bits.append("tags " + ",".join(a["tags"]))
    for flag in ("player", "template"):
        if a.get(flag):
            bits.append(f"{flag} {a[flag] if flag == 'player' else 'true'}")
    if a.get("camera"):
        bits.append("camera follows it")
    if a.get("wheels"):
        bits.append("needs 2 wheel objects joined with wheel joints (motor true)")
    return f"- {a['kind']} ({a.get('label', '')}): " + "; ".join(bits)


def _world(w: dict[str, Any]) -> str:
    cam = w.get("camera", {})
    cam_s = cam.get("mode", "fixed") + (f" axis {cam['axis']}" if cam.get("axis") else "") + (
        f" speed {cam['speed']}" if cam.get("speed") else "")
    extra = f", players {w['players']}" if w.get("players") else ""
    return (f"- {w['kind']}: gravity {w.get('gravity')}, camera {cam_s}, edges {w.get('edges')}, "
            f"{w.get('width')}x{w.get('height')}{extra}")


@lru_cache(maxsize=1)
def render() -> str:
    """The catalog as compact text: `name:type=default [min..max]` per param (type omitted for numbers and bools)."""
    c = load()
    lines = ["# CATALOG (the only behaviour, event and action types that exist)", "",
             "Param notation: name=default [min..max], name:type=default for targets, counters, templates, keys, "
             "vecs and strings, name=(a|b|c) for choices. Leave params out to use the default.", "",
             "## Behaviours (ObjectDef.behaviors[].type)"]
    lines += [_entry(e) for e in c.get("behaviors", [])]
    lines += ["", "## Rule events (RuleDef.when.type)"]
    lines += [_entry(e) for e in c.get("events", [])]
    lines += ["", "## Rule actions (RuleDef.then[].type)"]
    lines += [_entry(e) for e in c.get("actions", [])]
    lines += ["", "## Keys (key params): " + ", ".join(key_names()),
              "Players: with world.players 2, player-1 objects use WASD + F (action) / G (action2), player-2 objects "
              "use the arrows + L (action) / K (action2). With 1 player: arrows or WASD, space, E (action), Q.", "",
              "## Archetypes (starting points for what a drawing is; apply with update_object + add_behavior)"]
    lines += [_archetype(a) for a in c.get("archetypes", [])]
    lines += ["", "## World presets (set_world)"]
    lines += [_world(w) for w in c.get("worlds", [])]
    return "\n".join(lines)
