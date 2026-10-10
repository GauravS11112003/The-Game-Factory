"""Progressive build events (SSE, PLAN_V2 §3.11): 13 named events, frozen at the end of P0.

On the wire each SSE message is `id: <seq>` / `event: <name>` / `data: <json payload>`.
Persisted streams (`drafts/<draft_id>/events.jsonl`, `shared/spec/conformance/events/*.jsonl`) store one
envelope per line: `{"seq": n, "event": name, "data": payload}`; that envelope is `BuildEvent`.
"""
from typing import Annotated, Any, Literal

from pydantic import Field
from typing_extensions import TypeAliasType

from app.spec.common import LlmMode, MessageArgs, RectCells, Role, Spec, Stage, StageName, Tier
from app.spec.edits import EditRecord
from app.spec.ink import InkDoc
from app.spec.level import LevelV2
from app.spec.report import PlaytestReport
from app.spec.scene import AskCard, SceneGraph

StageStatus = TypeAliasType("StageStatus", Literal["start", "done", "skipped", "failed", "late"])
EVENT_NAMES = (
    "hello", "stage", "ink", "saw", "edits", "tier", "ask", "note", "suggestions", "cost", "warning", "error", "done",
)


class EvHello(Spec):
    build_id: str
    draft_id: str
    version: int
    core_version: str
    model: LlmMode


class EvStage(Spec):
    stage: StageName
    status: StageStatus
    t_ms: int
    note_key: str | None = None


class EvInk(Spec):
    ink: InkDoc
    graph0: SceneGraph


class SawItem(Spec):
    object_id: str
    role: Role
    rel_key: str
    rel_args: MessageArgs = Field(default_factory=dict)
    conf: float
    bbox: RectCells


class EvSaw(Spec):
    items: list[SawItem]
    stage: Stage | None = None


class EvEdits(Spec):
    edits: list[EditRecord]  # upsert by id; carries tier and status


class Morph(Spec):
    object_id: str
    from_: RectCells = Field(alias="from")
    to: RectCells
    kind: Literal["move", "relabel", "appear", "vanish"]


class EvTier(Spec):
    stage: Stage
    tier: Tier
    level: LevelV2  # `ink` omitted, `ink_ref` set
    report: PlaytestReport
    edit_ids: list[str]
    reach: bool
    morphs: list[Morph] = Field(default_factory=list)


class EvAsk(Spec):
    ask: AskCard


class EvNote(Spec):
    designer_note: str
    critique: list[str] = Field(default_factory=list)
    title_suggestion: str | None = None
    source: Literal["model", "greedy"]


class EvSuggestions(Spec):
    edits: list[EditRecord]  # status "suggested"
    source: Literal["late_design", "refine", "critic"]


class EvCost(Spec):
    usd: float
    calls: int
    by_kind: dict[str, float] = Field(default_factory=dict)


class EvWarning(Spec):
    message_key: str
    args: MessageArgs = Field(default_factory=dict)


class EvError(Spec):
    message_key: str
    args: MessageArgs = Field(default_factory=dict)
    fatal: bool


class EvDone(Spec):
    final_stage: StageName
    total_ms: int


class _Env(Spec):
    seq: int = Field(ge=1)


class EnvHello(_Env):
    event: Literal["hello"]
    data: EvHello


class EnvStage(_Env):
    event: Literal["stage"]
    data: EvStage


class EnvInk(_Env):
    event: Literal["ink"]
    data: EvInk


class EnvSaw(_Env):
    event: Literal["saw"]
    data: EvSaw


class EnvEdits(_Env):
    event: Literal["edits"]
    data: EvEdits


class EnvTier(_Env):
    event: Literal["tier"]
    data: EvTier


class EnvAsk(_Env):
    event: Literal["ask"]
    data: EvAsk


class EnvNote(_Env):
    event: Literal["note"]
    data: EvNote


class EnvSuggestions(_Env):
    event: Literal["suggestions"]
    data: EvSuggestions


class EnvCost(_Env):
    event: Literal["cost"]
    data: EvCost


class EnvWarning(_Env):
    event: Literal["warning"]
    data: EvWarning


class EnvError(_Env):
    event: Literal["error"]
    data: EvError


class EnvDone(_Env):
    event: Literal["done"]
    data: EvDone


BuildEvent = TypeAliasType(
    "BuildEvent",
    Annotated[
        EnvHello | EnvStage | EnvInk | EnvSaw | EnvEdits | EnvTier | EnvAsk | EnvNote | EnvSuggestions | EnvCost
        | EnvWarning | EnvError | EnvDone,
        Field(discriminator="event"),
    ],
)

PAYLOADS: dict[str, type[Spec]] = {
    "hello": EvHello, "stage": EvStage, "ink": EvInk, "saw": EvSaw, "edits": EvEdits, "tier": EvTier, "ask": EvAsk,
    "note": EvNote, "suggestions": EvSuggestions, "cost": EvCost, "warning": EvWarning, "error": EvError,
    "done": EvDone,
}

EXPORTS: list[Any] = [
    StageStatus, EvHello, EvStage, EvInk, SawItem, EvSaw, EvEdits, Morph, EvTier, EvAsk, EvNote, EvSuggestions, EvCost,
    EvWarning, EvError, EvDone, EnvHello, EnvStage, EnvInk, EnvSaw, EnvEdits, EnvTier, EnvAsk, EnvNote, EnvSuggestions,
    EnvCost, EnvWarning, EnvError, EnvDone, BuildEvent,
]
ROOT = BuildEvent
assert tuple(PAYLOADS) == EVENT_NAMES
