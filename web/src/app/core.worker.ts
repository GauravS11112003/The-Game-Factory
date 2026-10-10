/**
 * The app's browser core worker (§1.3, §7.11): the TS core off the main thread for live hints, ▶ test-play builds and
 * local preview rebuilds. Load with `new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' })`.
 */
import { runTask } from './core_run.ts';
import type { CoreRequest } from './core_types.ts';

interface WorkerScope {
  onmessage: ((e: { data: CoreRequest }) => void) | null;
  postMessage(msg: unknown): void;
}

const scope = globalThis as unknown as WorkerScope;
scope.onmessage = (e) => {
  scope.postMessage(runTask(e.data));
};
