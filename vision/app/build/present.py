"""What the stream shows (PLAN_V2 §3.11, §7.10): "What I saw" items, tier payloads, morphs, edit unions and the
tier summaries returned by the draft endpoints. Pure functions over core results (dicts in the wire shape)."""
from __future__ import annotations

import copy
import hashlib
import re
from functools import lru_cache
from typing import Any, Iterable

from app.build import drafts
from app.spec.level import canonical_json

TIERS = drafts.TIERS
FACE_TO_DIR = {"top": "up", "bottom": "down", "left": "left", "right": "right"}
DOES = {"walker": "walks", "hopper": "hops", "flyer": "flies", "shooter": "shoots", "chaser": "chases you",
        "crusher": "crushes", "static": "stands still"}


# ---- geometry ----------------------------------------------------------------------------------------


def _union(rects: Iterable[Iterable[float]]) -> list[float] | None:
    rs = [list(r) for r in rects if r is not None]
    if not rs:
        return None
    return [min(r[0] for r in rs), min(r[1] for r in rs), max(r[2] for r in rs), max(r[3] for r in rs)]


def shape_bbox(shape: dict[str, Any]) -> list[float] | None:
    k = shape.get("k")
    if k == "surface":
        pts = [p for s in shape.get("segs") or [] for p in (s["a"], s["b"])]
        if not pts:
            return None
        y0 = min(p[1] for p in pts)
        y1 = max(p[1] for p in pts)
        return [min(p[0] for p in pts), y0, max(p[0] for p in pts), max(y1, y0) + 1]
    if k == "strip":
        a, b = shape["a"], shape["b"]
        return [min(a[0], b[0]), min(a[1], b[1]) - 0.5, max(a[0], b[0]), max(a[1], b[1]) + 0.5]
    if k == "body":
        return list(shape.get("bbox") or [0, 0, 1, 1])
    if k == "point":
        p = shape.get("p") or [0, 0]
        return [p[0] - 0.5, p[1] - 0.5, p[0] + 0.5, p[1] + 0.5]
    if k == "wall":
        w = float(shape.get("w", 1))
        return [shape["x"], shape["y0"], shape["x"] + w, shape["y1"]]
    return None


def object_bbox(o: dict[str, Any], comps: dict[int, dict[str, Any]]) -> list[float]:
    b = _union(comps[c]["bbox"] for c in o.get("components") or [] if c in comps)
    return b or shape_bbox(o.get("shape") or {}) or [0, 0, 1, 1]


# ---- "What I saw" --------------------------------------------------------------------------------------


def saw_items(graph: dict[str, Any], ink: dict[str, Any]) -> list[dict[str, Any]]:
    """One item per meaningful object, with ground and dot-coins aggregated ("Ground ×3", "4 coins from your dots").
    Parts (eyes, poles) are described by their root, never listed alone."""
    comps = {int(c["id"]): c for c in ink.get("components") or []}
    objs = graph.get("objects") or []
    by_id = {o["id"]: o for o in objs}
    items: list[dict[str, Any]] = []
    grounds = [o for o in objs if o.get("role") == "ground"]
    if grounds:
        items.append({"object_id": grounds[0]["id"], "role": "ground", "rel_key": "saw.ground",
                      "rel_args": {"n": len(grounds)}, "conf": round(min(o.get("conf", 1) for o in grounds), 3),
                      "bbox": _union(object_bbox(o, comps) for o in grounds)})
    coins = [o for o in objs if o.get("role") == "coin"]
    if coins:
        items.append({"object_id": coins[0]["id"], "role": "coin", "rel_key": "saw.coins_from_dots",
                      "rel_args": {"n": len(coins)}, "conf": round(min(o.get("conf", 1) for o in coins), 3),
                      "bbox": _union(object_bbox(o, comps) for o in coins)})
    has_pole = {(o.get("rel") or {}).get("part_of") for o in objs if o.get("role") == "pole"}
    for o in objs:
        role = o.get("role")
        rel = o.get("rel") or {}
        if role in ("ground", "coin", "pole", "door") or (rel.get("part_of") and role not in ("text", "arrow")):
            continue
        key, args = "saw.unknown", {}
        if role == "platform":
            beh = o.get("behavior") or {}
            if beh.get("kind") == "move":
                key, args = "saw.platform", {"how": f"moves {beh.get('dir', '')}".strip()}
            elif o.get("collision") == "one_way":
                key = "saw.oneway"
            else:
                key, args = "saw.platform", {"how": "solid"}
        elif role in ("wall", "ceiling", "lava", "saw", "spring", "checkpoint", "big_coin"):
            key = f"saw.{role}"
        elif role == "spikes":
            att = rel.get("attached") or {}
            host = by_id.get(att.get("host") or rel.get("rests_on") or "", {})
            facing = rel.get("points") if rel.get("points") not in (None, "none") else FACE_TO_DIR.get(att.get("face", "top"), "up")
            key, args = "saw.spikes_on", {"host": host.get("role", "ground"), "facing": facing}
        elif role == "enemy":
            beh = o.get("behavior") or {}
            arche = beh.get("archetype") if beh.get("kind") == "enemy" else "static"
            parts = rel.get("parts") or []
            if parts:
                key, args = "saw.monster", {"does": DOES.get(arche or "static", "stands still"),
                                            "parts": "eyes" if len(parts) <= 2 else "parts"}
            else:
                key, args = "saw.monster_plain", {"does": DOES.get(arche or "static", "stands still")}
        elif role == "goal":
            key = "saw.goal_pole" if o["id"] in has_pole else "saw.goal"
        elif role == "key":
            key = "saw.key_door"
        elif role == "start_marker":
            key = "saw.start"
        elif role == "text":
            key, args = "saw.sign", {"text": (o.get("text") or "words")[:40]}
        elif role == "arrow":
            tgt = by_id.get(rel.get("refers_to") or "", {})
            key, args = "saw.arrow", {"what": tgt.get("role", "thing"), "dir": rel.get("points") or "right"}
        elif role == "decoration":
            key, args = "saw.decoration", {"what": "This"}
        items.append({"object_id": o["id"], "role": role, "rel_key": key, "rel_args": args,
                      "conf": round(float(o.get("conf", 1)), 3), "bbox": object_bbox(o, comps)})
    for it in items:
        it["bbox"] = [round(float(v), 3) for v in it["bbox"] or [0, 0, 1, 1]]
    return items


# ---- tiers ---------------------------------------------------------------------------------------------


def morphs(prev: dict[str, Any] | None, new: dict[str, Any], ink: dict[str, Any]) -> list[dict[str, Any]]:
    """Per-object changes between the same tier at two stages (300 ms preview morphs, §3.11)."""
    if not prev:
        return []
    comps = {int(c["id"]): c for c in ink.get("components") or []}
    a = {o["id"]: o for o in (prev.get("level") or {}).get("objects") or []}
    b = {o["id"]: o for o in (new.get("level") or {}).get("objects") or []}
    out: list[dict[str, Any]] = []
    for oid, ob in b.items():
        oa = a.get(oid)
        bb_new = shape_bbox(ob.get("shape") or {}) or object_bbox(ob, comps)
        if oa is None:
            out.append({"object_id": oid, "from": bb_new, "to": bb_new, "kind": "appear"})
            continue
        bb_old = shape_bbox(oa.get("shape") or {}) or object_bbox(oa, comps)
        if oa.get("role") != ob.get("role"):
            out.append({"object_id": oid, "from": bb_old, "to": bb_new, "kind": "relabel"})
        elif any(abs(float(x) - float(y)) > 0.05 for x, y in zip(bb_old, bb_new)):
            out.append({"object_id": oid, "from": bb_old, "to": bb_new, "kind": "move"})
    for oid, oa in a.items():
        if oid not in b:
            bb_old = shape_bbox(oa.get("shape") or {}) or object_bbox(oa, comps)
            out.append({"object_id": oid, "from": bb_old, "to": bb_old, "kind": "vanish"})
    for m in out:
        m["from"] = [round(float(v), 3) for v in m["from"]]
        m["to"] = [round(float(v), 3) for v in m["to"]]
    return out


def applied_ids(result: dict[str, Any]) -> list[str]:
    return [e["id"] for e in result.get("edits") or [] if e.get("status") == "applied"]


def tier_payload(stage: str, tier: str, result: dict[str, Any], *, draft_id: str, reach: bool,
                 morphs_: list[dict[str, Any]]) -> dict[str, Any]:
    level = copy.copy(result.get("level") or {})
    level.pop("ink", None)
    level["ink_ref"] = drafts.ink_ref(draft_id)
    return {"stage": stage, "tier": tier, "level": level, "report": result.get("report") or {},
            "edit_ids": applied_ids(result), "reach": bool(reach), "morphs": morphs_}


def edits_union(tierset: dict[str, Any], extra: Iterable[dict[str, Any]] = ()) -> list[dict[str, Any]]:
    """Every edit record of the four tiers (lowest tier first, so a record keeps the tier it first appears in),
    the rejected ones, and `extra` records (perception, parser, kid), deduped by id."""
    seen: dict[str, dict[str, Any]] = {}
    for e in extra:
        if e.get("id"):
            seen.setdefault(e["id"], e)
    for t in TIERS:  # first appearance wins; which tiers apply an edit is carried by each tier event's edit_ids
        r = tierset.get(t) or {}
        for e in list(r.get("edits") or []) + list(r.get("rejected") or []):
            if e.get("id") and e["id"] not in seen:
                seen[e["id"]] = e
    return list(seen.values())


def summary(tierset: dict[str, Any], rejected: Iterable[str] = ()) -> dict[str, Any]:
    """TierSetSummary (§11.3e PUT edits / answers)."""
    reach = tierset.get("reach") or {}
    tiers: dict[str, Any] = {}
    for t in TIERS:
        r = tierset.get(t)
        if not r:
            continue
        rep = r.get("report") or {}
        lvl = r.get("level") or {}
        tiers[t] = {"tier": t, "level_hash": rep.get("level_hash") or (lvl.get("meta") or {}).get("level_hash") or "",
                    "C": float(rep.get("C", 0) or 0), "band": str(rep.get("band", "trivial")),
                    "solvable": bool(rep.get("solvable", False)), "reach": True if t == "faithful" else bool(reach.get(t, True)),
                    "edit_ids": applied_ids(r)}
    return {"tiers": tiers, "rejected": sorted(set(rejected))}


# ---- kid edits -------------------------------------------------------------------------------------------

# The core's id scheme (web/src/core/util/ids.ts editId/opTarget): `op:target:hash6(canonical identity)`, where the
# identity is the whole op (its `op` name included) minus the fields the normalizer computes. Kid records made here
# must carry the same id the browser and the core give the same op, or statuses would not match (D6).
_OP_TARGET_KEY: dict[str, str] = {
    **{k: "target" for k in ("set_role", "detach", "bind", "use_library", "straighten", "snap", "orient",
                             "set_collision", "coin_from_dot", "fix_behavior", "fit_creature", "trim", "extend",
                             "animate", "make_mine")},
    "group": "root", "link": "key", "set_start": "near", "close_gap": "a", "join_seam": "a", "form_goal": "flag",
    "dedupe": "drop", "nudge": "group", "shift_platform": "group",
    **{k: "slot" for k in ("add_step", "add_spring", "add_checkpoint", "add_coin", "add_big_coin", "add_hint_arrow",
                           "add_spikes", "add_enemy", "add_hazard", "reprise")},
    "add_coin_trail": "action", "tune": "entity", "widen_gap": "gap", "shrink_landing": "surface",
    "make_crumble": "surface",
}
_OP_TARGET_FIXED = {"place_start": "start", "clear_spawn": "start", "set_par": "level", "set_timer": "level"}
_COMPUTED_FIELDS: dict[str, tuple[str, ...]] = {
    "place_start": ("at",), "clear_spawn": ("start_dx", "trimmed"), "set_par": ("par_ms",), "fix_behavior": ("value",),
}
_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]")


def op_target(op: dict[str, Any]) -> str:
    """The object, slot or level an op is about (the middle part of its id), as the core's opTarget."""
    name = str(op.get("op") or "")
    if name in _OP_TARGET_FIXED:
        return _OP_TARGET_FIXED[name]
    v = op.get(_OP_TARGET_KEY.get(name, "target"))
    return _UNSAFE.sub("_", v) if isinstance(v, str) and v else "x"


def edit_id(op: dict[str, Any]) -> str:
    """`op:target:hash6(identity)` exactly as the core's editId (D6)."""
    skip = _COMPUTED_FIELDS.get(str(op.get("op")), ())
    ident = {k: v for k, v in op.items() if k not in skip}
    h = hashlib.sha256(canonical_json(ident).encode("utf-8")).hexdigest()[:6]
    return f"{op['op']}:{op_target(op)}:{h}"


@lru_cache(maxsize=1)
def _op_classes() -> dict[str, str]:
    from typing import get_args

    from app.spec.edits import OP_CLASSES

    return {get_args(m.model_fields["op"].annotation)[0]: cls for cls, ops in OP_CLASSES.items() for m in ops}


def op_class(op_name: str) -> str:
    return _op_classes().get(op_name, "K")


def kid_record(op: dict[str, Any], stage: str, *, reason_key: str | None = None,
               reason_args: dict[str, Any] | None = None) -> dict[str, Any]:
    cls = op_class(op["op"])
    if reason_key is None:
        reason_key = {"set_role": "kid.relabel", "make_mine": "kid.make_mine"}.get(op["op"], "kid.answer")
    if reason_args is None and op["op"] == "set_role":
        reason_args = {"role": op.get("role", "")}
    return {"id": edit_id(op), "op": op, "class": cls, "by": "kid", "stage": stage if stage in drafts.STAGES else "designed",
            "tier": "faithful", "status": "applied", "reason_key": reason_key, "reason_args": reason_args or {},
            "reason_text": None, "depends_on": [], "required": False, "group": None}
