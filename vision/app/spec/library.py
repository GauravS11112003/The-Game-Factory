"""Object library per game: immutable per version; levels pin {type_id, version} (PLAN_V2 §8.1)."""
from typing import Any, Literal

from pydantic import Field

from app.spec.behavior import Behavior
from app.spec.common import InkColor, Spec
from app.spec.ink import InkStroke


class Rig(Spec):
    """Rig extracted from a creature drawing (§7.6). Parts are stroke ids."""

    legs: list[str] = Field(default_factory=list)
    arms: list[str] = Field(default_factory=list)
    eyes: list[str] = Field(default_factory=list)
    synth_legs: bool = False
    hip_y: float = 0.7  # fraction of the bbox height


class LibraryArt(Spec):
    strokes: list[InkStroke]
    size_cells: tuple[float, float]
    rig: Rig | None = None


class LibrarySymbol(Spec):
    samples: list[list[InkStroke]] = Field(min_length=3, max_length=3)
    color: InkColor


class LibraryType(Spec):
    id: str
    game_id: str
    version: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=16)
    letter: str = Field(min_length=1, max_length=1)
    kind: Literal["creature", "platform", "hazard", "pickup", "prop", "player"]
    behavior: Behavior
    spiky: bool = False
    collision: Literal["solid", "one_way", "none"]
    art: LibraryArt
    symbol: LibrarySymbol | None = None
    author: str
    created_at: str


EXPORTS: list[Any] = [Rig, LibraryArt, LibrarySymbol, LibraryType]
ROOT = LibraryType
