"""Shared pytest fixtures. Makes `app` importable even without the editable install."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

VISION_DIR = Path(__file__).resolve().parents[1]
if str(VISION_DIR) not in sys.path:
    sys.path.insert(0, str(VISION_DIR))

from app.config import FIXTURES_DIR, SCHEMA_PATH  # noqa: E402

FIXTURE_LEVEL_PATHS = sorted((FIXTURES_DIR / "levels").glob("*.json"))


@pytest.fixture(scope="session")
def schema_path() -> Path:
    return SCHEMA_PATH


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    return FIXTURES_DIR
