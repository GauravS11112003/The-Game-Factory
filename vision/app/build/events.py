"""Build events: persistence, SSE framing and the sample stream (PLAN_V2 §3.11, §11.3d/f).

Each persisted line is an envelope `{"seq": n, "event": name, "data": payload}` (vision/app/spec/events.py
BuildEvent). On the wire: `id: <seq>`, `event: <name>`, `data: <payload JSON>`.

    cd vision && uv run --no-sync python -m app.build.events --write-sample
regenerates shared/spec/conformance/events/sample_build.jsonl from the core's stub fixtures.
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import threading
from pathlib import Path
from typing import Any, Protocol

from app.config import PROJECT_ROOT

SAMPLE_PATH = PROJECT_ROOT / "shared" / "spec" / "conformance" / "events" / "sample_build.jsonl"


class EventSink(Protocol):
    def emit(self, event: str, data: dict[str, Any]) -> int: ...  # returns seq; persists to events.jsonl

    def closed(self) -> bool: ...


class JsonlEventSink:
    """Appends envelopes to drafts/<draft_id>/events.jsonl; seq continues from what is already there."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._seq = len(read_events(path))
        self._closed = False

    def emit(self, event: str, data: dict[str, Any]) -> int:
        with self._lock:
            self._seq += 1
            line = json.dumps({"seq": self._seq, "event": event, "data": data}, separators=(",", ":"), ensure_ascii=False)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
            if event == "done":
                self._closed = True
            return self._seq

    def closed(self) -> bool:
        return self._closed


def read_events(path: Path, since: int = 0) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            env = json.loads(line)
            if env["seq"] > since:
                out.append(env)
    return out


def format_sse(env: dict[str, Any]) -> str:
    data = json.dumps(env["data"], separators=(",", ":"), ensure_ascii=False)
    return f"id: {env['seq']}\nevent: {env['event']}\ndata: {data}\n\n"


def load_sample() -> list[dict[str, Any]]:
    return read_events(SAMPLE_PATH)


# ---- sample stream ------------------------------------------------------------------------------


def _fixture(method: str, params: dict[str, Any] | None = None) -> Any:
    cmd = ["node", "web/src/core/cli.ts", "fixture", method]
    if params is not None:
        cmd.append(json.dumps(params))
    out = subprocess.run(cmd, cwd=PROJECT_ROOT, check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def build_sample_events(build_id: str = "b_5a3f1e00", draft_id: str = "d_5a3f1e00") -> list[tuple[str, dict[str, Any]]]:
    """A p50 canvas build (§3.11 ordering table) with all 13 event types, from the core's stub fixtures."""
    tiers = _fixture("build_tiers")
    ink = _fixture("layout_plan")["ink"]
    graph0 = _fixture("perceive_heuristic")["graph"]
    level = tiers["polished"]["level"]
    comps = {c["id"]: c for c in ink["components"]}
    edits = level["edits"]
    ink_ref = f"drafts/{draft_id}/ink.json"

    def tier_events(stage: str, edit_ids: list[str]) -> list[tuple[str, dict[str, Any]]]:
        out = []
        for tier in ("faithful", "polished", "normal", "hard"):
            res = tiers[tier]
            lv = copy.deepcopy(res["level"])
            lv.pop("ink", None)
            lv["ink_ref"] = ink_ref
            morphs = [] if stage == "ink" else [
                {"object_id": "o4", "from": [52, 21.0, 56, 21.6], "to": [52, 21.4, 56, 22], "kind": "move"},
            ]
            out.append(("tier", {"stage": stage, "tier": tier, "level": lv, "report": res["report"],
                                 "edit_ids": edit_ids, "reach": True, "morphs": morphs}))
        return out

    def saw(stage: str) -> dict[str, Any]:
        items = []
        for o in graph0["objects"]:
            c = comps.get(o["components"][0]) if o["components"] else None
            rel_key = {"spikes": "saw.spikes_on", "enemy": "saw.monster_plain", "goal": "saw.goal_pole",
                       "coin": "saw.coins_from_dots", "decoration": "saw.decoration", "ground": "saw.ground",
                       "platform": "saw.oneway", "pole": "saw.goal_pole"}.get(o["role"], "saw.unknown")
            rel_args: dict[str, Any] = {"spikes": {"host": "ground", "facing": "up"}, "enemy": {"does": "stands still"},
                                        "coin": {"n": 1}, "decoration": {"what": "scribble"}, "ground": {"n": 2}}.get(o["role"], {})
            items.append({"object_id": o["id"], "role": o["role"], "rel_key": rel_key, "rel_args": rel_args,
                          "conf": o["conf"], "bbox": c["bbox"] if c else [0, 0, 1, 1]})
        return {"items": items, "stage": stage}

    ink_edits = [e for e in edits if e["stage"] == "ink"]
    und_edits = [e for e in edits if e["stage"] == "understood"]
    des_edits = [e for e in edits if e["stage"] == "designed"]
    late = [{
        "id": "tune:o5:7c8d9e", "op": {"op": "tune", "entity": "o5", "param": "speed", "step": 1}, "class": "P",
        "by": "model", "stage": "designed", "tier": "polished", "status": "suggested", "reason_key": "polish.tune",
        "reason_args": {"what": "monster"}, "reason_text": "A faster monster makes the hop exciting.",
        "depends_on": ["animate:o5:1a2b3c"], "required": False, "group": None,
        "validation": {"solvable": True, "flags": [], "drift_cells": 0, "dC": 0.04},
        "ghost": {"before": [[60, 20.6, 73, 22.1]], "after": [[58, 20.6, 75, 22.1]]},
    }]
    ask = {"id": "ask_o10_1", "about": "o10", "kind": "is_decoration", "message_key": "ask.is_decoration", "args": {},
           "options": [
               {"id": "yes", "label_key": "ask.option.decoration", "label_args": {}, "tap_target": False,
                "ops": [{"op": "set_role", "target": "o10", "role": "decoration"}]},
               {"id": "spikes", "label_key": "ask.option.spikes", "label_args": {}, "tap_target": False,
                "ops": [{"op": "set_role", "target": "o10", "role": "spikes"}]},
           ], "default_option": "yes", "answer": None, "by": "model"}
    ev: list[tuple[str, dict[str, Any]]] = [
        ("hello", {"build_id": build_id, "draft_id": draft_id, "version": 1, "core_version": "2.0.0", "model": "live"}),
        ("stage", {"stage": "ink", "status": "start", "t_ms": 0}),
        ("ink", {"ink": ink, "graph0": graph0}),
        ("saw", saw("ink")),
        ("edits", {"edits": ink_edits}),
        *tier_events("ink", [e["id"] for e in ink_edits]),
        ("stage", {"stage": "ink", "status": "done", "t_ms": 540}),
        ("stage", {"stage": "perceive", "status": "start", "t_ms": 560}),
        ("stage", {"stage": "design", "status": "start", "t_ms": 2010, "note_key": "stage.design"}),
        ("stage", {"stage": "perceive", "status": "done", "t_ms": 10980}),
        ("edits", {"edits": und_edits}),
        ("saw", saw("understood")),
        *tier_events("understood", [e["id"] for e in ink_edits + und_edits]),
        ("ask", {"ask": ask}),
        ("stage", {"stage": "understood", "status": "done", "t_ms": 11020}),
        ("cost", {"usd": 0.044, "calls": 1, "by_kind": {"perceive": 0.044}}),
        ("warning", {"message_key": "warning.specks_ignored", "args": {"n": 2}}),
        ("error", {"message_key": "error.entity", "args": {"thing": "moving platform", "where": "the start"}, "fatal": False}),
        ("stage", {"stage": "design", "status": "done", "t_ms": 13300}),
        ("edits", {"edits": des_edits}),
        *tier_events("designed", [e["id"] for e in edits]),
        ("stage", {"stage": "designed", "status": "done", "t_ms": 13480}),
        ("note", {"designer_note": level["design"]["designer_note"], "critique": ["The spike hop is the star; keep it."],
                  "title_suggestion": "Spike Hop", "source": "model"}),
        ("cost", {"usd": 0.093, "calls": 2, "by_kind": {"perceive": 0.044, "design": 0.049}}),
        ("suggestions", {"edits": late, "source": "late_design"}),
        ("done", {"final_stage": "designed", "total_ms": 13490}),
    ]
    return ev


def write_sample_build(path: Path = SAMPLE_PATH) -> int:
    from app.spec.events import BuildEvent  # validate before writing
    from pydantic import TypeAdapter

    adapter = TypeAdapter(BuildEvent)
    lines = []
    for seq, (event, data) in enumerate(build_sample_events(), 1):
        env = {"seq": seq, "event": event, "data": data}
        adapter.validate_python(env)
        lines.append(json.dumps(env, separators=(",", ":"), ensure_ascii=False))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--write-sample", action="store_true")
    if ap.parse_args().write_sample:
        print(f"wrote {write_sample_build()} events to {SAMPLE_PATH}")
