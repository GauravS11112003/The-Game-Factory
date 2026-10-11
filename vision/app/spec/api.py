"""Cross-runtime wire contracts: HTTP API v2 bodies (PLAN_V2 §11.3e), worker RPC (§11.3c) and the
sanitized model outputs Python hands to the core.

`PerceptionJson` and `DesignPlanJson` are the *sanitized* forms of the model-facing schemas in
vision/app/mind/schemas.py (§3.10): ids checked, integers clamped, enums mapped to numbers through
shared/spec/params.json, the model tier "polish" mapped to the build tier "polished". The model-facing
schemas stay slim and may change with lane D; these wire forms change only through a contract PR.
"""
from typing import Annotated, Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.behavior import Behavior
from app.spec.blocks import BlockCard, BlockKind
from app.spec.common import (
    Archetype,
    ChallengeBand, Dial, DifficultyWish, GameMode, LlmMode, MessageArgs, MessageRef, Role, SetpieceKind, Spec, Tier,
)
from app.spec.edits import Candidate, EditOp, EditRecord
from app.spec.events import BuildEvent
from app.spec.ink import InkDoc, InkStroke
from app.spec.level import LevelV2
from app.spec.library import BlockRef, LibraryArt, LibrarySymbol, LibraryType
from app.spec.logic import RuleV4
from app.spec.script import Script
from app.spec.studio import ObjectDef, StudioTheme
from app.spec.report import PlaytestReport
from app.spec.rules import GameRules
from app.spec.scene import SceneGraph

# ---- sanitized model output: Perception (PERCEIVE, §3.3 merge input) -------------------------------

ModelFace = TypeAliasType("ModelFace", Literal["top", "bottom", "left", "right", "none"])
ModelDir = TypeAliasType("ModelDir", Literal["up", "down", "left", "right", "none"])


class PerceptionNode(Spec):
    id: int  # component id
    role: Role
    conf: float  # high 0.9 / medium 0.75 / low 0.5
    on: int | None
    att: int | None
    face: ModelFace
    pts: ModelDir
    part: int | None
    ref: int | None


class BindMove(Spec):
    kind: Literal["move"]
    target: int
    dir: Literal["left", "right", "up", "down"]
    cells: int  # clamped 1-12
    speed: float  # c/s from the param grid enum map
    mode: Literal["pingpong", "loop"]


class BindEnemy(Spec):
    kind: Literal["enemy"]
    target: int
    archetype: Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher", "static"]
    speed: float
    spiky: bool


class BindSpring(Spec):
    kind: Literal["spring"]
    target: int
    dir: Literal["up", "left", "right"]
    strength: float


class BindCrumble(Spec):
    kind: Literal["crumble"]
    target: int
    falls: bool


class BindSaw(Spec):
    kind: Literal["saw"]
    target: int
    dir: Literal["left", "right", "up", "down", "none"]
    cells: int
    speed: float


class BindKeyDoor(Spec):
    kind: Literal["key_door"]
    key: int
    door: int


class BindCheckpoint(Spec):
    kind: Literal["checkpoint"]
    target: int


class BindStart(Spec):
    kind: Literal["start"]
    near: int


class BindTimer(Spec):
    kind: Literal["timer"]
    seconds: int  # clamped 10-300


class BindLibrary(Spec):
    kind: Literal["library"]
    target: int
    type_name: str


Binding = TypeAliasType(
    "Binding",
    Annotated[
        BindMove | BindEnemy | BindSpring | BindCrumble | BindSaw | BindKeyDoor | BindCheckpoint | BindStart
        | BindTimer | BindLibrary,
        Field(discriminator="kind"),
    ],
)
PinnedParam = TypeAliasType("PinnedParam", Literal["speed", "cells", "dir", "archetype", "strength", "seconds"])


class PerceptionBound(Spec):
    binding: Binding
    pinned: list[PinnedParam]
    evidence: str


class PerceptionSetpiece(Spec):
    name: str
    ids: list[int]
    kind: SetpieceKind


class PerceptionAsk(Spec):
    about: int
    kind: Literal["which_door", "is_decoration", "what_does_it_do", "which_flag_is_goal", "is_library", "keep_or_fix"]
    options: list[str]


class PerceptionJson(Spec):
    tile: str  # tile or sheet id this perception covers
    nodes: list[PerceptionNode]
    bindings: list[PerceptionBound]
    setpieces: list[PerceptionSetpiece]
    intent: str  # ≤ 160 chars
    difficulty_wish: DifficultyWish
    transcript: str
    title: str | None
    asks: list[PerceptionAsk]
    safety_ok: bool
    safety_reason: str | None


# ---- sanitized model output: DesignPlan (DESIGN / REFINE / CRITIC picks) ---------------------------

BuildTierPick = TypeAliasType("BuildTierPick", Literal["polished", "normal", "hard"])


class DesignPick(Spec):
    cid: str
    tier: BuildTierPick
    reason: str  # ≤ 90 chars, rendered as text only


class RepairChoice(Spec):
    alts: str
    cid: str
    reason: str


class Veto(Spec):
    edit_id: str
    reason: str


class NovelEnemy(Spec):
    op: Literal["add_enemy"]
    slot: str
    archetype: Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher"]
    tier: BuildTierPick
    reason: str


class NovelSpikes(Spec):
    op: Literal["add_spikes"]
    slot: str
    tier: BuildTierPick
    reason: str


class NovelBigCoin(Spec):
    op: Literal["add_big_coin"]
    slot: str
    reason: str


class NovelCheckpoint(Spec):
    op: Literal["add_checkpoint"]
    slot: str
    reason: str


class NovelTune(Spec):
    op: Literal["tune"]
    target: str
    param: Literal["speed", "interval", "range"]
    step: Literal[1, 2]
    tier: BuildTierPick
    reason: str


class NovelCrumble(Spec):
    op: Literal["make_crumble"]
    target: str
    tier: BuildTierPick
    reason: str


class NovelReprise(Spec):
    op: Literal["reprise"]
    setpiece: str
    slot: str
    escalation: Literal["faster", "plus_saw", "plus_spikes", "narrower"]
    reason: str


NovelOp = TypeAliasType(
    "NovelOp",
    Annotated[
        NovelEnemy | NovelSpikes | NovelBigCoin | NovelCheckpoint | NovelTune | NovelCrumble | NovelReprise,
        Field(discriminator="op"),
    ],
)


class DesignAskJson(Spec):
    about: str
    kind: Literal["is_door", "keep_or_fix", "which_way"]
    options: list[str]


class DesignPlanJson(Spec):
    repair_choices: list[RepairChoice]
    vetoes: list[Veto]
    picks: list[DesignPick]
    novel: list[NovelOp]  # ≤ 3 after sanitizing
    asks: list[DesignAskJson]
    designer_note: str  # ≤ 240 chars
    critique: list[str]
    title: str | None


# ---- core build I/O (mirrors the interfaces in web/src/core/index.ts) ------------------------------


class BuildInputJson(Spec):
    ink: InkDoc
    graph0: SceneGraph
    edits: list[EditRecord]
    rules: GameRules
    library: list[LibraryType]
    parent: LevelV2 | None
    tier: Tier
    repairUnsolvable: bool
    seed: int
    # v4 (CONTRACTS_V4 §2.4): this level's rules, already parsed (by Claude) from ink.typed_rules; when null the core
    # parses the typed rules with its keyword parser. `mode` overrides rules.mode for this level when set.
    logic: list[RuleV4] | None = None
    mode: GameMode | None = None


class BuildResultJson(Spec):
    graph: SceneGraph
    level: LevelV2
    report: PlaytestReport
    edits: list[EditRecord]
    rejected: list[EditRecord]
    ms: float


class TierReach(Spec):
    polished: bool
    normal: bool
    hard: bool


class TierSetJson(Spec):
    faithful: BuildResultJson
    polished: BuildResultJson
    normal: BuildResultJson
    hard: BuildResultJson
    reach: TierReach
    why: MessageRef | None = None
    menu: list[Candidate]


# ---- worker RPC (§11.3c): one JSON object per line over stdio --------------------------------------

WorkerMethod = TypeAliasType(
    "WorkerMethod",
    Literal[
        "ping", "perceive_heuristic", "merge_perception", "parse_rules", "build", "build_tiers", "apply_plan",
        "transfer_plan", "digest", "analyze", "layout_plan", "keyword_plan", "remix_diff", "migrate_v1", "verify_run",
        "level_hash", "art_svg", "generate_level", "rules_check", "library_check", "parse_logic",
    ],
)


class WorkerRequest(Spec):
    id: int
    method: WorkerMethod
    params: dict[str, Any] = Field(default_factory=dict)


class WorkerError(Spec):
    code: Literal["timeout", "invalid", "internal"]
    message: str


class WorkerResponse(Spec):
    id: int
    ok: bool
    result: Any = None
    error: WorkerError | None = None


class PingResult(Spec):
    core_version: str
    node: str
    stub: bool = False


# ---- HTTP API v2 ---------------------------------------------------------------------------------


class Health(Spec):
    ok: bool
    llm: LlmMode
    worker: Literal["ok", "down"]
    core_version: str | None
    budget_left_usd: float


class BuildAccepted(Spec):
    build_id: str
    draft_id: str
    events_url: str


class DraftState(Spec):
    state: Literal["running", "done", "failed"]
    events: list[BuildEvent]


class EditsBody(Spec):
    statuses: dict[str, Literal["applied", "undone"]]
    kid_edits: list[EditOp] = Field(default_factory=list)


class TierSummary(Spec):
    tier: Tier
    level_hash: str
    C: float
    band: str
    solvable: bool
    reach: bool
    edit_ids: list[str]


class TierSetSummary(Spec):
    tiers: dict[str, TierSummary]
    rejected: list[str] = Field(default_factory=list)


class AnswerBody(Spec):
    ask_id: str
    choice: str


class DialBody(Spec):
    tier: Tier


class Accepted(Spec):
    build_id: str
    draft_id: str | None = None


class DeathEvent(Spec):
    x: float
    y: float
    cause: str
    frame: int
    segment: str


class Telemetry(Spec):
    deaths: list[DeathEvent]
    attempts: int
    segment_times: dict[str, float] = Field(default_factory=dict)


class CriticBody(Spec):
    telemetry: Telemetry


class PublishBody(Spec):
    draft_id: str
    tier: Tier
    author: str = Field(min_length=1, max_length=16)
    title: str | None = None
    statuses: dict[str, Literal["applied", "undone"]]
    level_hash: str


class ApiMessage(Spec):
    """Error bodies (409, 422, 501, 503): a message key, never a raw code in the UI."""

    message_key: str
    args: MessageArgs = Field(default_factory=dict)


class LevelStats(Spec):
    plays: int
    clears: int
    clear_rate: float | None
    best: int | None  # ms


class LevelResponse(Spec):
    level: LevelV2
    stats: LevelStats
    children: list[str]


class AttemptsBody(Spec):
    attempts: int = Field(ge=0)
    deaths: int = Field(ge=0)
    clears: int = Field(ge=0)


class GameCreate(Spec):
    title: str
    author: str


class AffectedLevel(Spec):
    level_id: str
    reason_key: str
    # v1.3 (optional): can a Faithful repair fix it under the new rules? The repairs are shown per level (§8.2).
    repairable: bool | None = None
    repairs: list[EditRecord] = Field(default_factory=list)
    level_hash: str | None = None  # the repaired level's hash, when repairable


class RulesCheck(Spec):
    affected: list[AffectedLevel]


class PackCreate(Spec):
    kind: Literal["new", "game", "remix", "extend"]
    k: int = Field(ge=1, le=6)
    game_id: str | None = None
    parent_id: str | None = None


class PackCreated(Spec):
    pack_id: str
    pdf_url: str


class CreatureSpecJson(Spec):
    archetype: Literal["walker", "hopper", "flyer", "shooter", "chaser", "crusher", "static"]
    speed: Literal["slow", "normal", "fast"]
    spiky: bool
    summary: str
    safety_ok: bool


class InterpretBody(Spec):
    name: str
    text: str
    ink: list[InkStroke]


class InterpretResult(Spec):
    spec: CreatureSpecJson
    behavior: Behavior
    source: Literal["model", "keywords"]


class PromptLevelBody(Spec):
    prompt: str
    game_id: str | None = None
    screens: int = Field(ge=1, le=6)
    dial: Dial = "polished"
    band: ChallengeBand | None = None


class RulesSheetResult(Spec):
    patch: dict[str, Any]
    asks: list[MessageRef] = Field(default_factory=list)
    # v1.3 (C-6): the "My world is…" line as a draft-relative JPEG, and the game the sheet's QR names
    story_crop: str | None = None
    game_id: str | None = None


class LibraryDraft(Spec):
    """One box of a scanned Library Sheet (§8.1), before the creator saves it as a LibraryType (C-6)."""

    box: int
    name: str
    name_source: Literal["default", "model", "kid"] = "default"
    name_has_ink: bool = False
    name_crop: str | None = None
    letter: str | None = None
    kind: Literal["creature"] = "creature"
    archetype: Archetype | None = None
    speed: Literal["slow", "normal", "fast"] = "normal"
    spiky: bool = False
    behavior: Behavior
    collision: Literal["solid", "one_way", "none"] = "none"
    art: LibraryArt
    symbol: LibrarySymbol | None = None
    symbol_samples: int = 0
    ticks: dict[str, float] = Field(default_factory=dict)
    asks: list[MessageRef] = Field(default_factory=list)
    warnings: list[MessageRef] = Field(default_factory=list)


# ---- v4 (docs/v4/CONTRACTS_V4.md §6): blocks, written rules, dashboard, connectors ----------------


class BlockCreate(Spec):
    """POST /blocks and POST /blocks/{id}/versions. Server fills id, version, author, created_at."""

    name: str = Field(min_length=1, max_length=24)
    kind: BlockKind
    behavior: Behavior | None = None
    spiky: bool = False
    collision: Literal["solid", "one_way", "none"] = "none"
    art: LibraryArt | None = None
    symbol: LibrarySymbol | None = None
    logic: list[RuleV4] = Field(default_factory=list)
    description: str | None = Field(default=None, max_length=300)
    tags: list[str] = Field(default_factory=list, max_length=8)
    parent: BlockRef | None = None
    frames: list[LibraryArt] | None = Field(default=None, max_length=6)  # v5
    script: Script | None = None  # v5
    object: ObjectDef | None = None  # v6
    theme: StudioTheme | None = None  # v6


class BlockList(Spec):
    blocks: list[BlockCard]
    total: int


class BlockDescribeBody(Spec):
    """POST /blocks/describe: the maker's words (and drawing) become a block draft."""

    name: str = Field(max_length=24)
    text: str = Field(max_length=300)
    ink: list[InkStroke] = Field(default_factory=list)


class BlockDescribeResult(Spec):
    kind: BlockKind
    behavior: Behavior | None
    spiky: bool
    collision: Literal["solid", "one_way", "none"]
    logic: list[RuleV4]
    summary: str  # one short sentence saying what it does
    unknown: list[str]  # parts of the text that could not be made, in the maker's words
    source: Literal["model", "keywords"]


class UseBlockBody(Spec):
    """POST /games/{id}/blocks: add a block to a game (copies it into the game's library or its rules)."""

    block_id: str = Field(pattern=r"^blk_[a-z0-9]{8}$")
    version: int | None = None  # null = newest


class UseBlockResult(Spec):
    library_type: LibraryType | None  # objects
    rules: GameRules | None  # rule packs: the game's rules after appending the pack's logic


class LogicParseBody(Spec):
    """POST /logic/parse: written rules ("space flips gravity") become RuleV4s."""

    sentences: list[str] = Field(min_length=1, max_length=12)
    game_id: str | None = None
    entity_ids: list[str] = Field(default_factory=list)  # ids the rules may name (doors, portals...)


class LogicParseResult(Spec):
    rules: list[RuleV4]
    mode: GameMode | None  # when a sentence names the kind of game ("it's like flappy bird")
    unknown: list[str]  # sentences that could not be made into rules
    source: Literal["model", "keywords"]


class DashboardGame(Spec):
    game_id: str
    title: str
    role: Literal["owner", "maintainer", "contributor"] | None
    mode: GameMode
    level_count: int
    beatable: int  # levels the bot cleared
    to_fix: int  # hard/block flags across the newest level versions (warn flags are notes, not fixes)
    pending_reviews: int  # submissions waiting (keepers only)
    open_quests: int
    cover_level_id: str | None
    updated_at: str | None


class DraftCard(Spec):
    draft_id: str
    title: str | None
    game_id: str | None
    kind: str  # canvas | paper | prompt
    updated_at: str


class Dashboard(Spec):
    """GET /dashboard (needs X-DP-Player): everything the workspace home shows."""

    games: list[DashboardGame]
    drafts: list[DraftCard]
    blocks: list[BlockCard]  # blocks this player made
    unread: int


class MinecraftBody(Spec):
    """POST /games/{id}/export/minecraft/live: build the game's first level in a running server over RCON."""

    host: str = "127.0.0.1"
    port: int = Field(default=25575, ge=1, le=65535)
    password: str = Field(min_length=1, max_length=128)
    level_id: str | None = None  # null = the game's first level
    origin: tuple[int, int, int] | None = None  # null = near the nearest player


class MinecraftResult(Spec):
    ok: bool
    commands: int
    message_key: str | None = None
    untranslated: list[str] = Field(default_factory=list)  # message keys for parts Minecraft cannot do


EXPORTS: list[Any] = [
    ModelFace, ModelDir, PerceptionNode, BindMove, BindEnemy, BindSpring, BindCrumble, BindSaw, BindKeyDoor,
    BindCheckpoint, BindStart, BindTimer, BindLibrary, Binding, PinnedParam, PerceptionBound, PerceptionSetpiece,
    PerceptionAsk, PerceptionJson, BuildTierPick, DesignPick, RepairChoice, Veto, NovelEnemy, NovelSpikes, NovelBigCoin,
    NovelCheckpoint, NovelTune, NovelCrumble, NovelReprise, NovelOp, DesignAskJson, DesignPlanJson, BuildInputJson,
    BuildResultJson, TierReach, TierSetJson, WorkerMethod, WorkerRequest, WorkerError, WorkerResponse, PingResult,
    Health, BuildAccepted, DraftState, EditsBody, TierSummary, TierSetSummary, AnswerBody, DialBody, Accepted,
    DeathEvent, Telemetry, CriticBody, PublishBody, ApiMessage, LevelStats, LevelResponse, AttemptsBody, GameCreate,
    AffectedLevel, RulesCheck, PackCreate, PackCreated, CreatureSpecJson, InterpretBody, InterpretResult,
    PromptLevelBody, RulesSheetResult, LibraryDraft,
    BlockCreate, BlockList, BlockDescribeBody, BlockDescribeResult, UseBlockBody, UseBlockResult, LogicParseBody,
    LogicParseResult, DashboardGame, DraftCard, Dashboard, MinecraftBody, MinecraftResult,
]
ROOT = None
