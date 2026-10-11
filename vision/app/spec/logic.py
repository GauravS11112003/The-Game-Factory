"""Logic: the v4 rules engine (docs/v4/CONTRACTS_V4.md §2).

A rule is WHEN one trigger happens, DO up to 4 actions. Rules come from a fixed vocabulary, never code, so the bot can
test them and replays stay exact. Game-wide rules live in GameRules.logic and a level's own rules in compiled.logic;
both run, game rules first. Seconds are turned into whole frames by the sim (round(s * 60)).
"""
from typing import Annotated, Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.common import CellXY, RectCells, RuleKey, SoundName, Spec

_ID = r"^[A-Za-z0-9_]{1,40}$"
_NAME = r"^[a-z][a-z0-9 ]{0,15}$"  # counter and item names: "keys", "stars", "red gems"

# ---- WHEN: one trigger per rule ------------------------------------------------------------------


class WhenStart(Spec):
    kind: Literal["start"]


class WhenKey(Spec):
    """Fires on the frame the key goes down (an edge, never while held)."""

    kind: Literal["key"]
    key: RuleKey


class WhenTouch(Spec):
    """Fires on the frame the player starts touching the entity (edge)."""

    kind: Literal["touch"]
    target: str = Field(pattern=_ID)


class WhenCollect(Spec):
    """A coin, big coin, key or pickup is collected: one entity (target), any pickup with this item name, or any
    coin (item "coin"). Exactly one of target or item is set."""

    kind: Literal["collect"]
    target: str | None = Field(default=None, pattern=_ID)
    item: str | None = Field(default=None, pattern=_NAME)


class WhenAllCoins(Spec):
    kind: Literal["all_coins"]


class WhenTimer(Spec):
    """After `seconds` from the level start (the first input), or every `seconds` when `every`."""

    kind: Literal["timer"]
    seconds: float = Field(gt=0, le=600)
    every: bool = False


class WhenZone(Spec):
    """The player's feet enter the rectangle (cells, half-open [x0, y0, x1, y1])."""

    kind: Literal["zone"]
    rect: RectCells


class WhenScore(Spec):
    kind: Literal["score"]
    at_least: int = Field(ge=1, le=100000)


class WhenCounter(Spec):
    kind: Literal["counter"]
    name: str = Field(pattern=_NAME)
    at_least: int = Field(ge=1, le=1000)


class WhenFrame(Spec):
    """v5: a flipbook entity reaches frame `frame` (0-based)."""

    kind: Literal["frame"]
    target: str = Field(pattern=_ID)
    frame: int = Field(ge=0, le=5)


class WhenChoice(Spec):
    """v5: the player picks choice `index` (0-based) in a talking character's choices."""

    kind: Literal["choice"]
    target: str = Field(pattern=_ID)
    index: int = Field(ge=0, le=3)


RuleWhen = TypeAliasType(
    "RuleWhen",
    Annotated[
        WhenStart | WhenKey | WhenTouch | WhenCollect | WhenAllCoins | WhenTimer | WhenZone | WhenScore | WhenCounter
        | WhenFrame | WhenChoice,
        Field(discriminator="kind"),
    ],
)

# ---- DO: up to four actions per rule --------------------------------------------------------------
# `seconds: None` means for the rest of the life (until the player respawns or the level restarts).


class DoFlipGravity(Spec):
    kind: Literal["flip_gravity"]


class DoGravity(Spec):
    """Scale gravity (0.5 = moon jumps)."""

    kind: Literal["gravity"]
    times: float = Field(ge=0.25, le=2)
    seconds: float | None = Field(default=None, gt=0, le=600)


class DoSpeed(Spec):
    kind: Literal["speed"]
    times: float = Field(ge=0.25, le=3)
    seconds: float | None = Field(default=None, gt=0, le=600)


class DoJumpPower(Spec):
    kind: Literal["jump_power"]
    times: float = Field(ge=0.5, le=2)
    seconds: float | None = Field(default=None, gt=0, le=600)


class DoReverse(Spec):
    kind: Literal["reverse_controls"]
    seconds: float | None = Field(default=None, gt=0, le=600)


class DoTeleport(Spec):
    """Move the player to a cell (to) or onto an entity (target). Exactly one is set."""

    kind: Literal["teleport"]
    to: CellXY | None = None
    target: str | None = Field(default=None, pattern=_ID)


class DoToggle(Spec):
    """Show or hide an entity: a hidden entity is not drawn, not solid and does nothing."""

    kind: Literal["toggle"]
    target: str = Field(pattern=_ID)
    to: Literal["on", "off", "flip"] = "flip"


class DoOpen(Spec):
    kind: Literal["open"]
    target: str = Field(pattern=_ID)


class DoFreeze(Spec):
    kind: Literal["freeze_enemies"]
    seconds: float = Field(gt=0, le=60)


class DoScore(Spec):
    kind: Literal["add_score"]
    n: int = Field(ge=-1000, le=1000)


class DoCounter(Spec):
    kind: Literal["add_counter"]
    name: str = Field(pattern=_NAME)
    n: int = Field(default=1, ge=-100, le=100)


class DoHeal(Spec):
    kind: Literal["heal"]


class DoHurt(Spec):
    kind: Literal["hurt"]


class DoWin(Spec):
    kind: Literal["win"]


class DoLose(Spec):
    kind: Literal["lose"]


class DoSay(Spec):
    """A speech bubble over the player (or over `target`) for `seconds`."""

    kind: Literal["say"]
    text: str = Field(min_length=1, max_length=90)
    target: str | None = Field(default=None, pattern=_ID)
    seconds: float = Field(default=3, gt=0, le=10)


class DoSound(Spec):
    kind: Literal["sound"]
    name: SoundName


class DoShake(Spec):
    kind: Literal["shake"]


class DoSetFrame(Spec):
    """v5: jump a flipbook entity to frame `frame`."""

    kind: Literal["set_frame"]
    target: str = Field(pattern=_ID)
    frame: int = Field(ge=0, le=5)


class DoPush(Spec):
    """v5: give a physics body a push (cells/s added to its velocity)."""

    kind: Literal["push"]
    target: str = Field(pattern=_ID)
    vx: float = Field(default=0, ge=-30, le=30)
    vy: float = Field(default=0, ge=-30, le=30)


RuleDo = TypeAliasType(
    "RuleDo",
    Annotated[
        DoFlipGravity | DoGravity | DoSpeed | DoJumpPower | DoReverse | DoTeleport | DoToggle | DoOpen | DoFreeze
        | DoScore | DoCounter | DoHeal | DoHurt | DoWin | DoLose | DoSay | DoSound | DoShake | DoSetFrame | DoPush,
        Field(discriminator="kind"),
    ],
)


class RuleIf(Spec):
    """v5: a condition on a counter (counters double as the inventory: "keys", "red gems")."""

    name: str = Field(pattern=_NAME)
    at_least: int | None = Field(default=None, ge=0, le=100000)
    below: int | None = Field(default=None, ge=0, le=100000)


class RuleV4(Spec):
    id: str = Field(pattern=_ID)
    when: RuleWhen
    then: list[RuleDo] = Field(min_length=1, max_length=4)
    once: bool = False  # fire at most once per life
    off: bool | None = None  # switched off by the maker: kept, shown greyed out, never fires (null = on)
    only_if: list[RuleIf] | None = Field(default=None, max_length=3)  # v5: every condition must hold when it fires


EXPORTS: list[Any] = [
    WhenStart, WhenKey, WhenTouch, WhenCollect, WhenAllCoins, WhenTimer, WhenZone, WhenScore, WhenCounter, WhenFrame,
    WhenChoice, RuleWhen, RuleIf, DoSetFrame, DoPush,
    DoFlipGravity, DoGravity, DoSpeed, DoJumpPower, DoReverse, DoTeleport, DoToggle, DoOpen, DoFreeze, DoScore,
    DoCounter, DoHeal, DoHurt, DoWin, DoLose, DoSay, DoSound, DoShake, RuleDo, RuleV4,
]
ROOT = RuleV4
