"""Contract model rules (PLAN_V2 §2.1, §3.5, §3.11): x_* extensions, strictness, the 43-op vocabulary, the 13 SSE
events and the sample stream."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from app.spec.common import World
from app.spec.edits import ALL_OPS, OP_CLASSES, EditOp
from app.spec.events import EVENT_NAMES, BuildEvent
from app.spec.ink import InkStroke
from app.spec.rules import GameRules

REPO = Path(__file__).resolve().parents[2]
SAMPLE = REPO / "shared" / "spec" / "conformance" / "events" / "sample_build.jsonl"


def test_extension_keys_round_trip_and_unknown_keys_fail() -> None:
    r = GameRules.model_validate({"version": 1, "x_house_rule": {"a": 1}})
    assert r.model_dump()["x_house_rule"] == {"a": 1}
    with pytest.raises(ValidationError):
        GameRules.model_validate({"version": 1, "house_rule": 1})


def test_world_width_follows_screens() -> None:
    assert World(screens=3, w=144).w == 144
    with pytest.raises(ValidationError):
        World(screens=3, w=96)
    with pytest.raises(ValidationError):
        World(screens=7, w=336)


def test_vocabulary_has_43_ops_in_6_classes() -> None:
    assert len(ALL_OPS) == 43
    assert {k: len(v) for k, v in OP_CLASSES.items()} == {"U": 7, "N": 13, "R": 5, "P": 8, "C": 9, "K": 1}
    names = [op.model_fields["op"].annotation.__args__[0] for op in ALL_OPS]
    assert len(set(names)) == 43


def test_op_bounds_are_enforced() -> None:
    ta = TypeAdapter(EditOp)
    ta.validate_python({"op": "nudge", "group": "o3", "dx": 3, "dy": 0})
    for bad in ({"op": "nudge", "group": "o3", "dx": 4, "dy": 0}, {"op": "trim", "target": "o1", "side": "top", "cells": 3},
                {"op": "add_coin_trail", "action": "r1", "n": 9}, {"op": "teleport", "target": "o1"}):
        with pytest.raises(ValidationError):
            ta.validate_python(bad)


def test_dot_strokes_have_one_point() -> None:
    InkStroke.model_validate({"id": "s1", "color": "blue", "kind": "dot", "pts": [[1, 1]], "w": [0.875], "closed": True,
                              "sheet": 0, "origin": "kid"})
    with pytest.raises(ValidationError):
        InkStroke.model_validate({"id": "s1", "color": "blue", "kind": "dot", "pts": [[1, 1], [2, 2]], "w": [1],
                                  "closed": True, "sheet": 0, "origin": "kid"})


def test_sample_stream_has_every_event_and_validates() -> None:
    ta = TypeAdapter(BuildEvent)
    lines = [json.loads(x) for x in SAMPLE.read_text().splitlines() if x.strip()]
    assert [e["seq"] for e in lines] == list(range(1, len(lines) + 1))
    assert {e["event"] for e in lines} == set(EVENT_NAMES)
    assert lines[0]["event"] == "hello" and lines[-1]["event"] == "done"
    for e in lines:
        ta.validate_python(e)
    tiers = [e for e in lines if e["event"] == "tier"]
    assert len(tiers) == 12 and all("ink" not in t["data"]["level"] and t["data"]["level"]["ink_ref"] for t in tiers)
