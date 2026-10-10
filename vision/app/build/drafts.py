"""Draft and build ids, the draft folder layout and the draft state (PLAN_V2 §11.3i).

vision/data/uploads/drafts/<draft_id>/
    ink.json, graph0.json                  what was seen
    perception/<tile>.json                 sanitized PERCEIVE answers (PerceptionJson)
    plans/<n>.json                         sanitized DesignPlanJson (n = 1, 2, ...)
    edits.json                             every edit record the draft knows (U, kid, accepted suggestions, last tiers)
    tiers/<stage>.<tier>.json              BuildResult per stage and tier; tiers/<stage>.menu.json the menu
    tiers/current.<tier>.json              the authoritative current tiers (after kid edits and answers)
    events.jsonl, state.json
    sheets/<n>.jpg, annotated/<tile>.jpg

The folder sits under the uploads static mount, so `ink_ref` ("drafts/<id>/ink.json") and the tier files are
fetchable at /uploads/drafts/<id>/... by the web app.

`state.json` is written atomically (temp file + rename). Mutations of one draft are serialized by `lock(draft_id)`.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import tempfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import get_settings

DRAFT_RE = re.compile(r"^d_[0-9a-f]{8}$")
BUILD_RE = re.compile(r"^b_[0-9a-f]{8}$")
TIERS = ("faithful", "polished", "normal", "hard")
STAGES = ("ink", "understood", "designed")


def new_draft_id() -> str:
    return f"d_{secrets.token_hex(4)}"


def new_build_id() -> str:
    return f"b_{secrets.token_hex(4)}"


def draft_dir(draft_id: str) -> Path:
    if not DRAFT_RE.match(draft_id):
        raise ValueError(f"bad draft id {draft_id!r}")
    return get_settings().drafts_dir / draft_id


def events_path(draft_id: str) -> Path:
    return draft_dir(draft_id) / "events.jsonl"


def exists(draft_id: str) -> bool:
    try:
        return (draft_dir(draft_id) / "state.json").exists()
    except ValueError:
        return False


def ink_ref(draft_id: str) -> str:
    return f"drafts/{draft_id}/ink.json"


def seed_of(draft_id: str) -> int:
    """Deterministic per-draft seed for the core (art boil, designer tie-breaks)."""
    try:
        return int(draft_id[2:], 16) % 2_147_483_647
    except ValueError:
        return 1


# ---- files ----------------------------------------------------------------------------------------


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_json(draft_id: str, rel: str, obj: Any) -> Path:
    path = draft_dir(draft_id) / rel
    _atomic_write(path, json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
    return path


def read_json(draft_id: str, rel: str) -> Any:
    path = draft_dir(draft_id) / rel
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def write_bytes(draft_id: str, rel: str, data: bytes) -> Path:
    path = draft_dir(draft_id) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def tier_rel(stage: str, tier: str) -> str:
    return f"tiers/{stage}.{tier}.json"


def save_tierset(draft_id: str, stage: str, tierset: dict[str, Any]) -> None:
    """Persist a TierSet under `stage` (ink | understood | designed | current) and its menu."""
    for t in TIERS:
        if t in tierset:
            write_json(draft_id, tier_rel(stage, t), tierset[t])
    write_json(draft_id, f"tiers/{stage}.menu.json", tierset.get("menu", []))
    write_json(draft_id, f"tiers/{stage}.meta.json", {"reach": tierset.get("reach"), "why": tierset.get("why")})


def load_tierset(draft_id: str, stage: str) -> dict[str, Any] | None:
    out: dict[str, Any] = {}
    for t in TIERS:
        r = read_json(draft_id, tier_rel(stage, t))
        if r is None:
            return None
        out[t] = r
    out["menu"] = read_json(draft_id, f"tiers/{stage}.menu.json") or []
    meta = read_json(draft_id, f"tiers/{stage}.meta.json") or {}
    out["reach"] = meta.get("reach") or {"polished": True, "normal": True, "hard": True}
    out["why"] = meta.get("why")
    return out


def load_current(draft_id: str) -> dict[str, Any] | None:
    """The authoritative tiers: `current` if a kid edit rebuilt them, else the latest stage that exists."""
    for stage in ("current", "designed", "understood", "ink"):
        ts = load_tierset(draft_id, stage)
        if ts is not None:
            ts["_stage"] = stage
            return ts
    return None


# ---- state ----------------------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_state(draft_id: str, kind: str, **fields: Any) -> dict[str, Any]:
    s: dict[str, Any] = {
        "v": 1, "draft_id": draft_id, "kind": kind, "created_at": _now(), "updated_at": _now(),
        "model": "off", "game_id": None, "parent_id": None, "pack_id": None, "dial": "polished", "band": None,
        "rules": None, "library": [], "seed": seed_of(draft_id), "builds": [],
        "stage": None, "stages": [],
        "perception": {"tiles": [], "status": None, "dropped": [], "discarded": False},
        "edits": {"perception": [], "parser": {}, "kid": [], "suggestions": [], "accepted": []},
        "statuses": {}, "asks": [], "answers": {}, "setpieces": [],
        "plan": None, "plans": 0, "design_source": "greedy",
        "current": None, "safety": "unchecked", "perceive_ran": False,
        "cost": {"usd": 0.0, "calls": 0, "by_kind": {}}, "model_calls": [],
        "note": None, "title": None, "transcript": "", "intent": None, "warnings": [], "published": None,
    }
    s.update(fields)
    return s


def load_state(draft_id: str) -> dict[str, Any] | None:
    s = read_json(draft_id, "state.json")
    return s if isinstance(s, dict) else None


def save_state(draft_id: str, state: dict[str, Any]) -> None:
    state = deepcopy(state)
    state["updated_at"] = _now()
    write_json(draft_id, "state.json", state)


_LOCKS: dict[str, asyncio.Lock] = {}


def lock(draft_id: str) -> asyncio.Lock:
    lk = _LOCKS.get(draft_id)
    if lk is None:
        lk = _LOCKS[draft_id] = asyncio.Lock()
    return lk
