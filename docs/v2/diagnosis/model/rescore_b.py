"""Re-apply every Probe B plan with the current builder.py (no API calls); writes results/probe_b_rescored.json."""
import json
from builder import State, evaluate, graph_from_call, load_scene
from common import RESULTS, ascii_grid

out = []
for f in sorted(RESULTS.glob("probe_b_*_*.json")):
    if "rescored" in f.name:
        continue
    b = json.loads(f.read_text())
    st = State(load_scene(b["scene"]), graph_from_call("A:" + b["scene"]))
    log = [st.apply(e) for e in b["call"]["parsed"]["edits"]]
    after = evaluate(st, b["scene"]); after.pop("_reachable")
    rec = {"scene": b["scene"], "effort": b["effort"], "before": b["before"], "after": after, "applied": log,
           "n_edits": len(log), "latency_s": b["call"]["latency_s"], "output_tokens": b["call"]["output_tokens"], "cost_usd": b["call"]["cost_usd"]}
    out.append(rec)
    print(b["scene"], b["effort"], "solvable", b["before"]["solvable"], "->", after["solvable"], after)
    for l in log:
        print("   ", l)
    if b["effort"] == "high":
        print(ascii_grid(st.rows()))
(RESULTS / "probe_b_rescored.json").write_text(json.dumps(out, indent=1, default=list))
