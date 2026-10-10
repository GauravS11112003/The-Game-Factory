"""Every fixture level validates against shared/level.schema.json and round-trips through the Level model."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from app.models import Interpretation, Level
from tests.conftest import FIXTURE_LEVEL_PATHS, FIXTURES_DIR, SCHEMA_PATH


def _validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _errors(validator: Draft202012Validator, doc: dict) -> list[str]:
    return [f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}" for e in validator.iter_errors(doc)]


def test_fixtures_exist() -> None:
    names = {p.name for p in FIXTURE_LEVEL_PATHS}
    assert {"starter_1_first_steps.json", "starter_2_spike_valley.json", "starter_3_key_cave.json"} <= names


@pytest.mark.parametrize("path", FIXTURE_LEVEL_PATHS, ids=lambda p: p.stem)
def test_fixture_matches_schema(path: Path) -> None:
    doc = json.loads(path.read_text())
    assert _errors(_validator(), doc) == []


@pytest.mark.parametrize("path", FIXTURE_LEVEL_PATHS, ids=lambda p: p.stem)
def test_fixture_round_trips_through_model(path: Path) -> None:
    doc = json.loads(path.read_text())
    level = Level.model_validate(doc)
    assert level.id == doc["id"]
    assert level.grid.h == 27 and level.grid.w == 48
    assert len(level.grid.rows) == 27

    # The dumped form (every field present, None for the unset ones) must also satisfy the schema.
    dumped = level.model_dump(mode="json")
    assert _errors(_validator(), dumped) == []
    assert Level.model_validate(dumped) == level

    # And the on-disk document is exactly what the model produces minus unset optionals.
    assert json.loads(level.model_dump_json(exclude_none=True)) == _strip_none(doc)


def _strip_none(value):  # type: ignore[no-untyped-def]
    if isinstance(value, dict):
        return {k: _strip_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_strip_none(v) for v in value]
    return value


def test_schema_rejects_bad_documents() -> None:
    validator = _validator()
    good = json.loads(FIXTURE_LEVEL_PATHS[0].read_text())

    extra = dict(good, bogus=1)
    assert _errors(validator, extra)

    short_row = json.loads(json.dumps(good))
    short_row["grid"]["rows"][0] = "0" * 47
    assert _errors(validator, short_row)
    with pytest.raises(ValueError):
        Level.model_validate(short_row)

    bad_rule = json.loads(json.dumps(good))
    bad_rule["rules"] = [{"when": "collect:k", "then": "explode"}]
    assert _errors(validator, bad_rule)

    platform_without_path = json.loads(json.dumps(good))
    platform_without_path["entities"] = [{"id": "mp", "type": "moving_platform", "bbox": [1, 1, 2, 1]}]
    assert _errors(validator, platform_without_path)


def test_default_interpretation_fixture() -> None:
    doc = json.loads((FIXTURES_DIR / "interpretations" / "default.json").read_text())
    interp = Interpretation.model_validate(doc)
    assert interp.bindings == [] and interp.safety_ok is True
