"""Latency / token / cost summary per probe and effort from results/calls.jsonl (no API calls)."""
import json
import statistics
from common import CALLS, RESULTS

recs = [json.loads(l) for l in CALLS.read_text().splitlines() if l.strip()]
def pct(xs, p):
    xs = sorted(xs); k = (len(xs) - 1) * p; f = int(k); c = min(f + 1, len(xs) - 1)
    return round(xs[f] + (xs[c] - xs[f]) * (k - f), 1)
groups = {}
for r in recs:
    groups.setdefault((r["probe"], r["effort"]), []).append(r)
rows = []
for (p, e), rs in sorted(groups.items()):
    lat = [r["latency_s"] for r in rs]
    rows.append({"probe": p, "effort": e, "n": len(rs), "p50_s": pct(lat, .5), "p90_s": pct(lat, .9), "max_s": max(lat),
                 "in_tok_mean": round(statistics.mean(r["input_tokens"] for r in rs)), "out_tok_mean": round(statistics.mean(r["output_tokens"] for r in rs)),
                 "usd_mean": round(statistics.mean(r["cost_usd"] for r in rs), 4), "usd_total": round(sum(r["cost_usd"] for r in rs), 4),
                 "errors": sum(1 for r in rs if r.get("error")), "refusals": sum(1 for r in rs if r.get("stop_reason") == "refusal"),
                 "fallbacks": sum(1 for r in rs if r.get("fallback_used"))})
tot = {"calls": len(recs), "usd_total": round(sum(r["cost_usd"] for r in recs), 3), "errors": sum(1 for r in recs if r.get("error")),
       "refusals": sum(1 for r in recs if r.get("stop_reason") == "refusal"), "fallbacks": sum(1 for r in recs if r.get("fallback_used")),
       "stop_reasons": sorted({r.get("stop_reason") for r in recs})}
(RESULTS / "summary.json").write_text(json.dumps({"by_probe_effort": rows, "total": tot}, indent=1))
for r in rows: print(r)
print(tot)
