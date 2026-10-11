"""Blocks: the public, cross-game library (docs/v4/CONTRACTS_V4.md §5).

A block is a named, versioned, immutable recipe made by any player: an object (art + behaviour, exactly what a game's
LibraryType holds) or a rule pack (logic only). Using a block in a game copies it into that game's library
(LibraryType.block points back here), so levels keep pinning library versions and level_hash never depends on a block.
"""
from typing import Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.behavior import Behavior
from app.spec.common import Spec
from app.spec.library import BlockRef, LibraryArt, LibrarySymbol
from app.spec.logic import RuleV4
from app.spec.script import Script
from app.spec.studio import ObjectDef, StudioTheme

BlockKind = TypeAliasType(
    "BlockKind", Literal["creature", "platform", "hazard", "pickup", "prop", "player", "rules", "object", "theme"]
)


class Block(Spec):
    id: str = Field(pattern=r"^blk_[a-z0-9]{8}$")
    version: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=24)
    kind: BlockKind
    behavior: Behavior | None = None  # required unless kind == "rules"
    spiky: bool = False
    collision: Literal["solid", "one_way", "none"] = "none"
    art: LibraryArt | None = None  # required unless kind == "rules"
    symbol: LibrarySymbol | None = None  # the legend symbol others can draw for it
    logic: list[RuleV4] = Field(default_factory=list)  # a rule pack, or rules that come with the object
    frames: list[LibraryArt] | None = Field(default=None, max_length=6)  # v5: flipbook frame art
    script: Script | None = None  # v5: developer pack behaviour
    object: ObjectDef | None = None  # v6 Studio: a reusable drawn object (kind "object")
    theme: StudioTheme | None = None  # v6 Studio: a shareable theme (kind "theme")
    description: str | None = Field(default=None, max_length=300)  # the maker's own words
    tags: list[str] = Field(default_factory=list, max_length=8)
    author: str
    author_id: str | None = None
    parent: BlockRef | None = None  # remixed from
    created_at: str


class BlockCard(Block):
    """A block as listed: the newest version plus usage counted by the server."""

    uses: int = 0  # games that use any version
    versions: int = 1


EXPORTS: list[Any] = [BlockKind, Block, BlockCard]
ROOT = Block
