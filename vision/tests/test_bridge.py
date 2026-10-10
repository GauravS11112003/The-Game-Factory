"""CorePool (PLAN_V2 §1.3, §11.3c): ping, round robin, error codes, restart + 1 retry after a worker dies."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app.build.bridge import CoreError, CorePool

REPO = Path(__file__).resolve().parents[2]
LEVEL = json.loads((REPO / "shared/spec/conformance/levels/valid/minimal_1screen.json").read_text())


def run(coro):  # noqa: ANN001, ANN201
    return asyncio.run(coro)


def test_pool_pings_and_hashes() -> None:
    async def go() -> None:
        pool = CorePool(n=2)
        await pool.start()
        try:
            assert pool.state() == "ok" and pool.core_version == "2.0.0"
            h1 = await pool.call("level_hash", {"level": LEVEL})
            h2 = await pool.call("level_hash", {"level": LEVEL})
            assert h1 == h2 == {"hash": LEVEL["meta"]["level_hash"]}
            with pytest.raises(CoreError) as e:
                await pool.call("build", {"ink": {}, "graph0": {}, "edits": [], "rules": {}, "tier": "faithful"})
            assert e.value.code == "internal" and "NotImplemented" in e.value.message
            with pytest.raises(CoreError) as e:
                await pool.call("teleport", {})
            assert e.value.code == "invalid"
        finally:
            await pool.stop()
        assert pool.state() == "down"

    run(go())


def test_pool_restarts_a_dead_worker_and_retries() -> None:
    async def go() -> None:
        pool = CorePool(n=1)
        await pool.start()
        try:
            proc = pool._workers[0].proc
            assert proc is not None
            proc.kill()
            await proc.wait()
            assert pool.state() == "down"
            r = await pool.call("ping", {})
            assert r["core_version"] == "2.0.0" and pool.state() == "ok"
        finally:
            await pool.stop()

    run(go())


def test_stub_pool_returns_fixtures() -> None:
    async def go() -> None:
        pool = CorePool(n=1, stub=True)
        await pool.start()
        try:
            tiers = await pool.call("build_tiers", {"ink": {}, "graph0": {}, "edits": [], "rules": {}, "deadlineMs": 3000}, 5)
            assert set(tiers) >= {"faithful", "polished", "normal", "hard", "reach", "menu"}
        finally:
            await pool.stop()

    run(go())


def test_missing_node_reports_down() -> None:
    async def go() -> None:
        pool = CorePool(n=1, node="definitely-not-node-xyz")
        await pool.start()
        assert pool.state() == "down"
        with pytest.raises(CoreError) as e:
            await pool.call("ping", {})
        assert e.value.code == "down"

    run(go())
