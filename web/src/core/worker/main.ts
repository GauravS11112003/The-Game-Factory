/// <reference types="node" />
/**
 * Node core worker: JSON lines over stdio (§1.3, §11.3c). One request per line on stdin, one response per line
 * on stdout, in order. `DAL_CORE_STUB=1` answers every method except ping with canned fixtures (P0).
 * Started by vision/app/build/bridge.py as `node web/src/core/worker/main.ts` (cwd = repo root).
 */
import { createInterface } from 'node:readline';
import { dispatch } from './dispatch.ts';
import { stubResult } from './stub.ts';

const MAX_LINE = 32 * 1024 * 1024;
const stub = process.env.DAL_CORE_STUB === '1' ? stubResult : null;

// stdout carries only responses: anything a module logs goes to stderr.
console.log = (...args: unknown[]) => console.error(...args);
console.info = console.log;

function reply(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  if (line.length > MAX_LINE) {
    reply({ id: -1, ok: false, error: { code: 'invalid', message: `request line exceeds ${MAX_LINE} bytes` } });
    return;
  }
  let req: unknown;
  try {
    req = JSON.parse(line);
  } catch {
    reply({ id: -1, ok: false, error: { code: 'invalid', message: 'request is not valid JSON' } });
    return;
  }
  reply(dispatch(req, { runtime: `node ${process.version}`, stub }));
});
// The bridge owns this process: when it closes stdin (shutdown, reload, crash) the event loop drains and the
// process exits after stdout is flushed. Never process.exit() here: it would drop buffered responses.
rl.on('close', () => {
  process.exitCode = 0;
});
