"""Score Probe A scene graphs against ground truth (no API calls). Writes results/probe_a_scores.json."""
from __future__ import annotations

import json

from common import CALLS, HERE, RESULTS

SOLID_FAMILY = {"ground", "platform"}


def load_calls(probe: str) -> list[dict]:
    return [json.loads(l) for l in CALLS.read_text().splitlines() if l.strip() and json.loads(l)["probe"] == probe]


def score(rec: dict) -> dict:
    scene = rec["name"].split(":", 1)[1]
    gt = json.loads((HERE / "inputs" / scene / "gt.json").read_text())
    obj_of = {c["id"]: c["object"] for c in gt["components"]}
    gtc = {c["id"]: c for c in gt["components"]}
    nodes = {n["id"]: n for n in (rec.get("parsed") or {}).get("nodes", [])}
    role_ok = role_lenient = 0
    errors = []
    for cid, g in gtc.items():
        n = nodes.get(cid)
        if n is None:
            errors.append(f"#{cid} {g['object']}: missing node")
            continue
        if n["role"] == g["role"]:
            role_ok += 1; role_lenient += 1
        elif {n["role"], g["role"]} <= SOLID_FAMILY:
            role_lenient += 1
            errors.append(f"#{cid} {g['object']}: role {n['role']} (gt {g['role']}, lenient ok)")
        else:
            errors.append(f"#{cid} {g['object']}: role {n['role']} (gt {g['role']})")
    # relations: rests_on / attached_to (either field accepted, compared by object), points
    rel_total = rel_ok = 0
    for cid, g in gtc.items():
        n = nodes.get(cid)
        for k in ("rests_on", "attached_to"):
            if k not in g:
                continue
            rel_total += 1
            want = obj_of.get(g[k]) if g[k] is not None else None
            got = [obj_of.get(n[f]) for f in ("rests_on", "attached_to") if n and n.get(f) is not None]
            ok = (want is None and not (n and n.get("rests_on") is not None)) if want is None else (want in got)
            rel_ok += ok
            if not ok:
                errors.append(f"#{cid} {g['object']}: {k} want {want} got rests_on={n and n.get('rests_on')} attached_to={n and n.get('attached_to')}")
        if "points" in g:
            rel_total += 1
            ok = bool(n) and n["points"] == g["points"]
            rel_ok += ok
            if not ok:
                errors.append(f"#{cid} {g['object']}: points want {g['points']} got {n and n['points']}")
    # non-geometry detection: text/arrow/decoration recall (what must NOT become tiles)
    ng = [cid for cid, g in gtc.items() if g["role"] in ("text", "arrow", "decoration")]
    ng_ok = sum(1 for cid in ng if nodes.get(cid, {}).get("role") in ("text", "arrow", "decoration"))
    fp = [cid for cid, g in gtc.items() if g["role"] not in ("text", "arrow", "decoration")
          and nodes.get(cid, {}).get("role") in ("text", "arrow", "decoration")]
    n = len(gtc)
    return {
        "call": rec["n"], "scene": scene, "effort": rec["effort"], "latency_s": rec["latency_s"],
        "input_tokens": rec.get("input_tokens"), "output_tokens": rec.get("output_tokens"), "cost_usd": rec.get("cost_usd"),
        "components": n, "role_acc": round(role_ok / n, 3), "role_acc_lenient": round(role_lenient / n, 3),
        "relations": f"{rel_ok}/{rel_total}", "relation_acc": round(rel_ok / rel_total, 3) if rel_total else None,
        "non_geometry_recall": f"{ng_ok}/{len(ng)}", "geometry_dropped_as_annotation": fp,
        "errors": errors,
        "creator_intent": (rec.get("parsed") or {}).get("creator_intent"),
        "problems_noticed": (rec.get("parsed") or {}).get("problems_noticed"),
    }


if __name__ == "__main__":
    out = [score(r) for r in load_calls("A") if r.get("parsed")]
    (RESULTS / "probe_a_scores.json").write_text(json.dumps(out, indent=1))
    for s in out:
        print(json.dumps({k: s[k] for k in ("call", "scene", "effort", "latency_s", "output_tokens", "cost_usd", "role_acc", "role_acc_lenient", "relations", "non_geometry_recall", "geometry_dropped_as_annotation")}))
        for e in s["errors"]:
            print("    ", e)
        print("     intent:", s["creator_intent"])
        print("     problems:", s["problems_noticed"])
