"""SQLite v2: additive, idempotent migrations run at startup, plus the v2 persistence helpers (PLAN_V2 §11.3h).

v1 tables are untouched apart from added nullable columns, so the running v1 code keeps working. New tables:
packs, object_types, runs, attempts, builds, model_calls, and levels_v2.

`levels_v2` (deviation from §11.3h, see docs/v2/requests/D-1.md): published v2 levels are versioned
(`GET /levels/{id}?version=`), and v1's `levels.id` is a primary key, so it cannot hold version history. A v2 row in
v1's `levels` table would also be read by v1's home feed and tree as a v1 level and break the live v1 UI. v2 games
live in `games` with `format = 2` (v1 shows them as games with no levels). v1 levels migrated in P4 keep using
`levels.json_v2`; the read helpers fall back to it.

Uses sqlite3 directly (no ORM) so v1's SQLModel metadata never sees v2 tables.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.config import get_settings

ADD_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "games": [("rules_json", "TEXT"), ("format", "INTEGER")],
    "levels": [
        ("format", "INTEGER DEFAULT 1"), ("version", "INTEGER"), ("json_v2", "TEXT"), ("level_hash", "TEXT"),
        ("c_casual", "REAL"), ("score", "INTEGER"), ("band", "TEXT"), ("screens", "INTEGER"), ("verified", "BOOLEAN"),
        ("safety", "TEXT"), ("par_ms", "INTEGER"), ("fastest_ms", "INTEGER"),
    ],
    "builds": [("first_seq", "INTEGER")],
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
        finished_at TEXT, final_stage TEXT, cost_usd REAL NOT NULL DEFAULT 0, first_seq INTEGER)""",
    "model_calls": """CREATE TABLE IF NOT EXISTS model_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, draft_id TEXT, kind TEXT NOT NULL, effort TEXT, latency_ms INTEGER,
        in_tok INTEGER, out_tok INTEGER, cache_read_tok INTEGER, cost_usd REAL NOT NULL DEFAULT 0, stop_reason TEXT,
        served_by TEXT, fallback_used BOOLEAN, ok BOOLEAN, request_id TEXT, created_at TEXT NOT NULL)""",
    "levels_v2": """CREATE TABLE IF NOT EXISTS levels_v2 (
        id TEXT NOT NULL, version INTEGER NOT NULL, game_id TEXT, parent_id TEXT, parent_version INTEGER,
        order_index INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, author TEXT NOT NULL, json TEXT NOT NULL,
        level_hash TEXT NOT NULL, c_casual REAL, score INTEGER, band TEXT, screens INTEGER, verified BOOLEAN,
        safety TEXT NOT NULL DEFAULT 'unchecked', listed BOOLEAN NOT NULL DEFAULT 1, par_ms INTEGER,
        fastest_ms INTEGER, changed_json TEXT, draft_id TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (id, version))""",
    # v4 (docs/v4/CONTRACTS_V4.md §6): public blocks (immutable per version), who uses them, and the drafts a
    # profile started (the workspace dashboard lists the unpublished ones)
    "blocks": """CREATE TABLE IF NOT EXISTS blocks (
        id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        author TEXT NOT NULL, author_id TEXT, listed BOOLEAN NOT NULL DEFAULT 1,
        safety TEXT NOT NULL DEFAULT 'unchecked', search TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        PRIMARY KEY (id, version))""",
    "block_uses": """CREATE TABLE IF NOT EXISTS block_uses (
        block_id TEXT NOT NULL, version INTEGER NOT NULL, game_id TEXT NOT NULL, type_id TEXT, kind TEXT NOT NULL,
        player_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY (block_id, version, game_id))""",
    "drafts": """CREATE TABLE IF NOT EXISTS drafts (
        draft_id TEXT PRIMARY KEY, player_id TEXT, game_id TEXT, kind TEXT NOT NULL, title TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
}

INDEXES = [
    "CREATE INDEX IF NOT EXISTS ix_runs_level ON runs (level_id, board, frames)",
    "CREATE INDEX IF NOT EXISTS ix_builds_draft ON builds (draft_id)",
    "CREATE INDEX IF NOT EXISTS ix_model_calls_created ON model_calls (created_at)",
    "CREATE INDEX IF NOT EXISTS ix_model_calls_draft ON model_calls (draft_id)",
    "CREATE INDEX IF NOT EXISTS ix_object_types_game ON object_types (game_id)",
    "CREATE INDEX IF NOT EXISTS ix_levels_v2_game ON levels_v2 (game_id)",
    "CREATE INDEX IF NOT EXISTS ix_levels_v2_parent ON levels_v2 (parent_id)",
    "CREATE INDEX IF NOT EXISTS ix_levels_v2_draft ON levels_v2 (draft_id)",
    "CREATE INDEX IF NOT EXISTS ix_blocks_author ON blocks (author_id)",
    "CREATE INDEX IF NOT EXISTS ix_block_uses_game ON block_uses (game_id)",
    "CREATE INDEX IF NOT EXISTS ix_drafts_player ON drafts (player_id, updated_at)",
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
        for table, cols in ADD_COLUMNS.items():
            have = _columns(conn, table)
            if not have:  # v1 creates its tables on first use; the next startup adds the columns
                continue
            for name, decl in cols:
                if name not in have:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                    applied.append(f"{table}.{name}")
        for sql in INDEXES:
            conn.execute(sql)
    return applied


_ready_lock = threading.Lock()
_ready_paths: set[str] = set()


def ensure(path: Path | None = None) -> None:
    """Run `migrate` once per process and database file (the routers call it lazily, so a v2 module saved while
    uvicorn is running never depends on the lifespan having run with the new tables)."""
    key = str(path or db_path())
    if key in _ready_paths:
        return
    with _ready_lock:
        if key not in _ready_paths:
            migrate(path)
            _ready_paths.add(key)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _row(r: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(r) if r is not None else None


# ---- builds -------------------------------------------------------------------------------------


def insert_build(build_id: str, draft_id: str, kind: str, first_seq: int) -> None:
    ensure()
    with closing(connect()) as conn, conn:
        conn.execute(
            "INSERT INTO builds (id, draft_id, kind, started_at, first_seq) VALUES (?, ?, ?, ?, ?)",
            (build_id, draft_id, kind, now_iso(), first_seq),
        )


def finish_build(build_id: str, final_stage: str, cost_usd: float) -> None:
    ensure()
    with closing(connect()) as conn, conn:
        conn.execute(
            "UPDATE builds SET finished_at = ?, final_stage = ?, cost_usd = ? WHERE id = ?",
            (now_iso(), final_stage, round(cost_usd, 5), build_id),
        )


def get_build(build_id: str) -> dict[str, Any] | None:
    ensure()
    with closing(connect()) as conn:
        return _row(conn.execute("SELECT * FROM builds WHERE id = ?", (build_id,)).fetchone())


def builds_of_draft(draft_id: str) -> list[dict[str, Any]]:
    ensure()
    with closing(connect()) as conn:
        rows = conn.execute("SELECT * FROM builds WHERE draft_id = ? ORDER BY started_at, id", (draft_id,)).fetchall()
    return [dict(r) for r in rows]


# ---- games --------------------------------------------------------------------------------------


def create_game(game_id: str, title: str, author: str, rules: dict[str, Any]) -> dict[str, Any]:
    ensure()
    created = now_iso()
    with closing(connect()) as conn, conn:
        conn.execute(
            "INSERT INTO games (id, title, author, created_at, rules_json, format) VALUES (?, ?, ?, ?, ?, 2)",
            (game_id, title, author, created, json.dumps(rules, separators=(",", ":"))),
        )
    return {"id": game_id, "title": title, "author": author, "created_at": created, "rules": rules, "format": 2}


def get_game(game_id: str) -> dict[str, Any] | None:
    ensure()
    with closing(connect()) as conn:
        r = conn.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
    if r is None:
        return None
    g = dict(r)
    rules = None
    if g.get("rules_json"):
        try:
            rules = json.loads(g["rules_json"])
        except json.JSONDecodeError:
            rules = None
    return {"id": g["id"], "title": g["title"], "author": g["author"], "created_at": g["created_at"],
            "rules": rules, "format": g.get("format") or 1}


def list_games_v2() -> list[dict[str, Any]]:
    ensure()
    with closing(connect()) as conn:
        rows = conn.execute("SELECT * FROM games WHERE format = 2 ORDER BY created_at DESC, id").fetchall()
    out = []
    for r in rows:
        g = dict(r)
        try:
            rules = json.loads(g["rules_json"]) if g.get("rules_json") else None
        except json.JSONDecodeError:
            rules = None
        out.append({"id": g["id"], "title": g["title"], "author": g["author"], "created_at": g["created_at"],
                    "rules": rules, "format": 2})
    return out


# ---- levels -------------------------------------------------------------------------------------

_LEVEL_SUMMARY_COLS = (
    "id, version, game_id, parent_id, parent_version, order_index, title, author, level_hash, c_casual, score, band, "
    "screens, verified, safety, listed, par_ms, fastest_ms, changed_json, draft_id, created_at"
)


def insert_level(row: dict[str, Any]) -> None:
    ensure()
    cols = ("id", "version", "game_id", "parent_id", "parent_version", "order_index", "title", "author", "json",
            "level_hash", "c_casual", "score", "band", "screens", "verified", "safety", "listed", "par_ms",
            "fastest_ms", "changed_json", "draft_id", "created_at")
    with closing(connect()) as conn, conn:
        conn.execute(
            f"INSERT INTO levels_v2 ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
            tuple(row.get(c) for c in cols),
        )


def next_level_version(level_id: str) -> int:
    ensure()
    with closing(connect()) as conn:
        r = conn.execute("SELECT MAX(version) FROM levels_v2 WHERE id = ?", (level_id,)).fetchone()
    return int(r[0] or 0) + 1


def get_level_row(level_id: str, version: int | None = None) -> dict[str, Any] | None:
    """The stored v2 level (latest version unless `version`), with `json` parsed into `level`. Falls back to a
    migrated v1 row (`levels.json_v2`)."""
    ensure()
    with closing(connect()) as conn:
        if version is None:
            r = conn.execute("SELECT * FROM levels_v2 WHERE id = ? ORDER BY version DESC LIMIT 1", (level_id,)).fetchone()
        else:
            r = conn.execute("SELECT * FROM levels_v2 WHERE id = ? AND version = ?", (level_id, version)).fetchone()
        if r is None:
            cols = _columns(conn, "levels")
            if "json_v2" in cols:
                m = conn.execute(
                    "SELECT id, game_id, parent_id, order_index, title, author, json_v2, level_hash, c_casual, score, "
                    "band, screens, verified, safety, par_ms, fastest_ms, created_at, version FROM levels "
                    "WHERE id = ? AND json_v2 IS NOT NULL", (level_id,)).fetchone()
                if m is not None and (version is None or int(m["version"] or 1) == version):
                    d = dict(m)
                    d["json"] = d.pop("json_v2")
                    d["version"] = int(d.get("version") or 1)
                    d["listed"] = 1
                    d["parent_version"] = None
                    d["changed_json"] = None
                    d["draft_id"] = None
                    return _with_level(d)
            return None
    return _with_level(dict(r))


def _with_level(d: dict[str, Any]) -> dict[str, Any]:
    try:
        d["level"] = json.loads(d.pop("json"))
    except (json.JSONDecodeError, TypeError):
        d["level"] = None
    try:
        d["changed"] = json.loads(d.pop("changed_json")) if d.get("changed_json") else None
    except json.JSONDecodeError:
        d["changed"] = None
    d.pop("changed_json", None)
    return d


def level_versions(level_id: str) -> list[int]:
    ensure()
    with closing(connect()) as conn:
        rows = conn.execute("SELECT version FROM levels_v2 WHERE id = ? ORDER BY version", (level_id,)).fetchall()
    return [int(r[0]) for r in rows]


def latest_level_summaries(*, game_id: str | None = None, parent_id: str | None = None,
                           listed_only: bool = True, no_game: bool = False) -> list[dict[str, Any]]:
    """Latest version of each level (no `json`), filtered by game or parent (`no_game`: levels outside any game)."""
    ensure()
    where, args = [], []
    if game_id is not None:
        where.append("l.game_id = ?")
        args.append(game_id)
    if no_game:
        where.append("l.game_id IS NULL")
    if parent_id is not None:
        where.append("l.parent_id = ?")
        args.append(parent_id)
    if listed_only:
        where.append("l.listed = 1")
    clause = (" AND " + " AND ".join(where)) if where else ""
    sql = (f"SELECT {', '.join('l.' + c.strip() for c in _LEVEL_SUMMARY_COLS.split(','))} FROM levels_v2 l "
           "WHERE l.version = (SELECT MAX(version) FROM levels_v2 x WHERE x.id = l.id)" + clause +
           " ORDER BY l.order_index, l.created_at, l.id")
    with closing(connect()) as conn:
        rows = conn.execute(sql, tuple(args)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["changed"] = json.loads(d.pop("changed_json")) if d.get("changed_json") else None
        except json.JSONDecodeError:
            d["changed"] = None
        d.pop("changed_json", None)
        out.append(d)
    return out


def children_ids(level_id: str) -> list[str]:
    ensure()
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT DISTINCT id FROM levels_v2 WHERE parent_id = ? AND id != ? ORDER BY created_at, id",
            (level_id, level_id),
        ).fetchall()
    return [str(r[0]) for r in rows]


def count_sequence(game_id: str) -> int:
    """Number of levels in a game's playable sequence (remixes of a level in the same game hang under it)."""
    rows = latest_level_summaries(game_id=game_id, listed_only=False)
    ids = {r["id"] for r in rows}
    return sum(1 for r in rows if r["parent_id"] is None or r["parent_id"] not in ids)


# ---- stats --------------------------------------------------------------------------------------


def level_stats(level_id: str) -> dict[str, Any]:
    ensure()
    with closing(connect()) as conn:
        a = conn.execute(
            "SELECT COALESCE(SUM(attempts), 0), COALESCE(SUM(clears), 0) FROM attempts WHERE level_id = ?", (level_id,)
        ).fetchone()
        best = conn.execute(
            "SELECT MIN(frames) FROM runs WHERE level_id = ? AND verified = 1", (level_id,)
        ).fetchone()
    plays, clears = int(a[0]), int(a[1])
    frames = best[0]
    return {"plays": plays, "clears": clears, "clear_rate": round(clears / plays, 4) if plays else None,
            "best": int(round(frames * 1000 / 60)) if frames is not None else None}


def game_activity(game_id: str, since_days: int = 7) -> dict[str, float]:
    """Plays and clears over all levels of a game; `recent_plays` over the last `since_days` days (the hot sort)."""
    ensure()
    since = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%Y-%m-%d")
    with closing(connect()) as conn:
        r = conn.execute(
            "SELECT COALESCE(SUM(a.attempts), 0), COALESCE(SUM(a.clears), 0), "
            "COALESCE(SUM(CASE WHEN a.day >= ? THEN a.attempts ELSE 0 END), 0) "
            "FROM attempts a WHERE a.level_id IN (SELECT DISTINCT id FROM levels_v2 WHERE game_id = ?)",
            (since, game_id),
        ).fetchone()
    return {"plays": float(r[0]), "clears": float(r[1]), "recent_plays": float(r[2])}


# ---- runs and attempts (§8.4) -------------------------------------------------------------------


def insert_run(row: dict[str, Any]) -> None:
    ensure()
    cols = ("id", "level_id", "level_version", "level_hash", "player", "frames", "deaths", "coins", "big_coins",
            "board", "replay", "verified", "created_at")
    with closing(connect()) as conn, conn:
        conn.execute(f"INSERT INTO runs ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                     tuple(row.get(c) for c in cols))


def get_run(run_id: str) -> dict[str, Any] | None:
    ensure()
    with closing(connect()) as conn:
        return _row(conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone())


def board_runs(level_id: str, board: str = "any", limit: int = 10, version: int | None = None) -> list[dict[str, Any]]:
    """Verified runs, each player's best (fewest frames, then fewest deaths, then earliest), fastest first.
    `any` includes collector runs; `collector` only runs that banked every big coin."""
    ensure()
    where = ["level_id = ?", "verified = 1"]
    args: list[Any] = [level_id]
    if board == "collector":
        where.append("board = 'collector'")
    if version is not None:
        where.append("level_version = ?")
        args.append(version)
    sql = (f"SELECT * FROM runs WHERE {' AND '.join(where)} ORDER BY frames, deaths, created_at, id")
    with closing(connect()) as conn:
        rows = [dict(r) for r in conn.execute(sql, tuple(args)).fetchall()]
    best: dict[str, dict[str, Any]] = {}
    for r in rows:
        best.setdefault(str(r["player"]).lower(), r)
    out = sorted(best.values(), key=lambda r: (int(r["frames"]), int(r["deaths"]), str(r["created_at"]), str(r["id"])))
    return out[: max(1, min(100, limit))]


def player_best_frames(level_id: str, player: str, *, exclude: str | None = None) -> int | None:
    ensure()
    with closing(connect()) as conn:
        r = conn.execute(
            "SELECT MIN(frames) FROM runs WHERE level_id = ? AND verified = 1 AND lower(player) = lower(?) AND id != ?",
            (level_id, player, exclude or ""),
        ).fetchone()
    return int(r[0]) if r and r[0] is not None else None


def add_attempts(level_id: str, attempts: int, deaths: int, clears: int) -> None:
    ensure()
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with closing(connect()) as conn, conn:
        conn.execute(
            "INSERT INTO attempts (level_id, day, attempts, deaths, clears) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(level_id, day) DO UPDATE SET attempts = attempts + excluded.attempts, "
            "deaths = deaths + excluded.deaths, clears = clears + excluded.clears",
            (level_id, day, attempts, deaths, clears),
        )


# ---- games: rules (§8.2) ----------------------------------------------------------------------------------------


def set_game_rules(game_id: str, rules: dict[str, Any]) -> None:
    ensure()
    with closing(connect()) as conn, conn:
        conn.execute("UPDATE games SET rules_json = ? WHERE id = ?",
                     (json.dumps(rules, separators=(",", ":")), game_id))


def ensure_game(game_id: str, title: str, author: str, rules: dict[str, Any], created_at: str) -> bool:
    """Create a v2 game with a fixed id (seeds). Returns True when it was created."""
    ensure()
    with closing(connect()) as conn, conn:
        if conn.execute("SELECT 1 FROM games WHERE id = ?", (game_id,)).fetchone() is not None:
            return False
        conn.execute(
            "INSERT INTO games (id, title, author, created_at, rules_json, format) VALUES (?, ?, ?, ?, ?, 2)",
            (game_id, title, author, created_at, json.dumps(rules, separators=(",", ":"))),
        )
    return True


def game_level_rows(game_id: str, *, listed_only: bool = False) -> list[dict[str, Any]]:
    """Latest version of every level of a game, with the level JSON parsed (rules check, export)."""
    out = []
    for s in latest_level_summaries(game_id=game_id, listed_only=listed_only):
        full = get_level_row(s["id"], int(s["version"]))
        if full is not None and full.get("level") is not None:
            out.append(full)
    return out


# ---- levels: safety, versions, existence ----------------------------------------------------------------------


def set_level_safety(level_id: str, safety: str, listed: bool, version: int | None = None) -> int:
    """Update the stored safety of a level (every version unless `version`); also patches meta.safety in the JSON."""
    ensure()
    with closing(connect()) as conn, conn:
        if version is None:
            rows = conn.execute("SELECT version, json FROM levels_v2 WHERE id = ?", (level_id,)).fetchall()
        else:
            rows = conn.execute("SELECT version, json FROM levels_v2 WHERE id = ? AND version = ?",
                                (level_id, version)).fetchall()
        for r in rows:
            try:
                doc = json.loads(r["json"])
                doc.setdefault("meta", {})["safety"] = safety
                text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
            except (json.JSONDecodeError, AttributeError):
                text = r["json"]
            conn.execute("UPDATE levels_v2 SET safety = ?, listed = ?, json = ? WHERE id = ? AND version = ?",
                         (safety, 1 if listed else 0, text, level_id, int(r["version"])))
    return len(rows)


def level_rows_all_versions(level_id: str) -> list[dict[str, Any]]:
    ensure()
    with closing(connect()) as conn:
        rows = conn.execute("SELECT * FROM levels_v2 WHERE id = ? ORDER BY version", (level_id,)).fetchall()
    return [_with_level(dict(r)) for r in rows]


def level_listed(level_id: str) -> bool:
    """Is the latest version of the level listed (shown in feeds and game sequences)?"""
    ensure()
    with closing(connect()) as conn:
        r = conn.execute("SELECT listed FROM levels_v2 WHERE id = ? ORDER BY version DESC LIMIT 1", (level_id,)).fetchone()
    return bool(r is not None and r[0])


def set_level_listed(level_id: str, listed: bool) -> int:
    """List or unlist every version of a level (seeds retire levels they no longer ship; nothing is deleted)."""
    ensure()
    with closing(connect()) as conn, conn:
        cur = conn.execute("UPDATE levels_v2 SET listed = ? WHERE id = ?", (1 if listed else 0, level_id))
    return int(cur.rowcount or 0)


def retire_level(level_id: str) -> int:
    """Take a seeded level out of its game: unlisted and detached (game_id NULL) on every version. Nothing is
    deleted; its runs and versions stay readable by id."""
    ensure()
    with closing(connect()) as conn, conn:
        cur = conn.execute("UPDATE levels_v2 SET listed = 0, game_id = NULL WHERE id = ?", (level_id,))
    return int(cur.rowcount or 0)


def level_id_taken(level_id: str) -> bool:
    ensure()
    with closing(connect()) as conn:
        if conn.execute("SELECT 1 FROM levels_v2 WHERE id = ? LIMIT 1", (level_id,)).fetchone() is not None:
            return True
        return conn.execute("SELECT 1 FROM levels WHERE id = ? LIMIT 1", (level_id,)).fetchone() is not None


def latest_level_hash(level_id: str) -> str | None:
    ensure()
    with closing(connect()) as conn:
        r = conn.execute("SELECT level_hash FROM levels_v2 WHERE id = ? ORDER BY version DESC LIMIT 1",
                         (level_id,)).fetchone()
    return str(r[0]) if r is not None else None


def latest_version(level_id: str) -> int | None:
    vs = level_versions(level_id)
    return vs[-1] if vs else None


# ---- runs: creator's best (§8.4) ---------------------------------------------------------------------------------


def best_run_of(level_id: str, player: str) -> dict[str, Any] | None:
    ensure()
    with closing(connect()) as conn:
        return _row(conn.execute(
            "SELECT * FROM runs WHERE level_id = ? AND verified = 1 AND lower(player) = lower(?) "
            "ORDER BY frames, deaths, created_at LIMIT 1", (level_id, player)).fetchone())


# ---- packs (§6.4) -------------------------------------------------------------------------------------------------


def insert_pack(pack_id: str, kind: str, k: int, game_id: str | None, parent_id: str | None) -> dict[str, Any]:
    ensure()
    created = now_iso()
    with closing(connect()) as conn, conn:
        conn.execute(
            "INSERT INTO packs (id, kind, k, game_id, parent_id, sheets_json, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?)",
            (pack_id, kind, k, game_id, parent_id, created),
        )
    return {"id": pack_id, "kind": kind, "k": k, "game_id": game_id, "parent_id": parent_id, "sheets": [],
            "created_at": created}


def get_pack(pack_id: str) -> dict[str, Any] | None:
    ensure()
    with closing(connect()) as conn:
        r = conn.execute("SELECT * FROM packs WHERE id = ?", (pack_id,)).fetchone()
    if r is None:
        return None
    d = dict(r)
    try:
        d["sheets"] = json.loads(d.pop("sheets_json") or "[]")
    except json.JSONDecodeError:
        d["sheets"] = []
    return d


def record_pack_sheets(pack_id: str, sheets: list[dict[str, Any]]) -> None:
    """Merge scanned sheets into the pack record: per sheet number the newest scan wins (the pack tray checklist)."""
    ensure()
    with closing(connect()) as conn, conn:
        r = conn.execute("SELECT sheets_json FROM packs WHERE id = ?", (pack_id,)).fetchone()
        if r is None:
            return
        try:
            have = {int(s["n"]): s for s in json.loads(r[0] or "[]") if isinstance(s, dict) and "n" in s}
        except (json.JSONDecodeError, TypeError, ValueError):
            have = {}
        for s in sheets:
            have[int(s["n"])] = s
        conn.execute("UPDATE packs SET sheets_json = ? WHERE id = ?",
                     (json.dumps([have[n] for n in sorted(have)], separators=(",", ":")), pack_id))


# ---- object library (§8.1) ------------------------------------------------------------------------------------------


def library_latest(game_id: str) -> list[dict[str, Any]]:
    """The latest version of every type of a game (levels pin their own versions)."""
    ensure()
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT t.json FROM object_types t WHERE t.game_id = ? AND t.version = "
            "(SELECT MAX(version) FROM object_types x WHERE x.id = t.id) ORDER BY t.created_at, t.id", (game_id,)).fetchall()
    out = []
    for r in rows:
        try:
            out.append(json.loads(r[0]))
        except json.JSONDecodeError:
            continue
    return out


def library_all_versions(game_id: str) -> list[dict[str, Any]]:
    ensure()
    with closing(connect()) as conn:
        rows = conn.execute("SELECT json FROM object_types WHERE game_id = ? ORDER BY id, version", (game_id,)).fetchall()
    out = []
    for r in rows:
        try:
            out.append(json.loads(r[0]))
        except json.JSONDecodeError:
            continue
    return out


def get_type(type_id: str, version: int | None = None) -> dict[str, Any] | None:
    ensure()
    with closing(connect()) as conn:
        if version is None:
            r = conn.execute("SELECT json FROM object_types WHERE id = ? ORDER BY version DESC LIMIT 1", (type_id,)).fetchone()
        else:
            r = conn.execute("SELECT json FROM object_types WHERE id = ? AND version = ?", (type_id, version)).fetchone()
    if r is None:
        return None
    try:
        return json.loads(r[0])
    except json.JSONDecodeError:
        return None


def type_versions(type_id: str) -> list[int]:
    ensure()
    with closing(connect()) as conn:
        rows = conn.execute("SELECT version FROM object_types WHERE id = ? ORDER BY version", (type_id,)).fetchall()
    return [int(r[0]) for r in rows]


def type_owner(type_id: str) -> str | None:
    ensure()
    with closing(connect()) as conn:
        r = conn.execute("SELECT game_id FROM object_types WHERE id = ? LIMIT 1", (type_id,)).fetchone()
    return str(r[0]) if r is not None else None


def insert_type(doc: dict[str, Any]) -> dict[str, Any]:
    """Insert one immutable version; the version number is assigned here (max + 1) under the write transaction."""
    ensure()
    with closing(connect()) as conn, conn:
        r = conn.execute("SELECT MAX(version) FROM object_types WHERE id = ?", (doc["id"],)).fetchone()
        doc = dict(doc)
        doc["version"] = int((r[0] if r is not None else 0) or 0) + 1
        conn.execute(
            "INSERT INTO object_types (id, game_id, version, json, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (doc["id"], doc["game_id"], doc["version"], json.dumps(doc, separators=(",", ":"), ensure_ascii=False),
             doc.get("author"), doc.get("created_at") or now_iso()),
        )
    return doc


# ---- v1 levels (boot migration, §2.6) ------------------------------------------------------------------------------


def v1_level_rows(*, missing_v2_only: bool = True) -> list[dict[str, Any]]:
    """v1 rows of the shared `levels` table (json = the v1 level, kept untouched)."""
    ensure()
    with closing(connect()) as conn:
        if "json_v2" not in _columns(conn, "levels"):
            return []
        sql = ("SELECT * FROM levels" + (" WHERE json_v2 IS NULL" if missing_v2_only else "")
               + " ORDER BY order_index, created_at, id")
        return [dict(r) for r in conn.execute(sql).fetchall()]


def set_level_json_v2(level_id: str, level: dict[str, Any], *, level_hash_: str, report: dict[str, Any] | None) -> None:
    """Store a migrated level next to its v1 JSON (levels.json_v2 and the v2 summary columns)."""
    ensure()
    rep = report or {}
    with closing(connect()) as conn, conn:
        conn.execute(
            "UPDATE levels SET json_v2 = ?, version = ?, level_hash = ?, c_casual = ?, score = ?, band = ?, screens = ?, "
            "verified = ?, safety = COALESCE(safety, 'unchecked'), par_ms = ?, fastest_ms = ? WHERE id = ?",
            (json.dumps(level, separators=(",", ":"), ensure_ascii=False), int(level.get("version") or 1), level_hash_,
             rep.get("C"), rep.get("score"), rep.get("band"), int((level.get("world") or {}).get("screens") or 1),
             1 if rep.get("solvable") else (0 if rep else None), rep.get("par_ms"), rep.get("fastest_ms"), level_id),
        )


# ---- v4: public blocks (docs/v4/CONTRACTS_V4.md §6) -----------------------------------------------------------------
# One row per immutable version. `search` is the lowercased name, description and tags (the library's search box).

_BLOCK_CARD_SQL = (
    "SELECT b.json, b.listed, (SELECT COUNT(DISTINCT u.game_id) FROM block_uses u WHERE u.block_id = b.id) AS uses, "
    "(SELECT COUNT(*) FROM blocks v WHERE v.id = b.id) AS versions FROM blocks b"
)


def _card(r: sqlite3.Row) -> dict[str, Any] | None:
    try:
        doc = json.loads(r["json"])
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(doc, dict):
        return None
    return {**doc, "uses": int(r["uses"] or 0), "versions": int(r["versions"] or 1)}


def insert_block(doc: dict[str, Any], *, listed: bool = True, safety: str = "unchecked") -> dict[str, Any]:
    """Insert one immutable block version; the version number is assigned here (max + 1) under the write
    transaction, so two saves of the same block never collide."""
    ensure()
    with closing(connect()) as conn, conn:
        r = conn.execute("SELECT MAX(version) FROM blocks WHERE id = ?", (doc["id"],)).fetchone()
        doc = dict(doc)
        doc["version"] = int((r[0] if r is not None else 0) or 0) + 1
        search = " ".join([str(doc.get("name") or ""), str(doc.get("description") or ""),
                           " ".join(str(t) for t in doc.get("tags") or [])]).lower()
        conn.execute(
            "INSERT INTO blocks (id, version, json, name, kind, author, author_id, listed, safety, search, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (doc["id"], doc["version"], json.dumps(doc, separators=(",", ":"), ensure_ascii=False), doc["name"],
             doc["kind"], doc["author"], doc.get("author_id"), 1 if listed else 0, safety, search,
             doc.get("created_at") or now_iso()),
        )
    return doc


def get_block(block_id: str, version: int | None = None) -> dict[str, Any] | None:
    """A block version as a BlockCard dict (newest version unless `version`), with uses and versions counted."""
    ensure()
    with closing(connect()) as conn:
        if version is None:
            r = conn.execute(f"{_BLOCK_CARD_SQL} WHERE b.id = ? ORDER BY b.version DESC LIMIT 1", (block_id,)).fetchone()
        else:
            r = conn.execute(f"{_BLOCK_CARD_SQL} WHERE b.id = ? AND b.version = ?", (block_id, version)).fetchone()
    return _card(r) if r is not None else None


def block_id_taken(block_id: str) -> bool:
    ensure()
    with closing(connect()) as conn:
        return conn.execute("SELECT 1 FROM blocks WHERE id = ? LIMIT 1", (block_id,)).fetchone() is not None


def list_blocks(*, q: str | None = None, kind: str | None = None, author_id: str | None = None, sort: str = "new",
                limit: int = 24, offset: int = 0, include_unlisted: bool = False) -> tuple[list[dict[str, Any]], int]:
    """(cards, total): the newest version of every matching block. `popular` = games that use it, then newest."""
    ensure()
    where = ["b.version = (SELECT MAX(version) FROM blocks x WHERE x.id = b.id)"]
    args: list[Any] = []
    if not include_unlisted:
        where.append("b.listed = 1")
    if kind:
        where.append("b.kind = ?")
        args.append(kind)
    if author_id:
        where.append("b.author_id = ?")
        args.append(author_id)
    for word in (q or "").lower().split()[:6]:
        esc = word.replace("!", "!!").replace("%", "!%").replace("_", "!_")
        where.append("b.search LIKE ? ESCAPE '!'")
        args.append(f"%{esc}%")
    clause = " WHERE " + " AND ".join(where)
    order = " ORDER BY uses DESC, b.created_at DESC, b.id" if sort == "popular" else " ORDER BY b.created_at DESC, b.id"
    with closing(connect()) as conn:
        total = int(conn.execute(f"SELECT COUNT(*) FROM blocks b{clause}", tuple(args)).fetchone()[0])
        rows = conn.execute(f"{_BLOCK_CARD_SQL}{clause}{order} LIMIT ? OFFSET ?",
                            (*args, max(1, int(limit)), max(0, int(offset)))).fetchall()
    return [c for c in (_card(r) for r in rows) if c is not None], total


def record_block_use(block_id: str, version: int, game_id: str, *, type_id: str | None, kind: str,
                     player_id: str | None) -> bool:
    """One row per (block version, game). True when this game had not used this version before."""
    ensure()
    with closing(connect()) as conn, conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO block_uses (block_id, version, game_id, type_id, kind, player_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)", (block_id, int(version), game_id, type_id, kind, player_id, now_iso()))
    return int(cur.rowcount or 0) == 1


# ---- v4: drafts a profile started (the dashboard's "keep going" list) ------------------------------------------------


def record_draft(draft_id: str, *, player_id: str | None, game_id: str | None, kind: str, title: str | None) -> None:
    ensure()
    now = now_iso()
    with closing(connect()) as conn, conn:
        conn.execute(
            "INSERT INTO drafts (draft_id, player_id, game_id, kind, title, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(draft_id) DO UPDATE SET updated_at = excluded.updated_at, "
            "title = COALESCE(excluded.title, drafts.title), game_id = COALESCE(excluded.game_id, drafts.game_id), "
            "player_id = COALESCE(drafts.player_id, excluded.player_id)",
            (draft_id, player_id, game_id, kind, title, now, now),
        )


def unpublished_drafts(player_id: str, limit: int = 20) -> list[dict[str, Any]]:
    """The profile's drafts that never became a published level, newest first."""
    ensure()
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT d.* FROM drafts d WHERE d.player_id = ? AND NOT EXISTS "
            "(SELECT 1 FROM levels_v2 l WHERE l.draft_id = d.draft_id) ORDER BY d.updated_at DESC, d.draft_id LIMIT ?",
            (player_id, max(1, int(limit)))).fetchall()
    return [dict(r) for r in rows]
