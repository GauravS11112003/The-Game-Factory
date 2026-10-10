"""API v2 (PLAN_V2 §11.3e), mounted by app.main behind a guarded import so a v2 error never takes down v1.

mount(app) adds every /api/v2 router; lifespan(app) starts the core worker pool and runs the additive SQLite
migrations, and stops the pool on shutdown. Both are wrapped by app.main so failures only disable v2.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from app import db_v2
from app.build.bridge import CorePool, set_pool
from app.config import get_settings_v2
from app.routers.v2 import builds, health, stubs

log = logging.getLogger("dal.v2")
PREFIX = "/api/v2"


def mount(app: FastAPI) -> None:
    for module in (health, builds, stubs):
        app.include_router(module.router, prefix=PREFIX, tags=["v2"])


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:  # noqa: ARG001
    try:
        applied = db_v2.migrate()
        if applied:
            log.info("db_v2 migrations: %s", ", ".join(applied))
    except Exception as e:  # noqa: BLE001
        log.warning("db_v2 migration failed: %s", e)
    s = get_settings_v2()
    pool = CorePool(n=s.core_workers, node=s.node, stub=s.core_stub)
    try:
        await pool.start()
    except Exception as e:  # noqa: BLE001
        log.warning("core worker pool failed to start: %s", e)
    set_pool(pool)
    try:
        yield
    finally:
        set_pool(None)
        await pool.stop()
