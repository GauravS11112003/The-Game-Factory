"""InkDoc: the only thing that crosses from seeing to building (PLAN_V2 §3.2)."""
from typing import Any, Literal

from pydantic import Field, model_validator

from app.spec.behavior import Behavior
from app.spec.common import CellXY, InkColor, InkWorld, LibRef, MessageRef, Origin, RectCells, Role, Spec, StampKind


class InkStroke(Spec):
    id: str
    color: InkColor
    kind: Literal["line", "dot", "blob"]
    pts: list[CellXY]  # cells, 1/64 precision. line: centreline; blob: closed contour; dot: [centre]
    w: list[float]  # width per point in cells (dot and blob: a single value is allowed)
    closed: bool
    sheet: int = Field(ge=0)
    origin: Origin
    stamp: StampKind | None = None  # canvas stamp
    label: Role | None = None  # kid chip, conf 1.0 ("pinned")
    rule: Behavior | None = None  # kid "What does it do?" chip
    lib: LibRef | None = None
    t: float | None = None  # canvas creation order

    @model_validator(mode="after")
    def _shape(self) -> "InkStroke":
        if not self.pts:
            raise ValueError("a stroke needs at least one point")
        if self.kind == "dot" and len(self.pts) != 1:
            raise ValueError("a dot has exactly one point (its centre)")
        if len(self.w) not in (1, len(self.pts)):
            raise ValueError("w has one width per point, or a single width")
        return self


class ComponentFeatures(Spec):
    fill: float
    circ: float
    straight: float
    zigN: float
    zigAmp: float
    aspect: float
    holes: int
    w: float
    corners: int
    spokes: int
    bumps: int
    is_dot: bool


class InkComponent(Spec):
    id: int = Field(ge=1)
    color: InkColor
    stroke_ids: list[str]
    bbox: RectCells
    area: float
    f: ComponentFeatures


class TypedRule(Spec):
    text: str
    target: int | None = None  # component id, when typed while a stroke was selected


class SheetInfo(Spec):
    index: int = Field(ge=0)
    photo_url: str | None = None
    qr: str | None = None
    warnings: list[MessageRef] = Field(default_factory=list)


class CharacterInk(Spec):
    strokes: list[InkStroke]


class NoiseInfo(Spec):
    count: int = Field(ge=0)  # marks < 0.03 cell² ("I ignored N tiny specks")


class ParentRef(Spec):
    level_id: str
    version: int
    level_hash: str


class InkDoc(Spec):
    v: Literal[2]
    source: Literal["canvas", "paper", "prompt", "migrated"]
    world: InkWorld
    strokes: list[InkStroke]
    components: list[InkComponent]
    character: CharacterInk | None
    typed_rules: list[TypedRule]
    rules_ink: list[str]  # paper rules-box stroke ids
    sheets: list[SheetInfo]
    noise: NoiseInfo
    parent: ParentRef | None


class LevelInk(Spec):
    """The `ink` block stored inside a LevelV2 (§2.2): InkDoc minus v/source/world/sheets/parent,
    which the level carries in `world`, `source` and `parent_id`."""

    strokes: list[InkStroke]
    components: list[InkComponent]
    character: CharacterInk | None = None
    typed_rules: list[TypedRule] = Field(default_factory=list)
    rules_ink: list[str] = Field(default_factory=list)
    noise: NoiseInfo = Field(default_factory=lambda: NoiseInfo(count=0))


EXPORTS: list[Any] = [
    InkStroke, ComponentFeatures, InkComponent, TypedRule, SheetInfo, CharacterInk, NoiseInfo, ParentRef, InkDoc,
    LevelInk,
]
ROOT = InkDoc
