"""model_calls ledger (PLAN_V2 §3.14, D28): every call's tokens, latency, cost, stop_reason, served_by,
fallback_used and request id. Never stores prompts, outputs or the API key."""
from __future__ import annotations

import logging
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from app import db_v2

log = logging.getLogger("dal.v2.ledger")


@dataclass
class CallRecord:
    kind: str
    draft_id: str | None
    effort: str
    latency_ms: int
    in_tok: int = 0
    out_tok: int = 0
    cache_read_tok: int = 0
    cost_usd: float = 0.0
    stop_reason: str | None = None
    served_by: str | None = None
    fallback_used: bool = False
    ok: bool = True
    request_id: str | None = None


def record(rec: CallRecord, path: Path | None = None) -> None:
    """Append one row; a ledger failure is logged, never raised into a build."""
    try:
        db_v2.ensure(path)  # the table exists even when the v2 lifespan has not run (scripts, a fresh data dir)
        with closing(db_v2.connect(path)) as conn, conn:
            conn.execute(
                """INSERT INTO model_calls (draft_id, kind, effort, latency_ms, in_tok, out_tok, cache_read_tok, cost_usd,
                   stop_reason, served_by, fallback_used, ok, request_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (rec.draft_id, rec.kind, rec.effort, rec.latency_ms, rec.in_tok, rec.out_tok, rec.cache_read_tok,
                 rec.cost_usd, rec.stop_reason, rec.served_by, rec.fallback_used, rec.ok, rec.request_id,
                 datetime.now(timezone.utc).isoformat(timespec="seconds")),
            )
    except Exception as e:  # noqa: BLE001
        log.warning("ledger write failed: %s", e)


def spent_since(since_iso: str, *, draft_id: str | None = None, path: Path | None = None) -> float:
    try:
        with closing(db_v2.connect(path)) as conn:
            q = "SELECT COALESCE(SUM(cost_usd), 0) FROM model_calls WHERE created_at >= ?"
            args: tuple[object, ...] = (since_iso,)
            if draft_id is not None:
                q += " AND draft_id = ?"
                args += (draft_id,)
            return float(conn.execute(q, args).fetchone()[0])
    except Exception as e:  # noqa: BLE001 - no table yet means nothing spent
        log.debug("ledger read failed: %s", e)
        return 0.0
