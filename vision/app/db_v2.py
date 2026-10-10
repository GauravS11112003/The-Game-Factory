"""SQLite v2: additive, idempotent migrations run at startup (PLAN_V2 §11.3h).

v1 tables are untouched apart from added nullable columns, so the running v1 code keeps working. New tables:
packs, object_types, runs, attempts, builds, model_calls. Uses sqlite3 directly (no ORM) so v1's SQLModel
metadata never sees v2 tables.
"""
from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

from app.config import get_settings

ADD_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "games": [("rules_json", "TEXT"), ("format", "INTEGER")],
    "levels": [
        ("format", "INTEGER DEFAULT 1"), ("version", "INTEGER"), ("json_v2", "TEXT"), ("level_hash", "TEXT"),
        ("c_casual", "REAL"), ("score", "INTEGER"), ("band", "TEXT"), ("screens", "INTEGER"), ("verified", "BOOLEAN"),
        ("safety", "TEXT"), ("par_ms", "INTEGER"), ("fastest_ms", "INTEGER"),
    ],
}

NEW_TABLES: dict[str, str] = {
    "packs": """CREATE TABLE IF NOT EXISTS packs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, k INTEGER NOT NULL, game_id TEXT, parent_id TEXT,
        sheets_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)""",
    "object_types": """CREATE TABLE IF NOT EXISTS object_types (
        id TEXT NOT NULL, game_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, author TEXT,
        created_at TEXT NOT NULL, PRIMARY KEY (id, version))""",
    "runs": """CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, level_id TEXT NOT NULL, level_version INTEGER NOT NULL, level_hash TEXT NOT NULL,
        player TEXT NOT NULL, frames INTEGER NOT NULL, deaths INTEGER NOT NULL, coins INTEGER NOT NULL,
        big_coins INTEGER NOT NULL, board TEXT NOT NULL, replay TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL)""",
    "attempts": """CREATE TABLE IF NOT EXISTS attempts (
        level_id TEXT NOT NULL, day TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        deaths INTEGER NOT NULL DEFAULT 0, clears INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (level_id, day))""",
    "builds": """CREATE TABLE IF NOT EXISTS builds (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, kind TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, final_stage TEXT, cost_usd REAL NOT NULL DEFAULT 0)""",
    "model_calls": """CREATE TABLE IF NOT EXISTS model_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, draft_id TEXT, kind TEXT NOT NULL, effort TEXT, latency_ms INTEGER,
        in_tok INTEGER, out_tok INTEGER, cache_read_tok INTEGER, cost_usd REAL NOT NULL DEFAULT 0, stop_reason TEXT,
        served_by TEXT, fallback_used BOOLEAN, ok BOOLEAN, request_id TEXT, created_at TEXT NOT NULL)""",
}

INDEXES = [
    "CREATE INDEX IF NOT EXISTS ix_runs_level ON runs (level_id, board, frames)",
    "CREATE INDEX IF NOT EXISTS ix_builds_draft ON builds (draft_id)",
    "CREATE INDEX IF NOT EXISTS ix_model_calls_created ON model_calls (created_at)",
    "CREATE INDEX IF NOT EXISTS ix_model_calls_draft ON model_calls (draft_id)",
    "CREATE INDEX IF NOT EXISTS ix_object_types_game ON object_types (game_id)",
]


def db_path() -> Path:
    return get_settings().db_path


def connect(path: Path | None = None) -> sqlite3.Connection:
    p = path or db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def migrate(path: Path | None = None) -> list[str]:
    """Apply every missing additive migration. Idempotent; returns what changed."""
    applied: list[str] = []
    with closing(connect(path)) as conn, conn:
        for table, sql in NEW_TABLES.items():
            if not _columns(conn, table):
                conn.execute(sql)
                applied.append(f"create {table}")
        for sql in INDEXES:
            conn.execute(sql)
        for table, cols in ADD_COLUMNS.items():
            have = _columns(conn, table)
            if not have:  # v1 creates its tables on first use; the next startup adds the columns
                continue
            for name, decl in cols:
                if name not in have:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                    applied.append(f"{table}.{name}")
    return applied
