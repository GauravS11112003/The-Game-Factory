"""Collaboration tables (CONTRACTS_V3 "Collaboration API"): additive, idempotent migrations in the db_v2 style.

Every table is created with CREATE TABLE IF NOT EXISTS; later columns go in ADD_COLUMNS and are added with a guarded
ALTER TABLE ADD COLUMN. Nothing here ever drops or deletes rows. `ensure()` runs the migration once per process and
database file, so a module saved while uvicorn is running never depends on the lifespan having run.

Games stay in the shared `games` table (format = 2); their owner, maintainers and contributors live in `members`.
`player_levels` ties a published level to the profile that published it (stats, "your level was played 100 times").
"""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, Iterator

from app import db_v2

TABLES: dict[str, str] = {
    "players": """CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar_path TEXT, token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL)""",
    "members": """CREATE TABLE IF NOT EXISTS members (
        game_id TEXT NOT NULL, player_id TEXT NOT NULL, role TEXT NOT NULL, joined_at TEXT NOT NULL, added_by TEXT,
        PRIMARY KEY (game_id, player_id))""",
    "bibles": """CREATE TABLE IF NOT EXISTS bibles (
        game_id TEXT PRIMARY KEY, pitch TEXT NOT NULL DEFAULT '', mechanics_text TEXT NOT NULL DEFAULT '',
        style_id TEXT, style_prompt TEXT, starter_type_ids TEXT NOT NULL DEFAULT '[]',
        open_for TEXT NOT NULL DEFAULT 'everyone', updated_at TEXT NOT NULL, updated_by TEXT)""",
    "submissions": """CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY, game_id TEXT NOT NULL, level_id TEXT NOT NULL, level_version INTEGER,
        player_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT, votes INTEGER NOT NULL DEFAULT 0,
        quest_id TEXT, created_at TEXT NOT NULL, updated_at TEXT, decided_at TEXT, decided_by TEXT)""",
    "comments": """CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, player_id TEXT NOT NULL, text TEXT NOT NULL,
        created_at TEXT NOT NULL)""",
    "votes": """CREATE TABLE IF NOT EXISTS votes (
        submission_id TEXT NOT NULL, player_id TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, PRIMARY KEY (submission_id, player_id))""",
    "quests": """CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY, game_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'level', status TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, claimed_at TEXT,
        submission_id TEXT, reward_badge TEXT, created_by TEXT, created_at TEXT NOT NULL, done_at TEXT,
        done_by TEXT)""",
    "credits": """CREATE TABLE IF NOT EXISTS credits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL DEFAULT '', player_id TEXT NOT NULL,
        kind TEXT NOT NULL, ref_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        UNIQUE (game_id, player_id, kind, ref_id))""",
    "activity": """CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT, player_id TEXT, kind TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)""",
    "notifications": """CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, kind TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)""",
    "badges": """CREATE TABLE IF NOT EXISTS badges (
        player_id TEXT NOT NULL, badge_id TEXT NOT NULL, awarded_at TEXT NOT NULL, game_id TEXT,
        PRIMARY KEY (player_id, badge_id))""",
    "jams": """CREATE TABLE IF NOT EXISTS jams (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, theme TEXT NOT NULL DEFAULT '', game_id TEXT,
        starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL)""",
    "jam_entries": """CREATE TABLE IF NOT EXISTS jam_entries (
        jam_id TEXT NOT NULL, level_id TEXT NOT NULL, player_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (jam_id, level_id))""",
    "player_levels": """CREATE TABLE IF NOT EXISTS player_levels (
        level_id TEXT PRIMARY KEY, player_id TEXT NOT NULL, game_id TEXT, created_at TEXT NOT NULL)""",
    "milestones": """CREATE TABLE IF NOT EXISTS milestones (
        ref_id TEXT NOT NULL, key TEXT NOT NULL, reached_at TEXT NOT NULL, PRIMARY KEY (ref_id, key))""",
    "collab_meta": """CREATE TABLE IF NOT EXISTS collab_meta (
        key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)""",
}

# later additive columns: {"table": [("column", "DECL")]}
ADD_COLUMNS: dict[str, list[tuple[str, str]]] = {}

INDEXES = [
    "CREATE INDEX IF NOT EXISTS ix_members_player ON members (player_id)",
    "CREATE INDEX IF NOT EXISTS ix_submissions_game ON submissions (game_id, status)",
    "CREATE INDEX IF NOT EXISTS ix_submissions_level ON submissions (level_id)",
    "CREATE INDEX IF NOT EXISTS ix_submissions_player ON submissions (player_id)",
    "CREATE INDEX IF NOT EXISTS ix_comments_submission ON comments (submission_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_quests_game ON quests (game_id, status)",
    "CREATE INDEX IF NOT EXISTS ix_credits_game ON credits (game_id)",
    "CREATE INDEX IF NOT EXISTS ix_credits_player ON credits (player_id)",
    "CREATE INDEX IF NOT EXISTS ix_activity_game ON activity (game_id, id)",
    "CREATE INDEX IF NOT EXISTS ix_notifications_player ON notifications (player_id, read, id)",
    "CREATE INDEX IF NOT EXISTS ix_player_levels_player ON player_levels (player_id)",
    "CREATE INDEX IF NOT EXISTS ix_jam_entries_player ON jam_entries (player_id)",
]


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def migrate(path: Path | None = None) -> list[str]:
    """Create every missing collab table, column and index. Idempotent; returns what changed."""
    applied: list[str] = []
    with closing(db_v2.connect(path)) as conn, conn:
        for table, sql in TABLES.items():
            if not _columns(conn, table):
                conn.execute(sql)
                applied.append(f"create {table}")
        for table, cols in ADD_COLUMNS.items():
            have = _columns(conn, table)
            if not have:
                continue
            for name, decl in cols:
                if name not in have:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                    applied.append(f"{table}.{name}")
        for sql in INDEXES:
            conn.execute(sql)
    return applied


_lock = threading.Lock()
_ready: set[str] = set()


def ensure(path: Path | None = None) -> None:
    key = str(path or db_v2.db_path())
    if key in _ready:
        return
    with _lock:
        if key not in _ready:
            db_v2.ensure(path)
            migrate(path)
            _ready.add(key)


now_iso = db_v2.now_iso


# ---- small query helpers ----------------------------------------------------------------------------------------------


def rows(sql: str, args: tuple[Any, ...] | list[Any] = ()) -> list[dict[str, Any]]:
    ensure()
    with closing(db_v2.connect()) as conn:
        return [dict(r) for r in conn.execute(sql, tuple(args)).fetchall()]


def row(sql: str, args: tuple[Any, ...] | list[Any] = ()) -> dict[str, Any] | None:
    ensure()
    with closing(db_v2.connect()) as conn:
        r = conn.execute(sql, tuple(args)).fetchone()
    return dict(r) if r is not None else None


def scalar(sql: str, args: tuple[Any, ...] | list[Any] = (), default: Any = None) -> Any:
    ensure()
    with closing(db_v2.connect()) as conn:
        r = conn.execute(sql, tuple(args)).fetchone()
    return r[0] if r is not None and r[0] is not None else default


def execute(sql: str, args: tuple[Any, ...] | list[Any] = ()) -> int:
    """Run one write in its own transaction; returns the row count."""
    ensure()
    with closing(db_v2.connect()) as conn, conn:
        cur = conn.execute(sql, tuple(args))
    return int(cur.rowcount or 0)


def insert(sql: str, args: tuple[Any, ...] | list[Any] = ()) -> int:
    """Run one INSERT in its own transaction; returns lastrowid."""
    ensure()
    with closing(db_v2.connect()) as conn, conn:
        cur = conn.execute(sql, tuple(args))
    return int(cur.lastrowid or 0)


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """One write transaction (BEGIN IMMEDIATE, so read-then-write steps never race)."""
    ensure()
    conn = db_v2.connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def dumps(x: Any) -> str:
    return json.dumps(x, separators=(",", ":"), ensure_ascii=False)


def loads(s: Any, default: Any = None) -> Any:
    if s is None or s == "":
        return default
    try:
        return json.loads(s)
    except (TypeError, json.JSONDecodeError):
        return default


# ---- meta flags (seed markers) ------------------------------------------------------------------------------------------


def meta_get(key: str) -> str | None:
    v = scalar("SELECT value FROM collab_meta WHERE key = ?", (key,))
    return str(v) if v is not None else None


def meta_claim(key: str, value: str) -> bool:
    """Set a flag once. True only for the caller that set it (so seeds never run twice)."""
    return execute("INSERT OR IGNORE INTO collab_meta (key, value, updated_at) VALUES (?, ?, ?)",
                   (key, value, now_iso())) == 1


# ---- levels (collab writes only listing and order; nothing is deleted) -------------------------------------------------


def set_order_index(level_id: str, order_index: int) -> int:
    """Move a level in its game's sequence: the order_index column and the JSON's order_index, every version."""
    ensure()
    n = 0
    with closing(db_v2.connect()) as conn, conn:
        for r in conn.execute("SELECT version, json FROM levels_v2 WHERE id = ?", (level_id,)).fetchall():
            doc = loads(r["json"])
            if isinstance(doc, dict):
                doc["order_index"] = int(order_index)
                text = dumps(doc)
            else:
                text = r["json"]
            conn.execute("UPDATE levels_v2 SET order_index = ?, json = ? WHERE id = ? AND version = ?",
                         (int(order_index), text, level_id, int(r["version"])))
            n += 1
    return n


def level_game_and_title(level_id: str) -> dict[str, Any] | None:
    """Latest version summary of a level without its JSON: {id, version, game_id, parent_id, title, author, listed,
    safety, order_index}."""
    return row("SELECT id, version, game_id, parent_id, title, author, listed, safety, order_index FROM levels_v2 "
               "WHERE id = ? ORDER BY version DESC LIMIT 1", (level_id,))


def level_plays(level_ids: list[str]) -> dict[str, tuple[int, int]]:
    """{level_id: (plays, clears)} from the attempts table."""
    if not level_ids:
        return {}
    out: dict[str, tuple[int, int]] = {}
    for i in range(0, len(level_ids), 400):
        chunk = level_ids[i:i + 400]
        q = ",".join("?" for _ in chunk)
        for r in rows(f"SELECT level_id, COALESCE(SUM(attempts), 0) AS a, COALESCE(SUM(clears), 0) AS c "
                      f"FROM attempts WHERE level_id IN ({q}) GROUP BY level_id", chunk):
            out[str(r["level_id"])] = (int(r["a"]), int(r["c"]))
    return out
