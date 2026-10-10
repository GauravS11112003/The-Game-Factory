"""Run the six drawings through v1's pipeline in-process with the model OFF (DAL_FAKE_LLM=1).

Same code path as POST /api/scan (run_scan -> interpret -> compile_level), but
the vision model is replaced by v1's fake mode, i.e. what a user gets when the
API key is missing, the call times out (20 s) or the model refuses.
Run from vision/:  DAL_FAKE_LLM=1 uv run --no-sync python ../docs/v2/diagnosis/build/run_offline.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

os.environ["DAL_FAKE_LLM"] = "1"
sys.path.insert(0, str(Path.cwd()))

from app.compile import compile_level  # noqa: E402
from app.cv.pipeline import run_scan  # noqa: E402
from app.llm.interpret import interpret  # noqa: E402

HERE = Path(__file__).resolve().parent
manifest = json.loads((HERE / "inputs" / "manifest.json").read_text())
for item in manifest:
    stem = Path(item["file"]).stem
    work = HERE / "offline" / stem
    work.mkdir(parents=True, exist_ok=True)
    cv = run_scan((HERE / "inputs" / item["file"]).read_bytes(), "canvas", str(work))
    interp = interpret(cv, [], item.get("prompt"))
    level = compile_level(cv, interp, None, "diag", None, f"off_{stem}", str(work), f"offline/{stem}")
    (work / "level.json").write_text(json.dumps({"level": level.model_dump(mode="json")}, indent=2))
    print(stem, "annotations:", interp.annotation_component_ids if interp else None,
          "bindings:", [(b.component_id, b.behavior) for b in interp.bindings] if interp else None)
