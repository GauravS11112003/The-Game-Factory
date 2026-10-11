"""Behavior: the typed union a kid chip, a perception binding, a library type or U4 `bind` attaches
to an object (PLAN_V2 §3.5 U4, §5.7-5.8, §8.1). Numbers come from the param grids (§5.6);
the model never writes these directly (it emits enums that the sanitizer maps, §3.10).
"""
from typing import Annotated, Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.common import Archetype, Dir, Dir4, PickupEffect, Spec, ZoneEffect


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


# ---- v4 primitives (docs/v4/CONTRACTS_V4.md §3) ----


class BPortal(Spec):
    """Touching a portal moves the player to its partner: the other portal with the same `pair` label in the level
    (a lone portal does nothing)."""

    kind: Literal["portal"]
    pair: str = Field(default="a", pattern=r"^[a-z0-9]{1,8}$")


class BZone(Spec):
    """An area with an effect while the player is inside: wind and conveyor push toward `dir`, water slows and lets
    you swim up, ice is slippery, low_gravity floats, slow halves speed. `strength` scales the effect."""

    kind: Literal["zone"]
    effect: ZoneEffect
    dir: Dir4 = "right"
    strength: float = Field(default=1.0, ge=0.5, le=2.0)


class BPickup(Spec):
    """Something to collect. `item` names it for rules ("star"); `effect` is a ready-made rule fired on collect."""

    kind: Literal["pickup"]
    item: str = Field(default="star", pattern=r"^[a-z][a-z0-9 ]{0,15}$")
    effect: PickupEffect = "none"
    seconds: float | None = Field(default=5.0, gt=0, le=60)
    respawn_s: float | None = Field(default=None, gt=0, le=60)


class BNpc(Spec):
    """A character that talks: touching it shows its lines one by one in a speech bubble."""

    kind: Literal["npc"]
    lines: list[str] = Field(min_length=1, max_length=6)
    name: str | None = Field(default=None, max_length=16)


# ---- v5 primitives (docs/v5/CONTRACTS_V5.md) ----

Material = TypeAliasType("Material", Literal["wood", "stone", "rubber", "ice", "metal"])


class BPhysics(Spec):
    """A loose object that falls, slides, stacks and can be pushed. Boxes stay upright; balls roll."""

    kind: Literal["physics"]
    shape: Literal["box", "ball"] = "box"
    material: Material = "wood"
    fixed: bool = False  # anchored: solid, never moves


class BFlipbook(Spec):
    """Changes through its drawn frames over time (seed, sprout, flower). The frame art is the library type's frames."""

    kind: Literal["flipbook"]
    frames: int = Field(default=3, ge=2, le=6)
    frame_s: float = Field(default=2.0, gt=0, le=600)
    loop: bool = False
    solid_from: int | None = Field(default=None, ge=0, le=5)  # from this frame on, it is solid ground
    collect_at: int | None = Field(default=None, ge=0, le=5)  # at this frame it can be collected as `item`
    item: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9 ]{0,15}$")


class BScripted(Spec):
    """Runs the library type's script (a developer pack, app/spec/script.py)."""

    kind: Literal["scripted"]


Behavior = TypeAliasType(
    "Behavior",
    Annotated[
        BStatic | BEnemy | BMove | BSpring | BCrumble | BFalling | BSaw | BFirebar | BPortal | BZone | BPickup | BNpc
        | BPhysics | BFlipbook | BScripted,
        Field(discriminator="kind"),
    ],
)

EXPORTS: list[Any] = [
    EnemyParams, BStatic, BEnemy, BMove, BSpring, BCrumble, BFalling, BSaw, BFirebar, BPortal, BZone, BPickup, BNpc,
    Material, BPhysics, BFlipbook, BScripted, Behavior,
]
ROOT = Behavior
