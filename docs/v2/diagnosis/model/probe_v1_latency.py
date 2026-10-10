"""One call that reproduces v1's interpret request exactly (app.llm.prompt + client.messages.parse, default
effort, adaptive thinking by default) but with a 120 s timeout instead of v1's 20 s, to measure whether v1's
live path fits its own timeout. Logged to results/calls.jsonl like the other probes.

Usage (inside vision/ env): python probe_v1_latency.py <scene>
"""
from __future__ import annotations

import json
import sys
import time

import anthropic

from common import CALLS, HERE, BUDGET, PRICE_IN, PRICE_OUT, calls_so_far, image_block

sys.path.insert(0, str(HERE.parents[3] / "vision"))
from app.llm.prompt import SYSTEM_PROMPT, build_user_message  # noqa: E402
from app.models import Component, Interpretation  # noqa: E402

scene = sys.argv[1]
if calls_so_far() >= BUDGET:
    raise SystemExit("budget exhausted")
cv = json.loads((HERE / "inputs" / scene / "cv.json").read_text())
comps = [Component(id=c["id"], color=c["color"], bbox=c["bbox"], area_cells=c["area_cells"]) for c in cv["components"]]
content = [image_block(HERE / "inputs" / scene / "annotated.jpg"), {"type": "text", "text": build_user_message(comps, [], None)}]
client = anthropic.Anthropic().with_options(timeout=120.0, max_retries=0)
t0 = time.perf_counter()
resp = client.messages.parse(model="claude-opus-5", max_tokens=4000, system=SYSTEM_PROMPT,
                             messages=[{"role": "user", "content": content}], output_format=Interpretation)
dt = time.perf_counter() - t0
u = resp.usage
rec = {"n": calls_so_far() + 1, "name": f"V1:{scene}", "probe": "V1", "effort": "default(high)", "model": "claude-opus-5",
       "latency_s": round(dt, 2), "stop_reason": resp.stop_reason, "served_by": resp.model, "fallback_used": False,
       "input_tokens": u.input_tokens, "output_tokens": u.output_tokens,
       "cost_usd": round(u.input_tokens * PRICE_IN / 1e6 + u.output_tokens * PRICE_OUT / 1e6, 4),
       "would_time_out_in_v1": dt > 20.0,
       "parsed": resp.parsed_output.model_dump() if resp.parsed_output else None}
with CALLS.open("a") as f:
    f.write(json.dumps(rec) + "\n")
print(json.dumps({k: rec[k] for k in rec if k != "parsed"}))
print(json.dumps(rec["parsed"], indent=1))
