"""SQLModel engine + tables (PLAN.md section 9). Owned by lane D (Backend + UI).

Tables:
    games(id, title, author, created_at)
    levels(id, game_id, parent_id, order_index, title, author, json TEXT, solvable BOOL, likes INT, created_at)

The SQLite file lives at Settings.db_path (DAL_DATA_DIR/dal.sqlite). Swapping to
Postgres later is a change to this file only.

Every helper takes the Session as its first argument so there is no global
connection state; the only cache is one engine per database path.
"""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Any, Iterator

from sqlalchemy import Column, Text
from sqlalchemy.engine import Engine
from sqlmodel import Field, Session, SQLModel, create_engine, select

from app.config import get_settings
from app.models import Level


class GameRow(SQLModel, table=True):
    __tablename__ = "games"

    id: str = Field(primary_key=True)
    title: str
    author: str
    created_at: str


class LevelRow(SQLModel, table=True):
    __tablename__ = "levels"

    id: str = Field(primary_key=True)
    game_id: str | None = Field(default=None, index=True)
    parent_id: str | None = Field(default=None, index=True)
    order_index: int = 0
    title: str
    author: str
    # The column is called "json" as in the plan; the attribute is json_text so it
    # does not shadow pydantic's BaseModel.json().
    json_text: str = Field(sa_column=Column("json", Text, nullable=False))
    solvable: bool | None = None
    likes: int = 0
    created_at: str

    def to_level(self) -> Level:
        return Level.model_validate(json.loads(self.json_text))

    def summary(self) -> dict[str, Any]:
        level = self.to_level()
        return {
            "id": self.id,
            "game_id": self.game_id,
            "parent_id": self.parent_id,
            "order_index": self.order_index,
            "title": self.title,
            "author": self.author,
            "likes": self.likes,
            "solvable": self.solvable,
            "created_at": self.created_at,
            "backdrop_url": level.source.backdrop_url,
        }


@lru_cache(maxsize=4)
def _engine_for(db_path: str) -> Engine:
    # check_same_thread=False: FastAPI runs sync endpoints in a thread pool and
    # each request opens its own Session, so sharing the pool across threads is safe.
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return engine


def get_engine() -> Engine:
    """Return the SQLModel engine for Settings.db_path, creating tables on first use."""
    settings = get_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return _engine_for(str(settings.db_path))


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one Session per request."""
    with Session(get_engine()) as session:
        yield session


# --- levels -----------------------------------------------------------------


def get_level_row(session: Session, level_id: str) -> LevelRow | None:
    return session.get(LevelRow, level_id)


def get_level(session: Session, level_id: str) -> Level | None:
    row = session.get(LevelRow, level_id)
    return row.to_level() if row else None


def save_level(session: Session, level: Level, *, likes: int | None = None) -> LevelRow:
    """Insert or update the row for a Level; the JSON column always mirrors the model."""
    row = session.get(LevelRow, level.id)
    if row is None:
        row = LevelRow(
            id=level.id,
            title=level.title,
            author=level.author,
            json_text=level.model_dump_json(),
            created_at=level.created_at,
        )
    row.game_id = level.game_id
    row.parent_id = level.parent_id
    row.order_index = level.order_index
    row.title = level.title
    row.author = level.author
    row.json_text = level.model_dump_json()
    row.solvable = level.meta.solvable
    row.created_at = level.created_at
    if likes is not None:
        row.likes = likes
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def children_of(session: Session, level_id: str) -> list[LevelRow]:
    stmt = select(LevelRow).where(LevelRow.parent_id == level_id).order_by(LevelRow.created_at, LevelRow.id)
    return list(session.exec(stmt))


def tree_of(session: Session, root_id: str) -> dict[str, Any] | None:
    """root -> nested children, each node carrying author, title, created_at and the level JSON."""
    root = session.get(LevelRow, root_id)
    if root is None:
        return None

    def node(row: LevelRow, seen: set[str]) -> dict[str, Any]:
        seen.add(row.id)
        children = [node(c, seen) for c in children_of(session, row.id) if c.id not in seen]
        return {
            "id": row.id,
            "title": row.title,
            "author": row.author,
            "created_at": row.created_at,
            "likes": row.likes,
            "game_id": row.game_id,
            "parent_id": row.parent_id,
            "level": json.loads(row.json_text),
            "children": children,
        }

    return node(root, set())


def all_levels_in_game(session: Session, game_id: str) -> list[LevelRow]:
    """Every level that belongs to the game, remixes included, in play order."""
    stmt = select(LevelRow).where(LevelRow.game_id == game_id).order_by(LevelRow.order_index, LevelRow.created_at)
    return list(session.exec(stmt))


def levels_in_game(session: Session, game_id: str) -> list[LevelRow]:
    """The game's playable sequence (PLAN.md section 12: Starter World has three levels).

    A remix of a level that is in the same game hangs under its parent in the
    remix tree instead of extending the sequence; it keeps the parent's
    order_index so "next level" after a remix continues the game.
    """
    rows = all_levels_in_game(session, game_id)
    ids = {r.id for r in rows}
    return [r for r in rows if r.parent_id is None or r.parent_id not in ids]


def count_levels_in_game(session: Session, game_id: str) -> int:
    return len(levels_in_game(session, game_id))


def next_level_in_game(session: Session, row: LevelRow) -> LevelRow | None:
    if row.game_id is None:
        return None
    sequence = levels_in_game(session, row.game_id)
    position = next((i for i, r in enumerate(sequence) if r.id == row.id), None)
    if position is not None:
        return sequence[position + 1] if position + 1 < len(sequence) else None
    # A remix: continue after the sequence slot it inherited from its parent.
    return next((r for r in sequence if r.order_index > row.order_index), None)


# --- games ------------------------------------------------------------------


def get_game(session: Session, game_id: str) -> GameRow | None:
    return session.get(GameRow, game_id)


def create_game(session: Session, *, game_id: str, title: str, author: str, created_at: str) -> GameRow:
    game = GameRow(id=game_id, title=title, author=author, created_at=created_at)
    session.add(game)
    session.commit()
    session.refresh(game)
    return game


def game_dict(game: GameRow) -> dict[str, Any]:
    return {"id": game.id, "title": game.title, "author": game.author, "created_at": game.created_at}


def list_games_with_counts(session: Session) -> list[dict[str, Any]]:
    """The home feed: every game with level_count (its sequence), authors and likes (remixes included) and the first level as cover."""
    games = list(session.exec(select(GameRow).order_by(GameRow.created_at.desc(), GameRow.id)))  # type: ignore[attr-defined]
    feed: list[dict[str, Any]] = []
    for game in games:
        rows = all_levels_in_game(session, game.id)
        sequence = levels_in_game(session, game.id)
        authors: list[str] = []
        for r in rows:
            if r.author not in authors:
                authors.append(r.author)
        first = sequence[0] if sequence else (rows[0] if rows else None)
        feed.append(
            {
                **game_dict(game),
                "level_count": len(sequence),
                "authors": authors,
                "likes": sum(r.likes for r in rows),
                "cover": json.loads(first.json_text) if first else None,
            }
        )
    return feed


def games_table_empty(session: Session) -> bool:
    return session.exec(select(GameRow).limit(1)).first() is None
