/**
 * Browser Web Worker entry (§1.3): the same dispatch as the Node worker, over postMessage.
 * Load with `new Worker(new URL('../core/worker/web.worker.ts', import.meta.url), { type: 'module' })`.
 */
import { dispatch } from './dispatch.ts';

interface WorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(msg: unknown): void;
}

const scope = globalThis as unknown as WorkerScope;
scope.onmessage = (e) => {
  scope.postMessage(dispatch(e.data, { runtime: 'browser' }));
};
