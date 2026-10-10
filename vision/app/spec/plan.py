"""LevelPlan: prompt-to-level beats (PLAN_V2 §8.3). The model picks pacing and content from a fixed
beat vocabulary; code (core/generate) lays out geometry, clamps integers by band and proves it.

This schema is also the model-facing PLAN output schema (vision/app/mind/schemas.py imports it), so it
follows the model-facing rules: enums and required fields only, no numeric bounds, no extension keys.
Starter World plans (shared/starter/L*.plan.json) use the same schema.
"""
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from typing_extensions import TypeAliasType


class _Beat(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BeatFlat(_Beat):
    kind: Literal["flat"]
    length: int
    enemy: Literal["none", "walker", "hopper", "chaser"]
    coins: int
    spikes: Literal["none", "middle", "far_end"]


class BeatGap(_Beat):
    kind: Literal["gap"]
    width: int
    floor: Literal["void", "spikes", "lava"]


class BeatStep(_Beat):
    kind: Literal["step"]
    rise: int
    length: int


class BeatStairs(_Beat):
    kind: Literal["stairs"]
    n: int
    rise: int
    run: int


class BeatPillars(_Beat):
    kind: Literal["pillars"]
    n: int
    spacing: int
    hazard: Literal["void", "spikes", "lava"]


class BeatFloaters(_Beat):
    kind: Literal["floaters"]
    n: int
    dy: int
    spacing: int
    oneway: bool


class BeatCeiling(_Beat):
    kind: Literal["ceiling"]
    length: int
    spikes: bool
    headroom: int


class BeatWall(_Beat):
    kind: Literal["wall"]
    height: int
    spikes: Literal["none", "near_face"]


class BeatBridge(_Beat):
    kind: Literal["moving_bridge"]
    gap: int
    speed: Literal["slow", "normal", "fast"]
    vertical: bool


class BeatCrumble(_Beat):
    kind: Literal["crumble_run"]
    n: int
    floor: Literal["void", "shallow"]


class BeatSaws(_Beat):
    kind: Literal["saw_corridor"]
    length: int
    saws: int


class BeatTower(_Beat):
    kind: Literal["tower"]
    tiers: int
    rise: int
    oneway: bool


class BeatGauntlet(_Beat):
    kind: Literal["enemy_gauntlet"]
    archetype: Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher"]
    n: int


class BeatSpringUp(_Beat):
    kind: Literal["spring_up"]
    height: int


class BeatKey(_Beat):
    kind: Literal["key"]
    place: Literal["high", "guarded", "alcove"]


class BeatDoor(_Beat):
    kind: Literal["door"]


class BeatRest(_Beat):
    kind: Literal["rest"]
    length: int


class BeatCheckpoint(_Beat):
    kind: Literal["checkpoint"]


class BeatGoal(_Beat):
    kind: Literal["goal"]
    style: Literal["flag", "staircase"]


Beat = TypeAliasType(
    "Beat",
    Annotated[
        BeatFlat | BeatGap | BeatStep | BeatStairs | BeatPillars | BeatFloaters | BeatCeiling | BeatWall | BeatBridge
        | BeatCrumble | BeatSaws | BeatTower | BeatGauntlet | BeatSpringUp | BeatKey | BeatDoor | BeatRest
        | BeatCheckpoint | BeatGoal,
        Field(discriminator="kind"),
    ],
)


class Section(_Beat):
    role: Literal["teach", "test", "twist", "finale", "rest"]
    beats: list[Beat]


class LevelPlan(_Beat):
    title: str
    theme: Literal["sketchbook", "notebook", "graph", "kraft"]
    screens: int
    band: Literal["easy", "normal", "hard"]
    sections: list[Section]
    kid_summary: str
    safety_ok: bool


EXPORTS: list[Any] = [
    BeatFlat, BeatGap, BeatStep, BeatStairs, BeatPillars, BeatFloaters, BeatCeiling, BeatWall, BeatBridge, BeatCrumble,
    BeatSaws, BeatTower, BeatGauntlet, BeatSpringUp, BeatKey, BeatDoor, BeatRest, BeatCheckpoint, BeatGoal, Beat,
    Section, LevelPlan,
]
ROOT = LevelPlan
