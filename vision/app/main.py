"""FastAPI application (PLAN.md section 9).

Run from the vision/ folder:

    uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

Routers live in app/routers/*.py; each one is an APIRouter with prefix "/api"
so the paths in PLAN.md section 9 appear verbatim in the router modules.
Startup seeds the database (Starter World + the remix chain) when it is empty.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.routers import games, levels, scan, templates
from app.seed import seed_if_empty


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    get_settings().ensure_dirs()
    seed_if_empty()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    settings.ensure_dirs()

    app = FastAPI(title="draw-a-level vision", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, object]:
        return {"ok": True, "llm": settings.llm_mode}

    for router in (scan.router, levels.router, games.router, templates.router):
        app.include_router(router)

    app.mount(settings.public_uploads, StaticFiles(directory=str(settings.uploads_dir)), name="uploads")
    return app


app = create_app()
