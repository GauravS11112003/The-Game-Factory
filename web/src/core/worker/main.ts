/// <reference types="node" />
/**
 * Node core worker: JSON lines over stdio (§1.3, §11.3c). One request per line on stdin, one response per line
 * on stdout, matched by id. Heavy methods (builds, tiers, plans, analysis) run on the worker_threads pool, so a
 * long build never delays `ping` (the bridge restarts a worker that misses a 2 s ping) and several requests from
 * the orchestrator (e.g. the 4 Understood tier builds) run in parallel. Light methods answer inline.
 * `DAL_CORE_STUB=1` answers every method except ping with canned fixtures (P0).
 * Started by vision/app/build/bridge.py as `node web/src/core/worker/main.ts` (cwd = repo root).
 */
import { createInterface } from 'node:readline';
import type { WorkerMethod } from '../types.gen.ts';
import { dispatch, METHOD_PARAMS } from './dispatch.ts';
import { createThreadPool } from './pool.ts';
import type { ThreadPool } from './pool.ts';
import { stubResult } from './stub.ts';

const MAX_LINE = 32 * 1024 * 1024;
const stub = process.env.DAL_CORE_STUB === '1' ? stubResult : null;
const THREADS = Math.max(0, Number(process.env.DAL_CORE_THREADS ?? 3) || 0);

/** Methods that may take more than a few milliseconds. */
const HEAVY: ReadonlySet<WorkerMethod> = new Set<WorkerMethod>([
  'perceive_heuristic', 'build', 'build_tiers', 'apply_plan', 'analyze', 'migrate_v1', 'verify_run', 'layout_plan',
  'remix_diff', 'art_svg', 'digest', 'merge_perception', 'generate_level', 'rules_check', 'library_check',
]);

// stdout carries only responses: anything a module logs goes to stderr.
console.log = (...args: unknown[]) => console.error(...args);
console.info = console.log;

const runtime = `node ${process.version}`;
let pool: ThreadPool | null = null;
let inflight = 0;
let stdinClosed = false;

function reply(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function maybeExit(): void {
  if (stdinClosed && inflight === 0 && pool) {
    const p = pool;
    pool = null;
    void p.close();
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  if (line.length > MAX_LINE) {
    reply({ id: -1, ok: false, error: { code: 'invalid', message: `request line exceeds ${MAX_LINE} bytes` } });
    return;
  }
  let req: { id?: unknown; method?: unknown; params?: unknown };
  try {
    req = JSON.parse(line);
  } catch {
    reply({ id: -1, ok: false, error: { code: 'invalid', message: 'request is not valid JSON' } });
    return;
  }
  const method = req && typeof req.method === 'string' ? (req.method as WorkerMethod) : null;
  const heavy = !stub && THREADS > 0 && method !== null && method in METHOD_PARAMS && HEAVY.has(method) && req.params && typeof req.params === 'object';
  if (!heavy) {
    reply(dispatch(req, { runtime, stub }));
    return;
  }
  pool ??= createThreadPool(THREADS);
  inflight++;
  const id = typeof req.id === 'number' ? req.id : -1;
  pool.run(method!, req.params as Record<string, unknown>).then(
    (resp) => reply({ ...resp, id }),
    (e: unknown) => reply({ id, ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } }),
  ).finally(() => {
    inflight--;
    maybeExit();
  });
});
// The bridge owns this process: when it closes stdin (shutdown, reload, crash) the in-flight requests finish, the
// threads stop, and the process exits after stdout is flushed. Never process.exit() here: it would drop responses.
rl.on('close', () => {
  stdinClosed = true;
  process.exitCode = 0;
  maybeExit();
});
