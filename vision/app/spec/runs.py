"""Replays and run verdicts (PLAN_V2 §8.4). Published as shared/spec/run.schema.json."""
from typing import Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.common import Spec

Stamp = TypeAliasType("Stamp", Literal["clear", "collector", "speedy", "flawless"])


class Replay(Spec):
    """Deterministic input log. `input` = base64 of RLE records (u16 little-endian run, u8 bits L R J RUN D)."""

    v: Literal[1]
    core: str
    profile_hash: str
    level_id: str
    level_version: int = Field(ge=1)
    level_hash: str
    frames: int = Field(ge=0)
    input: str


class RunClaim(Spec):
    time_ms: int = Field(ge=0)
    deaths: int = Field(ge=0)
    coins: int = Field(ge=0)
    big_coins: int = Field(ge=0)


class RunSubmit(Spec):
    player: str = Field(min_length=1, max_length=16)
    replay: Replay
    claimed: RunClaim
    vs_run_id: str | None = None


class RunVerdict(Spec):
    finished: bool
    frames: int
    time_ms: int
    deaths: int
    coins: int
    big_coins: int
    stamps: list[Stamp]


class VsResult(Spec):
    beat: bool
    by_ms: int


class RunResult(Spec):
    run_id: str
    verified: bool
    rank: int | None = None
    pb: bool
    stamps: list[Stamp]
    vs: VsResult | None = None


EXPORTS: list[Any] = [Stamp, Replay, RunClaim, RunSubmit, RunVerdict, VsResult, RunResult]
ROOT = Replay
