"""Pydantic v2 models: the cross-lane contract.

Level and its parts mirror shared/level.schema.json by hand (PLAN.md section 3);
CVResult is the CV pipeline output (section 6); Binding and Interpretation are
the vision-model structured output (section 7). Keep field names identical to
the JSON Schema and to web/src/types.ts.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Color = Literal["black", "red", "green", "blue"]
EntityType = Literal[
    "player_start",
    "goal",
    "coin",
    "moving_platform",
    "enemy",
    "bounce_pad",
    "key",
    "door",
    "checkpoint",
]
BehaviorName = Literal["move", "patrol", "bounce", "key", "door", "checkpoint", "start"]
SourceKind = Literal["paper", "canvas", "fixture"]
ScanMode = Literal["paper", "canvas"]

BBox = tuple[int, int, int, int]  # [x0, y0, x1, y1] inclusive grid cells
Cell = tuple[int, int]  # [x, y] grid cell


class _LevelPart(BaseModel):
    """Base for everything that lives in the level JSON: additionalProperties false."""

    model_config = ConfigDict(extra="forbid")


class Component(_LevelPart):
    id: int
    color: Color
    bbox: BBox
    area_cells: int


class CVComponent(Component):
    """A component as the CV pipeline sees it; cells are the grid cells it covers at >= 0.25."""

    cells: list[Cell]


class Entity(_LevelPart):
    id: str
    type: EntityType
    x: int | None = None
    y: int | None = None
    component_id: int | None = None
    bbox: BBox | None = None
    image_url: str | None = None
    path: list[Cell] | None = None
    speed: float | None = None
    patrol: dict | None = None
    strength: float | None = None
    opens: str | None = None


class Rule(_LevelPart):
    when: str
    then: str


class Grid(_LevelPart):
    w: int = 48
    h: int = 27
    cell: int = 16
    rows: list[str]  # h strings of w chars, each char in "012"

    @model_validator(mode="after")
    def _check_rows(self) -> "Grid":
        if len(self.rows) != self.h:
            raise ValueError(f"grid.rows must have {self.h} rows, got {len(self.rows)}")
        for i, row in enumerate(self.rows):
            if len(row) != self.w:
                raise ValueError(f"grid.rows[{i}] must have {self.w} chars, got {len(row)}")
            if set(row) - {"0", "1", "2"}:
                raise ValueError(f"grid.rows[{i}] has chars outside '012'")
        return self


class Source(_LevelPart):
    kind: SourceKind
    photo_url: str | None = None
    backdrop_url: str | None = None
    template_version: int = 1


class Sprites(_LevelPart):
    player: str | None = None


class Meta(_LevelPart):
    solvable: bool | None = None
    warnings: list[str] = Field(default_factory=list)
    notes_transcript: str = ""


class Level(_LevelPart):
    schema_version: int = 1
    id: str
    game_id: str | None = None
    parent_id: str | None = None
    order_index: int = 0
    title: str
    author: str
    created_at: str
    source: Source
    grid: Grid
    sprites: Sprites
    components: list[Component]
    entities: list[Entity]
    rules: list[Rule]
    meta: Meta


class CVResult(BaseModel):
    """Output of app.cv.pipeline.run_scan (PLAN.md section 6).

    Every *_path is an absolute file path inside work_dir:
    - backdrop_path: 768x432 RGB PNG, background pure white.
    - drawing_path: cleaned drawing area at full working resolution (2400x1350), background white.
    - labels_path: 16-bit PNG the size of drawing_path; pixel value = component id (0 = background).
    - annotated_path: JPEG <= 1500 px wide of the whole rectified sheet with magenta component
      ids, for the vision model. None in canvas mode if nothing was annotated.
    - sprite_path: 32x48 RGBA PNG of the drawn character, or None when the box is empty.
    """

    mode: ScanMode
    grid_rows: list[str]
    components: list[CVComponent]
    goal: Cell | None
    coins: list[Cell]
    player_start: Cell
    sprite_path: str | None
    backdrop_path: str
    drawing_path: str
    labels_path: str
    annotated_path: str | None
    qr_payload: str | None
    warnings: list[str]
    work_dir: str


class Binding(BaseModel):
    """One behavior bound to one numbered component (shared/behaviors.md)."""

    component_id: int
    behavior: BehaviorName
    params: dict[str, float | int] = Field(default_factory=dict)


class Interpretation(BaseModel):
    """Structured output of the vision model (PLAN.md section 7)."""

    title: str | None = None
    annotation_component_ids: list[int] = Field(default_factory=list)
    bindings: list[Binding] = Field(default_factory=list)
    timer_seconds: int | None = None
    notes_transcript: str = ""
    safety_ok: bool = True
    safety_reason: str | None = None
