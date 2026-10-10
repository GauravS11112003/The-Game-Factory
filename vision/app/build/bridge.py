"""Bridge to the TS core: a pool of persistent Node workers speaking JSON lines over stdio (PLAN_V2 §1.3, §11.3c).

    pool = CorePool(n=2); await pool.start()
    result = await pool.call("level_hash", {"level": level}, timeout_s=1)

- Workers run `node web/src/core/worker/main.ts` with cwd = repo root; calls are assigned round robin.
- A worker is restarted when it exits or when a call times out; the call is then retried once on the fresh worker.
- `state()` is reported by /api/v2/health. The pool owns its children and kills them on stop(); a worker also
  exits by itself when its stdin closes (uvicorn --reload, crash).
"""
from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from app.config import PROJECT_ROOT

log = logging.getLogger("dal.v2.bridge")

WORKER_ENTRY = Path("web") / "src" / "core" / "worker" / "main.ts"
MAX_LINE = 33 * 1024 * 1024  # §11.3c: a line may carry at most 32 MB
PING_TIMEOUT_S = 1.0
# §11.3c gives p50-sized timeouts for a 1-2 screen level. The bot bounds its work in simulated frames, not wall
# time, so a 6-screen level with many entities can need several times longer; a timeout here kills the worker and
# fails a build that was only slow. The heavy methods therefore get generous backstops (integration decision,
# docs/v2/CONTRACTS.md §3.11). build_tiers uses its deadline + TIERS_SLACK_S.
RPC_TIMEOUTS_S: dict[str, float] = {
    "ping": 1, "perceive_heuristic": 4, "merge_perception": 2, "parse_rules": 2, "build": 15, "apply_plan": 20,
    "transfer_plan": 2, "digest": 2, "analyze": 12, "layout_plan": 4, "keyword_plan": 2, "remix_diff": 4,
    "migrate_v1": 4, "verify_run": 8, "level_hash": 2, "art_svg": 6,
    # P5 (B-2): up to 4 layouts + fast analyses + one full build; per-level dry runs (callers pass per_level_timeout)
    "generate_level": 30, "rules_check": 8, "library_check": 8,
}
PER_LEVEL_CHECK_S = 8.0  # rules_check / library_check: 8 s + 8 s per level (B-2)
TIERS_SLACK_S = 15.0
# A timeout on these means "slow", not "crashed": the worker is restarted (to stop the runaway computation) but the
# same deterministic call is not retried, which would only double the wait.
NO_RETRY_ON_TIMEOUT = frozenset({
    "build", "build_tiers", "apply_plan", "analyze", "verify_run", "generate_level", "rules_check", "library_check",
})


def per_level_timeout(n_levels: int) -> float:
    """Timeout for rules_check / library_check over n levels (B-2: 8 s + 8 s per level)."""
    return PER_LEVEL_CHECK_S + PER_LEVEL_CHECK_S * max(0, int(n_levels))


class CoreError(Exception):
    """A worker call failed: code is timeout | invalid | internal | down (no worker could answer)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass
class _Worker:
    index: int
    proc: asyncio.subprocess.Process | None = None
    reader: asyncio.Task[None] | None = None
    stderr: asyncio.Task[None] | None = None
    pending: dict[int, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)
    ids: itertools.count[int] = field(default_factory=lambda: itertools.count(1))
    restarts: int = 0

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None


class CorePool:
    def __init__(
        self, n: int = 2, *, node: str = "node", root: Path = PROJECT_ROOT, stub: bool = False,
        env: dict[str, str] | None = None,
    ) -> None:
        self.n = max(1, n)
        self.node = node
        self.root = root
        self.stub = stub
        self.env = env
        self._workers = [_Worker(i) for i in range(self.n)]
        self._rr = itertools.count()
        self._locks = [asyncio.Lock() for _ in range(self.n)]
        self.core_version: str | None = None
        self.node_version: str | None = None
        self.last_error: str | None = None
        self._started = False

    # ---- lifecycle -------------------------------------------------------------------------------

    async def start(self) -> None:
        self._started = True
        for w in self._workers:
            try:
                await self._spawn(w)
                pong = await self._send(w, "ping", {}, PING_TIMEOUT_S * 5)  # first start includes Node boot
                self.core_version = pong.get("core_version")
                self.node_version = pong.get("node")
            except Exception as e:  # noqa: BLE001 - a dead worker is reported, never raised into the app
                self.last_error = f"worker {w.index}: {e}"
                log.warning("core worker %d failed to start: %s", w.index, e)

    async def stop(self) -> None:
        self._started = False
        for w in self._workers:
            await self._kill(w)

    def state(self) -> Literal["ok", "down"]:
        return "ok" if self._workers and all(w.alive for w in self._workers) else "down"

    def info(self) -> dict[str, Any]:
        return {
            "state": self.state(), "workers": self.n, "alive": sum(w.alive for w in self._workers),
            "restarts": sum(w.restarts for w in self._workers), "core_version": self.core_version,
            "node": self.node_version, "stub": self.stub, "last_error": self.last_error,
        }

    # ---- calls -----------------------------------------------------------------------------------

    async def call(self, method: str, params: dict[str, Any], timeout_s: float | None = None) -> Any:
        """Run one RPC. Returns `result`; raises CoreError. Restart + 1 retry on exit or timeout."""
        timeout = timeout_s if timeout_s is not None else RPC_TIMEOUTS_S.get(method, 3.0)
        i = next(self._rr) % self.n
        w = self._workers[i]
        for attempt in (1, 2):
            async with self._locks[i]:
                if not w.alive:
                    await self._spawn(w)
                proc = w.proc
            try:
                return await self._send(w, method, params, timeout)
            except CoreError as e:
                last = e.code in ("invalid", "internal") or attempt == 2
                if e.code == "timeout" and method in NO_RETRY_ON_TIMEOUT:
                    last = True
                    async with self._locks[i]:
                        if w.proc is proc:
                            await self._kill(w)
                            w.restarts += 1
                            await self._spawn(w)
                if last:
                    raise
                log.warning("core worker %d %s on %s; restarting and retrying once", w.index, e.code, method)
                async with self._locks[i]:
                    if w.proc is proc:  # a concurrent caller may already have restarted it
                        await self._kill(w)
                        w.restarts += 1
                        await self._spawn(w)
        raise CoreError("down", "unreachable")  # pragma: no cover

    async def _send(self, w: _Worker, method: str, params: dict[str, Any], timeout: float) -> Any:
        if not w.alive or w.proc is None or w.proc.stdin is None:
            raise CoreError("down", f"worker {w.index} is not running")
        rid = next(w.ids)
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        w.pending[rid] = fut
        line = json.dumps({"id": rid, "method": method, "params": params}, separators=(",", ":")) + "\n"
        try:
            w.proc.stdin.write(line.encode("utf-8"))
            await w.proc.stdin.drain()
            resp = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise CoreError("timeout", f"{method} took longer than {timeout:.1f} s") from None
        except (BrokenPipeError, ConnectionResetError) as e:
            raise CoreError("down", f"worker {w.index} pipe closed: {e}") from None
        finally:
            w.pending.pop(rid, None)
        if resp.get("ok"):
            return resp.get("result")
        err = resp.get("error") or {}
        raise CoreError(str(err.get("code", "internal")), str(err.get("message", "unknown error")))

    # ---- processes -------------------------------------------------------------------------------

    async def _spawn(self, w: _Worker) -> None:
        exe = shutil.which(self.node) or self.node
        env = dict(os.environ if self.env is None else self.env)
        env["DAL_CORE_STUB"] = "1" if self.stub else env.get("DAL_CORE_STUB", "0")
        try:
            w.proc = await asyncio.create_subprocess_exec(
                exe, str(WORKER_ENTRY), cwd=str(self.root), env=env, limit=MAX_LINE,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
        except OSError as e:  # node missing or not executable
            self.last_error = f"cannot start {self.node}: {e}"
            raise CoreError("down", self.last_error) from None
        w.reader = asyncio.create_task(self._read(w, w.proc))
        w.stderr = asyncio.create_task(self._drain_stderr(w, w.proc))

    async def _read(self, w: _Worker, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        try:
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("core worker %d wrote a non-JSON line: %.200r", w.index, raw)
                    continue
                fut = w.pending.get(msg.get("id"))
                if fut is not None and not fut.done():
                    fut.set_result(msg)
        except (asyncio.CancelledError, ValueError):  # ValueError: line over the StreamReader limit
            pass
        finally:
            for fut in list(w.pending.values()):
                if not fut.done():
                    fut.set_exception(CoreError("down", f"worker {w.index} exited"))

    async def _drain_stderr(self, w: _Worker, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr is not None
        with contextlib.suppress(asyncio.CancelledError):
            while line := await proc.stderr.readline():
                log.info("core worker %d: %s", w.index, line.decode("utf-8", "replace").rstrip())

    async def _kill(self, w: _Worker) -> None:
        proc, w.proc = w.proc, None
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError, OSError):
                if proc.stdin is not None:
                    proc.stdin.close()
                proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), 2)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                await proc.wait()
        for t in (w.reader, w.stderr):
            if t is not None and not t.done():
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t
        w.reader = w.stderr = None


_POOL: CorePool | None = None


def get_pool() -> CorePool | None:
    return _POOL


def set_pool(pool: CorePool | None) -> None:
    global _POOL
    _POOL = pool
