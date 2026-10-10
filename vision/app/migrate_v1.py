"""Boot migration of v1 levels to dal-level v2 (PLAN_V2 §2.6). Idempotent; runs in the background after the core
worker pool starts, so v1 and the v2 API are serving while it works.

For every row of v1's `levels` table that has no `json_v2` yet:
    1. the core worker's `migrate_v1` converts the v1 JSON (exact tile copy, faced spike strips, typed entities,
       zero-length mover paths dropped with a warning, patrolling enemies as horizontal flyers under `v1-classic`,
       terrain re-synthesized as `migrated` ink so the level can be remixed in the v2 editor);
    2. the result must validate as LevelV2;
    3. the bot (fast `analyze`) measures it, for the feed's band badge, par and the `verified` flag;
    4. `levels.json_v2` and the v2 summary columns are written. The v1 JSON in `levels.json` is never touched, so v1
       keeps serving the same level.

A v1 row whose migration fails stays un-migrated and is retried on the next boot (the reason is logged). The v1
Starter World becomes the v2 game "Classic Starter" in `seed_v2`.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from app import db_v2
from app.build.bridge import CoreError, CorePool, get_pool
from app.build.levels_io import validate
from app.spec.level import level_hash

log = logging.getLogger("dal.v2.migrate")

MIGRATE_TIMEOUT_S = 4.0
ANALYZE_TIMEOUT_S = 12.0


async def migrate_one(pool: CorePool, row: dict[str, Any]) -> dict[str, Any] | None:
    """The v2 level for one v1 row (None when it cannot be migrated). Raises CoreError('down')."""
    try:
        v1 = json.loads(row["json"])
    except (TypeError, json.JSONDecodeError):
        log.warning("v1 level %s: unreadable JSON", row.get("id"))
        return None
    try:
        res = await pool.call("migrate_v1", {"level": v1}, MIGRATE_TIMEOUT_S)
    except CoreError as e:
        if e.code == "down":
            raise
        log.warning("v1 level %s: migrate_v1 failed (%s)", row.get("id"), e)
        return None
    level = (res or {}).get("level") if isinstance(res, dict) else None
    if not isinstance(level, dict):
        return None
    # the row is the truth for what v1 shows (title or order edits after the JSON was written)
    for k in ("id", "game_id", "parent_id", "title", "author", "created_at"):
        if row.get(k) is not None:
            level[k] = row[k]
    level["order_index"] = int(row.get("order_index") or 0)
    meta = dict(level.get("meta") or {})
    meta["level_hash"] = level_hash(level)
    level["meta"] = meta
    errors = validate(level)
    if errors:
        log.warning("v1 level %s: migrated level is invalid: %s", row.get("id"), errors[:2])
        return None
    return level


async def analyze(pool: CorePool, level: dict[str, Any]) -> dict[str, Any] | None:
    try:
        res = await pool.call("analyze", {"level": level, "mode": "fast"}, ANALYZE_TIMEOUT_S)
    except CoreError as e:
        if e.code == "down":
            raise
        log.info("migrated level %s: analyze failed (%s)", level.get("id"), e)
        return None
    return (res or {}).get("report") if isinstance(res, dict) else None


async def migrate_all(pool: CorePool | None = None) -> int:
    """Migrate every v1 level that has no json_v2 yet. Returns the number migrated."""
    pool = pool or get_pool()
    if pool is None:
        return 0
    try:
        rows = db_v2.v1_level_rows(missing_v2_only=True)
    except Exception as e:  # noqa: BLE001 - a v1 database without the levels table yet
        log.info("no v1 levels to migrate: %s", e)
        return 0
    n = 0
    for row in rows:
        try:
            level = await migrate_one(pool, row)
            if level is None:
                continue
            report = await analyze(pool, level)
        except CoreError:
            log.warning("core worker down: v1 migration paused until the next boot")
            break
        db_v2.set_level_json_v2(str(row["id"]), level, level_hash_=level["meta"]["level_hash"], report=report)
        n += 1
    if n:
        log.info("migrated %d v1 level(s) to v2", n)
    return n
