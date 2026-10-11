"""LOGIC (docs/v4/CONTRACTS_V4.md §2.4): written rules ("space flips gravity") → RuleV4s from the fixed vocabulary.

    parse(sentences, entity_ids, …)        → LogicOut(rules, mode, unknown, source)   POST /logic/parse
    model_parse(sentences, entity_ids, …)  → LogicOut | None                           builds (None = let the core parse)
    sanitize_rules(flat, sentences, ids)   the clamps; also used by the block describer for rule packs

The model only picks from the vocabulary: one trigger and up to four actions per rule, or the kind of game a sentence
names ("it's like flappy bird" → mode flappy). The output schema is flat (no unions: unused fields carry sentinels,
like PerceptionFlat and LevelPlanFlat) and slim; every number is clamped here and every rule is validated against
app/spec/logic.py, so one odd field drops one rule, never the whole answer. Rule ids are r1, r2, … in sentence order.

Offline (no key, fake without a reply, over budget, a failed or refused call) the core's keyword parser answers
through the worker (`parse_logic`); when the core cannot answer either, nothing is made and every sentence comes back
in `unknown`. Entity targets (touch, teleport, toggle, open) must be one of the ids the caller passed.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.mind import budget, client, moderate, sanitize
from app.mind.client import CallSpec, MindResult
from app.spec.logic import RuleV4

log = logging.getLogger("dal.v4.logic")

# kind: effort, max_tokens (caps thinking + output), timeout. Registered here so client.py stays untouched.
client.CALLS.setdefault("logic_parse", CallSpec("low", 3000, 15))
budget.ESTIMATE_USD.setdefault("logic_parse", 0.02)

SENTENCE_CHARS = 200
MAX_RULES = 24
MODES = ("platformer", "topdown", "runner", "flappy")
SOUNDS = ("ding", "boing", "zap", "whoosh", "boom", "fanfare")
RPC_TIMEOUT_S = 2.0

_ID = re.compile(r"^[A-Za-z0-9_]{1,40}$")
_NAME_OK = re.compile(r"^[a-z][a-z0-9 ]{0,15}$")

Rpc = Callable[[str, dict[str, Any], float | None], Awaitable[Any]]


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


WhenKind = Literal["start", "key", "touch", "collect", "all_coins", "timer", "zone", "score", "counter"]
DoKind = Literal[
    "flip_gravity", "gravity", "speed", "jump_power", "reverse_controls", "teleport", "toggle", "open",
    "freeze_enemies", "add_score", "add_counter", "heal", "hurt", "win", "lose", "say", "sound", "shake",
]


class FlatWhen(_M):
    kind: WhenKind
    key: Literal["space", "action", "none"] = Field(description="key: space, or action (E / Enter); otherwise none")
    target: str = Field(description="touch, collect: an entity id from the given list; otherwise empty")
    item: str = Field(description='collect: an item name ("coin" = any coin, "star", "red gem"); otherwise empty')
    seconds: float = Field(description="timer: seconds after the start; otherwise 0")
    every: bool = Field(description="timer: repeats every `seconds`; otherwise false")
    rect: list[float] = Field(description="zone: [x0, y0, x1, y1] in cells; otherwise empty")
    at_least: int = Field(description="score, counter: the number to reach; otherwise 0")
    name: str = Field(description="counter: the counter's name; otherwise empty")


class FlatDo(_M):
    kind: DoKind
    times: float = Field(description="gravity, speed, jump_power: the multiplier (0.5 = half); otherwise 0")
    seconds: float = Field(description="how long it lasts; 0 = until the player respawns")
    to_cell: list[float] = Field(description="teleport to a cell: [x, y]; otherwise empty")
    target: str = Field(description="teleport, toggle, open, say: an entity id from the list; otherwise empty")
    to: Literal["on", "off", "flip", "none"] = Field(description="toggle: show, hide or swap; otherwise none")
    n: int = Field(description="add_score, add_counter: how much to add; otherwise 0")
    name: str = Field(description="add_counter: the counter's name; otherwise empty")
    text: str = Field(description="say: the words in the speech bubble; otherwise empty")
    sound: Literal["ding", "boing", "zap", "whoosh", "boom", "fanfare", "none"] = Field(
        description="sound: which sound; otherwise none")


class FlatRule(_M):
    sentence: int = Field(description="index of the sentence this rule comes from")
    when: FlatWhen
    then: list[FlatDo]
    once: bool


class LogicFlat(_M):
    rules: list[FlatRule]
    mode: Literal["platformer", "topdown", "runner", "flappy", "none"]
    mode_sentence: int = Field(description="index of the sentence that names the mode; -1 when none")
    unknown: list[int] = Field(description="indexes of sentences that cannot be made from the vocabulary")


@dataclass
class LogicOut:
    rules: list[dict[str, Any]]
    mode: str | None
    unknown: list[str]
    source: Literal["model", "keywords"]
    used: set[int] = field(default_factory=set)  # sentence indexes that became rules or named the mode
    result: MindResult[Any] | None = None

    def as_result(self) -> dict[str, Any]:
        """The LogicParseResult body."""
        return {"rules": self.rules, "mode": self.mode, "unknown": self.unknown, "source": self.source}


# ---- clamps -------------------------------------------------------------------------------------------------------------


def _num(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if x != x:  # NaN
        return default
    return round(max(lo, min(hi, x)), 4)


def clean_name(v: Any) -> str | None:
    """A counter or item name ("stars", "red gems"): lowercase letters, digits and spaces, starting with a letter."""
    s = re.sub(r"[^a-z0-9 ]+", "", str(v or "").lower())
    s = re.sub(r"\s+", " ", s).strip()[:16].strip()
    return s if _NAME_OK.match(s) else None


def _target(v: Any, ids: set[str]) -> str | None:
    s = str(v or "").strip()
    return s if s and _ID.match(s) and s in ids else None


def _when(w: FlatWhen, ids: set[str]) -> dict[str, Any] | None:
    k = w.kind
    if k in ("start", "all_coins"):
        return {"kind": k}
    if k == "key":
        return {"kind": "key", "key": w.key} if w.key in ("space", "action") else None
    if k == "touch":
        t = _target(w.target, ids)
        return {"kind": "touch", "target": t} if t else None
    if k == "collect":
        t = _target(w.target, ids)
        if t:
            return {"kind": "collect", "target": t}
        item = clean_name(w.item)
        if item in ("coins", "a coin", "any coin"):
            item = "coin"
        return {"kind": "collect", "item": item} if item else None
    if k == "timer":
        if not w.seconds or w.seconds <= 0:
            return None
        return {"kind": "timer", "seconds": _num(w.seconds, 0.1, 600, 10), "every": bool(w.every)}
    if k == "zone":
        if len(w.rect) != 4:
            return None
        x0, y0, x1, y1 = (_num(v, 0, 288, 0) for v in w.rect)
        y0, y1 = min(y0, 27), min(y1, 27)
        return {"kind": "zone", "rect": [x0, y0, x1, y1]} if x1 > x0 and y1 > y0 else None
    if k == "score":
        return {"kind": "score", "at_least": int(_num(w.at_least, 1, 100000, 1))} if w.at_least > 0 else None
    if k == "counter":
        name = clean_name(w.name)
        if not name or w.at_least <= 0:
            return None
        return {"kind": "counter", "name": name, "at_least": int(_num(w.at_least, 1, 1000, 1))}
    return None


def _secs(v: float, hi: float = 600) -> float | None:
    """0 (or less) = until the player respawns."""
    return None if not v or v <= 0 else _num(v, 0.1, hi, 5)


def _do(d: FlatDo, ids: set[str]) -> dict[str, Any] | None:
    k = d.kind
    if k in ("flip_gravity", "heal", "hurt", "win", "lose", "shake"):
        return {"kind": k}
    if k == "gravity":
        return {"kind": k, "times": _num(d.times or 0.5, 0.25, 2, 0.5), "seconds": _secs(d.seconds)}
    if k == "speed":
        return {"kind": k, "times": _num(d.times or 1.6, 0.25, 3, 1.6), "seconds": _secs(d.seconds)}
    if k == "jump_power":
        return {"kind": k, "times": _num(d.times or 1.4, 0.5, 2, 1.4), "seconds": _secs(d.seconds)}
    if k == "reverse_controls":
        return {"kind": k, "seconds": _secs(d.seconds)}
    if k == "teleport":
        if len(d.to_cell) == 2:
            return {"kind": k, "to": [_num(d.to_cell[0], 0, 288, 0), _num(d.to_cell[1], 0, 27, 0)]}
        t = _target(d.target, ids)
        return {"kind": k, "target": t} if t else None
    if k == "toggle":
        t = _target(d.target, ids)
        return {"kind": k, "target": t, "to": d.to if d.to in ("on", "off", "flip") else "flip"} if t else None
    if k == "open":
        t = _target(d.target, ids)
        return {"kind": k, "target": t} if t else None
    if k == "freeze_enemies":
        return {"kind": k, "seconds": _num(d.seconds or 5, 0.1, 60, 5)}
    if k == "add_score":
        return {"kind": k, "n": int(_num(d.n or 10, -1000, 1000, 10))}
    if k == "add_counter":
        name = clean_name(d.name)
        return {"kind": k, "name": name, "n": int(_num(d.n or 1, -100, 100, 1))} if name else None
    if k == "say":
        text = sanitize.text(d.text, 90)
        if not text or moderate.blocklist_hit([text]):
            return None
        out: dict[str, Any] = {"kind": k, "text": text, "seconds": _num(d.seconds or 3, 0.5, 10, 3)}
        t = _target(d.target, ids)
        if t:
            out["target"] = t
        return out
    if k == "sound":
        return {"kind": k, "name": d.sound if d.sound in SOUNDS else "ding"}
    return None


def rule_of(r: FlatRule, ids: set[str], rid: str) -> dict[str, Any] | None:
    """One flat rule → a validated RuleV4 dict, or None when its trigger or every action is unusable."""
    when = _when(r.when, ids)
    if when is None:
        return None
    then = [x for x in (_do(d, ids) for d in r.then[:8]) if x is not None][:4]
    if not then:
        return None
    try:
        return RuleV4.model_validate({"id": rid, "when": when, "then": then, "once": bool(r.once)}).model_dump(
            mode="json", exclude_none=True)
    except ValidationError:
        return None


def sanitize_rules(flat: list[FlatRule], n_sentences: int, entity_ids: list[str] | tuple[str, ...] = (),
                   *, prefix: str = "r") -> tuple[list[dict[str, Any]], set[int]]:
    """(rules with ids r1, r2, … in sentence order, sentence indexes that produced a rule)."""
    ids = {str(i) for i in entity_ids if isinstance(i, str)}
    order = sorted(range(len(flat)), key=lambda i: (flat[i].sentence if 0 <= flat[i].sentence < n_sentences else
                                                    n_sentences, i))
    out: list[dict[str, Any]] = []
    used: set[int] = set()
    for i in order[:MAX_RULES]:
        r = flat[i]
        rule = rule_of(r, ids, f"{prefix}{len(out) + 1}")
        if rule is not None:
            out.append(rule)
            if 0 <= r.sentence < n_sentences:
                used.add(r.sentence)
    return out, used


# ---- the call ------------------------------------------------------------------------------------------------------------


def clean_sentences(sentences: list[str]) -> list[str]:
    return [t for t in (sanitize.text(s, SENTENCE_CHARS) for s in sentences or []) if t]


async def logic_call(sentences: list[str], entity_ids: list[str], *, draft_id: str | None = None,
                     deadline: float | None = None) -> MindResult[Any]:
    """The model call itself; never raises."""
    listing = "\n".join(f"{i}: {s}" for i, s in enumerate(sentences))
    ids = ", ".join(entity_ids[:80]) if entity_ids else "(none: no rule may name an entity)"
    content = [{"type": "text", "text": (
        f"Sentences the child wrote, by index:\n{listing}\n\n"
        f"Entity ids the rules may name: {ids}\n"
        "Turn each sentence into rules from the vocabulary, name the mode if a sentence names one, "
        "and list the indexes of sentences that cannot be made.")}]
    dl = deadline if deadline is not None else time.monotonic() + client.CALLS["logic_parse"].timeout_s
    try:
        return await client.call("logic_parse", LogicFlat, content, draft_id=draft_id, deadline=dl)
    except Exception as e:  # noqa: BLE001 - call() never raises; belt and braces
        return MindResult[LogicFlat](kind="logic_parse", status="failed", error=type(e).__name__)


def from_flat(v: LogicFlat, sentences: list[str], entity_ids: list[str]) -> LogicOut:
    rules, used = sanitize_rules(v.rules, len(sentences), entity_ids)
    mode = v.mode if v.mode in MODES else None
    if mode is not None and 0 <= v.mode_sentence < len(sentences):
        used.add(v.mode_sentence)
    elif mode is not None and not used and len(sentences) == 1:
        used.add(0)
    return LogicOut(rules=rules, mode=mode, unknown=[s for i, s in enumerate(sentences) if i not in used],
                    source="model", used=used)


async def model_parse(sentences: list[str], entity_ids: list[str] | None = None, *, draft_id: str | None = None,
                      deadline: float | None = None) -> LogicOut | None:
    """The model's answer, or None when it cannot answer (off, over budget, failed, refused). Never raises."""
    clean = clean_sentences(sentences)
    if not clean or not client.available():
        return None
    ids = [str(i) for i in entity_ids or [] if isinstance(i, str)]
    r = await logic_call(clean, ids, draft_id=draft_id, deadline=deadline)
    if not r.ok or r.value is None:
        return None
    out = from_flat(r.value, clean, ids)
    out.result = r
    return out


async def _pool_rpc(method: str, params: dict[str, Any], timeout_s: float | None) -> Any:
    from app.build.bridge import CoreError, get_pool

    pool = get_pool()
    if pool is None:
        raise CoreError("down", "the core worker pool is not running")
    return await pool.call(method, params, timeout_s)


async def keyword_parse(sentences: list[str], entity_ids: list[str] | None = None, *, rpc: Rpc | None = None) -> LogicOut:
    """The core's keyword parser (worker `parse_logic`); with no core answer, nothing is made. Never raises."""
    clean = clean_sentences(sentences)
    nothing = LogicOut(rules=[], mode=None, unknown=list(clean), source="keywords")
    if not clean:
        return nothing
    try:
        res = await (rpc or _pool_rpc)("parse_logic", {"sentences": clean, "entity_ids": list(entity_ids or [])},
                                       RPC_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001 - CoreError (down, timeout, NotImplemented) or a broken pool
        log.info("parse_logic unavailable: %s", e)
        return nothing
    if not isinstance(res, dict):
        return nothing
    rules: list[dict[str, Any]] = []
    for r in res.get("rules") or []:
        try:
            rules.append(RuleV4.model_validate(r).model_dump(mode="json", exclude_none=True))
        except ValidationError:
            continue
    mode = res.get("mode") if res.get("mode") in MODES else None
    unknown = [sanitize.text(u, SENTENCE_CHARS) for u in res.get("unknown") or [] if isinstance(u, str)]
    used = {i for i, s in enumerate(clean) if s not in unknown}
    return LogicOut(rules=rules, mode=mode, unknown=[u for u in unknown if u], source="keywords", used=used)


async def parse(sentences: list[str], entity_ids: list[str] | None = None, *, draft_id: str | None = None,
                deadline: float | None = None, rpc: Rpc | None = None) -> LogicOut:
    """POST /logic/parse: the model when it can answer, else the core's keyword parser. Never raises."""
    out = await model_parse(sentences, entity_ids, draft_id=draft_id, deadline=deadline)
    if out is not None:
        return out
    return await keyword_parse(sentences, entity_ids, rpc=rpc)
