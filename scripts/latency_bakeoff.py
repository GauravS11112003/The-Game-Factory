#!/usr/bin/env python3
"""P0 latency bakeoff (PLAN_V2 §11.4 P0 item 5): ≤ 16 calls, ≤ $1.50, through the real mind client.

Measures
  - PERCEIVE (effort low, slim schema) on the 4 [M] scenes: thinking omitted (adaptive) vs {"type": "disabled"};
    role accuracy and relations against the hand-labelled gt.json;
  - DESIGN (effort low) on 2 hand-built menus, both thinking modes; share of picks that validate;
  - whether the API accepts the discriminated unions (Perception.bindings, DesignPlan.novel);
  - whether AsyncAnthropic().beta.messages.parse exists (the client uses it);
  - fast mode only when DAL_FAST_MODE=1 (owner decision 1).

Run inside vision/ (the key never leaves the environment):
    set -a; source ../.env; set +a
    uv run --no-sync python ../scripts/latency_bakeoff.py --max-usd 1.50
Writes docs/v2/evals/bakeoff_p0.json; every call is also logged to model_calls (draft_id "bakeoff_p0").
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "vision"))
SCENES_DIR = REPO / "docs" / "v2" / "diagnosis" / "model" / "inputs"
OUT = REPO / "docs" / "v2" / "evals" / "bakeoff_p0.json"
SCENES = ["canvas_floating_spikes", "canvas_wobbly_cave", "canvas_tower_key", "paper_synth_1"]
REPEAT_SCENES = ["canvas_floating_spikes", "canvas_tower_key"]
DRAFT = "bakeoff_p0"
EST_USD = {"perceive": 0.07, "design": 0.08}  # pessimistic, so the cap is never crossed
MEASURE_TIMEOUT_S = 90  # measure the real tail; production timeouts are reported separately
PROD_TIMEOUT_S = {"perceive": 20, "design": 15}
ROLE_MAP = {"spike_strip": "spikes"}
SOLID_FAMILY = {"ground", "platform"}


def image_block(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    media = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": base64.standard_b64encode(data).decode()}}


# ---- PERCEIVE ---------------------------------------------------------------------------------------


def perceive_content(scene: str) -> list[dict[str, Any]]:
    d = SCENES_DIR / scene
    cv = json.loads((d / "cv.json").read_text())
    comps = [{"id": c["id"], "color": c["color"], "bbox": c["bbox"], "area": c["area_cells"]} for c in cv["components"]]
    text = (
        f"Tile: {scene} (1 screen, 48 x 27 cells; {cv.get('mode', 'canvas')} drawing).\n"
        "Component table (bbox = [x0, y0, x1, y1] in cells; area in cells²):\n"
        + json.dumps(comps, separators=(",", ":"))
        + "\nTyped rules: none.\nLibrary: empty.\nReturn the perception for every listed component."
    )
    return [image_block(d / "annotated.jpg"), {"type": "text", "text": text}]


def score_perception(scene: str, parsed: dict[str, Any]) -> dict[str, Any]:
    gt = json.loads((SCENES_DIR / scene / "gt.json").read_text())
    obj_of = {c["id"]: c["object"] for c in gt["components"]}
    nodes = {n["id"]: n for n in parsed.get("nodes", [])}
    role_ok = lenient = 0
    errors: list[str] = []
    for c in gt["components"]:
        want = ROLE_MAP.get(c["role"], c["role"])
        n = nodes.get(c["id"])
        if n is None:
            errors.append(f"#{c['id']} missing")
            continue
        if n["role"] == want:
            role_ok += 1
            lenient += 1
        elif {n["role"], want} <= SOLID_FAMILY:
            lenient += 1
        else:
            errors.append(f"#{c['id']} {c['object']}: {n['role']} (gt {want}, {n['conf']})")
    rel_total = rel_ok = 0
    for c in gt["components"]:
        n = nodes.get(c["id"])
        for k in ("rests_on", "attached_to"):
            if k not in c:
                continue
            rel_total += 1
            want = obj_of.get(c[k]) if c[k] is not None else None
            got = [obj_of.get(n[f]) for f in ("on", "att") if n and n.get(f) is not None]
            ok = (not (n and n.get("on") is not None)) if want is None else want in got
            rel_ok += ok
            if not ok:
                errors.append(f"#{c['id']} {k}: want {want}, got on={n and n.get('on')} att={n and n.get('att')}")
        if "points" in c:
            rel_total += 1
            ok = bool(n) and n["pts"] == c["points"]
            rel_ok += ok
            if not ok:
                errors.append(f"#{c['id']} points: want {c['points']}, got {n and n['pts']}")
    listed = {c["id"] for c in json.loads((SCENES_DIR / scene / "cv.json").read_text())["components"]}
    invented = sorted(set(nodes) - listed)
    n = len(gt["components"])
    return {"components": n, "role_ok": role_ok, "role_lenient": lenient, "role_acc": round(lenient / n, 3),
            "relations": f"{rel_ok}/{rel_total}", "rel_ok": rel_ok, "rel_total": rel_total, "invented_ids": invented,
            "bindings": len(parsed.get("bindings", [])), "errors": errors}


# ---- DESIGN (hand-built menus in the §3.10 DESIGN input format) ---------------------------------------

MENUS: dict[str, dict[str, Any]] = {
    "canvas_floating_spikes": {
        "graph": (
            "objects: o15 ground x0-21 | o16 ground x25-47 | o11 platform one-way x7-15 r22 | o8 platform one-way x15-24 r19 |"
            " o3 ceiling x33-47 r6 | o9 spikes on o11 top, up (snapped) | o14 spikes on o16 top x29-34, up | o4 spikes under o3,"
            " down | o13 enemy static on o15 x14-18 (kid monster) | o5 goal on o16 x44 (grounded) | o6,o12 coins |"
            " o10 text \"jump!\" | o7 arrow -> o8 | o1 cloud, o2 sun: decoration\n"
            "setpieces: \"the spike ledge\" [o9, o11]; \"the pit jump\" [o15, o16]\nintent: a spiky run to a flag; wish: none; pinned: none"
        ),
        "level": (
            "route: r1 walk 2→7 | r2 jump onto o11 (w 18f, h 20f, p 0.01) | r3 jump over o9 to o8 (w 11f, p 0.05) |"
            " r4 runjump o8→o16 over the 5-cell pit (w 9f, p 0.06, lethal) | r5 walk under o4 to goal (h 14f, p 0.02)\n"
            "segments: seg0 start→goal E 0.14 T 9.2 s F 0.6 s actions 5\nC 0.14 (easy) · fastest 9.2 s · par 12 s\n"
            "flags: long_flat (info) o16 x34-44, 10 cells with no required action"
        ),
        "rows": [
            "add_checkpoint:slot.cp.1:a1b2c3 · I added a checkpoint so you don't replay 5 seconds · polish,normal,hard · dC 0 · dT 0 · cost 0.5 · fixes -",
            "add_coin_trail:r4:b2c3d4 · Coins show the jump. Run before this gap! · polish,normal,hard · dC 0 · dT 0 · cost 0.5 · fixes -",
            "add_big_coin:slot.risk.1:c3d4e5 · A big star waits under the ceiling spikes · polish,normal,hard · dC 0 · dT 0.6 · cost 0.5 · fixes -",
            "animate:o13:d4e5f6 · Your monster walks now · polish,normal,hard · dC +0.05 · dT 0.3 · cost 0.5 · fixes -",
            "tune:o13:e5f6a7 · Your monster walks a little faster · normal,hard · dC +0.03 · dT 0.1 · cost 0.5 · fixes -",
            "add_enemy:slot.enemy.2:f6a7b8 · A walker guards the long flat · normal,hard · dC +0.12 · dT 0.5 · cost 1.0 · fixes f_long_flat",
            "widen_gap:gap.1:0a1b2c · The pit is 1 wider · normal,hard · alts gap1 · dC +0.18 · dT 0.1 · cost 1.2 · fixes -",
            "widen_gap:gap.1:1b2c3d · The pit is 2 wider · hard · alts gap1 · dC +0.42 · dT 0.2 · cost 2.4 · fixes -",
            "shrink_landing:o11:2c3d4e · The spike ledge landing is smaller · normal,hard · dC +0.08 · dT 0 · cost 1.2 · fixes -",
            "add_spikes:slot.spk.3:3d4e5f · New spikes on the far ground · normal,hard · dC +0.15 · dT 0.2 · cost 1.0 · fixes f_long_flat",
            "make_crumble:o8:4e5f6a · The high ledge crumbles · hard · dC +0.20 · dT 0 · cost 1.5 · fixes -",
            "add_hazard:slot.hz.1:5f6a7b · A saw spins over the pit · hard · dC +0.35 · dT 0.4 · cost 1.0 · fixes -",
            "add_enemy:slot.enemy.4:6a7b8c · A hopper waits on the first ground · hard · dC +0.25 · dT 0.6 · cost 1.0 · fixes -",
        ],
        "alts": {"gap1": ["widen_gap:gap.1:0a1b2c", "widen_gap:gap.1:1b2c3d"]},
        "cosmetic": ["straighten:o15:7b8c9d", "straighten:o16:8c9d0e"],
        "slots": ["slot.cp.1", "slot.risk.1", "slot.enemy.2", "slot.enemy.4", "slot.spk.3", "slot.hz.1", "slot.coin.1"],
    },
    "canvas_wobbly_cave": {
        "graph": (
            "objects: o9 ground (wavy) x0-23 | o10 ground (wavy) x23-31 (1-cell hole to o9 closed) | o11 ground x38-47 |"
            " o1 ceiling (wavy roof) x0-47 r1-3 | o2 spikes under o1 x19-24, down | o4 wall on o9 x15-17 r18-23 (5 tall) |"
            " o12 spikes on the pit floor x30-39, up | o7, o8 coins | o5 text \"lava!\" (red; sign, walk-through) |"
            " o3 bat drawing: decoration | o6 goal on o11 x44\n"
            "setpieces: \"the tall wall\" [o4]; \"the big pit\" [o10, o11, o12]\n"
            "intent: a dark cave with a wall to climb and a scary pit; wish: none; pinned: none"
        ),
        "level": (
            "faithful repair needed: wall_too_tall at o4 (5 rows; walking jump max 4.45)\n"
            "route: r1 walk 2→14 | r2 jump onto o4 after repair (w 10f, p 0.02) | r3 walk o9→o10 (8-cell runway) |"
            " r4 runjump o10→o11 over the 7-cell pit (w 6f, p 0.18, lethal) | r5 walk to goal\n"
            "segments: seg0 start→goal E 0.21 T 11.5 s F 1.4 s actions 5\n"
            "C 0.24 (easy) · fastest 11.5 s · par 15 s\nflags: none"
        ),
        "rows": [
            "trim:o4:a0b1c2 · This wall was too tall to jump. I made it 1 shorter · faithful,polish,normal,hard · alts rep.wall · dC -0.02 · dT 0 · cost 1.2 · fixes f_wall",
            "nudge:o4:b1c2d3 · I lifted the wall so you can duck under it · faithful,polish,normal,hard · alts rep.wall · dC -0.05 · dT 0 · cost 9.2 · fixes f_wall",
            "add_step:slot.step.1:c2d3e4 · I added a little step so you can climb up · faithful,polish,normal,hard · alts rep.wall · dC -0.03 · dT 0.2 · cost 6 · fixes f_wall",
            "add_checkpoint:slot.cp.2:d3e4f5 · I added a checkpoint after the wall · polish,normal,hard · dC 0 · dT 0 · cost 0.5 · fixes -",
            "add_coin_trail:r4:e4f5a6 · Coins show the jump. Run before this gap! · polish,normal,hard · dC 0 · dT 0 · cost 0.5 · fixes -",
            "add_big_coin:slot.risk.3:f5a6b7 · A big star hangs over the pit · polish,normal,hard · dC 0 · dT 0.8 · cost 0.5 · fixes -",
            "add_enemy:slot.enemy.5:a6b7c8 · A walker patrols the runway before the pit · normal,hard · dC +0.14 · dT 0.4 · cost 1.0 · fixes -",
            "add_spikes:slot.spk.6:b7c8d9 · Spikes on the far end of the wall top · normal,hard · dC +0.22 · dT 0.2 · cost 1.0 · fixes -",
            "make_crumble:o11:c8d9e0 · The landing after the pit crumbles · hard · dC +0.30 · dT 0 · cost 1.5 · fixes -",
            "add_hazard:slot.hz.2:d9e0f1 · A saw swings over the pit · hard · dC +0.45 · dT 0.3 · cost 1.0 · fixes -",
            "add_enemy:slot.enemy.6:e0f1a2 · A bat flies near the ceiling spikes · hard · dC +0.28 · dT 0.4 · cost 1.0 · fixes -",
        ],
        "alts": {"rep.wall": ["trim:o4:a0b1c2", "nudge:o4:b1c2d3", "add_step:slot.step.1:c2d3e4"]},
        "cosmetic": ["straighten:o9:f1a2b3", "straighten:o10:a2b3c4", "straighten:o1:b3c4d5"],
        "slots": ["slot.cp.2", "slot.risk.3", "slot.enemy.5", "slot.enemy.6", "slot.spk.6", "slot.hz.2", "slot.step.1"],
    },
}
TIER_ORDER = {"polish": 1, "polished": 1, "normal": 2, "hard": 3, "faithful": 0}


def design_content(scene: str) -> list[dict[str, Any]]:
    m = MENUS[scene]
    alts = "\n".join(f"{k}: {', '.join(v)}" for k, v in m["alts"].items())
    text = (
        f"GRAPH DIGEST\n{m['graph']}\n\nLEVEL DIGEST\n{m['level']}\n\nALTS GROUPS (pick at most one per group)\n{alts}\n\n"
        "MENU (cid · summary · tiers · dC · dT · cost · fixes)\n" + "\n".join(m["rows"]) + "\n\n"
        f"NON-REQUIRED COSMETIC NORMALIZATIONS (edit ids): {', '.join(m['cosmetic'])}\n"
        f"SLOTS for novel ops: {', '.join(m['slots'])}\n"
        "TIER TARGETS: polish C ≥ max(C_f, 0.1), raised only up to 0.3; normal C 0.3-1.0 (aim 0.6); hard C 1.0-3.0 (aim 1.8).\n"
        "BUDGETS: polish ≤ 2 picks per screen plus coins; normal/hard ≤ 4 per screen. The level is 1 screen.\n"
        "Return the design plan."
    )
    return [image_block(SCENES_DIR / scene / "input.png"), {"type": "text", "text": text}]


def validate_plan(scene: str, plan: dict[str, Any]) -> dict[str, Any]:
    m = MENUS[scene]
    rows = {r.split(" · ")[0]: r for r in m["rows"]}
    tiers_of = {cid: r.split(" · ")[2].split(",") for cid, r in rows.items()}
    alts_of = {cid: g for g, cids in m["alts"].items() for cid in cids}
    ok = total = 0
    problems: list[str] = []
    used_alts: dict[str, str] = {}
    for p in plan.get("picks", []):
        total += 1
        cid, tier = p["cid"], p["tier"]
        if cid not in rows:
            problems.append(f"unknown cid {cid}")
            continue
        allowed = [TIER_ORDER[t] for t in tiers_of[cid]]
        if TIER_ORDER[tier] < min(allowed):
            problems.append(f"{cid} picked for {tier}, lowest allowed {tiers_of[cid][0]}")
            continue
        g = alts_of.get(cid)
        if g and g in used_alts and used_alts[g] != cid:
            problems.append(f"{cid}: second pick in alts {g}")
            continue
        if g:
            used_alts[g] = cid
        ok += 1
    for n in plan.get("novel", []):
        total += 1
        slot = n.get("slot")
        if slot is not None and slot not in m["slots"]:
            problems.append(f"novel {n['op']} into unknown slot {slot}")
            continue
        ok += 1
    for rc in plan.get("repair_choices", []):
        total += 1
        if rc["cid"] in m["alts"].get(rc["alts"], []):
            ok += 1
        else:
            problems.append(f"repair choice {rc['cid']} not in {rc['alts']}")
    bad_vetoes = [v["edit_id"] for v in plan.get("vetoes", []) if v["edit_id"] not in m["cosmetic"]]
    long_reasons = [p["reason"] for p in plan.get("picks", []) if len(p["reason"].split()) > 12]
    repair = [rc["cid"] for rc in plan.get("repair_choices", [])]
    return {"items": total, "valid": ok, "valid_frac": round(ok / total, 3) if total else None, "problems": problems,
            "bad_vetoes": bad_vetoes, "reasons_over_12_words": len(long_reasons), "repair_choices": repair,
            "picks": [(p["cid"], p["tier"]) for p in plan.get("picks", [])],
            "note_words": len(plan.get("designer_note", "").split())}


# ---- run ----------------------------------------------------------------------------------------------


def pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    k = (len(xs) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 2)


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-usd", type=float, default=1.50)
    ap.add_argument("--max-calls", type=int, default=16)
    ap.add_argument("--dry-run", action="store_true", help="build every request and print the plan; no API calls")
    ap.add_argument("--only", choices=["perceive", "design"], help="run one kind only")
    ap.add_argument("--perceive-schema", choices=["union", "flat"], default="union",
                    help="union: §3.10 Perception (discriminated Binding union); flat: the PerceptionFlat fallback")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    # The per-draft cap would stop the bakeoff after a few calls; the bakeoff has its own --max-usd guard.
    os.environ["DAL_DRAFT_BUDGET_USD"] = str(a.max_usd)

    import anthropic

    from app import db_v2
    from app.mind import client as mind
    from app.mind.schemas import DesignPlan, Perception, PerceptionFlat

    fast = os.environ.get("DAL_FAST_MODE") == "1"
    plan: list[tuple[str, str, str | None]] = []  # (kind, scene, thinking)
    for scene in SCENES:
        for think in (None, "disabled"):
            plan.append(("perceive", scene, think))
    for scene in MENUS:
        for think in (None, "disabled"):
            plan.append(("design", scene, think))
    for scene in REPEAT_SCENES:
        for think in (None, "disabled"):
            plan.append(("perceive", scene, think))
    if a.only:
        plan = [p for p in plan if p[0] == a.only]
        if a.only == "perceive":  # one more repeat per mode on a third scene keeps the 6+6 design
            plan = plan + [("perceive", "canvas_wobbly_cave", t) for t in (None, "disabled")][: max(0, a.max_calls - len(plan))]
    plan = plan[: a.max_calls]
    perceive_schema = Perception if a.perceive_schema == "union" else PerceptionFlat
    async_parse = hasattr(anthropic.AsyncAnthropic(api_key="x").beta.messages, "parse")
    print(f"{len(plan)} calls planned; AsyncAnthropic().beta.messages.parse exists: {async_parse}; fast mode: {fast}")
    if a.dry_run:
        for kind, scene, think in plan:
            content = perceive_content(scene) if kind == "perceive" else design_content(scene)
            print(kind, scene, think or "adaptive", sum(len(c.get("text", "")) for c in content), "text chars")
        return 0
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set (run: set -a; source ../.env; set +a)")
        return 2
    db_v2.migrate()

    records: list[dict[str, Any]] = []
    spent = 0.0
    for i, (kind, scene, think) in enumerate(plan, 1):
        if spent + EST_USD[kind] > a.max_usd:
            print(f"stopping: ${spent:.3f} spent, next call could exceed --max-usd {a.max_usd}")
            break
        schema = perceive_schema if kind == "perceive" else DesignPlan
        content = perceive_content(scene) if kind == "perceive" else design_content(scene)
        r = await mind.call(kind, schema, content, draft_id=DRAFT, deadline=time.monotonic() + MEASURE_TIMEOUT_S + 5,
                            thinking=think, timeout_s=MEASURE_TIMEOUT_S, fast=fast)
        spent += r.cost_usd
        rec: dict[str, Any] = {
            "n": i, "kind": kind, "scene": scene, "thinking": think or "adaptive", "status": r.status, "error": r.error,
            "latency_s": r.latency_s, "in_tok": r.in_tok, "out_tok": r.out_tok, "cache_read_tok": r.cache_read_tok,
            "cost_usd": r.cost_usd, "stop_reason": r.stop_reason, "served_by": r.served_by, "fallback_used": r.fallback_used,
            "over_prod_timeout": r.latency_s > PROD_TIMEOUT_S[kind],
        }
        if r.value is not None:
            parsed = r.value.model_dump()
            rec["parsed"] = parsed
            rec["score"] = score_perception(scene, parsed) if kind == "perceive" else validate_plan(scene, parsed)
        records.append(rec)
        if r.error and "grammar is too large" in r.error and i == 1:
            print("schema rejected by the API on the first call; stopping this pass (rejections cost nothing)")
            break
        s = rec.get("score", {})
        print(f"[{i:2}] {kind:8} {scene:24} {rec['thinking']:8} {r.status:9} {r.latency_s:6.2f}s in {r.in_tok:5} out {r.out_tok:5}"
              f" cache {r.cache_read_tok:5} ${r.cost_usd:.4f}  {s.get('role_acc', s.get('valid_frac', ''))} {r.error or ''}")

    summary: dict[str, Any] = {"calls": len(records), "billed_calls": sum(r["out_tok"] > 0 for r in records),
                               "perceive_schema": a.perceive_schema, "spent_usd": round(spent, 4), "async_parse": async_parse,
                               "fast_mode": "run" if fast else "not run (DAL_FAST_MODE != 1)", "by": {}}
    for kind in ("perceive", "design"):
        for think in ("adaptive", "disabled"):
            rs = [r for r in records if r["kind"] == kind and r["thinking"] == think]
            ok = [r for r in rs if r["status"] == "ok"]
            lat = [r["latency_s"] for r in ok]
            entry: dict[str, Any] = {
                "n": len(rs), "ok": len(ok), "p50_s": pct(lat, 0.5), "p90_s": pct(lat, 0.9),
                "mean_out_tok": round(statistics.mean(r["out_tok"] for r in ok)) if ok else None,
                "mean_cost_usd": round(statistics.mean(r["cost_usd"] for r in ok), 4) if ok else None,
                "over_prod_timeout": sum(r["over_prod_timeout"] for r in rs),
                "errors": [r["error"] for r in rs if r["status"] != "ok"],
            }
            if kind == "perceive" and ok:
                comps = sum(r["score"]["components"] for r in ok)
                entry["role_acc"] = round(sum(r["score"]["role_lenient"] for r in ok) / comps, 3)
                entry["role_acc_strict"] = round(sum(r["score"]["role_ok"] for r in ok) / comps, 3)
                entry["relations"] = f"{sum(r['score']['rel_ok'] for r in ok)}/{sum(r['score']['rel_total'] for r in ok)}"
                entry["invented_ids"] = sum(len(r["score"]["invented_ids"]) for r in ok)
                entry["bindings"] = sum(r["score"]["bindings"] for r in ok)
            if kind == "design" and ok:
                items = sum(r["score"]["items"] for r in ok)
                entry["picks_valid_frac"] = round(sum(r["score"]["valid"] for r in ok) / items, 3) if items else None
                entry["repair_choices"] = [r["score"]["repair_choices"] for r in ok]
            summary["by"][f"{kind}/{think}"] = entry
    perceive_ok = any(r["kind"] == "perceive" and r["status"] == "ok" for r in records)
    ran = {r["kind"] for r in records}
    unions = {
        "perception_bindings_union": (perceive_ok if a.perceive_schema == "union" else None) if "perceive" in ran else None,
        "perception_flat_bindings": (perceive_ok if a.perceive_schema == "flat" else None) if "perceive" in ran else None,
        "design_novel_union": any(r["kind"] == "design" and r["status"] == "ok" for r in records) if "design" in ran else None,
        "schema_errors": [r["error"] for r in records if r["error"] and "schema" in r["error"].lower()],
    }
    summary["unions_accepted"] = unions
    out = a.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"date": time.strftime("%Y-%m-%d %H:%M"), "model": mind.MODEL, "summary": summary,
                               "calls": records}, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps(summary, indent=1))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
