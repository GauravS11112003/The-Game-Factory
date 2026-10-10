/** Dispatch one browser-core request (shared by the Web Worker and the inline fallback). */
import { isNotImplemented } from '../core/util/errors.ts';
import * as tasks from './core_tasks.ts';
import type { CoreRequest, CoreResponse } from './core_types.ts';

type Any = any;

export function runTask(req: CoreRequest): CoreResponse {
  try {
    const p = req.params as Any;
    let result: unknown;
    switch (req.method) {
      case 'ink':
        result = tasks.makeInk(p, !!p.allowBare);
        break;
      case 'hints':
        result = tasks.hints(p);
        break;
      case 'graph0':
        result = tasks.graph0(p);
        break;
      case 'build':
        result = tasks.localBuild(p);
        break;
      case 'menu':
        result = tasks.menu(p);
        break;
      case 'hash':
        result = tasks.hash(p);
        break;
      case 'analyze':
        result = tasks.analyzeLevel(p);
        break;
      case 'rulesCheck':
        result = tasks.rulesCheck(p);
        break;
      case 'libraryCheck':
        result = tasks.libraryCheck(p);
        break;
      case 'plan':
        result = tasks.plan(p);
        break;
      case 'remix':
        result = tasks.remix(p);
        break;
      case 'verify':
        result = tasks.verify(p);
        break;
      default:
        throw new Error(`unknown core method ${String(req.method)}`);
    }
    return { id: req.id, ok: true, result };
  } catch (e) {
    if (isNotImplemented(e)) {
      return { id: req.id, ok: false, error: { code: 'not_implemented', fn: (e as { fn?: string }).fn, message: e.message } };
    }
    return { id: req.id, ok: false, error: { code: 'internal', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) } };
  }
}
