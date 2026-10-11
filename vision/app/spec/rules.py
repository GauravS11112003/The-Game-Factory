"""GameRules: the game-wide rules sheet; each level stores the resolved snapshot (PLAN_V2 §8.2)."""
from typing import Any, Literal

from pydantic import Field

from app.spec.common import ChallengeBand, Dial, GameMode, ProfileId, Spec, Theme
from app.spec.logic import RuleV4


class Abilities(Spec):
    run: bool = True
    stomp: bool = True
    double_jump: bool = False
    fast_fall: bool = True


class GameRules(Spec):
    version: int = Field(ge=1)
    physics_profile: ProfileId = "v2-standard"  # v1-classic only for migrated levels
    profile_hash: str | None = None  # sha256 of the profile's canonical JSON, pinned at publish
    abilities: Abilities = Field(default_factory=Abilities)
    lives: Literal["off", 3, 5] = "off"
    hearts: int = Field(default=1, ge=1, le=3)
    theme: Theme = "sketchbook"
    music: bool = True
    timer_pressure: bool = False  # lets Challenging add timers (C8)
    camera: Literal["follow", "no_backscroll"] = "follow"
    default_dial: Dial = "polished"
    default_band: ChallengeBand = "normal"
    player_type: str | None = None  # the game's default character (library type id)
    # v4 (docs/v4/CONTRACTS_V4.md): null = the v2 default, so v2 levels keep their level_hash
    mode: GameMode | None = None  # null = platformer
    logic: list[RuleV4] | None = None  # game-wide rules; run before each level's compiled.logic


EXPORTS: list[Any] = [Abilities, GameRules]
ROOT = GameRules
