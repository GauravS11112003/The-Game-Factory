/// <reference types="node" />
/**
 * worker_threads pool (3 threads per Node worker) for candidate verification (§1.3, §3.8). Lane B, P3.
 * P0 skeleton: the interface the designer will use; runs tasks inline until the threaded version lands.
 */
import { dispatch } from './dispatch.ts';
import type { WorkerMethod, WorkerResponse } from '../types.gen.ts';

export interface ThreadPool {
  readonly size: number;
  run(method: WorkerMethod, params: Record<string, unknown>): Promise<WorkerResponse>;
  close(): Promise<void>;
}

export function createThreadPool(size = 3): ThreadPool {
  let next = 0;
  return {
    size,
    run(method, params) {
      return Promise.resolve(dispatch({ id: next++, method, params }, { runtime: `node ${process.version} (inline pool)` }));
    },
    close() {
      return Promise.resolve();
    },
  };
}
