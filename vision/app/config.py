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
