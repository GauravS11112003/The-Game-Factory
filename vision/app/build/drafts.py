"""Draft and build ids and the draft folder layout (PLAN_V2 §11.3i):
vision/data/uploads/drafts/<draft_id>/{ink.json, graph0.json, perception/, plans/, edits.json, tiers/, events.jsonl,
state.json, sheets/, annotated/}.
"""
from __future__ import annotations

import re
import secrets
from pathlib import Path

from app.config import get_settings

DRAFT_RE = re.compile(r"^d_[0-9a-f]{8}$")
BUILD_RE = re.compile(r"^b_[0-9a-f]{8}$")


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
