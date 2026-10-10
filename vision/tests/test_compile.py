"""Fixture CVResult + fixture Interpretation -> Level that validates against the schema (PLAN.md section 16). Owned by lane C.

Fixtures come from shared/fixtures/cvresults/<case>/ (written by make_cvresults.py);
the loader copies a case into a temp work dir and makes its paths absolute, like
run_scan would.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pytest
from jsonschema import Draft202012Validator, FormatChecker
from PIL import Image

from app.compile import compile_level, remix_offset
from app.models import Binding, CVResult, Interpretation, Level
from tests.conftest import FIXTURES_DIR, SCHEMA_PATH

CVRESULTS_DIR = FIXTURES_DIR / "cvresults"
PATH_FIELDS = ("sprite_path", "backdrop_path", "drawing_path", "labels_path", "annotated_path")


def load_case(name: str, work_dir: Path) -> CVResult:
    """Copy a fixture case into work_dir and return its CVResult with absolute paths."""
    src = CVRESULTS_DIR / name
    shutil.copytree(src, work_dir, dirs_exist_ok=True)
    doc = json.loads((src / "cvresult.json").read_text())
    for field in PATH_FIELDS:
        if doc[field]:
            doc[field] = str(work_dir / doc[field])
    doc["work_dir"] = str(work_dir)
    return CVResult.model_validate(doc)


def load_interpretation(name: str) -> Interpretation:
    return Interpretation.model_validate(json.loads((CVRESULTS_DIR / name / "interpretation.json").read_text()))


@pytest.fixture(scope="module")
def validator() -> Draft202012Validator:
    return Draft202012Validator(json.loads(SCHEMA_PATH.read_text()), format_checker=FormatChecker())


def schema_errors(validator: Draft202012Validator, level: Level) -> list[str]:
    doc = level.model_dump(mode="json")
    return [f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}" for e in validator.iter_errors(doc)]


def by_type(level: Level, etype: str) -> list:
    return [e for e in level.entities if e.type == etype]


def cell(level: Level, x: int, y: int) -> str:
    return level.grid.rows[y][x]


def compile_case(tmp_path: Path, case: str, interp: Interpretation | None, parent: Level | None = None, sub: str = "d1"):
    cv = load_case(case, tmp_path / f"work_{sub}")
    uploads = tmp_path / "uploads" / "drafts" / sub
    level = compile_level(cv, interp, parent, "maya", None, f"lvl_{sub}", str(uploads), f"/uploads/drafts/{sub}")
    return cv, level, uploads


def test_fixture_cases_exist() -> None:
    assert (CVRESULTS_DIR / "first_jump" / "cvresult.json").is_file()
    assert (CVRESULTS_DIR / "rules_demo" / "cvresult.json").is_file()


def test_rules_demo_compiles_every_behavior(tmp_path: Path, validator: Draft202012Validator) -> None:
    cv, level, uploads = compile_case(tmp_path, "rules_demo", load_interpretation("rules_demo"))
    assert schema_errors(validator, level) == []
    assert level.meta.warnings == []
    assert level.title == "Rules Demo"
    assert level.source.kind == "paper" and level.source.photo_url is None
    assert level.source.backdrop_url == "/uploads/drafts/d1/backdrop.png"
    assert level.meta.notes_transcript.startswith("platform moves right 10")

    (platform,) = by_type(level, "moving_platform")
    assert platform.component_id == 2 and platform.bbox == (14, 18, 22, 18)
    assert platform.path == [(14, 18), (24, 18)] and platform.speed == 2
    assert platform.image_url == "/uploads/drafts/d1/comp_2.png"
    crop = Image.open(uploads / "comp_2.png")
    assert crop.mode == "RGBA" and crop.size == (9 * 16, 16)
    assert np.asarray(crop)[..., 3].max() == 255, "platform crop has opaque ink"
    assert all(cell(level, x, 18) == "0" for x in range(14, 23)), "platform cells left the grid"

    (door,) = by_type(level, "door")
    assert door.component_id == 3 and door.bbox == (40, 21, 40, 24)
    assert (uploads / "comp_3.png").is_file()
    assert all(cell(level, 40, y) == "0" for y in range(21, 25)), "door removed from the grid"

    (enemy,) = by_type(level, "enemy")
    assert enemy.patrol == {"dx": 6, "speed": 3} and enemy.image_url == "/uploads/drafts/d1/comp_6.png"
    assert all(cell(level, x, y) == "0" for x in (30, 31) for y in (23, 24)), "hazard cells of the patroller cleared"

    (key,) = by_type(level, "key")
    assert (key.x, key.y) == (5, 22) and key.opens == door.id
    assert {(c.x, c.y) for c in by_type(level, "coin")} == {(42, 23)}, "the key replaced its coin"
    assert {(r.when, r.then) for r in level.rules} == {(f"collect:{key.id}", f"open:{door.id}"), ("timer:90", "lose")}

    assert all(cell(level, x, 16) == "0" for x in range(14, 20)), "annotation cells cleared"
    assert all(cell(level, x, 25) == "1" and cell(level, x, 26) == "1" for x in range(48)), "floor untouched"

    (goal,) = by_type(level, "goal")
    assert (goal.x, goal.y) == (44, 22)
    (start,) = by_type(level, "player_start")
    assert (start.x, start.y) == (0, 24)
    assert level.sprites.player == "/uploads/drafts/d1/player.png" and (uploads / "player.png").is_file()

    backdrop = Image.open(uploads / "backdrop.png")
    assert backdrop.size == (768, 432) and backdrop.mode == "RGB"
    arr = np.asarray(backdrop)
    assert (arr[18 * 16 : 19 * 16, 14 * 16 : 23 * 16] == 255).all(), "moving platform whitened out of the backdrop"
    assert (arr[25 * 16 : 27 * 16, :] < 128).any(), "floor still drawn in the backdrop"

    assert [c.id for c in level.components] == [2, 3, 4, 5, 6, 7, 8], "annotation component is not geometry"
    assert len({e.id for e in level.entities}) == len(level.entities)


def test_invalid_bindings_are_dropped_with_warnings(tmp_path: Path, validator: Draft202012Validator) -> None:
    interp = Interpretation(
        bindings=[
            Binding(component_id=8, behavior="move", params={"dx": 4}),  # the floor
            Binding(component_id=2, behavior="patrol"),  # black, needs red
            Binding(component_id=99, behavior="bounce"),  # no such component
            Binding(component_id=7, behavior="key", params={"opens_component_id": 2}),  # 2 is not a door
            Binding(component_id=5, behavior="key"),  # no door at all
        ],
        notes_transcript="nonsense",
    )
    cv, level, _ = compile_case(tmp_path, "rules_demo", interp)
    assert schema_errors(validator, level) == []
    assert by_type(level, "moving_platform") == [] and by_type(level, "enemy") == [] and by_type(level, "bounce_pad") == []
    assert by_type(level, "key") == [] and level.rules == []
    assert {(c.x, c.y) for c in by_type(level, "coin")} == {(5, 22), (42, 23)}, "keys without doors stay coins"
    warnings = "\n".join(level.meta.warnings)
    assert len(level.meta.warnings) == 5
    assert "move on component 8" in warnings and "floor" in warnings
    assert "patrol needs a red component" in warnings
    assert "unknown component 99" in warnings
    assert "key on component 7 has no valid door" in warnings
    assert "key on component 5 has no valid door" in warnings
    assert all(cell(level, x, 25) == "1" for x in range(48)), "the floor stays solid"


def test_params_are_clamped_and_duplicates_dropped(tmp_path: Path, validator: Draft202012Validator) -> None:
    interp = Interpretation(
        bindings=[
            Binding(component_id=2, behavior="move", params={"dx": 50, "speed": 0.1}),
            Binding(component_id=2, behavior="bounce"),
            Binding(component_id=6, behavior="patrol", params={"dx": -40, "speed": 99}),
        ],
        timer_seconds=5,
    )
    _, level, _ = compile_case(tmp_path, "rules_demo", interp)
    assert schema_errors(validator, level) == []
    (platform,) = by_type(level, "moving_platform")
    assert platform.path == [(14, 18), (34, 18)] and platform.speed == 1
    (enemy,) = by_type(level, "enemy")
    assert enemy.patrol == {"dx": -20, "speed": 6}
    assert by_type(level, "bounce_pad") == []
    assert ("timer:10", "lose") in {(r.when, r.then) for r in level.rules}
    warnings = "\n".join(level.meta.warnings)
    assert "dx=50 clamped to 20" in warnings and "speed=0.1 clamped to 1" in warnings
    assert "dx=-40 clamped to -20" in warnings and "speed=99 clamped to 6" in warnings
    assert "component 2 already has a behavior" in warnings
    assert "timer 5s clamped to 10s" in warnings


def test_bounce_keeps_tiles_and_start_binding_stands_on_top(tmp_path: Path, validator: Draft202012Validator) -> None:
    interp = Interpretation(
        bindings=[
            Binding(component_id=2, behavior="bounce", params={"strength": 1.5}),
            Binding(component_id=3, behavior="start"),
            Binding(component_id=6, behavior="checkpoint"),
        ]
    )
    _, level, _ = compile_case(tmp_path, "rules_demo", interp)
    assert schema_errors(validator, level) == []
    (pad,) = by_type(level, "bounce_pad")
    assert pad.bbox == (14, 18, 22, 18) and pad.strength == 1.5
    assert all(cell(level, x, 18) == "1" for x in range(14, 23)), "bounce pad tiles stay solid"
    (start,) = by_type(level, "player_start")
    assert (start.x, start.y) == (40, 20), "the bar is solid, so the start is lifted onto it"
    (checkpoint,) = by_type(level, "checkpoint")
    assert (checkpoint.x, checkpoint.y) == (30, 22), "checkpoint lifted above the hazard cells"


def test_no_interpretation_still_compiles(tmp_path: Path, validator: Draft202012Validator) -> None:
    _, level, _ = compile_case(tmp_path, "rules_demo", None)
    assert schema_errors(validator, level) == []
    assert level.meta.warnings == ["rules_not_read"]
    assert level.title == "Untitled level" and level.rules == []
    assert len(by_type(level, "coin")) == 2 and len(by_type(level, "goal")) == 1 and len(by_type(level, "player_start")) == 1
    assert all(cell(level, x, 16) == "1" for x in range(14, 20)), "without the model the handwriting stays solid"
    assert [c.id for c in level.components] == [1, 2, 3, 4, 5, 6, 7, 8]


def test_safety_flag_and_missing_images_become_warnings(tmp_path: Path, validator: Draft202012Validator) -> None:
    cv = load_case("rules_demo", tmp_path / "work")
    broken = cv.model_copy(
        update={
            "backdrop_path": str(tmp_path / "nope.png"),
            "drawing_path": str(tmp_path / "nope2.png"),
            "labels_path": str(tmp_path / "nope3.png"),
            "sprite_path": None,
            "goal": None,
            "components": [c for c in cv.components if c.color != "green"],
        }
    )
    interp = Interpretation(
        bindings=[Binding(component_id=2, behavior="move")], safety_ok=False, safety_reason="rude words"
    )
    level = compile_level(broken, interp, None, "x", "game_1", "lvl_x", str(tmp_path / "u"), "/uploads/u")
    assert schema_errors(validator, level) == []
    assert level.game_id == "game_1"
    warnings = "\n".join(level.meta.warnings)
    assert "unsafe_content: rude words" in warnings
    assert "backdrop image missing" in warnings and "dynamic components have no image" in warnings
    assert "no goal drawn" in warnings
    (platform,) = by_type(level, "moving_platform")
    assert platform.image_url is None
    (goal,) = by_type(level, "goal")
    assert (goal.x, goal.y) == (47, 24), "fallback goal on top of the rightmost ground"
    assert level.sprites.player is None
    assert (tmp_path / "u" / "backdrop.png").is_file(), "a blank backdrop is still written"


def test_remix_keeps_parent_entities_and_renumbers(tmp_path: Path, validator: Draft202012Validator) -> None:
    parent_cv = load_case("first_jump", tmp_path / "work_parent")
    parent_dir = tmp_path / "uploads" / "lvl_parent"
    parent = compile_level(
        parent_cv, load_interpretation("first_jump"), None, "team", "game_x", "lvl_parent", str(parent_dir), "/uploads/lvl_parent"
    )
    assert schema_errors(validator, parent) == []
    assert [c.id for c in parent.components] == [1, 2, 3, 4]
    assert remix_offset(parent.components) == 4
    (pad,) = by_type(parent, "bounce_pad")
    assert pad.id == "e2"

    # The rules_demo scan drawn on top of it: its ids 1..8 become 5..12.
    child_interp = Interpretation(
        title="Child",
        annotation_component_ids=[5],
        bindings=[
            Binding(component_id=6, behavior="move", params={"dx": 10}),
            Binding(component_id=7, behavior="door"),
            Binding(component_id=9, behavior="key", params={"opens_component_id": 7}),
            Binding(component_id=10, behavior="patrol"),
        ],
        timer_seconds=90,
    )
    cv, child, uploads = compile_case(tmp_path, "rules_demo", child_interp, parent=parent, sub="d2")
    assert schema_errors(validator, child) == []
    assert child.meta.warnings == []
    assert child.parent_id == "lvl_parent" and child.game_id == "game_x"
    assert [c.id for c in child.components] == [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]
    assert len({e.id for e in child.entities}) == len(child.entities)

    ids = {e.id: e for e in child.entities}
    assert ids["e2"].type == "bounce_pad", "parent bounce pad preserved"
    assert ids["c1"].type == "coin" and (ids["c1"].x, ids["c1"].y) == (22, 18), "parent coin preserved"
    assert {(c.x, c.y) for c in by_type(child, "coin")} == {(22, 18), (42, 23)}
    (start,) = by_type(child, "player_start")
    assert (start.x, start.y) == (0, 24), "parent start preserved"
    (goal,) = by_type(child, "goal")
    assert (goal.x, goal.y) == (44, 22), "the new green blob replaces the parent goal"
    assert ids["e6"].type == "moving_platform" and ids["e6"].path == [(14, 18), (24, 18)]
    assert ids["e9"].type == "key" and ids["e9"].opens == "e7"
    assert {(r.when, r.then) for r in child.rules} == {("collect:e9", "open:e7"), ("timer:90", "lose")}

    assert all(cell(child, x, 20) == "1" for x in range(20, 26)), "parent platform still solid"
    assert all(cell(child, x, 18) == "0" for x in range(14, 23)), "new moving platform cleared"
    assert all(cell(child, x, 16) == "0" for x in range(14, 20)), "new annotation cleared"

    arr = np.asarray(Image.open(uploads / "backdrop.png"))
    assert (arr[20 * 16 + 4 : 21 * 16 - 4, 22 * 16 + 4 : 23 * 16 - 4] < 128).all(), "parent ink composed into the backdrop"
    # Cell (22, 18) holds the parent's coin, which rightly shows through; the rest of the platform is whitened.
    assert (arr[18 * 16 : 19 * 16, 14 * 16 : 22 * 16] == 255).all(), "new moving platform whitened"
    assert (arr[18 * 16 + 4 : 19 * 16 - 4, 22 * 16 + 4 : 23 * 16 - 4] < 255).any(), "parent coin still visible"
    assert sorted(p.name for p in uploads.iterdir()) == ["backdrop.png", "comp_10.png", "comp_6.png", "comp_7.png", "player.png"]


def test_remix_rebinding_a_parent_component(tmp_path: Path, validator: Draft202012Validator) -> None:
    parent_cv = load_case("first_jump", tmp_path / "work_parent")
    parent = compile_level(
        parent_cv, load_interpretation("first_jump"), None, "team", None, "lvl_parent", str(tmp_path / "uploads" / "lvl_parent"), "/uploads/lvl_parent"
    )
    # The remix scan (rules_demo ink only; the parent's platform is gray print, so it is not in it)
    # says the parent's platform (component 2) moves.
    child_interp = Interpretation(bindings=[Binding(component_id=2, behavior="move", params={"dx": -6})])
    _, child, uploads = compile_case(tmp_path, "rules_demo", child_interp, parent=parent, sub="d3")
    assert schema_errors(validator, child) == []
    assert child.title == "Remix of First Jump"
    assert by_type(child, "bounce_pad") == [], "the parent's bounce pad on component 2 is replaced"
    (platform,) = by_type(child, "moving_platform")
    assert platform.component_id == 2 and platform.path == [(20, 20), (14, 20)]
    assert platform.image_url == "/uploads/drafts/d3/comp_2.png"
    crop = Image.open(uploads / "comp_2.png")
    assert crop.size == (6 * 16, 16) and np.asarray(crop)[..., 3].max() == 255, "cropped from the parent backdrop"
    assert all(cell(child, x, 20) == "0" for x in range(20, 26)), "rebound parent platform cleared from the grid"
    assert all(cell(child, x, 18) == "1" for x in range(14, 23)), "new ink without bindings stays solid"
    arr = np.asarray(Image.open(uploads / "backdrop.png"))
    assert (arr[20 * 16 : 21 * 16, 20 * 16 : 26 * 16] == 255).all(), "rebound parent platform whitened"


def test_grid_rows_are_normalized(tmp_path: Path, validator: Draft202012Validator) -> None:
    cv = load_case("first_jump", tmp_path / "work")
    rows = list(cv.grid_rows)
    rows[0] = "x" * 10
    bad = cv.model_copy(update={"grid_rows": rows[:20]})
    level = compile_level(bad, None, None, "x", None, "lvl_bad", str(tmp_path / "u"), "/uploads/u")
    assert schema_errors(validator, level) == []
    assert any("malformed" in w for w in level.meta.warnings)
