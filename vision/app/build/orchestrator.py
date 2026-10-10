"""The staged build orchestrator (PLAN_V2 §1.1, §3.8, §3.11): Ink → Understood → Designed, speculative DESIGN,
pick transfer, REFINE, the 25 s deadline and suggestions. Lane D, P1-P3.

P0 stub: `run_build` replays shared/spec/conformance/events/sample_build.jsonl through the sink with this build's
ids, so the SSE endpoint, the polling fallback and the web preview can be built against a real stream.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from app.build.events import EventSink, load_sample


@dataclass
class BuildRequest:
    build_id: str
    draft_id: str
    kind: Literal["canvas", "paper", "prompt", "redesign", "critic"] = "canvas"
    ink: dict[str, Any] | None = None
    photos: list[bytes] = field(default_factory=list)
    typed_rules: list[dict[str, Any]] = field(default_factory=list)
    parent_id: str | None = None
    game_id: str | None = None
    pack_id: str | None = None
    dial: str = "polished"
    band: str | None = None


async def run_build(req: BuildRequest, sink: EventSink) -> None:
    for env in load_sample():
        data = env["data"]
        if env["event"] == "hello":
            data = {**data, "build_id": req.build_id, "draft_id": req.draft_id}
        elif env["event"] == "tier":
            data = {**data, "level": {**data["level"], "ink_ref": f"drafts/{req.draft_id}/ink.json"}}
        sink.emit(env["event"], data)
