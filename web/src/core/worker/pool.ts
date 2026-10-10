/// <reference types="node" />
/**
 * worker_threads pool (3 threads per Node core worker, §1.3 / §3.8). Each task goes to the least-loaded thread;
 * threads start lazily and are replaced if they crash (the task in flight fails with `internal`). When threads
 * cannot start at all, tasks run inline on the calling thread, so the worker always answers.
 */
import { Worker } from 'node:worker_threads';
import type { WorkerMethod, WorkerResponse } from '../types.gen.ts';
import { dispatch } from './dispatch.ts';

export interface ThreadPool {
  readonly size: number;
  run(method: WorkerMethod, params: Record<string, unknown>): Promise<WorkerResponse>;
  pending(): number;
  close(): Promise<void>;
}

interface Slot {
  w: Worker | null;
  busy: number;
  waiting: Map<number, (r: WorkerResponse) => void>;
}

const ENTRY = new URL('./thread.ts', import.meta.url);

export function createThreadPool(size = 3): ThreadPool {
  const slots: Slot[] = Array.from({ length: Math.max(1, size) }, () => ({ w: null, busy: 0, waiting: new Map() }));
  let next = 1;
  let inline = false;
  let open = 0;
  let closed = false;

  const start = (s: Slot): Worker | null => {
    if (s.w) return s.w;
    try {
      const w = new Worker(ENTRY, { workerData: { runtime: `node ${process.version} (thread)` }, stdout: true, stderr: false });
      // a thread's stdout must never reach the protocol pipe
      w.stdout.on('data', (d: Buffer) => process.stderr.write(d));
      w.on('message', (m: WorkerResponse) => {
        const cb = s.waiting.get(m.id);
        if (!cb) return;
        s.waiting.delete(m.id);
        s.busy--;
        cb(m);
      });
      const fail = (why: string): void => {
        for (const [id, cb] of s.waiting) cb({ id, ok: false, error: { code: 'internal', message: `core thread ${why}` } });
        s.waiting.clear();
        s.busy = 0;
        s.w = null;
      };
      w.on('error', (e) => fail(`error: ${e instanceof Error ? e.message : String(e)}`));
      w.on('exit', (code) => {
        if (s.w === w) fail(`exited (${code})`);
      });
      w.unref();
      s.w = w;
      return w;
    } catch (e) {
      console.error(`core: worker_threads unavailable, running inline: ${e instanceof Error ? e.message : String(e)}`);
      inline = true;
      return null;
    }
  };

  return {
    size: slots.length,
    pending: () => open,
    run(method, params) {
      const id = next++;
      if (closed || inline) return Promise.resolve(dispatch({ id, method, params }, { runtime: `node ${process.version} (inline)` }));
      const s = slots.reduce((a, b) => (b.busy < a.busy ? b : a));
      const w = start(s);
      if (!w) return Promise.resolve(dispatch({ id, method, params }, { runtime: `node ${process.version} (inline)` }));
      open++;
      return new Promise<WorkerResponse>((resolve) => {
        s.busy++;
        s.waiting.set(id, (r) => {
          open--;
          resolve(r);
        });
        w.ref();
        w.postMessage({ id, method, params });
      }).finally(() => {
        if (s.busy <= 0 && s.w) s.w.unref();
      });
    },
    async close() {
      closed = true;
      await Promise.all(slots.map(async (s) => {
        const w = s.w;
        s.w = null;
        if (w) await w.terminate();
      }));
    },
  };
}
