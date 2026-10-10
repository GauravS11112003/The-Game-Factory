"""Shared helpers for the model-capability probes.

- call(): one structured-output call to claude-opus-5 through client.beta.messages.parse with
  adaptive thinking, an explicit effort, and server-side refusal fallbacks ("default").
  Every call is appended to results/calls.jsonl (latency, tokens, cost, stop reason, served model).
  A hard budget guard refuses to send more than BUDGET calls in total.
- solve_levels(): runs the real v1 TypeScript solver (web/src/solver) via vite-node.
- grid helpers and a minimal level builder for the solver.

Never prints or logs the API key.
"""
from __future__ import annotations

import base64
import json
import subprocess
import time
from pathlib import Path
from typing import Any

import anthropic

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
RESULTS = HERE / "results"
RESULTS.mkdir(exist_ok=True)
CALLS = RESULTS / "calls.jsonl"

MODEL = "claude-opus-5"
PRICE_IN, PRICE_OUT = 5.0, 25.0  # $ per million tokens
BUDGET = 24
W, H = 48, 27


def calls_so_far() -> int:
    if not CALLS.exists():
        return 0
    return sum(1 for line in CALLS.read_text().splitlines() if line.strip())


def image_block(path: Path) -> dict:
    data = path.read_bytes()
    media = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": base64.standard_b64encode(data).decode("ascii")}}


def call(name: str, probe: str, effort: str, system: str, content: list[dict], schema: type, max_tokens: int = 16000) -> dict:
    n = calls_so_far()
    if n >= BUDGET:
        raise SystemExit(f"budget exhausted ({n}/{BUDGET} calls)")
    client = anthropic.Anthropic().with_options(timeout=600.0, max_retries=0)
    rec: dict[str, Any] = {"n": n + 1, "name": name, "probe": probe, "effort": effort, "model": MODEL}
    t0 = time.perf_counter()
    try:
        resp = client.beta.messages.parse(
            model=MODEL,
            max_tokens=max_tokens,
            system=system,
            thinking={"type": "adaptive"},
            output_config={"effort": effort},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": content}],
            output_format=schema,
        )
    except anthropic.APIStatusError as exc:
        rec.update(latency_s=round(time.perf_counter() - t0, 2), error=f"APIStatusError {exc.status_code}: {exc.message}")
    except anthropic.APIConnectionError as exc:
        rec.update(latency_s=round(time.perf_counter() - t0, 2), error=f"APIConnectionError: {exc}")
    except Exception as exc:  # noqa: BLE001 - parse/validation errors are a measured failure mode
        rec.update(latency_s=round(time.perf_counter() - t0, 2), error=f"{type(exc).__name__}: {exc}"[:2000])
    else:
        dt = time.perf_counter() - t0
        u = resp.usage
        fallback = any(getattr(it, "type", None) == "fallback_message" for it in (getattr(u, "iterations", None) or []))
        out_tok = u.output_tokens
        in_tok = u.input_tokens + (u.cache_creation_input_tokens or 0) + (u.cache_read_input_tokens or 0)
        text_chars = sum(len(b.text) for b in resp.content if b.type == "text")
        rec.update(
            latency_s=round(dt, 2),
            stop_reason=resp.stop_reason,
            served_by=resp.model,
            fallback_used=fallback,
            input_tokens=in_tok,
            output_tokens=out_tok,
            visible_text_chars=text_chars,
            cost_usd=round(in_tok * PRICE_IN / 1e6 + out_tok * PRICE_OUT / 1e6, 4),
            request_id=getattr(resp, "_request_id", None),
            parsed=resp.parsed_output.model_dump() if resp.parsed_output is not None else None,
        )
        if resp.stop_reason == "refusal":
            rec["refusal"] = {"category": getattr(resp.stop_details, "category", None), "explanation": getattr(resp.stop_details, "explanation", None)}
    with CALLS.open("a") as f:
        f.write(json.dumps(rec) + "\n")
    short = {k: rec.get(k) for k in ("n", "name", "effort", "latency_s", "input_tokens", "output_tokens", "cost_usd", "stop_reason", "served_by", "fallback_used", "error")}
    print(json.dumps(short))
    return rec


# ---------------------------------------------------------------------------------- solver


def solve_levels(levels: list[dict]) -> list[dict]:
    """Run web/src/solver/solve.ts on minimal levels ({name, grid:{w,h,cell,rows}, entities})."""
    tmp_in, tmp_out = RESULTS / "_solve_in.json", RESULTS / "_solve_out.json"
    tmp_in.write_text(json.dumps(levels))
    subprocess.run(
        ["npx", "vite-node", str(HERE / "solve_cli.ts"), "--", str(tmp_in), str(tmp_out)],
        cwd=ROOT / "web", check=True, capture_output=True, text=True,
    )
    out = json.loads(tmp_out.read_text())
    tmp_in.unlink(); tmp_out.unlink()
    return out


def make_level(name: str, rows: list[str], start: tuple[int, int] | None, goal: tuple[int, int] | None, extra: list[dict] | None = None) -> dict:
    ents: list[dict] = []
    if start is not None:
        ents.append({"id": "start", "type": "player_start", "x": int(start[0]), "y": int(start[1])})
    if goal is not None:
        ents.append({"id": "goal", "type": "goal", "x": int(goal[0]), "y": int(goal[1])})
    ents += extra or []
    return {"name": name, "grid": {"w": W, "h": H, "cell": 16, "rows": rows}, "entities": ents}


def empty_grid() -> list[list[str]]:
    return [["0"] * W for _ in range(H)]


def rows_of(g: list[list[str]]) -> list[str]:
    return ["".join(r) for r in g]


def default_start(rows: list[str]) -> tuple[int, int] | None:
    """v1 rule: top of the leftmost solid column, clamped so a 2-tall body fits."""
    for x in range(W):
        for y in range(H):
            if rows[y][x] == "1":
                return (x, max(1, y - 1))
    return None


def ascii_grid(rows: list[str]) -> str:
    """Numbered rows for the model: '.' empty, '#' solid, '^' hazard."""
    m = {"0": ".", "1": "#", "2": "^"}
    head = "    " + "".join(str(x // 10) for x in range(W)) + "\n    " + "".join(str(x % 10) for x in range(W))
    body = "\n".join(f"{y:>2}  " + "".join(m[c] for c in r) for y, r in enumerate(rows))
    return head + "\n" + body
