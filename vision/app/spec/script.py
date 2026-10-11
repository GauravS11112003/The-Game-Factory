"""Scripts: developer packs (docs/v5/CONTRACTS_V5.md §4).

A script gives one object its own behaviour as a small state machine. It is data from a fixed vocabulary, never code:
the sim interprets it deterministically, so a script is safe to share in the public Blocks library, the bot can play
levels that use it, and replays stay exact. Every state can run ops when it is entered, on every frame, when the
player touches the object, and can move on to another state after some seconds. Speeds are cells per second.
"""
from typing import Annotated, Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.common import Spec
from app.spec.logic import RuleDo

_STATE = r"^[a-z][a-z0-9_]{0,15}$"


class OpMove(Spec):
    """Set the object's velocity (cells/s; +y is down)."""

    op: Literal["move"]
    vx: float = Field(default=0, ge=-20, le=20)
    vy: float = Field(default=0, ge=-20, le=20)


class OpFollow(Spec):
    """Move toward the player at `speed` (along x only, or freely in x and y)."""

    op: Literal["follow"]
    speed: float = Field(default=2, gt=0, le=20)
    axis: Literal["x", "xy"] = "x"


class OpPatrol(Spec):
    """Walk back and forth `range` cells around where the state started."""

    op: Literal["patrol"]
    speed: float = Field(default=2, gt=0, le=20)
    range: float = Field(default=4, gt=0, le=40)


class OpJump(Spec):
    """Jump (only when standing on something, if `gravity` is on)."""

    op: Literal["jump"]
    power: float = Field(default=1.0, ge=0.3, le=2.5)


class OpGravity(Spec):
    op: Literal["gravity"]
    on: bool = True


class OpSolid(Spec):
    """The player can stand on it (on) or passes through it (off)."""

    op: Literal["solid"]
    on: bool = True


class OpHazard(Spec):
    """Touching it hurts the player (on) or not (off)."""

    op: Literal["hazard"]
    on: bool = True


class OpHide(Spec):
    """Hidden objects are not drawn and do nothing (their script keeps running)."""

    op: Literal["hide"]
    on: bool = True


class OpGoto(Spec):
    op: Literal["goto"]
    state: str = Field(pattern=_STATE)


class OpDo(Spec):
    """Run one rule action (say, sound, add_counter, toggle, win…); `say` without a target speaks from this object."""

    op: Literal["do"]
    action: RuleDo


ScriptOp = TypeAliasType(
    "ScriptOp",
    Annotated[
        OpMove | OpFollow | OpPatrol | OpJump | OpGravity | OpSolid | OpHazard | OpHide | OpGoto | OpDo,
        Field(discriminator="op"),
    ],
)


class ScriptAfter(Spec):
    seconds: float = Field(gt=0, le=600)
    goto: str = Field(pattern=_STATE)


class ScriptState(Spec):
    name: str = Field(pattern=_STATE)
    enter: list[ScriptOp] = Field(default_factory=list, max_length=8)
    tick: list[ScriptOp] = Field(default_factory=list, max_length=8)  # every frame while in this state
    touch: list[ScriptOp] = Field(default_factory=list, max_length=8)  # the frame the player starts touching it
    after: ScriptAfter | None = None


class Script(Spec):
    id: str = Field(pattern=r"^[A-Za-z0-9_]{1,40}$")
    start: str = Field(pattern=_STATE)
    states: list[ScriptState] = Field(min_length=1, max_length=8)
    gravity: bool = False  # the starting value of OpGravity
    solid: bool = False
    hazard: bool = False


EXPORTS: list[Any] = [
    OpMove, OpFollow, OpPatrol, OpJump, OpGravity, OpSolid, OpHazard, OpHide, OpGoto, OpDo, ScriptOp, ScriptAfter,
    ScriptState, Script,
]
ROOT = Script
