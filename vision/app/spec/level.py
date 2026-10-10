"""LevelV2 (`dal-level`, schema_version 2): PLAN_V2 §2.

`world`, `rules`, `compiled` are normative for playing; `ink`, `objects`, `setpieces`, `edits` for editing;
`design` and `meta.build` are informative (§2.3). `level_hash` covers gameplay only (§2.5).
"""
import hashlib
import json
import math
import re
from typing import Annotated, Any, Literal

from pydantic import Field, model_validator
from typing_extensions import TypeAliasType

from app.spec.behavior import EnemyParams
from app.spec.common import (
    Archetype, Band, CallKind, CellXY, Dir4, Effort, Face, MessageRef, Origin, RectCells, Safety, Spec, Stage, Tier,
    World,
)
from app.spec.edits import EditRecord
from app.spec.ink import LevelInk
from app.spec.library import LibraryType, Rig
from app.spec.report import Flag
from app.spec.rules import GameRules
from app.spec.scene import SceneObject, Setpiece

TILE_LEGEND = ".#=/\\abcd~X"
_ROW_RE = re.compile(r"^(?:[0-9]*[.#=/\\abcd~X])+$")
_RUN_RE = re.compile(r"([0-9]*)([.#=/\\abcd~X])")


def decode_row(row: str) -> str:
    """Expand one run-length-encoded tile row (§2.4): `<count><char>`, count omitted when 1."""
    if not _ROW_RE.match(row):
        raise ValueError(f"bad tile row {row!r}")
    return "".join(ch * (int(n) if n else 1) for n, ch in _RUN_RE.findall(row))


def encode_row(cells: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(cells):
        j = i
        while j < len(cells) and cells[j] == cells[i]:
            j += 1
        n = j - i
        out.append(f"{n}{cells[i]}" if n > 1 else cells[i])
        i = j
    return "".join(out)


# ---- compiled entities (entities, never tiles: §2.4) ----------------------------------------------


class _Ent(Spec):
    id: str
    origin: Origin | None = None  # art only; excluded from level_hash
    sprite: str | None = None  # art only; excluded from level_hash


class EPlayerStart(_Ent):
    type: Literal["player_start"]
    x: float
    y: float  # feet line


class ESpikes(_Ent):
    type: Literal["spikes"]
    host: str | None
    face: Face
    x0: float
    x1: float
    y: float
    facing: Dir4


class EEnemy(_Ent):
    type: Literal["enemy"]
    archetype: Archetype | Literal["static"]
    x: float
    y: float
    w: float
    h: float
    spiky: bool = False
    params: EnemyParams = Field(default_factory=EnemyParams)
    bounds: tuple[float, float] | None = None  # patrol x-range


class ECoin(_Ent):
    type: Literal["coin"]
    x: float
    y: float


class EBigCoin(_Ent):
    type: Literal["big_coin"]
    x: float
    y: float


class ECheckpoint(_Ent):
    type: Literal["checkpoint"]
    x: float
    y: float


class EGoal(_Ent):
    type: Literal["goal"]
    x: float
    y: float
    trigger: RectCells  # flag ∪ pole


class EKey(_Ent):
    type: Literal["key"]
    x: float
    y: float
    door: str | None = None


class EDoor(_Ent):
    type: Literal["door"]
    x: float
    y: float
    w: float
    h: float
    key: str | None = None


class ESpring(_Ent):
    type: Literal["spring"]
    x: float
    y: float
    dir: Literal["up", "left", "right"] = "up"
    strength: float = Field(default=1.0, ge=0.6, le=1.4)
    w: float = 1


class ESaw(_Ent):
    type: Literal["saw"]
    x: float
    y: float
    r: float
    path: list[CellXY] = Field(default_factory=list)
    speed: float = 3.0
    mode: Literal["pingpong", "loop"] = "pingpong"


class EFirebar(_Ent):
    type: Literal["firebar"]
    x: float
    y: float
    balls: int = Field(ge=3, le=6)
    speed_deg_s: float
    phase: float = 0


class EMovingPlatform(_Ent):
    type: Literal["moving_platform"]
    x: float
    y: float
    w: float
    path: list[CellXY]
    speed: float
    mode: Literal["pingpong", "loop"] = "pingpong"
    wait_s: float = 0.3
    one_way: bool = True


class ECrumble(_Ent):
    type: Literal["crumble"]
    x: float
    y: float
    w: float
    delay_s: float = 0.5
    respawn_s: float = 3.0
    one_way: bool = True


class EFalling(_Ent):
    type: Literal["falling_platform"]
    x: float
    y: float
    w: float
    delay_s: float = 0.4
    one_way: bool = True


class EHintArrow(_Ent):
    type: Literal["hint_arrow"]
    x: float
    y: float
    dir: Dir4


Entity = TypeAliasType(
    "Entity",
    Annotated[
        EPlayerStart | ESpikes | EEnemy | ECoin | EBigCoin | ECheckpoint | EGoal | EKey | EDoor | ESpring | ESaw
        | EFirebar | EMovingPlatform | ECrumble | EFalling | EHintArrow,
        Field(discriminator="type"),
    ],
)

# Fields of an entity that are art, not gameplay (§2.5); level_hash drops them.
ENTITY_ART_FIELDS = ("sprite", "origin")


class Trigger(Spec):
    """v1 rules carried over unchanged (§2.6): collect:/touch:/timer: → open:/win/lose."""

    when: str = Field(pattern=r"^(collect:[A-Za-z0-9_]+|touch:[A-Za-z0-9_]+|timer:[0-9]+)$")
    then: str = Field(pattern=r"^(open:[A-Za-z0-9_]+|win|lose)$")


class Tiles(Spec):
    legend: Literal[".#=/\\abcd~X"]
    rows: list[Annotated[str, Field(pattern=r"^(?:[0-9]*[.#=/\\abcd~X])+$")]]


class PlayerSprite(Spec):
    url: str
    rig: Rig | None = None


class Sprites(Spec):
    player: PlayerSprite | None = None
    objects: dict[str, str] = Field(default_factory=dict)


class Compiled(Spec):
    tiles: Tiles
    entities: list[Entity]
    triggers: list[Trigger] = Field(default_factory=list)
    sprites: Sprites = Field(default_factory=Sprites)


# ---- design (informative) and meta ---------------------------------------------------------------


class DesignSegment(Spec):
    from_: str = Field(alias="from")
    to: str
    E: float
    T_ms: int
    F_s: float
    actions: int


class Reach(Spec):
    polished: bool | None = None
    normal: bool | None = None
    hard: bool | None = None


class DesignBlock(Spec):
    tier: Tier
    band: Band
    C: float
    score: int = Field(ge=0, le=100)
    fastest_ms: int
    par_ms: int
    casual_clear_s: float
    segments: list[DesignSegment]
    flags: list[Flag]
    solvable: bool
    reach: Reach
    designer_note: str | None = None
    source: Literal["model", "greedy", "none"]


class StageTime(Spec):
    stage: Stage
    t_ms: int


class ModelCallMeta(Spec):
    kind: CallKind
    effort: Effort
    latency_ms: int
    in_tok: int
    out_tok: int
    cost_usd: float
    stop_reason: str | None
    fallback_used: bool
    served_by: str | None = None
    cache_read_tok: int | None = None


class BuildMeta(Spec):
    stages: list[StageTime] = Field(default_factory=list)
    model_calls: list[ModelCallMeta] = Field(default_factory=list)
    cost_usd: float = 0.0


class LevelMeta(Spec):
    transcript: str = ""
    intent: str | None = None
    safety: Safety = "unchecked"
    level_hash: str
    core_version: str
    warnings: list[MessageRef] = Field(default_factory=list)
    build: BuildMeta | None = None


class LevelSheet(Spec):
    index: int = Field(ge=0)
    photo_url: str | None = None
    qr: str | None = None
    sketch_url: str | None = None


class LevelSource(Spec):
    kind: Literal["canvas", "paper", "prompt", "migrated"]
    prompt: str | None = None
    pack_id: str | None = None
    sheets: list[LevelSheet] = Field(default_factory=list)


class LevelV2(Spec):
    format: Literal["dal-level"]
    schema_version: Literal[2]
    core_min: str
    id: str
    version: int = Field(ge=1)
    game_id: str | None = None
    parent_id: str | None = None
    order_index: int = Field(default=0, ge=0)
    title: str
    author: str
    created_at: str
    license: str = "CC-BY-4.0"
    world: World
    rules: GameRules
    source: LevelSource
    ink: LevelInk | None = None  # omitted (and ink_ref set) inside SSE `tier` events (§3.11)
    ink_ref: str | None = None
    objects: list[SceneObject] = Field(default_factory=list)
    setpieces: list[Setpiece] = Field(default_factory=list)
    edits: list[EditRecord] = Field(default_factory=list)
    compiled: Compiled
    design: DesignBlock | None = None
    embedded_library: list[LibraryType] = Field(default_factory=list)
    meta: LevelMeta

    @model_validator(mode="after")
    def _tiles_fit_world(self) -> "LevelV2":
        rows = self.compiled.tiles.rows
        if len(rows) != self.world.h:
            raise ValueError(f"compiled.tiles.rows has {len(rows)} rows, world.h is {self.world.h}")
        for i, row in enumerate(rows):
            n = len(decode_row(row))
            if n != self.world.w:
                raise ValueError(f"tile row {i} decodes to {n} cells, world.w is {self.world.w}")
        return self


# ---- level_hash (§2.5) -------------------------------------------------------------------------
# Canonical JSON: sorted keys, no whitespace, null members omitted, numbers rounded half-up to 4
# decimals and printed without trailing zeros (2.0 → 2). Must match web/src/core/util/canonical.ts.


def _canon_number(x: float | int) -> str:
    if isinstance(x, bool):
        raise TypeError("bool is not a number")
    n = math.floor(float(x) * 10000 + 0.5)
    if n == 0:
        return "0"
    sign = "-" if n < 0 else ""
    n = abs(n)
    whole, frac = divmod(n, 10000)
    if frac == 0:
        return f"{sign}{whole}"
    return f"{sign}{whole}.{frac:04d}".rstrip("0")


def canonical_json(v: Any) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return _canon_number(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        items = sorted((k, x) for k, x in v.items() if x is not None)
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical_json(x) for k, x in items) + "}"
    raise TypeError(f"not JSON: {type(v).__name__}")


def gameplay_view(level: dict[str, Any]) -> dict[str, Any]:
    compiled = level["compiled"]
    entities = [{k: x for k, x in e.items() if k not in ENTITY_ART_FIELDS} for e in compiled.get("entities", [])]
    return {
        "world": level["world"],
        "rules": level["rules"],
        "tiles": compiled["tiles"],
        "entities": entities,
        "triggers": compiled.get("triggers", []),
    }


def level_hash(level: dict[str, Any]) -> str:
    """Hash of the raw level JSON (never of a re-dumped model: defaults would change it)."""
    data = canonical_json(gameplay_view(level)).encode("utf-8")
    return "sha256:" + hashlib.sha256(data).hexdigest()


EXPORTS: list[Any] = [
    EPlayerStart, ESpikes, EEnemy, ECoin, EBigCoin, ECheckpoint, EGoal, EKey, EDoor, ESpring, ESaw, EFirebar,
    EMovingPlatform, ECrumble, EFalling, EHintArrow, Entity, Trigger, Tiles, PlayerSprite, Sprites, Compiled,
    DesignSegment, Reach, DesignBlock, StageTime, ModelCallMeta, BuildMeta, LevelMeta, LevelSheet, LevelSource, LevelV2,
]
ROOT = LevelV2
