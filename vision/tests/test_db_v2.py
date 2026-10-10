"""Additive SQLite migrations (PLAN_V2 §11.3h): idempotent, v1 tables only gain columns."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from app import db_v2


def test_migrations_are_additive_and_idempotent(tmp_path: Path) -> None:
    db = tmp_path / "dal.sqlite"
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT, author TEXT, created_at TEXT)")
        c.execute("CREATE TABLE levels (id TEXT PRIMARY KEY, json TEXT NOT NULL)")
        c.execute("INSERT INTO levels VALUES ('lvl_1', '{}')")
    first = db_v2.migrate(db)
    assert "create model_calls" in first and "levels.json_v2" in first and "games.rules_json" in first
    assert db_v2.migrate(db) == []
    with sqlite3.connect(db) as c:
        assert c.execute("SELECT format FROM levels WHERE id = 'lvl_1'").fetchone()[0] == 1
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"packs", "object_types", "runs", "attempts", "builds", "model_calls"} <= tables
