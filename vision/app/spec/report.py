"""PlaytestReport: what the frame-exact bot measured (PLAN_V2 §4.2-4.5)."""
from typing import Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.common import Band, CellXY, Face, MessageArgs, Severity, Spec

FailureKind = TypeAliasType(
    "FailureKind",
    Literal[
        "gap_too_wide", "ledge_too_high", "head_bonk", "wall_too_tall", "goal_unreachable", "spawn_trapped",
        "key_unreachable", "hard_flag",
    ],
)
FlagCode = TypeAliasType(
    "FlagCode",
    Literal[
        "unsolvable", "tight_window", "blind_jump", "leap_of_faith", "spawn_unsafe", "invisible_lethal", "softlock",
        "long_segment", "head_bonk", "unreachable_drawn", "skippable_setpiece", "trivial", "long_flat", "dead_end",
        "entity_error",
    ],
)
RouteKind = TypeAliasType(
    "RouteKind",
    Literal["walk", "jump", "runjump", "drop", "dropthrough", "spring", "stomp", "ride", "wait", "timed_pass"],
)


class Flag(Spec):
    id: str
    code: FlagCode
    severity: Severity
    frame: int | None = None
    at: CellXY | None = None
    object_ids: list[str] = Field(default_factory=list)
    fix_cids: list[str] = Field(default_factory=list)
    message_key: str | None = None  # defaults to flag.<code>
    args: MessageArgs = Field(default_factory=dict)


class Blocking(Spec):
    from_: CellXY = Field(alias="from")
    to_object: str
    kind: FailureKind
    need: str
    have: str


class Frontier(Spec):
    reached: list[CellXY]
    blocking: Blocking | None = None


class RouteStep(Spec):
    i: int
    kind: RouteKind
    from_: CellXY = Field(alias="from")
    to: CellXY
    frames: int
    w_f: float  # takeoff window (frames)
    h_f: float  # hold window (frames)
    phi_f: float | None  # phase window (frames), timed entities only
    lethal: float  # lethal share L_i
    p_death_casual: float
    p_death_skilled: float
    blind: bool
    segment: str
    setpiece: str | None


class Segment(Spec):
    id: str
    from_: str = Field(alias="from")
    to: str
    E: float
    A: float
    T_ms: int
    F_s: float
    actions: int


class Slot(Spec):
    id: str  # e.g. slot.cp.3, slot.enemy.7
    x: float
    y: float
    host: str | None = None
    face: Face | None = None
    x0: float | None = None
    x1: float | None = None
    w: float | None = None
    segment: str | None = None
    tags: list[str] = Field(default_factory=list)


class Slots(Spec):
    checkpoint: list[Slot] = Field(default_factory=list)
    coin: list[Slot] = Field(default_factory=list)
    risk: list[Slot] = Field(default_factory=list)
    enemy: list[Slot] = Field(default_factory=list)
    hazard: list[Slot] = Field(default_factory=list)
    spikes: list[Slot] = Field(default_factory=list)
    step: list[Slot] = Field(default_factory=list)
    spring: list[Slot] = Field(default_factory=list)
    hint: list[Slot] = Field(default_factory=list)


class PlaytestReport(Spec):
    solvable: bool
    reason: Literal["no_start", "no_goal", "goal_unreachable", "key_unreachable"] | None = None
    frontier: Frontier | None = None
    route: list[RouteStep]  # min expected-deaths route; ties → fewer actions → faster
    segments: list[Segment]
    C: float
    F: float
    score: int = Field(ge=0, le=100)
    band: Band
    C_skilled: float
    fastest_ms: int
    par_ms: int
    casual_clear_s: float
    flags: list[Flag]
    reachable: list[str]  # node keys (reach halo)
    setpiece_order: list[str]
    slots: Slots
    engaged_enemies: int
    actions_per_screen: float
    trace: list[int]  # bot input log, RLE pairs (run, bits)
    level_hash: str
    core_version: str
    approx: bool = False  # 8-phase approximate timed search was used


EXPORTS: list[Any] = [
    FailureKind, FlagCode, RouteKind, Flag, Blocking, Frontier, RouteStep, Segment, Slot, Slots, PlaytestReport,
]
ROOT = PlaytestReport
