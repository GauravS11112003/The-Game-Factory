"""Behavior: the typed union a kid chip, a perception binding, a library type or U4 `bind` attaches
to an object (PLAN_V2 §3.5 U4, §5.7-5.8, §8.1). Numbers come from the param grids (§5.6);
the model never writes these directly (it emits enums that the sanitizer maps, §3.10).
"""
from typing import Annotated, Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.common import Archetype, Dir, Dir4, Spec


class BStatic(Spec):
    kind: Literal["static"]


class EnemyParams(Spec):
    """Archetype parameters (§5.7); every field optional, defaults live in core/params.ts."""

    speed: float | None = None  # c/s
    ledge_aware: bool | None = None  # walker
    interval: float | None = None  # s (hopper, shooter)
    forward: bool | None = None  # hopper drift
    pattern: Literal["hover", "horizontal", "vertical", "circle"] | None = None  # flyer
    range: float | None = None  # cells (flyer horizontal/vertical)
    radius: float | None = None  # cells (flyer circle)
    period: float | None = None  # s (flyer circle)
    facing: Literal["left", "right", "toward_player"] | None = None  # shooter
    blob_speed: float | None = None  # c/s (shooter)
    sight: float | None = None  # cells (chaser)
    warn: float | None = None  # s (crusher)
    rise_speed: float | None = None  # c/s (crusher)


class BEnemy(Spec):
    kind: Literal["enemy"]
    archetype: Archetype
    spiky: bool = False
    params: EnemyParams = Field(default_factory=EnemyParams)


class BMove(Spec):
    kind: Literal["move"]
    dir: Dir4
    cells: float  # 2-20 after N12 fix_behavior; degenerate input paths are fitted or dropped, never rejected here
    speed: float  # c/s
    mode: Literal["pingpong", "loop"] = "pingpong"
    wait_s: float = 0.3


class BSpring(Spec):
    kind: Literal["spring"]
    dir: Literal["up", "left", "right"] = "up"
    strength: float = Field(default=1.0, ge=0.6, le=1.4)


class BCrumble(Spec):
    kind: Literal["crumble"]
    delay_s: float = 0.5
    respawn_s: float = 3.0


class BFalling(Spec):
    kind: Literal["falling"]
    delay_s: float = 0.4


class BSaw(Spec):
    kind: Literal["saw"]
    radius: float = 1.0  # cells: 0.75 / 1 / 1.5
    dir: Dir = "none"
    cells: float = 0
    speed: float = 3.0


class BFirebar(Spec):
    kind: Literal["firebar"]
    balls: int = Field(default=4, ge=3, le=6)
    speed_deg_s: float = 90
    phase: float = 0


Behavior = TypeAliasType(
    "Behavior",
    Annotated[BStatic | BEnemy | BMove | BSpring | BCrumble | BFalling | BSaw | BFirebar, Field(discriminator="kind")],
)

EXPORTS: list[Any] = [EnemyParams, BStatic, BEnemy, BMove, BSpring, BCrumble, BFalling, BSaw, BFirebar, Behavior]
ROOT = Behavior
