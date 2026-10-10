/// <reference types="node" />
/**
 * worker_threads entry (§1.3): one of the 3 threads each Node core worker owns. Runs the same dispatch as the
 * stdio server, so heavy builds never block the worker's ping and light calls.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { dispatch } from './dispatch.ts';

const runtime = String((workerData as { runtime?: string } | null)?.runtime ?? `node ${process.version} (thread)`);

if (parentPort) {
  // stdout of the parent process carries only protocol lines: everything a module logs goes to stderr
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = console.log;
  const port = parentPort;
  port.on('message', (msg: unknown) => {
    port.postMessage(dispatch(msg, { runtime }));
  });
}
