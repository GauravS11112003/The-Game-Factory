"""Model budget (PLAN_V2 D28): $0.40 per draft and DAL_DAILY_BUDGET_USD (default 10) per UTC day. Over budget,
the build takes the model-off path ("The designer is resting; quick look only")."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from app.config import get_settings_v2
from app.mind import ledger

# Conservative pre-call estimates (§3.14) so a call that would cross the cap is not started.
ESTIMATE_USD: dict[str, float] = {
    "perceive": 0.05, "design": 0.06, "refine": 0.04, "critic": 0.04, "plan": 0.04, "creature": 0.02,
    "moderate": 0.02, "look": 0.08, "handwriting": 0.02,
}


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00")


def spent_today(path: Path | None = None) -> float:
    return ledger.spent_since(_today(), path=path)


def left_today(path: Path | None = None) -> float:
    return max(0.0, get_settings_v2().daily_budget_usd - spent_today(path))


def spent_on_draft(draft_id: str, path: Path | None = None) -> float:
    return ledger.spent_since("1970-01-01", draft_id=draft_id, path=path)


def allow(kind: str, draft_id: str | None, path: Path | None = None) -> bool:
    s = get_settings_v2()
    est = ESTIMATE_USD.get(kind, 0.05)
    if spent_today(path) + est > s.daily_budget_usd:
        return False
    if draft_id is not None and spent_on_draft(draft_id, path) + est > s.draft_budget_usd:
        return False
    return True
