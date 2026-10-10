"""Model-facing output schemas (PLAN_V2 §3.10). Slim and enum-only: no numeric bounds (structured outputs do not
enforce them and one bad number would reject the whole answer; the sanitizer clamps), required fields only, and
discriminated unions so a key can never lose its door. Not part of the published format: the sanitizer turns
these into the wire forms in vision/app/spec/api.py (PerceptionJson, DesignPlanJson).
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.spec.plan import LevelPlan  # PLAN output: one schema for the model and the published spec (§8.3)


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


Role = Literal[
    "ground", "platform", "wall", "ceiling", "spikes", "lava", "saw", "enemy", "coin", "big_coin", "key", "door",
    "spring", "checkpoint", "goal", "pole", "start_marker", "text", "arrow", "decoration", "library_tag", "unknown",
]
Face = Literal["top", "bottom", "left", "right", "none"]
Dir = Literal["up", "down", "left", "right", "none"]
Conf = Literal["high", "medium", "low"]  # → 0.9 / 0.75 / 0.5
Speed = Literal["slow", "normal", "fast"]  # → params grid (§5.6)


class Node(_M):  # slim: no free-text per node (≈30% fewer output tokens than Probe A)
    id: int
    role: Role
    conf: Conf
    on: int | None
    att: int | None
    face: Face
    pts: Dir
    part: int | None
    ref: int | None


class BMove(_M):
    kind: Literal["move"]
    target: int
    dir: Literal["left", "right", "up", "down"]
    cells: int
    speed: Speed
    mode: Literal["pingpong", "loop"]


class BEnemy(_M):
    kind: Literal["enemy"]
    target: int
    archetype: Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher", "static"]
    speed: Speed
    spiky: bool


class BSpring(_M):
    kind: Literal["spring"]
    target: int
    dir: Literal["up", "left", "right"]
    strength: Literal["small", "normal", "big"]


class BCrumble(_M):
    kind: Literal["crumble"]
    target: int
    falls: bool


class BSaw(_M):
    kind: Literal["saw"]
    target: int
    dir: Literal["left", "right", "up", "down", "none"]
    cells: int
    speed: Speed


class BKeyDoor(_M):
    kind: Literal["key_door"]
    key: int  # BOTH required [M v1]
    door: int


class BCheckpoint(_M):
    kind: Literal["checkpoint"]
    target: int


class BStart(_M):
    kind: Literal["start"]
    near: int  # the "S", never "the ground" [M v1]


class BTimer(_M):
    kind: Literal["timer"]
    seconds: int


class BLibrary(_M):
    kind: Literal["library"]
    target: int
    type_name: str


Binding = Annotated[
    BMove | BEnemy | BSpring | BCrumble | BSaw | BKeyDoor | BCheckpoint | BStart | BTimer | BLibrary,
    Field(discriminator="kind"),
]


class Bound(_M):
    binding: Binding
    pinned: list[Literal["speed", "cells", "dir", "archetype", "strength", "seconds"]]
    evidence: str


class Setpiece(_M):
    name: str
    ids: list[int]
    kind: Literal["jump", "hazard_run", "climb", "enemy", "puzzle", "finale", "other"]


class Ask(_M):
    about: int
    kind: Literal["which_door", "is_decoration", "what_does_it_do", "which_flag_is_goal", "is_library", "keep_or_fix"]
    options: list[str]


class Perception(_M):
    nodes: list[Node]
    bindings: list[Bound]
    setpieces: list[Setpiece]
    intent: str
    difficulty_wish: Literal["none", "easy", "normal", "hard"]
    transcript: str
    title: str | None
    asks: list[Ask]
    safety_ok: bool
    safety_reason: str | None


# ---- flat binding form (P0 bakeoff: the API rejected the Binding union inside Perception with "compiled grammar is
# too large"; DesignPlan's NovelOp union was accepted). Same content, no union: unused fields carry sentinels, and
# `unflatten` validates per variant in code (§3.10 fallback, docs/v2/latency.md).

BindKind = Literal["move", "enemy", "spring", "crumble", "saw", "key_door", "checkpoint", "start", "timer", "library"]


class FlatBinding(_M):
    kind: BindKind
    target: int = Field(description="component id it applies to; key_door: the key; start: the S or arrow; timer: -1")
    door: int = Field(description="key_door: the door's component id; otherwise -1")
    dir: Literal["left", "right", "up", "down", "none"] = Field(description="move, saw, spring; otherwise none")
    cells: int = Field(description="move and saw distance in cells; otherwise 0")
    speed: Literal["slow", "normal", "fast", "none"] = Field(description="move, enemy, saw; otherwise none")
    mode: Literal["pingpong", "loop", "none"] = Field(description="move; otherwise none")
    archetype: Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher", "static", "none"] = Field(
        description="enemy; otherwise none")
    spiky: bool = Field(description="enemy that cannot be stomped; otherwise false")
    strength: Literal["small", "normal", "big", "none"] = Field(description="spring; otherwise none")
    falls: bool = Field(description="crumble: falls away; otherwise false")
    seconds: int = Field(description="timer; otherwise 0")
    type_name: str = Field(description="library: the type's name as written; otherwise empty")


class BoundFlat(_M):
    binding: FlatBinding
    pinned: list[Literal["speed", "cells", "dir", "archetype", "strength", "seconds"]]
    evidence: str


class PerceptionFlat(_M):
    nodes: list[Node]
    bindings: list[BoundFlat]
    setpieces: list[Setpiece]
    intent: str
    difficulty_wish: Literal["none", "easy", "normal", "hard"]
    transcript: str
    title: str | None
    asks: list[Ask]
    safety_ok: bool
    safety_reason: str | None


_FLAT_FIELDS: dict[str, tuple[str, ...]] = {
    "move": ("target", "dir", "cells", "speed", "mode"), "enemy": ("target", "archetype", "speed", "spiky"),
    "spring": ("target", "dir", "strength"), "crumble": ("target", "falls"), "saw": ("target", "dir", "cells", "speed"),
    "key_door": ("key", "door"), "checkpoint": ("target",), "start": ("near",), "timer": ("seconds",),
    "library": ("target", "type_name"),
}


def unflatten(b: FlatBinding) -> BMove | BEnemy | BSpring | BCrumble | BSaw | BKeyDoor | BCheckpoint | BStart | BTimer | BLibrary | None:
    """Validate a flat binding as its typed variant; None when a required field is missing (e.g. a key with no door)."""
    from pydantic import TypeAdapter, ValidationError

    flat = b.model_dump()
    flat["key"] = flat["target"]
    flat["near"] = flat["target"]
    data = {"kind": b.kind, **{f: flat[f] for f in _FLAT_FIELDS[b.kind]}}
    if any(v in (-1, "none") for k, v in data.items() if k != "kind" and k not in ("dir",)) or (
        b.kind == "key_door" and (b.door < 0 or b.target < 0)
    ):
        return None
    try:
        return TypeAdapter(Binding).validate_python(data)
    except ValidationError:
        return None


Tier = Literal["polish", "normal", "hard"]  # model tier "polish" → build tier "polished"


class Pick(_M):
    cid: str
    tier: Tier
    reason: str


class RepairChoice(_M):
    alts: str
    cid: str
    reason: str


class Veto(_M):
    edit_id: str
    reason: str


class NEnemy(_M):
    op: Literal["add_enemy"]
    slot: str
    archetype: Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher"]
    tier: Tier
    reason: str


class NSpikes(_M):
    op: Literal["add_spikes"]
    slot: str
    tier: Tier
    reason: str


class NBigCoin(_M):
    op: Literal["add_big_coin"]
    slot: str
    reason: str


class NCheck(_M):
    op: Literal["add_checkpoint"]
    slot: str
    reason: str


class NTune(_M):
    op: Literal["tune"]
    target: str
    param: Literal["speed", "interval", "range"]
    step: Literal["+1", "+2"]
    tier: Tier
    reason: str


class NCrumble(_M):
    op: Literal["make_crumble"]
    target: str
    tier: Tier
    reason: str


class NReprise(_M):
    op: Literal["reprise"]
    setpiece: str
    slot: str
    escalation: Literal["faster", "plus_saw", "plus_spikes", "narrower"]
    reason: str


NovelOp = Annotated[NEnemy | NSpikes | NBigCoin | NCheck | NTune | NCrumble | NReprise, Field(discriminator="op")]


class DesignAsk(_M):
    about: str
    kind: Literal["is_door", "keep_or_fix", "which_way"]
    options: list[str]


class DesignPlan(_M):
    repair_choices: list[RepairChoice]
    vetoes: list[Veto]
    picks: list[Pick]
    novel: list[NovelOp]
    asks: list[DesignAsk]
    designer_note: str
    critique: list[str]
    title: str | None


class Observation(_M):
    segment: str
    what: str


class Critique(_M):
    observations: list[Observation]
    picks: list[Pick]
    note: str


class CreatureSpec(_M):
    archetype: Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher", "static"]
    speed: Speed
    spiky: bool
    summary: str
    safety_ok: bool


class Moderation(_M):
    safety: Literal["ok", "flag"]
    reason: str | None


class EditJudgement(_M):
    edit_id: str
    keeps_intent: bool
    why: str


class LookScore(_M):
    score: Literal[1, 2, 3, 4, 5]
    per_edit: list[EditJudgement]


SCHEMAS: dict[str, type[BaseModel]] = {
    "perceive": PerceptionFlat,  # the union form is rejected by the API (P0 bakeoff); see unflatten() "design": DesignPlan, "refine": DesignPlan, "critic": Critique, "plan": LevelPlan,
    "creature": CreatureSpec, "moderate": Moderation, "look": LookScore,
}
