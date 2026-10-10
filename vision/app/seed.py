"""Seed data on first boot (PLAN.md section 12). Owned by lane D (Backend + UI).

Game "Starter World" by "team" from shared/fixtures/levels/*.json (ids
lvl_starter1..3, game_id game_starter), plus the remix chain for the tree
demo: First Steps (team) -> First Steps + spikes (maya) -> First Steps speedrun
(sam) with likes 12 / 5 / 2. A backdrop PNG is generated for every seeded
level from its grid so the engine and the feed always have something to show.
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw
from sqlmodel import Session

from app.config import FIXTURES_DIR, get_settings
from app.db import create_game, games_table_empty, get_engine, save_level
from app.models import Level, Rule

GAME_ID = "game_starter"
GAME_TITLE = "Starter World"
TEAM = "team"
MAYA_ID = "lvl_remix_maya"
SAM_ID = "lvl_remix_sam"
LIKES = {"lvl_starter1": 12, MAYA_ID: 5, SAM_ID: 2}

INK_BLACK = (0, 0, 0)
INK_RED = (229, 57, 53)
PAPER = (255, 255, 255)


def fixture_levels() -> list[Level]:
    paths = sorted((FIXTURES_DIR / "levels").glob("*.json"))
    return [Level.model_validate(json.loads(p.read_text())) for p in paths]


def render_backdrop(level: Level, out_path: Path) -> None:
    """768x432 PNG of the grid as ink on paper: black blocks for ground, red spikes for hazards."""
    cell = level.grid.cell
    img = Image.new("RGB", (level.grid.w * cell, level.grid.h * cell), PAPER)
    draw = ImageDraw.Draw(img)
    for y, row in enumerate(level.grid.rows):
        for x, ch in enumerate(row):
            x0, y0 = x * cell, y * cell
            if ch == "1":
                draw.rectangle([x0, y0, x0 + cell - 1, y0 + cell - 1], fill=INK_BLACK)
            elif ch == "2":
                half = cell // 2
                for sx in (x0, x0 + half):
                    draw.polygon([(sx, y0 + cell - 1), (sx + half - 1, y0 + cell - 1), (sx + half // 2, y0 + 2)], fill=INK_RED)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG")


def _with_backdrop(level: Level) -> Level:
    settings = get_settings()
    out = settings.uploads_dir / level.id / "backdrop.png"
    render_backdrop(level, out)
    level.source.backdrop_url = f"{settings.public_uploads}/{level.id}/backdrop.png"
    return level


def _add_spikes(level: Level) -> None:
    """Put three hazard cells into the first pit; without a pit, into the floor under a coin."""
    rows = [list(r) for r in level.grid.rows]
    bottom = level.grid.h - 1
    pit = [x for x in range(level.grid.w) if rows[bottom][x] == "0" and rows[bottom - 1][x] == "0"]
    if pit:
        for x in pit[:3]:
            rows[bottom][x] = "2"
    else:
        start = next((e for e in level.entities if e.type == "player_start"), None)
        for coin in (e for e in level.entities if e.type == "coin" and e.x is not None):
            x = coin.x or 0
            xs = [x - 1, x, x + 1]
            if not all(0 <= cx < level.grid.w for cx in xs):
                continue
            if any(rows[bottom - 1][cx] != "1" or rows[bottom - 2][cx] != "0" for cx in xs):
                continue
            if start is not None and start.x in xs:
                continue
            for cx in xs:
                rows[bottom - 1][cx] = "2"
            break
    level.grid.rows = ["".join(r) for r in rows]


def _remix(parent: Level, *, level_id: str, author: str, title: str, created_at: str, order_index: int) -> Level:
    child = Level.model_validate(parent.model_dump(mode="json"))
    child.id = level_id
    child.parent_id = parent.id
    child.author = author
    child.title = title
    child.created_at = created_at
    child.order_index = order_index
    child.game_id = parent.game_id
    child.source.backdrop_url = None
    child.meta.warnings = []
    return child


def build_seed_levels() -> list[Level]:
    starters = fixture_levels()
    for i, level in enumerate(starters):
        level.game_id = GAME_ID
        level.order_index = i
    levels = list(starters)
    first = next((l for l in starters if l.id == "lvl_starter1"), starters[0])

    # Remixes keep the parent's order_index: they hang under it in the tree and are
    # not part of the game's three-level sequence (db.levels_in_game).
    maya = _remix(
        first,
        level_id=MAYA_ID,
        author="maya",
        title=f"{first.title} + spikes",
        created_at="2026-10-09T01:00:00Z",
        order_index=first.order_index,
    )
    _add_spikes(maya)
    maya.meta.notes_transcript = "added spikes"
    levels.append(maya)

    sam = _remix(
        maya,
        level_id=SAM_ID,
        author="sam",
        title=f"{first.title} speedrun",
        created_at="2026-10-09T02:00:00Z",
        order_index=maya.order_index,
    )
    sam.rules = [*sam.rules, Rule(when="timer:45", then="lose")]
    sam.meta.notes_transcript = "timer 45"
    levels.append(sam)

    # Re-validate so a bad edit above fails loudly at startup rather than at play time.
    return [Level.model_validate(l.model_dump(mode="json")) for l in levels]


def seed_if_empty() -> None:
    """Insert the seed game and levels when the games table is empty."""
    with Session(get_engine()) as session:
        if not games_table_empty(session):
            return
        create_game(session, game_id=GAME_ID, title=GAME_TITLE, author=TEAM, created_at="2026-10-09T00:00:00Z")
        for level in build_seed_levels():
            save_level(session, _with_backdrop(level), likes=LIKES.get(level.id, 0))
