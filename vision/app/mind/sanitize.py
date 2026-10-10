"""Sanitizer: model-facing answers → the wire forms the core receives (PLAN_V2 §3.10 "Sanitizer", §3.3 merge).

- **Drop** unknown ids, cids, slots and edit_ids (the model never invents an object into the level).
- **Clamp** `cells` to 1-12 and `seconds` to 10-300.
- **Map** enums to numbers through shared/spec/params.json `GRIDS` (confidence high/medium/low → 0.9/0.75/0.5).
- **Truncate** free text: reasons to 90 chars, the note to 240, the intent to 160 (the UI renders text, never HTML).
- **Ignore oversize lists** beyond the first entries: > 3 novel ops, > 4 setpieces, > 3 critique lines.
- **Priority on conflict:** kid > model > parser > heuristic: a pick the kid already undid is dropped.

PERCEIVE: a node is invalid when its id was not listed for that tile or repeats; when more than 30% of the
returned nodes are invalid the whole tile perception is discarded (the heuristic graph stands). A key whose door
cannot be identified becomes a `which_door` Ask, never a silent coin [M v1].

Speed enums map per binding: `move` → platform_speed, `saw` → saw_speed, `enemy` by archetype → walker/flyer/chaser
speed grids (c/s); for hopper, shooter and crusher the number is that archetype's timing grid value
(hopper_interval, shooter_interval, crusher_warn, in seconds), see docs/v2/requests/D-1.md.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Iterable

from app.config import SHARED_DIR
from app.mind import schemas as ms

CONF = {"high": 0.9, "medium": 0.75, "low": 0.5}
TIER_MAP = {"polish": "polished", "normal": "normal", "hard": "hard"}
TIER_RANK = {"faithful": 0, "polished": 1, "normal": 2, "hard": 3}

# Fallbacks when shared/spec/params.json is unreadable (values from web/src/core/params.ts).
_FALLBACK_GRIDS: dict[str, dict[str, Any]] = {
    "walker_speed": {"enum": {"slow": 1.5, "normal": 2, "fast": 3}},
    "flyer_speed": {"enum": {"slow": 1.5, "normal": 2, "fast": 3}},
    "chaser_speed": {"enum": {"slow": 3, "normal": 4, "fast": 5}},
    "platform_speed": {"enum": {"slow": 1.5, "normal": 2, "fast": 3.5}},
    "saw_speed": {"enum": {"slow": 2, "normal": 3, "fast": 5}},
    "hopper_interval": {"enum": {"slow": 2.5, "normal": 1.6, "fast": 1.0}},
    "shooter_interval": {"enum": {"slow": 4, "normal": 2.5, "fast": 1.5}},
    "crusher_warn": {"enum": {"slow": 0.8, "normal": 0.5, "fast": 0.3}},
    "spring_strength": {"enum": {"small": 0.8, "normal": 1.0, "big": 1.3}},
}
_FALLBACK_LIMITS = {"cells": [1, 12], "seconds": [10, 300], "reason_chars": 90, "note_chars": 240, "intent_chars": 160,
                    "novel_max": 3, "setpieces_max": 4, "critique_max": 3}

ENEMY_GRID = {"walker": "walker_speed", "static": "walker_speed", "flyer": "flyer_speed", "chaser": "chaser_speed",
              "hopper": "hopper_interval", "shooter": "shooter_interval", "crusher": "crusher_warn"}

TITLE_CHARS = 40
TRANSCRIPT_CHARS = 400
EVIDENCE_CHARS = 90
OPTION_CHARS = 40
SETPIECE_NAME_CHARS = 40
MAX_ASKS = 6
MAX_DESIGN_ASKS = 3
MAX_OPTIONS = 4
INVALID_DISCARD_FRAC = 0.3
DEFAULT_MOVE_CELLS = 4


@lru_cache(maxsize=1)
def params() -> dict[str, Any]:
    try:
        return json.loads((SHARED_DIR / "spec" / "params.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def limits() -> dict[str, Any]:
    return {**_FALLBACK_LIMITS, **(params().get("MODEL", {}).get("sanitize") or {})}


def grid_enum(grid: str, value: str, default: str = "normal") -> float:
    grids = params().get("GRIDS") or {}
    enum = (grids.get(grid) or _FALLBACK_GRIDS.get(grid) or {}).get("enum") or {}
    if value not in enum:
        value = default
    v = enum.get(value)
    if v is None:
        v = (_FALLBACK_GRIDS.get(grid) or {}).get("enum", {}).get(value, 1.0)
    return float(v)


_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_WS = re.compile(r"\s+")


def text(s: Any, n: int) -> str:
    """Plain text: control characters removed, whitespace collapsed, cut to n characters (with an ellipsis)."""
    if s is None:
        return ""
    t = _WS.sub(" ", _CTRL.sub("", str(s))).strip()
    if len(t) <= n:
        return t
    return t[: max(1, n - 1)].rstrip() + "…"


def opt_text(s: Any, n: int) -> str | None:
    t = text(s, n)
    return t or None


def clamp(v: Any, lo: int, hi: int) -> int:
    try:
        i = int(round(float(v)))
    except (TypeError, ValueError):
        i = lo
    return max(lo, min(hi, i))


# ---- PERCEIVE ---------------------------------------------------------------------------------------


@dataclass
class PerceptionOut:
    value: dict[str, Any] | None  # PerceptionJson (wire form), None when discarded
    dropped: list[str] = field(default_factory=list)
    discarded: bool = False
    invalid_frac: float = 0.0
    missing: list[int] = field(default_factory=list)  # listed ids the model did not return (the heuristic stands)


def _ask(about: int, kind: str, options: Iterable[str] = ()) -> dict[str, Any]:
    return {"about": about, "kind": kind, "options": [text(o, OPTION_CHARS) for o in list(options)[:MAX_OPTIONS]]}


def _binding(b: ms.FlatBinding, known: set[int]) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str | None]:
    """(binding, ask, drop_reason) for one flat binding."""
    lim = limits()
    lo_c, hi_c = lim["cells"]
    lo_s, hi_s = lim["seconds"]
    k = b.kind
    tgt = b.target
    if k == "timer":
        if b.seconds <= 0:
            return None, None, "timer:no_seconds"
        return {"kind": "timer", "seconds": clamp(b.seconds, lo_s, hi_s)}, None, None
    if tgt not in known:
        return None, None, f"{k}:unknown_target:{tgt}"
    if k == "key_door":
        if b.door in known and b.door != tgt:
            return {"kind": "key_door", "key": tgt, "door": b.door}, None, None
        return None, _ask(tgt, "which_door"), None  # both ids or an Ask, never a silent downgrade
    if k == "move":
        if b.dir == "none":
            return None, _ask(tgt, "what_does_it_do"), None
        cells = clamp(b.cells, lo_c, hi_c) if b.cells and b.cells > 0 else DEFAULT_MOVE_CELLS
        return {"kind": "move", "target": tgt, "dir": b.dir, "cells": cells,
                "speed": grid_enum("platform_speed", b.speed), "mode": b.mode if b.mode != "none" else "pingpong"}, None, None
    if k == "enemy":
        if b.archetype == "none":
            return None, _ask(tgt, "what_does_it_do"), None
        grid = ENEMY_GRID.get(b.archetype, "walker_speed")
        return {"kind": "enemy", "target": tgt, "archetype": b.archetype, "speed": grid_enum(grid, b.speed),
                "spiky": bool(b.spiky)}, None, None
    if k == "spring":
        d = b.dir if b.dir in ("up", "left", "right") else "up"
        return {"kind": "spring", "target": tgt, "dir": d, "strength": grid_enum("spring_strength", b.strength)}, None, None
    if k == "crumble":
        return {"kind": "crumble", "target": tgt, "falls": bool(b.falls)}, None, None
    if k == "saw":
        cells = 0 if b.dir == "none" else (clamp(b.cells, lo_c, hi_c) if b.cells and b.cells > 0 else DEFAULT_MOVE_CELLS)
        return {"kind": "saw", "target": tgt, "dir": b.dir, "cells": cells, "speed": grid_enum("saw_speed", b.speed)}, None, None
    if k == "checkpoint":
        return {"kind": "checkpoint", "target": tgt}, None, None
    if k == "start":
        return {"kind": "start", "near": tgt}, None, None
    if k == "library":
        name = text(b.type_name, 16)
        if not name:
            return None, _ask(tgt, "is_library"), None
        return {"kind": "library", "target": tgt, "type_name": name}, None, None
    return None, None, f"{k}:unsupported"


def _binding_key(b: dict[str, Any]) -> tuple[Any, ...]:
    return (b["kind"], b.get("target", b.get("key", b.get("near"))))


def sanitize_perception(p: ms.PerceptionFlat, tile: str, node_ids: Iterable[int], known_ids: Iterable[int]) -> PerceptionOut:
    """`node_ids`: the component ids listed for this tile (the only ids nodes may carry); `known_ids`: every
    component id in the drawing (relations, bindings and setpieces may point across tiles)."""
    listed = set(node_ids)
    known = set(known_ids) | listed
    lim = limits()
    dropped: list[str] = []
    seen: set[int] = set()
    invalid = 0
    nodes: list[dict[str, Any]] = []
    for n in p.nodes:
        if n.id not in listed or n.id in seen:
            invalid += 1
            dropped.append(f"node:{n.id}")
            continue
        seen.add(n.id)

        def rel(v: int | None) -> int | None:
            if v is None or v == n.id or v not in known:
                if v is not None and v != n.id:
                    dropped.append(f"rel:{n.id}->{v}")
                return None
            return v

        att = rel(n.att)
        nodes.append({"id": n.id, "role": n.role, "conf": CONF.get(n.conf, 0.5), "on": rel(n.on), "att": att,
                      "face": n.face if att is not None else "none", "pts": n.pts, "part": rel(n.part), "ref": rel(n.ref)})
    total = len(p.nodes)
    frac = invalid / total if total else 0.0
    missing = sorted(listed - seen)
    if total and frac > INVALID_DISCARD_FRAC:
        return PerceptionOut(value=None, dropped=dropped, discarded=True, invalid_frac=round(frac, 3), missing=missing)

    bindings: list[dict[str, Any]] = []
    asks: list[dict[str, Any]] = []
    bkeys: set[tuple[Any, ...]] = set()
    for bound in p.bindings:
        b, ask, why = _binding(bound.binding, known)
        if why:
            dropped.append(f"binding:{why}")
        if ask is not None:
            asks.append(ask)
        if b is None:
            continue
        key = _binding_key(b)
        if key in bkeys:
            dropped.append(f"binding:duplicate:{key[0]}:{key[1]}")
            continue
        bkeys.add(key)
        pinned = sorted(set(bound.pinned))
        if b["kind"] == "move" and not (bound.binding.cells and bound.binding.cells > 0) and "cells" in pinned:
            pinned.remove("cells")  # a default distance is not something the child stated
        bindings.append({"binding": b, "pinned": pinned, "evidence": text(bound.evidence, EVIDENCE_CHARS)})

    setpieces: list[dict[str, Any]] = []
    for sp in p.setpieces[: lim["setpieces_max"]]:
        ids = [i for i in dict.fromkeys(sp.ids) if i in known]
        name = text(sp.name, SETPIECE_NAME_CHARS)
        if not ids or not name:
            dropped.append(f"setpiece:{sp.name[:20]}")
            continue
        setpieces.append({"name": name, "ids": ids, "kind": sp.kind})

    ask_keys = {(a["about"], a["kind"]) for a in asks}
    for a in p.asks:
        if a.about not in known:
            dropped.append(f"ask:{a.about}")
            continue
        if (a.about, a.kind) in ask_keys:
            continue
        ask_keys.add((a.about, a.kind))
        asks.append(_ask(a.about, a.kind, a.options))

    value = {
        "tile": tile, "nodes": nodes, "bindings": bindings, "setpieces": setpieces,
        "intent": text(p.intent, lim["intent_chars"]), "difficulty_wish": p.difficulty_wish,
        "transcript": text(p.transcript, TRANSCRIPT_CHARS), "title": opt_text(p.title, TITLE_CHARS),
        "asks": asks[:MAX_ASKS], "safety_ok": bool(p.safety_ok),
        "safety_reason": opt_text(p.safety_reason, 160) if not p.safety_ok else None,
    }
    return PerceptionOut(value=value, dropped=dropped, discarded=False, invalid_frac=round(frac, 3), missing=missing)


# ---- DESIGN / REFINE / CRITIC ---------------------------------------------------------------------------


@dataclass
class MenuIndex:
    """What a design answer may refer to: menu cids (+ their candidate rows), alts groups, slot ids, object and
    entity ids, setpiece names, the non-required cosmetic normalizations, and ids the kid undid."""

    candidates: dict[str, dict[str, Any]]
    alts: dict[str, list[str]]
    slots: set[str]
    object_ids: set[str]
    entity_ids: set[str]
    setpieces: set[str]
    cosmetic: set[str]
    undone: set[str] = field(default_factory=set)
    segments: set[str] = field(default_factory=set)

    @classmethod
    def build(cls, menu: list[dict[str, Any]], result: dict[str, Any] | None, *, undone: Iterable[str] = (),
              graph: dict[str, Any] | None = None) -> "MenuIndex":
        cands = {c["cid"]: c for c in menu if isinstance(c, dict) and c.get("cid")}
        alts: dict[str, list[str]] = {}
        for c in cands.values():
            if c.get("alts"):
                alts.setdefault(c["alts"], []).append(c["cid"])
        slots: set[str] = set()
        objects: set[str] = set()
        entities: set[str] = set()
        setpieces: set[str] = set()
        cosmetic: set[str] = set()
        segments: set[str] = set()
        if result:
            report = result.get("report") or {}
            for group in (report.get("slots") or {}).values():
                for s in group or []:
                    if isinstance(s, dict) and s.get("id"):
                        slots.add(s["id"])
            for seg in report.get("segments") or []:
                if seg.get("id"):
                    segments.add(seg["id"])
            for step in report.get("route") or []:
                slots.add(f"r{step.get('i')}")  # route step ids for coin trails
            level = result.get("level") or {}
            for e in (level.get("compiled") or {}).get("entities") or []:
                if e.get("id"):
                    entities.add(e["id"])
            g = graph or result.get("graph") or {}
            for o in g.get("objects") or level.get("objects") or []:
                if o.get("id"):
                    objects.add(o["id"])
            for sp in g.get("setpieces") or level.get("setpieces") or []:
                if sp.get("name"):
                    setpieces.add(sp["name"])
            for e in result.get("edits") or []:
                if e.get("class") == "N" and not e.get("required"):
                    cosmetic.add(e["id"])
        return cls(candidates=cands, alts=alts, slots=slots, object_ids=objects, entity_ids=entities | objects,
                   setpieces=setpieces, cosmetic=cosmetic, undone=set(undone), segments=segments)


def _clamp_tier(tier: str, cand: dict[str, Any]) -> str | None:
    want = TIER_MAP.get(tier, tier)
    allowed = [t for t in cand.get("tiers") or [] if t in TIER_RANK]
    if not allowed:
        return want
    allowed_pickable = [t for t in allowed if t != "faithful"] or ["polished"]
    lo = min(allowed_pickable, key=lambda t: TIER_RANK[t])
    hi = max(allowed_pickable, key=lambda t: TIER_RANK[t])
    if TIER_RANK[want] < TIER_RANK[lo]:
        return lo  # a hard-only candidate picked for normal applies from its lowest allowed tier
    if TIER_RANK[want] > TIER_RANK[hi]:
        return hi
    return want


def _picks(picks: Iterable[ms.Pick], idx: MenuIndex, used_alts: set[str], dropped: list[str]) -> list[dict[str, Any]]:
    lim = limits()
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for p in picks:
        cand = idx.candidates.get(p.cid)
        if cand is None:
            dropped.append(f"pick:unknown:{p.cid}")
            continue
        if p.cid in seen:
            continue
        if p.cid in idx.undone:
            dropped.append(f"pick:kid_undid:{p.cid}")  # kid > model
            continue
        grp = cand.get("alts")
        if grp and grp in used_alts:
            dropped.append(f"pick:alts:{p.cid}")
            continue
        tier = _clamp_tier(p.tier, cand)
        if tier is None:
            dropped.append(f"pick:tier:{p.cid}")
            continue
        seen.add(p.cid)
        if grp:
            used_alts.add(grp)
        out.append({"cid": p.cid, "tier": tier, "reason": text(p.reason, lim["reason_chars"])})
    return out


_OBJ_ID = re.compile(r"\bo\d+\b")


def _resolve_about(about: str, idx: MenuIndex) -> str | None:
    a = (about or "").strip()
    if a in idx.object_ids:
        return a
    for m in _OBJ_ID.findall(a):
        if m in idx.object_ids:
            return m
    return None


def _novel(ops: Iterable[Any], idx: MenuIndex, dropped: list[str]) -> list[dict[str, Any]]:
    lim = limits()
    out: list[dict[str, Any]] = []
    for op in list(ops):
        if len(out) >= lim["novel_max"]:
            dropped.append("novel:oversize")
            break
        reason = text(getattr(op, "reason", ""), lim["reason_chars"])
        kind = op.op
        if kind in ("add_enemy", "add_spikes", "add_big_coin", "add_checkpoint"):
            if op.slot not in idx.slots:
                dropped.append(f"novel:{kind}:slot:{op.slot}")
                continue
            d: dict[str, Any] = {"op": kind, "slot": op.slot, "reason": reason}
            if kind == "add_enemy":
                d["archetype"] = op.archetype
            if kind in ("add_enemy", "add_spikes"):
                d["tier"] = TIER_MAP[op.tier]
            out.append(d)
        elif kind == "tune":
            if op.target not in idx.entity_ids:
                dropped.append(f"novel:tune:{op.target}")
                continue
            out.append({"op": "tune", "target": op.target, "param": op.param, "step": 2 if op.step == "+2" else 1,
                        "tier": TIER_MAP[op.tier], "reason": reason})
        elif kind == "make_crumble":
            if op.target not in idx.object_ids:
                dropped.append(f"novel:make_crumble:{op.target}")
                continue
            out.append({"op": "make_crumble", "target": op.target, "tier": TIER_MAP[op.tier], "reason": reason})
        elif kind == "reprise":
            if op.setpiece not in idx.setpieces or op.slot not in idx.slots:
                dropped.append(f"novel:reprise:{op.setpiece}:{op.slot}")
                continue
            out.append({"op": "reprise", "setpiece": op.setpiece, "slot": op.slot, "escalation": op.escalation,
                        "reason": reason})
    return out


def sanitize_plan(plan: ms.DesignPlan, idx: MenuIndex, *, picks_only: bool = False) -> tuple[dict[str, Any], list[str]]:
    """DesignPlan (model) → DesignPlanJson (wire). `picks_only` for REFINE (repair choices, vetoes, asks ignored)."""
    lim = limits()
    dropped: list[str] = []
    used_alts: set[str] = set()
    repair: list[dict[str, Any]] = []
    if not picks_only:
        for rc in plan.repair_choices:
            members = idx.alts.get(rc.alts)
            if not members or rc.cid not in members:
                dropped.append(f"repair:{rc.alts}:{rc.cid}")
                continue
            if rc.alts in used_alts or rc.cid in idx.undone:
                dropped.append(f"repair:dup:{rc.alts}")
                continue
            used_alts.add(rc.alts)
            repair.append({"alts": rc.alts, "cid": rc.cid, "reason": text(rc.reason, lim["reason_chars"])})
    picks = _picks(plan.picks, idx, used_alts, dropped)
    vetoes: list[dict[str, Any]] = []
    if not picks_only:
        seen_v: set[str] = set()
        for v in plan.vetoes:
            if v.edit_id not in idx.cosmetic or v.edit_id in seen_v:
                dropped.append(f"veto:{v.edit_id}")
                continue
            seen_v.add(v.edit_id)
            vetoes.append({"edit_id": v.edit_id, "reason": text(v.reason, lim["reason_chars"])})
    novel = _novel(plan.novel, idx, dropped)
    asks: list[dict[str, Any]] = []
    if not picks_only:
        for a in plan.asks:
            about = _resolve_about(a.about, idx)
            if about is None:
                dropped.append(f"ask:{a.about[:24]}")
                continue
            asks.append({"about": about, "kind": a.kind,
                         "options": [text(o, OPTION_CHARS) for o in a.options[:MAX_OPTIONS]]})
            if len(asks) >= MAX_DESIGN_ASKS:
                break
    out = {
        "repair_choices": repair, "vetoes": vetoes, "picks": picks, "novel": novel, "asks": asks,
        "designer_note": text(plan.designer_note, lim["note_chars"]),
        "critique": [t for t in (text(c, lim["reason_chars"]) for c in plan.critique[: lim["critique_max"]]) if t],
        "title": opt_text(plan.title, TITLE_CHARS),
    }
    return out, dropped


def sanitize_critique(c: ms.Critique, idx: MenuIndex) -> tuple[dict[str, Any], list[str]]:
    """Critique → {observations: [{segment, what}], plan: DesignPlanJson (picks only), note}."""
    lim = limits()
    dropped: list[str] = []
    obs: list[dict[str, str]] = []
    for o in c.observations[:3]:
        what = text(o.what, lim["reason_chars"])
        if not what:
            continue
        seg = o.segment if (not idx.segments or o.segment in idx.segments) else ""
        obs.append({"segment": seg, "what": what})
    picks = _picks(c.picks[:3], idx, set(), dropped)
    plan = {"repair_choices": [], "vetoes": [], "picks": picks, "novel": [], "asks": [],
            "designer_note": text(c.note, lim["note_chars"]), "critique": [o["what"] for o in obs], "title": None}
    return {"observations": obs, "plan": plan, "note": text(c.note, lim["note_chars"])}, dropped


def merge_plans(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    """REFINE result on top of the previous plan: picks and novel ops appended (no duplicate cid, at most one per
    alts group is enforced again by the core's applyPlan), everything else from the base."""
    seen = {p["cid"] for p in base.get("picks", [])}
    picks = list(base.get("picks", [])) + [p for p in extra.get("picks", []) if p["cid"] not in seen]
    novel = (list(base.get("novel", [])) + list(extra.get("novel", [])))[: limits()["novel_max"]]
    note = base.get("designer_note") or extra.get("designer_note", "")  # DESIGN's note is about the level; REFINE's about a delta
    return {**base, "picks": picks, "novel": novel, "designer_note": note}
