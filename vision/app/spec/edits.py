"""The fixed edit vocabulary (43 ops in 6 classes), EditRecord and the designer menu row
(PLAN_V2 §3.5, §3.8). Targets are object ids; additions go only into bot slot ids.
Schema bounds here are the contract's hard limits; core/edits/vocabulary.ts clamps to the
tighter per-tier bounds (§3.5, §3.6) whoever proposes the op.
"""
from typing import Annotated, Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.behavior import Behavior
from app.spec.common import CellXY, Dir, Dir4, Face, MessageArgs, MessageRef, RectCells, Role, Spec, Stage, Tier

Side = TypeAliasType("Side", Literal["left", "right", "top", "bottom"])

# ---- U · Understand -----------------------------------------------------------------------------


class OpSetRole(Spec):
    op: Literal["set_role"]
    target: str
    role: Role


class OpGroup(Spec):
    op: Literal["group"]
    root: str
    parts: list[str]


class OpDetach(Spec):
    op: Literal["detach"]
    target: str
    branch: str  # stroke id of the branch split off (area ≤ 3 cells²)


class OpBind(Spec):
    op: Literal["bind"]
    target: str
    behavior: Behavior


class OpLink(Spec):
    op: Literal["link"]
    key: str
    door: str


class OpSetStart(Spec):
    op: Literal["set_start"]
    near: str


class OpUseLibrary(Spec):
    op: Literal["use_library"]
    target: str
    type_id: str
    version: int = Field(ge=1)


# ---- N · Normalize ------------------------------------------------------------------------------


class OpStraighten(Spec):
    op: Literal["straighten"]
    target: str
    mode: Literal["flat", "slope_1_2", "slope_1_1"] | None = None
    max_shift: float | None = Field(default=None, ge=0, le=0.85)


class OpCloseGap(Spec):
    op: Literal["close_gap"]
    a: str
    b: str


class OpSnap(Spec):
    op: Literal["snap"]
    target: str
    host: str
    face: Face


class OpOrient(Spec):
    op: Literal["orient"]
    target: str
    facing: Dir


class OpFormGoal(Spec):
    op: Literal["form_goal"]
    flag: str
    pole: str | None = None


class OpSetCollision(Spec):
    op: Literal["set_collision"]
    target: str
    mode: Literal["solid", "one_way", "none"]


class OpPlaceStart(Spec):
    op: Literal["place_start"]
    at: CellXY | None = None  # computed by the §3.3 start rule


class OpClearSpawn(Spec):
    op: Literal["clear_spawn"]
    start_dx: float | None = Field(default=None, ge=-4, le=4)  # computed; ≤ 4 cells along the surface
    trimmed: list[str] = Field(default_factory=list)  # patrols trimmed instead (never deletes a hazard)


class OpCoinFromDot(Spec):
    op: Literal["coin_from_dot"]
    target: str


class OpDedupe(Spec):
    op: Literal["dedupe"]
    keep: str
    drop: str


class OpJoinSeam(Spec):
    op: Literal["join_seam"]
    a: str
    b: str


class OpFixBehavior(Spec):
    op: Literal["fix_behavior"]
    target: str
    param: str
    value: float | str | bool | None


class OpFitCreature(Spec):
    op: Literal["fit_creature"]
    target: str


# ---- R · Repair -------------------------------------------------------------------------------


class OpNudge(Spec):
    op: Literal["nudge"]
    group: str  # root object id; the whole part_of group and what it carries moves together
    dx: int = Field(ge=-3, le=3)
    dy: int = Field(ge=-3, le=3)


class OpTrim(Spec):
    op: Literal["trim"]
    target: str
    side: Side
    cells: int = Field(ge=1, le=2)


class OpExtend(Spec):
    op: Literal["extend"]
    target: str
    side: Side
    cells: int = Field(ge=1, le=3)


class OpAddStep(Spec):
    op: Literal["add_step"]
    slot: str
    w: int = Field(ge=2, le=3)


class OpAddSpring(Spec):
    op: Literal["add_spring"]
    slot: str
    strength: float = Field(ge=0.6, le=1.4)


# ---- P · Polish ---------------------------------------------------------------------------------


class OpAddCheckpoint(Spec):
    op: Literal["add_checkpoint"]
    slot: str


class OpAddCoinTrail(Spec):
    op: Literal["add_coin_trail"]
    action: str  # route step id the trail follows
    n: int = Field(ge=3, le=7)


class OpAddCoin(Spec):
    op: Literal["add_coin"]
    slot: str


class OpAddBigCoin(Spec):
    op: Literal["add_big_coin"]
    slot: str


class OpAddHintArrow(Spec):
    op: Literal["add_hint_arrow"]
    slot: str
    dir: Dir4


class OpTune(Spec):
    op: Literal["tune"]
    entity: str
    param: str
    step: Literal[1, 2]  # raise only


class OpAnimate(Spec):
    op: Literal["animate"]
    target: str
    archetype: Literal["walker"]


class OpSetPar(Spec):
    op: Literal["set_par"]
    par_ms: int | None = None  # computed: ceil_0.5s(1.3 × bot fastest)


# ---- C · Challenge ------------------------------------------------------------------------------


class OpWidenGap(Spec):
    op: Literal["widen_gap"]
    gap: str
    cells: int = Field(ge=1, le=2)


class OpShrinkLanding(Spec):
    op: Literal["shrink_landing"]
    surface: str
    side: Literal["left", "right"]
    cells: int = Field(ge=1, le=2)


class OpShiftPlatform(Spec):
    op: Literal["shift_platform"]
    group: str
    dx: int = Field(ge=-2, le=2)
    dy: int = Field(ge=-2, le=2)


class OpAddSpikes(Spec):
    op: Literal["add_spikes"]
    slot: str  # resolves to (host, face, x0..x1), 1-6 cells, undrawn faces only


class OpAddEnemy(Spec):
    op: Literal["add_enemy"]
    slot: str
    archetype: Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher"]


class OpAddHazard(Spec):
    op: Literal["add_hazard"]
    slot: str
    kind: Literal["saw", "firebar", "lava"]


class OpMakeCrumble(Spec):
    op: Literal["make_crumble"]
    surface: str


class OpSetTimer(Spec):
    op: Literal["set_timer"]
    k: float = Field(ge=1.5, le=2.0)  # one of 1.5 / 1.75 / 2.0 × the bot's fastest time


class OpReprise(Spec):
    op: Literal["reprise"]
    setpiece: str
    slot: str
    escalation: Literal["faster", "plus_saw", "plus_spikes", "narrower"]


# ---- K · Kid -------------------------------------------------------------------------------------


class OpMakeMine(Spec):
    op: Literal["make_mine"]
    target: str


OP_CLASSES: dict[str, list[type[Spec]]] = {
    "U": [OpSetRole, OpGroup, OpDetach, OpBind, OpLink, OpSetStart, OpUseLibrary],
    "N": [OpStraighten, OpCloseGap, OpSnap, OpOrient, OpFormGoal, OpSetCollision, OpPlaceStart, OpClearSpawn,
          OpCoinFromDot, OpDedupe, OpJoinSeam, OpFixBehavior, OpFitCreature],
    "R": [OpNudge, OpTrim, OpExtend, OpAddStep, OpAddSpring],
    "P": [OpAddCheckpoint, OpAddCoinTrail, OpAddCoin, OpAddBigCoin, OpAddHintArrow, OpTune, OpAnimate, OpSetPar],
    "C": [OpWidenGap, OpShrinkLanding, OpShiftPlatform, OpAddSpikes, OpAddEnemy, OpAddHazard, OpMakeCrumble,
          OpSetTimer, OpReprise],
    "K": [OpMakeMine],
}
ALL_OPS: list[type[Spec]] = [op for ops in OP_CLASSES.values() for op in ops]

EditOp = TypeAliasType(
    "EditOp",
    Annotated[
        OpSetRole | OpGroup | OpDetach | OpBind | OpLink | OpSetStart | OpUseLibrary
        | OpStraighten | OpCloseGap | OpSnap | OpOrient | OpFormGoal | OpSetCollision | OpPlaceStart | OpClearSpawn
        | OpCoinFromDot | OpDedupe | OpJoinSeam | OpFixBehavior | OpFitCreature
        | OpNudge | OpTrim | OpExtend | OpAddStep | OpAddSpring
        | OpAddCheckpoint | OpAddCoinTrail | OpAddCoin | OpAddBigCoin | OpAddHintArrow | OpTune | OpAnimate | OpSetPar
        | OpWidenGap | OpShrinkLanding | OpShiftPlatform | OpAddSpikes | OpAddEnemy | OpAddHazard | OpMakeCrumble
        | OpSetTimer | OpReprise
        | OpMakeMine,
        Field(discriminator="op"),
    ],
)

EditClass = TypeAliasType("EditClass", Literal["U", "N", "R", "P", "C", "K"])
EditStatus = TypeAliasType("EditStatus", Literal["applied", "undone", "rejected", "suggested"])
EditBy = TypeAliasType(
    "EditBy", Literal["auto", "heuristic", "model", "kid", "greedy", "parser", "library", "validator"]
)


class Validation(Spec):
    solvable: bool
    flags: list[str]
    drift_cells: float
    dC: float


class Ghost(Spec):
    before: list[RectCells]
    after: list[RectCells]


class EditRecord(Spec):
    """One edit with its status. Ids are stable: `op:target:hash6(params)` (D6)."""

    id: str
    op: EditOp
    cls: EditClass = Field(alias="class")
    by: EditBy
    stage: Stage
    tier: Tier
    status: EditStatus
    reason_key: str
    reason_args: MessageArgs = Field(default_factory=dict)
    reason_text: str | None = None  # model reason (≤ 90 chars, text only)
    depends_on: list[str] = Field(default_factory=list)
    required: bool = False
    group: str | None = None
    validation: Validation | None = None
    ghost: Ghost | None = None
    reject_reason: MessageRef | None = None
    cid: str | None = None  # menu candidate this edit came from


class Candidate(Spec):
    """A designer menu row (§3.8): pre-verified in a sandbox, never raw geometry."""

    cid: str  # `op:target:hash6(params)`, stable across rebuilds and stages
    generator: str  # fix_flag | checkpoint | trail | risk_coin | animate | speed_up | tighten_jump | ...
    op: EditOp
    extra_ops: list[EditOp] = Field(default_factory=list)  # macro atoms (repairs of 2 ops, C9 reprise)
    tiers: list[Tier]  # tiers that allow it, lowest first
    alts: str | None = None  # mutually exclusive group id
    summary_key: str
    summary_args: MessageArgs = Field(default_factory=dict)
    dC: float
    dT_s: float
    dF_s: float
    drift: float
    intent_cost: float
    fixes: list[str] = Field(default_factory=list)  # flag ids
    measured: bool = False  # true for the top 12 after full measurement


EXPORTS: list[Any] = [
    Side, *ALL_OPS, EditOp, EditClass, EditStatus, EditBy, Validation, Ghost, EditRecord, Candidate,
]
ROOT = EditRecord
assert len(ALL_OPS) == 43, len(ALL_OPS)
