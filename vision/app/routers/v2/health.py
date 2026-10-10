"""GET /api/v2/health (§11.3e): API, model mode, core worker state, core version, budget left today."""
from __future__ import annotations

from fastapi import APIRouter

from app.build.bridge import get_pool
from app.config import get_settings_v2
from app.mind import budget
from app.spec.api import Health

router = APIRouter()


@router.get("/health")
def health() -> dict[str, object]:
    pool = get_pool()
    return Health(
        ok=True,
        llm=get_settings_v2().llm_mode,
        worker=pool.state() if pool else "down",
        core_version=pool.core_version if pool else None,
        budget_left_usd=round(budget.left_today(), 4),
    ).model_dump()
