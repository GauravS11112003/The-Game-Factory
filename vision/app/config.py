"""Settings read from environment variables (PLAN.md section 9, "Env").

The only process-wide state in the service is the cached Settings object.

    DAL_DATA_DIR        holds dal.sqlite and uploads/ (default: <vision>/data)
    DAL_PORT            uvicorn port (default 8000)
    DAL_FAKE_LLM        1/true forces fake mode; unset = fake iff ANTHROPIC_API_KEY is unset
    DAL_PUBLIC_UPLOADS  URL prefix the uploads folder is served under (default /uploads)
    ANTHROPIC_API_KEY   unset -> fake mode, the demo never blocks on the model
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

VISION_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = VISION_DIR.parent
SHARED_DIR = PROJECT_ROOT / "shared"
FIXTURES_DIR = SHARED_DIR / "fixtures"
SCHEMA_PATH = SHARED_DIR / "level.schema.json"
TEMPLATE_SPEC_PATH = SHARED_DIR / "template_spec.json"


def _env_flag(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return None
    return raw.strip().lower() in {"1", "true", "yes", "on"}


class Settings(BaseModel):
    data_dir: Path
    port: int
    public_uploads: str
    anthropic_api_key: str | None
    fake_llm: bool

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def drafts_dir(self) -> Path:
        return self.uploads_dir / "drafts"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "dal.sqlite"

    @property
    def llm_mode(self) -> Literal["fake", "live"]:
        return "fake" if self.fake_llm else "live"

    def ensure_dirs(self) -> None:
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self.drafts_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    key = os.environ.get("ANTHROPIC_API_KEY") or None
    explicit_fake = _env_flag("DAL_FAKE_LLM")
    # Without a key there is nothing to call, so fake mode wins even if DAL_FAKE_LLM=0.
    fake = True if key is None else bool(explicit_fake)
    data_dir = Path(os.environ.get("DAL_DATA_DIR") or (VISION_DIR / "data")).expanduser().resolve()
    return Settings(
        data_dir=data_dir,
        port=int(os.environ.get("DAL_PORT", "8000")),
        public_uploads=os.environ.get("DAL_PUBLIC_UPLOADS", "/uploads"),
        anthropic_api_key=key,
        fake_llm=fake,
    )


# --- v2 (PLAN_V2 §11.3j): additive env only; v1 Settings above is unchanged -------------------------


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


class SettingsV2(BaseModel):
    enabled: bool  # DAL_V2 (default 1): mount /api/v2 behind a guarded import
    core_workers: int  # DAL_CORE_WORKERS (default 2)
    node: str  # DAL_NODE (default "node")
    core_stub: bool  # DAL_CORE_STUB (default 0): workers answer with canned fixtures
    daily_budget_usd: float  # DAL_DAILY_BUDGET_USD (default 10)
    draft_budget_usd: float  # DAL_DRAFT_BUDGET_USD (default 0.40)
    speculative_design: bool  # DAL_SPECULATIVE_DESIGN (default 1)
    design_deadline_s: float  # DAL_DESIGN_DEADLINE_S (default 25)
    fast_mode: bool  # DAL_FAST_MODE (default 0; owner decision 1)
    require_moderation: bool  # DAL_REQUIRE_MODERATION (default 0)

    @property
    def llm_mode(self) -> Literal["live", "fake", "off"]:
        """v2 semantics: fake = DAL_FAKE_LLM=1 (recorded replies), live = a key is set, off = no key."""
        if _env_flag("DAL_FAKE_LLM"):
            return "fake"
        return "live" if os.environ.get("ANTHROPIC_API_KEY") else "off"


@lru_cache(maxsize=1)
def get_settings_v2() -> SettingsV2:
    def flag(name: str, default: bool) -> bool:
        v = _env_flag(name)
        return default if v is None else v

    return SettingsV2(
        enabled=flag("DAL_V2", True),
        core_workers=max(1, int(_env_float("DAL_CORE_WORKERS", 2))),
        node=os.environ.get("DAL_NODE") or "node",
        core_stub=flag("DAL_CORE_STUB", False),
        daily_budget_usd=_env_float("DAL_DAILY_BUDGET_USD", 10.0),
        draft_budget_usd=_env_float("DAL_DRAFT_BUDGET_USD", 0.40),
        speculative_design=flag("DAL_SPECULATIVE_DESIGN", True),
        design_deadline_s=_env_float("DAL_DESIGN_DEADLINE_S", 25.0),
        fast_mode=flag("DAL_FAST_MODE", False),
        require_moderation=flag("DAL_REQUIRE_MODERATION", False),
    )
