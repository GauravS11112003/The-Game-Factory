"""API v2 (PLAN_V2 §11.3e), mounted by app.main behind a guarded import so a v2 error never takes down v1.

mount(app) adds every /api/v2 router; lifespan(app) runs the additive SQLite migrations, starts the core worker pool,
and then, in the background so startup is never held up, the boot migration of v1 levels (§2.6) and the v2 seeds
(§9: Classic Starter, Starter World, the remix chain). Both are wrapped by app.main so failures only disable v2.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from typing import AsyncIterator

from fastapi import FastAPI

from app import db_v2
from app.build.bridge import CorePool, set_pool
from app.config import get_settings_v2
from app.routers.v2 import (
    builds, drafts, games, health, levels, library, packs, prompts, rules, runs, stubs, transfer,
)

log = logging.getLogger("dal.v2")
PREFIX = "/api/v2"
BOOT_DELAY_S = 1.5  # let uvicorn finish starting (and the first requests through) before the background work


# v3 routers (docs/v3/CONTRACTS_V3.md); each is optional so a half-built module never takes the API down.
V3_MODULES = ("creative", "collab", "live", "export_phaser")
# v4 routers (docs/v4/CONTRACTS_V4.md §6), optional in the same way: blocks, written rules, the dashboard, connectors.
V4_MODULES = ("blocks", "logic", "dashboard", "export_connectors")
# v6 Studio (docs/v6/CONTRACTS_V6.md §5): games, templates and the AI copilot.
V6_MODULES = ("studio",)


def mount(app: FastAPI) -> None:
    import importlib

    modules = [health, builds, drafts, levels, runs, games, library, rules, prompts, packs, transfer]
    for name in V3_MODULES + V4_MODULES + V6_MODULES:
        try:
            modules.append(importlib.import_module(f"app.routers.v2.{name}"))
        except Exception as e:  # noqa: BLE001
            log.warning("v3/v4 router %s not mounted: %s", name, e)
    modules.append(stubs)  # stubs last: real routes win
    for module in modules:
        app.include_router(module.router, prefix=PREFIX, tags=["v2"])


async def boot_tasks(pool: CorePool) -> None:
    """v1 → v2 migration, then the seeds. Idempotent and quiet when there is nothing to do."""
    await asyncio.sleep(BOOT_DELAY_S)
    try:
        from app.migrate_v1 import migrate_all

        await migrate_all(pool)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        log.exception("v1 migration failed")
    try:
        from app.seed_v2 import seed_all

        await seed_all(pool)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        log.exception("v2 seeds failed")


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
    boot = None if s.core_stub else asyncio.create_task(boot_tasks(pool), name="v2 boot migration + seeds")
    try:
        yield
    finally:
        if boot is not None and not boot.done():
            boot.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await boot
        set_pool(None)
        await pool.stop()
