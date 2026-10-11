"""FastAPI application (PLAN.md section 9).

Run from the vision/ folder:

    uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

Routers live in app/routers/*.py; each one is an APIRouter with prefix "/api"
so the paths in PLAN.md section 9 appear verbatim in the router modules.
Startup seeds the database (Starter World + the remix chain) when it is empty.
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from types import ModuleType
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.routers import games, levels, scan, templates
from app.seed import seed_if_empty

log = logging.getLogger("dal")


def _load_v2() -> ModuleType | None:
    """v2 API behind a guarded import (PLAN_V2 D25, §11.1): any v2 error disables v2 and leaves v1 running."""
    if os.environ.get("DAL_V2", "1").strip().lower() in {"0", "false", "no", "off"}:
        return None
    try:
        import app.routers.v2 as v2
    except Exception:  # ImportError, SyntaxError, NameError... a broken v2 file must never stop v1
        log.exception("v2 API disabled: import failed")
        return None
    return v2


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    get_settings().ensure_dirs()
    seed_if_empty()
    v2_cm = None
    v2_lifespan = getattr(app.state, "v2_lifespan", None)
    if v2_lifespan is not None:
        try:
            v2_cm = v2_lifespan(app)
            await v2_cm.__aenter__()
        except Exception:
            log.exception("v2 startup failed; v1 keeps running")
            v2_cm = None
    try:
        yield
    finally:
        if v2_cm is not None:
            try:
                await v2_cm.__aexit__(None, None, None)
            except Exception:
                log.exception("v2 shutdown failed")


def create_app() -> FastAPI:
    settings = get_settings()
    settings.ensure_dirs()

    app = FastAPI(title="draw-a-level vision", version="0.1.0", lifespan=lifespan)
    from app import auth
    auth_settings = auth.settings()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[auth_settings.base_url] if auth_settings.enabled else ["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, object]:
        return {"ok": True, "llm": settings.llm_mode}

    for router in (scan.router, levels.router, games.router, templates.router):
        app.include_router(router)

    v2 = _load_v2()
    if v2 is not None:
        try:
            v2.mount(app)
            app.state.v2_lifespan = v2.lifespan
        except Exception:
            log.exception("v2 API disabled: mount failed")

    auth.install(app)
    app.mount(settings.public_uploads, StaticFiles(directory=str(settings.uploads_dir)), name="uploads")
    return app


app = create_app()
