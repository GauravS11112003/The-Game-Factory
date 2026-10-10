"""Stored levels ↔ core inputs, and storing levels that did not come through a draft (seeds, imports, rules apply).

A published LevelV2 carries everything a rebuild needs (§2.3): `ink` (LevelInk), `world`, `source`, `rules`, `edits`
(the records of the tier it was published at, with statuses) and `design.tier`. `ink_doc()` turns it back into the
InkDoc the core builds from; `rebuild_input()` gives the BuildInput for the same tier (optionally with other rules or
extra kid edits). The core regenerates N, R and greedy P/C edits itself and honours the stored statuses by stable id
(CONTRACTS §3.10), so a rebuild with unchanged inputs reproduces the level.
"""
from __future__ import annotations

import copy
import json
import logging
from typing import Any

from pydantic import ValidationError

from app import db_v2
from app.spec.level import LevelV2, level_hash

log = logging.getLogger("dal.v2.levels_io")

TIERS = ("faithful", "polished", "normal", "hard")


def ink_doc(level: dict[str, Any]) -> dict[str, Any]:
    """The InkDoc of a stored level (LevelInk + world/source/sheets/parent)."""
    li = level.get("ink") or {}
    world = level.get("world") or {}
    src = level.get("source") or {}
    kind = src.get("kind") if src.get("kind") in ("canvas", "paper", "prompt", "migrated") else "canvas"
    return {
        "v": 2, "source": kind,
        "world": {"screens": int(world.get("screens") or 1), "w": int(world.get("w") or 48), "h": 27},
        "strokes": copy.deepcopy(li.get("strokes") or []), "components": copy.deepcopy(li.get("components") or []),
        "character": copy.deepcopy(li.get("character")), "typed_rules": copy.deepcopy(li.get("typed_rules") or []),
        "rules_ink": list(li.get("rules_ink") or []), "sheets": [], "noise": li.get("noise") or {"count": 0},
        "parent": None,
    }


def tier_of(level: dict[str, Any]) -> str:
    t = (level.get("design") or {}).get("tier")
    return t if t in TIERS else "faithful"


def rebuild_input(level: dict[str, Any], *, rules: dict[str, Any] | None = None, tier: str | None = None,
                  extra_edits: list[dict[str, Any]] | None = None, parent: dict[str, Any] | None = None,
                  library: list[dict[str, Any]] | None = None, seed: int = 1) -> dict[str, Any]:
    """BuildInput (worker `build`) that rebuilds a stored level, by default at the tier it was published at."""
    edits = [copy.deepcopy(e) for e in level.get("edits") or [] if isinstance(e, dict) and e.get("id")]
    have = {e["id"] for e in edits}
    for e in extra_edits or []:
        if e["id"] not in have:
            edits.append(copy.deepcopy(e))
    lib = library if library is not None else list(level.get("embedded_library") or [])
    out = {"ink": ink_doc(level), "edits": edits, "rules": copy.deepcopy(rules or level.get("rules") or {"version": 1}),
           "library": lib, "parent": parent, "repairUnsolvable": True, "seed": int(seed), "tier": tier or tier_of(level)}
    g0 = migrated_graph0(level)
    if g0 is not None:
        out["graph0"] = g0
    return out


def migrated_graph0(level: dict[str, Any]) -> dict[str, Any] | None:
    """A migrated v1 level keeps its migration objects as G0 (its ink holds one stroke per object, and re-perceiving
    it would lose the typed entities: enemies, springs, movers, key/door links). None for drawn levels, which the
    core re-perceives (the kid's labels and the model's reading live in the edit records)."""
    if (level.get("source") or {}).get("kind") != "migrated" or not level.get("objects"):
        return None
    return {"objects": copy.deepcopy(level["objects"]), "setpieces": copy.deepcopy(level.get("setpieces") or [])}


UPGRADE_PROFILE = "v2-standard"


def upgrade_input(level: dict[str, Any], *, profile_hash: str | None = None) -> dict[str, Any] | None:
    """§2.6 "Upgrade to v2": the BuildInput that re-runs a migrated `v1-classic` level under `v2-standard` through the
    Faithful build. v1 patrollers (horizontal flyers, so they played exactly as before) become walkers with gravity,
    grounded by the normalize step's snap; everything else keeps its object. None when the level is not a migrated
    v1-classic level."""
    rules = level.get("rules") or {}
    g0 = migrated_graph0(level)
    if g0 is None or rules.get("physics_profile") != "v1-classic":
        return None
    for o in g0["objects"]:
        b = o.get("behavior") or {}
        params = b.get("params") or {}
        if b.get("kind") == "enemy" and b.get("archetype") == "flyer" and params.get("pattern") in ("horizontal", None):
            o["behavior"] = {"kind": "enemy", "archetype": "walker", "spiky": bool(b.get("spiky")),
                             "params": {k: v for k, v in {"speed": params.get("speed"), "ledge_aware": True}.items()
                                        if v is not None}}
            o["pinned"] = [x for x in o.get("pinned") or [] if x != "behavior"]
    new_rules = copy.deepcopy(rules)
    new_rules["physics_profile"] = UPGRADE_PROFILE
    if profile_hash:
        new_rules["profile_hash"] = profile_hash
    else:
        new_rules.pop("profile_hash", None)
    out = rebuild_input(level, rules=new_rules, tier="faithful")
    out["graph0"] = g0
    return out


def with_rules(level: dict[str, Any], rules: dict[str, Any]) -> dict[str, Any]:
    """A copy of the level that plays under other game rules (the rules check dry run: tiles and entities stay)."""
    out = copy.deepcopy(level)
    out["rules"] = copy.deepcopy(rules)
    return out


def summary_of(level: dict[str, Any], report: dict[str, Any] | None = None) -> dict[str, Any]:
    """C, score, band, par and fastest for the levels_v2 summary columns, from a report or the design block."""
    r = report or {}
    d = level.get("design") or {}
    return {"c_casual": r.get("C", d.get("C")), "score": r.get("score", d.get("score")), "band": r.get("band", d.get("band")),
            "par_ms": r.get("par_ms", d.get("par_ms")), "fastest_ms": r.get("fastest_ms", d.get("fastest_ms")),
            "verified": bool(r.get("solvable", d.get("solvable", False)))}


def validate(level: dict[str, Any]) -> list[str]:
    """Format errors (empty when the level is a valid LevelV2)."""
    try:
        LevelV2.model_validate(level)
        return []
    except ValidationError as e:
        return [f"{'.'.join(str(p) for p in err.get('loc', ()))}: {err.get('msg')}" for err in e.errors()[:5]]


def store(level: dict[str, Any], *, report: dict[str, Any] | None = None, listed: bool = True,
          safety: str | None = None, changed: dict[str, Any] | None = None, draft_id: str | None = None,
          parent_version: int | None = None) -> dict[str, Any]:
    """Insert one version of a level into levels_v2 (seeds, imports, rules apply). `level` must already carry its id,
    version, title, author and created_at; its meta.level_hash is (re)computed here from the raw JSON."""
    out = copy.deepcopy(level)
    out.pop("ink_ref", None)
    h = level_hash(out)
    meta = dict(out.get("meta") or {})
    meta["level_hash"] = h
    if safety is not None:
        meta["safety"] = safety
    out["meta"] = meta
    s = summary_of(out, report)
    db_v2.insert_level({
        "id": out["id"], "version": int(out["version"]), "game_id": out.get("game_id"), "parent_id": out.get("parent_id"),
        "parent_version": parent_version, "order_index": int(out.get("order_index") or 0), "title": out.get("title") or "Level",
        "author": out.get("author") or "", "json": json.dumps(out, separators=(",", ":"), ensure_ascii=False),
        "level_hash": h, "c_casual": s["c_casual"], "score": s["score"], "band": s["band"],
        "screens": int((out.get("world") or {}).get("screens") or 1), "verified": s["verified"],
        "safety": meta.get("safety") or "unchecked", "listed": listed, "par_ms": s["par_ms"], "fastest_ms": s["fastest_ms"],
        "changed_json": json.dumps(changed, separators=(",", ":")) if changed else None, "draft_id": draft_id,
        "created_at": out.get("created_at") or db_v2.now_iso(),
    })
    return out


def changed_objects(parent: dict[str, Any] | None, level: dict[str, Any]) -> dict[str, Any] | None:
    """Remix diff for the tree: objects added, removed and changed (role, shape or behavior) vs the parent."""
    if not parent:
        return None
    a = {o["id"]: o for o in parent.get("objects") or [] if isinstance(o, dict) and o.get("id")}
    b = {o["id"]: o for o in level.get("objects") or [] if isinstance(o, dict) and o.get("id")}
    changed = [oid for oid in b if oid in a and any(a[oid].get(k) != b[oid].get(k) for k in ("role", "shape", "behavior"))]
    return {"added": sorted(set(b) - set(a)), "removed": sorted(set(a) - set(b)), "changed": sorted(changed)}


def embedded_library(level: dict[str, Any], game_id: str | None) -> list[dict[str, Any]]:
    """The library types (pinned versions) a level uses, for self-contained exports and remixes (§8.1)."""
    wanted: set[tuple[str, int]] = set()
    for s in (level.get("ink") or {}).get("strokes") or []:
        lib = s.get("lib") if isinstance(s, dict) else None
        if isinstance(lib, dict) and lib.get("type_id"):
            wanted.add((str(lib["type_id"]), int(lib.get("version") or 1)))
    for o in level.get("objects") or []:
        lib = o.get("lib") if isinstance(o, dict) else None
        if isinstance(lib, dict) and lib.get("type_id"):
            wanted.add((str(lib["type_id"]), int(lib.get("version") or 1)))
    have = {(t.get("id"), int(t.get("version") or 0)) for t in level.get("embedded_library") or [] if isinstance(t, dict)}
    out = [t for t in level.get("embedded_library") or [] if isinstance(t, dict)]
    for tid, v in sorted(wanted - have):
        t = db_v2.get_type(tid, v)
        if t is not None:
            out.append(t)
    return out


KEEP_ON_REBUILD = ("id", "game_id", "parent_id", "order_index", "title", "author", "license", "source", "ink")


def save_rebuilt(row: dict[str, Any], built: dict[str, Any], report: dict[str, Any], *,
                 library: list[dict[str, Any]] | None = None) -> tuple[int | None, list[str]]:
    """Save a worker rebuild of a stored level (rules apply, Upgrade to v2) as the level's next version: identity,
    credits, source and ink come from the stored level, gameplay from the rebuild. Returns (version, []) or
    (None, format errors)."""
    level = row["level"]
    out = copy.deepcopy(built)
    version = db_v2.next_level_version(row["id"])
    for k in KEEP_ON_REBUILD:
        if k in level:
            out[k] = copy.deepcopy(level[k])
    for k in ("x_unlock_after", "x_bonus"):
        if k in level:
            out[k] = level[k]
    out.update({"version": version, "created_at": db_v2.now_iso()})
    if library is not None:
        out["embedded_library"] = library
    meta = dict(out.get("meta") or {})
    old_meta = level.get("meta") or {}
    meta.update({"safety": old_meta.get("safety", "unchecked"), "transcript": old_meta.get("transcript", ""),
                 "intent": old_meta.get("intent")})
    out["meta"] = meta
    out.pop("ink_ref", None)
    errors = validate({**out, "meta": {**meta, "level_hash": meta.get("level_hash") or "x"}})
    if errors:
        return None, errors
    store(out, report=report, listed=bool(row.get("listed", True)), safety=meta.get("safety"),
          changed=row.get("changed"), parent_version=row.get("parent_version"))
    return version, []

