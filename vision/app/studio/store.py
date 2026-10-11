"""Studio games in SQLite (CONTRACTS_V6 §5.1): table `studio_games`, created by this module's own idempotent
migration through `db_v2.connect()` (db_v2.NEW_TABLES stays untouched, so no other lane's file changes).

    studio_games(id, author, author_id, title, kind, doc_json, published, thumb_png, created_at, updated_at)

The GameDoc is stored whole in `doc_json`; title and kind are copied out for listings. Cards count scenes and objects
with SQLite's JSON functions (a Python fallback when they are missing), so a listing never loads every document into
Python. Timestamps are ISO-8601 UTC with milliseconds so "newest first" is stable within a second.
"""
from __future__ import annotations

import json
import secrets
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import db_v2

ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
LIST_LIMIT = 100

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS studio_games (
        id TEXT PRIMARY KEY, author TEXT, author_id TEXT, title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
        doc_json TEXT NOT NULL, published BOOLEAN NOT NULL DEFAULT 0, thumb_png BLOB, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS ix_studio_games_author ON studio_games (author_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS ix_studio_games_published ON studio_games (published, updated_at)",
]

_lock = threading.Lock()
_ready: set[str] = set()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def migrate(path: Path | None = None) -> None:
    with closing(db_v2.connect(path)) as conn, conn:
        for sql in SCHEMA:
            conn.execute(sql)


def ensure(path: Path | None = None) -> None:
    """Run the migration once per process and database file."""
    key = str(path or db_v2.db_path())
    if key in _ready:
        return
    with _lock:
        if key not in _ready:
            migrate(path)
            _ready.add(key)


def _conn() -> sqlite3.Connection:
    ensure()
    return db_v2.connect()


def new_id() -> str:
    for _ in range(20):
        gid = "sg_" + "".join(secrets.choice(ID_CHARS) for _ in range(12))
        if get_row(gid) is None:
            return gid
    raise RuntimeError("no free studio game id")  # pragma: no cover - 36^12 ids


def kind_of(doc: dict[str, Any]) -> str:
    scenes = doc.get("scenes") or [{}]
    return str((scenes[0].get("world") or {}).get("kind") or "")[:60]


def _dump(doc: dict[str, Any]) -> str:
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False)


def insert(doc: dict[str, Any], *, author: str | None, author_id: str | None, published: bool = False) -> dict[str, Any]:
    with closing(_conn()) as conn, conn:
        conn.execute(
            "INSERT INTO studio_games (id, author, author_id, title, kind, doc_json, published, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (doc["id"], author, author_id, str(doc.get("title") or ""), kind_of(doc), _dump(doc), 1 if published else 0,
             doc.get("created_at") or now_iso(), doc.get("updated_at") or now_iso()))
    return doc


def get_row(game_id: str) -> dict[str, Any] | None:
    """The row without the thumbnail bytes (`has_thumb` instead) and with `doc` parsed."""
    with closing(_conn()) as conn:
        r = conn.execute(
            "SELECT id, author, author_id, title, kind, doc_json, published, created_at, updated_at, "
            "thumb_png IS NOT NULL AS has_thumb FROM studio_games WHERE id = ?", (game_id,)).fetchone()
    if r is None:
        return None
    d = dict(r)
    try:
        d["doc"] = json.loads(d.pop("doc_json"))
    except (json.JSONDecodeError, TypeError):
        d["doc"] = None
    d["published"] = bool(d["published"])
    d["has_thumb"] = bool(d["has_thumb"])
    return d


def update_doc(game_id: str, doc: dict[str, Any]) -> None:
    with closing(_conn()) as conn, conn:
        conn.execute("UPDATE studio_games SET doc_json = ?, title = ?, kind = ?, updated_at = ? WHERE id = ?",
                     (_dump(doc), str(doc.get("title") or ""), kind_of(doc), doc.get("updated_at") or now_iso(),
                      game_id))


def set_published(game_id: str, published: bool) -> None:
    with closing(_conn()) as conn, conn:
        conn.execute("UPDATE studio_games SET published = ? WHERE id = ?", (1 if published else 0, game_id))


def set_thumbnail(game_id: str, png: bytes) -> None:
    with closing(_conn()) as conn, conn:
        conn.execute("UPDATE studio_games SET thumb_png = ? WHERE id = ?", (sqlite3.Binary(png), game_id))


def get_thumbnail(game_id: str) -> bytes | None:
    with closing(_conn()) as conn:
        r = conn.execute("SELECT thumb_png FROM studio_games WHERE id = ?", (game_id,)).fetchone()
    return bytes(r[0]) if r is not None and r[0] is not None else None


_CARD_SQL = (
    "SELECT id, author, title, kind, published, updated_at, thumb_png IS NOT NULL AS has_thumb, "
    "COALESCE(json_extract(doc_json, '$.theme.name'), 'Sketchbook') AS theme_name, "
    "COALESCE(json_array_length(doc_json, '$.scenes'), 0) AS scenes, "
    "COALESCE((SELECT SUM(json_array_length(s.value, '$.objects')) FROM json_each(doc_json, '$.scenes') s), 0) "
    "AS objects FROM studio_games"
)


def _cards_py(conn: sqlite3.Connection, where: str, args: tuple[Any, ...], limit: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        f"SELECT id, author, title, kind, published, updated_at, thumb_png IS NOT NULL AS has_thumb, doc_json "
        f"FROM studio_games WHERE {where} ORDER BY updated_at DESC, rowid DESC LIMIT ?", (*args, limit)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            doc = json.loads(d.pop("doc_json"))
        except (json.JSONDecodeError, TypeError):
            doc = {}
        scenes = doc.get("scenes") or []
        d["theme_name"] = (doc.get("theme") or {}).get("name") or "Sketchbook"
        d["scenes"] = len(scenes)
        d["objects"] = sum(len(s.get("objects") or []) for s in scenes)
        out.append(d)
    return out


def list_cards(*, author_id: str | None = None, published: bool | None = None,
               limit: int = LIST_LIMIT) -> list[dict[str, Any]]:
    """Card rows (no documents), newest first."""
    where, args = [], []
    if author_id is not None:
        where.append("author_id = ?")
        args.append(author_id)
    if published is not None:
        where.append("published = ?")
        args.append(1 if published else 0)
    clause = " AND ".join(where) or "1 = 1"
    lim = max(1, min(LIST_LIMIT, int(limit)))
    with closing(_conn()) as conn:
        try:
            rows = [dict(r) for r in conn.execute(
                f"{_CARD_SQL} WHERE {clause} ORDER BY updated_at DESC, rowid DESC LIMIT ?", (*args, lim)).fetchall()]
        except sqlite3.OperationalError:  # no JSON1 in this SQLite build
            rows = _cards_py(conn, clause, tuple(args), lim)
    for r in rows:
        r["published"] = bool(r["published"])
        r["has_thumb"] = bool(r["has_thumb"])
        r["scenes"] = int(r["scenes"] or 0)
        r["objects"] = int(r["objects"] or 0)
    return rows
