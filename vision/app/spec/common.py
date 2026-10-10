"""Shared primitives of the dal-level v2 contracts (PLAN_V2 §2.1, §3, §11.3a).

Every model derives from `Spec`: strict (`additionalProperties: false`) except for `x_*`
extension keys, which validate, round-trip and are ignored by engines (§2.1).
Named aliases use `TypeAliasType`, so they become named `$defs` in the published schema and
named types in `web/src/core/types.gen.ts`.
"""
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing_extensions import TypeAliasType

CELL_PX = 16
SCREEN_W = 48
WORLD_H = 27
MAX_SCREENS = 6
EXT_PREFIX = "x_"


def _strict_with_extensions(schema: dict[str, Any]) -> None:
    # Pydantic emits additionalProperties: true for extra="allow"; the published contract is
    # "no unknown keys, except x_* extension keys".
    schema["additionalProperties"] = False
    schema["patternProperties"] = {"^x_": {}}


class Spec(BaseModel):
    """Base for every contract model."""

    model_config = ConfigDict(
        extra="allow",
        json_schema_extra=_strict_with_extensions,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
    )

    @model_validator(mode="after")
    def _only_extension_extras(self) -> "Spec":
        extra = self.__pydantic_extra__ or {}
        bad = [k for k in extra if not k.startswith(EXT_PREFIX)]
        if bad:
            raise ValueError(f"unknown field(s) {sorted(bad)}; only x_* extension keys are allowed")
        return self


# ---- geometry (cells: floats quantized to 1/16; ink points 1/64; origin top-left, y down) ----
CellXY = TypeAliasType("CellXY", tuple[float, float])
RectCells = TypeAliasType("RectCells", tuple[float, float, float, float])  # [x0, y0, x1, y1], half-open

Scalar = TypeAliasType("Scalar", str | int | float | bool | None)
MessageArgs = TypeAliasType("MessageArgs", dict[str, Scalar])


class MessageRef(Spec):
    """A kid-facing sentence by key (shared/spec/messages.json); raw codes never reach the DOM."""

    key: str
    args: MessageArgs = Field(default_factory=dict)


class LibRef(Spec):
    type_id: str
    version: int = Field(ge=1)


# ---- vocabularies -----------------------------------------------------------------------------
InkColor = TypeAliasType("InkColor", Literal["black", "red", "green", "blue", "pencil", "draft"])
Origin = TypeAliasType("Origin", Literal["kid", "parent", "designer", "library", "draft", "migrated"])
Role = TypeAliasType(
    "Role",
    Literal[
        "ground", "platform", "wall", "ceiling", "spikes", "lava", "saw", "enemy", "coin", "big_coin",
        "key", "door", "spring", "checkpoint", "goal", "pole", "start_marker", "text", "arrow",
        "decoration", "library_tag", "unknown",
    ],
)
StampKind = TypeAliasType(
    "StampKind",
    Literal[
        "coin", "big_coin", "spikes", "flag", "checkpoint", "spring", "saw", "walker", "hopper",
        "flyer", "key", "door", "start", "library",
    ],
)
Face = TypeAliasType("Face", Literal["top", "bottom", "left", "right"])
Dir = TypeAliasType("Dir", Literal["up", "down", "left", "right", "none"])
Dir4 = TypeAliasType("Dir4", Literal["up", "down", "left", "right"])
Collision = TypeAliasType("Collision", Literal["solid", "one_way", "none", "hazard", "trigger"])
Archetype = TypeAliasType("Archetype", Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher"])
Tier = TypeAliasType("Tier", Literal["faithful", "polished", "normal", "hard"])
Band = TypeAliasType("Band", Literal["trivial", "easy", "normal", "hard", "expert"])
Dial = TypeAliasType("Dial", Literal["faithful", "polished", "challenging"])
ChallengeBand = TypeAliasType("ChallengeBand", Literal["normal", "hard"])
Stage = TypeAliasType("Stage", Literal["ink", "understood", "designed"])
ProfileId = TypeAliasType("ProfileId", Literal["v2-standard", "v2-gentle", "v2-snappy", "v1-classic"])
Theme = TypeAliasType("Theme", Literal["sketchbook", "notebook", "graph", "kraft"])
Severity = TypeAliasType("Severity", Literal["block", "hard", "warn", "info", "target"])
Safety = TypeAliasType("Safety", Literal["ok", "held", "flag", "unchecked"])
CallKind = TypeAliasType(
    "CallKind", Literal["perceive", "design", "refine", "critic", "plan", "creature", "moderate", "look"]
)
Effort = TypeAliasType("Effort", Literal["low", "medium", "high"])
DifficultyWish = TypeAliasType("DifficultyWish", Literal["none", "easy", "normal", "hard"])
SetpieceKind = TypeAliasType(
    "SetpieceKind", Literal["jump", "hazard_run", "climb", "enemy", "puzzle", "finale", "other"]
)
StageName = TypeAliasType(
    "StageName",
    Literal["upload", "cv", "ink", "perceive", "understood", "design", "designed", "refine", "critic"],
)
LlmMode = TypeAliasType("LlmMode", Literal["live", "fake", "off"])


class World(Spec):
    """Level world. w = 48·screens, h = 27 (§2.1, §6.1)."""

    cell: Literal[16] = 16
    screens: int = Field(ge=1, le=MAX_SCREENS)
    w: int = Field(ge=SCREEN_W, le=SCREEN_W * MAX_SCREENS)
    h: Literal[27] = 27

    @model_validator(mode="after")
    def _w_matches_screens(self) -> "World":
        if self.w != SCREEN_W * self.screens:
            raise ValueError(f"world.w must be 48*screens ({SCREEN_W * self.screens}), got {self.w}")
        return self


class InkWorld(Spec):
    """InkDoc world (§3.2): the same as World without the cell size."""

    screens: int = Field(ge=1, le=MAX_SCREENS)
    w: int = Field(ge=SCREEN_W, le=SCREEN_W * MAX_SCREENS)
    h: Literal[27] = 27

    @model_validator(mode="after")
    def _w_matches_screens(self) -> "InkWorld":
        if self.w != SCREEN_W * self.screens:
            raise ValueError(f"world.w must be 48*screens ({SCREEN_W * self.screens}), got {self.w}")
        return self


EXPORTS: list[Any] = [
    CellXY, RectCells, Scalar, MessageArgs, MessageRef, LibRef, InkColor, Origin, Role, StampKind, Face, Dir,
    Dir4, Collision, Archetype, Tier, Band, Dial, ChallengeBand, Stage, ProfileId, Theme, Severity, Safety,
    CallKind, Effort, DifficultyWish, SetpieceKind, StageName, LlmMode, World, InkWorld,
]
ROOT = None
