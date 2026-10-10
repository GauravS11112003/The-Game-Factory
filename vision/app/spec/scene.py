"""Scene graph: typed objects with fitted shapes, relations, setpieces and ask cards
(PLAN_V2 §3.3, §3.4, §3.7). Object ids are 'o' + min component id, so they are stable (D6, §3.8).
"""
from typing import Annotated, Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.behavior import Behavior
from app.spec.common import (
    CellXY, Collision, DifficultyWish, Dir, Face, LibRef, MessageArgs, Origin, RectCells, Role, Safety, SetpieceKind,
    Spec,
)
from app.spec.edits import EditOp


class SurfaceSeg(Spec):
    a: CellXY
    b: CellXY
    slope: float  # rise per run, snapped to {0, ±0.5, ±1}


class ShapeSurface(Spec):
    k: Literal["surface"]
    segs: list[SurfaceSeg]
    fill: Literal["to_bottom", "one_row", "to_top", "none"]


class ShapeStrip(Spec):
    k: Literal["strip"]
    a: CellXY
    b: CellXY


class ShapeBody(Spec):
    k: Literal["body"]
    bbox: RectCells


class ShapePoint(Spec):
    k: Literal["point"]
    p: CellXY


class ShapeWall(Spec):
    k: Literal["wall"]
    x: float
    y0: float
    y1: float
    w: float = 1


Shape = TypeAliasType(
    "Shape",
    Annotated[ShapeSurface | ShapeStrip | ShapeBody | ShapePoint | ShapeWall, Field(discriminator="k")],
)


class Attachment(Spec):
    host: str
    face: Face


class Relations(Spec):
    rests_on: str | None = None
    attached: Attachment | None = None
    points: Dir | None = None
    part_of: str | None = None
    parts: list[str] | None = None
    refers_to: str | None = None  # text and arrows: the object they describe


class RoleAlt(Spec):
    role: Role
    conf: float = Field(ge=0, le=1)


RoleBy = TypeAliasType(
    "RoleBy", Literal["heuristic", "model", "kid", "stamp", "library", "parser", "draft", "migrated", "designer"]
)


class SceneObject(Spec):
    id: str
    components: list[int]
    strokes: list[str]
    role: Role
    conf: float = Field(ge=0, le=1)
    role_by: RoleBy
    origin: Origin
    shape: Shape
    collision: Collision
    rel: Relations
    behavior: Behavior | None = None
    pinned: list[str]  # pinned behavior params (I4) and "role" when a kid chip or stamp fixed it
    alt: list[RoleAlt] = Field(default_factory=list)  # next two roles, for one-tap re-labels
    lib: LibRef | None = None
    text: str | None = None  # text objects: what it says


class Setpiece(Spec):
    name: str
    ids: list[str]
    kind: SetpieceKind
    by: Literal["model", "geometric", "kid"]


AskKind = TypeAliasType(
    "AskKind",
    Literal[
        "which_door", "is_decoration", "what_does_it_do", "which_flag_is_goal", "is_library", "keep_or_fix",
        "is_door", "which_way", "which_target", "grass_or_spikes", "is_this_right",
    ],
)


class AskOption(Spec):
    id: str
    label_key: str
    label_args: MessageArgs = Field(default_factory=dict)
    ops: list[EditOp] = Field(default_factory=list)  # the kid edit(s) this answer applies
    tap_target: bool = False  # "Tap it." answers name an object by tapping it


class AskCard(Spec):
    id: str
    about: str  # object id
    kind: AskKind
    message_key: str
    args: MessageArgs = Field(default_factory=dict)
    options: list[AskOption]
    default_option: str | None = None  # applied when publishing with the ask unanswered
    answer: str | None = None
    by: Literal["model", "heuristic", "parser", "validator", "designer"]


class SceneGraph(Spec):
    objects: list[SceneObject]
    setpieces: list[Setpiece] = Field(default_factory=list)
    intent: str | None = None
    difficulty_wish: DifficultyWish = "none"
    title: str | None = None
    safety: Safety = "unchecked"


EXPORTS: list[Any] = [
    SurfaceSeg, ShapeSurface, ShapeStrip, ShapeBody, ShapePoint, ShapeWall, Shape, Attachment, Relations, RoleAlt,
    RoleBy, SceneObject, Setpiece, AskKind, AskOption, AskCard, SceneGraph,
]
ROOT = SceneGraph
