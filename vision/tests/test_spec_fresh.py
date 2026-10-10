"""Staleness (PLAN_V2 §11.3a): regenerating shared/spec/*.schema.json and web/src/core/types.gen.ts from
vision/app/spec into a temp dir changes nothing."""
from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def _gen_contracts():  # noqa: ANN202
    spec = importlib.util.spec_from_file_location("gen_contracts", REPO / "scripts" / "gen_contracts.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.skipif(shutil.which("npx") is None, reason="needs node/npx for json2ts")
def test_generated_contracts_are_fresh() -> None:
    stale = _gen_contracts().check()
    assert stale == [], "stale generated contracts, run: cd vision && uv run --no-sync python ../scripts/gen_contracts.py"


def test_every_module_publishes_a_schema() -> None:
    from app.spec import SCHEMA_MODULES

    for name in SCHEMA_MODULES:
        assert (REPO / "shared" / "spec" / f"{name}.schema.json").exists(), name
