"""Conformance levels (PLAN_V2 §11.3a): jsonschema accepts valid/*.json and rejects invalid/*.json (files named
semantic_* are schema-valid but rejected by LevelV2's semantic checks); Python and TS level_hash agree."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import jsonschema
import pytest
from pydantic import ValidationError

from app.spec.level import LevelV2, canonical_json, level_hash

REPO = Path(__file__).resolve().parents[2]
LEVELS = REPO / "shared" / "spec" / "conformance" / "levels"
SCHEMA = json.loads((REPO / "shared" / "spec" / "level.schema.json").read_text())
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA)
VALID = sorted((LEVELS / "valid").glob("*.json"))
INVALID = sorted((LEVELS / "invalid").glob("*.json"))


def test_fixture_sets_exist() -> None:
    assert (LEVELS / "valid" / "example_2screen.json") in VALID
    assert len(VALID) >= 5 and len(INVALID) >= 10


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_valid_levels(path: Path) -> None:
    doc = json.loads(path.read_text())
    errors = [e.message for e in VALIDATOR.iter_errors(doc)]
    assert errors == []
    LevelV2.model_validate(doc)


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_invalid_levels(path: Path) -> None:
    doc = json.loads(path.read_text())
    schema_ok = not list(VALIDATOR.iter_errors(doc))
    if path.name.startswith("semantic_"):
        assert schema_ok, "semantic_* fixtures must pass the JSON schema"
    else:
        assert not schema_ok, "invalid fixture passed the JSON schema"
    with pytest.raises(ValidationError):
        LevelV2.model_validate(doc)


def test_level_model_round_trips_the_example() -> None:
    doc = json.loads((LEVELS / "valid" / "example_2screen.json").read_text())
    again = LevelV2.model_validate(LevelV2.model_validate(doc).model_dump(mode="json"))
    assert again.edits[0].cls == "N"
    assert again.model_dump(mode="json")["edits"][0]["class"] == "N"
    assert level_hash(again.model_dump(mode="json")) == level_hash(doc)  # nulls/defaults do not change the hash


def test_canonical_json() -> None:
    assert canonical_json({"b": 2.0, "a": [1.23456, -0.00004, 1e-9, -1.5, 7.1], "n": None, "s": 'é"'}) == (
        '{"a":[1.2346,0,0,-1.5,7.1],"b":2,"s":"é\\""}'
    )


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_level_hash_matches_core(path: Path) -> None:
    out = subprocess.run(["node", "web/src/core/cli.ts", "hash", str(path)], cwd=REPO, capture_output=True, text=True, check=True)
    assert out.stdout.strip() == level_hash(json.loads(path.read_text()))
