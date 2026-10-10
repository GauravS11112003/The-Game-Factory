/**
 * Worker RPC dispatch (§11.3c), shared by the Node stdio server (main.ts) and the browser worker (web.worker.ts).
 * Request `{id, method, params}` → response `{id, ok: true, result}` or `{id, ok: false, error: {code, message}}`.
 */
import * as core from '../index.ts';
import type { WorkerMethod, WorkerRequest, WorkerResponse } from '../types.gen.ts';
import { isNotImplemented } from '../util/errors.ts';
import { CORE_VERSION } from '../util/version.ts';

export type StubProvider = (method: WorkerMethod, params: Record<string, unknown>) => unknown;

export interface DispatchContext {
  runtime: string; // e.g. "node v24.16.0" or "browser"
  stub?: StubProvider | null;
}

export class RpcError extends Error {
  readonly code: 'timeout' | 'invalid' | 'internal';
  constructor(code: 'timeout' | 'invalid' | 'internal', message: string) {
    super(message);
    this.code = code;
  }
}

/** Required params per method (§11.3c table). */
export const METHOD_PARAMS: Record<WorkerMethod, readonly string[]> = {
  ping: [],
  perceive_heuristic: ['ink'],
  merge_perception: ['graph0', 'perceptions', 'ink'],
  parse_rules: ['text', 'graph'],
  build: ['ink', 'tier'],
  build_tiers: ['ink', 'deadlineMs'],
  apply_plan: ['input', 'menu', 'plan'],
  transfer_plan: ['plan', 'oldMenu', 'newMenu', 'oldGraph', 'newGraph'],
  digest: ['result', 'menu'],
  analyze: ['level', 'mode'],
  layout_plan: ['plan', 'rules', 'seed'],
  keyword_plan: ['prompt', 'screens'],
  remix_diff: ['parent', 'ink'],
  migrate_v1: ['level'],
  verify_run: ['level', 'replay'],
  level_hash: ['level'],
  art_svg: ['level', 'ink', 'theme', 'view'],
  generate_level: ['plan'],
  rules_check: ['levels', 'rules'],
  library_check: ['levels', 'type'],
};

// Params arrive as untyped JSON; the core validates its own inputs.
type Any = any;

/** BuildInput with the optional fields defaulted (library, parent, repairUnsolvable, seed). */
function buildInput(p: Record<string, Any>, withTier: boolean): Any {
  const out: Any = {
    ink: p.ink, graph0: p.graph0, edits: Array.isArray(p.edits) ? p.edits : [], rules: p.rules ?? { version: 1 },
    library: Array.isArray(p.library) ? p.library : [], parent: p.parent ?? null,
    repairUnsolvable: p.repairUnsolvable === undefined ? true : !!p.repairUnsolvable, seed: typeof p.seed === 'number' ? p.seed : 1,
  };
  if (withTier) out.tier = p.tier ?? 'faithful';
  if (!out.graph0 && out.ink) out.graph0 = core.perceiveHeuristic(out.ink, { library: out.library, parent: out.parent });
  return out;
}

function call(method: WorkerMethod, p: Record<string, Any>, ctx: DispatchContext): unknown {
  switch (method) {
    case 'ping':
      return { core_version: CORE_VERSION, node: ctx.runtime, stub: !!ctx.stub };
    case 'perceive_heuristic':
      return { graph: core.perceiveHeuristic(p.ink, { library: p.library ?? [], parent: p.parent ?? null }) };
    case 'merge_perception':
      return core.mergePerception(p.graph0, Array.isArray(p.perceptions) ? p.perceptions : [], p.ink, Array.isArray(p.library) ? p.library : []);
    case 'parse_rules':
      return core.parseRules(String(p.text ?? ''), p.graph, typeof p.target === 'number' ? p.target : null);
    case 'build':
      return core.build(buildInput(p, true));
    case 'build_tiers':
      return core.buildTiers(buildInput(p, false), { deadlineMs: Number(p.deadlineMs) || 3000, band: p.band ?? undefined });
    case 'apply_plan':
      return core.applyPlan(buildInput(p.input ?? {}, false), p.menu ?? [], p.plan);
    case 'transfer_plan':
      return core.transferPlan(p.plan, p.oldMenu ?? [], p.newMenu ?? [], p.oldGraph, p.newGraph);
    case 'digest':
      return core.digest(p.result, p.menu ?? []);
    case 'analyze':
      return { report: core.analyze(p.level, { mode: p.mode, profile: p.profile }) };
    case 'layout_plan':
      return { ink: core.layoutPlan(p.plan, p.rules, p.seed) };
    case 'keyword_plan':
      return { plan: core.keywordPlan(p.prompt, p.screens) };
    case 'remix_diff':
      return core.remixDiff(p.parent, p.ink);
    case 'migrate_v1':
      return { level: core.migrateV1(p.level) };
    case 'verify_run':
      // A-2: the claim (time, deaths, coins, big coins) is checked against the re-simulation
      return core.verifyRun(p.level, p.replay, p.claimed ?? null);
    case 'level_hash':
      return { hash: core.levelHash(p.level) };
    case 'art_svg':
      return { svg: core.artToSvg(core.buildArt(p.level, p.ink, { theme: p.theme, seed: p.seed ?? 1 }), p.view) };
    case 'generate_level': {
      // §8.3: lay out, build, prove, fix; `clamp: 'band'` (model / keyword plans) unless asked otherwise
      const g = core.generateLevel(p.plan, p.rules ?? { version: 1 }, typeof p.seed === 'number' ? p.seed : 1, {
        tier: p.tier ?? 'faithful', clamp: p.clamp === 'envelope' ? 'envelope' : 'band', ink: p.ink === 'marker' ? 'marker' : 'draft',
        library: Array.isArray(p.library) ? p.library : [],
      });
      return g;
    }
    case 'rules_check':
      return core.rulesCheck(Array.isArray(p.levels) ? p.levels : [], p.rules, { repair: p.repair !== false });
    case 'library_check':
      return core.libraryUpdateCheck(Array.isArray(p.levels) ? p.levels : [], p.type, Array.isArray(p.library) ? p.library : []);
  }
}

export function dispatch(req: unknown, ctx: DispatchContext): WorkerResponse {
  const r = req as Partial<WorkerRequest> | null;
  const id = typeof r?.id === 'number' ? r.id : -1;
  try {
    if (!r || typeof r !== 'object' || typeof r.method !== 'string') throw new RpcError('invalid', 'request needs {id, method, params}');
    const method = r.method as WorkerMethod;
    if (!(method in METHOD_PARAMS)) throw new RpcError('invalid', `unknown method ${JSON.stringify(r.method)}`);
    const params = (r.params ?? {}) as Record<string, unknown>;
    if (typeof params !== 'object' || Array.isArray(params)) throw new RpcError('invalid', 'params must be an object');
    const missing = METHOD_PARAMS[method].filter((k) => !(k in params));
    if (missing.length) throw new RpcError('invalid', `${method}: missing params ${missing.join(', ')}`);
    const result = method !== 'ping' && ctx.stub ? ctx.stub(method, params) : call(method, params, ctx);
    return { id, ok: true, result };
  } catch (e) {
    if (e instanceof RpcError) return { id, ok: false, error: { code: e.code, message: e.message } };
    const message = isNotImplemented(e) ? e.message : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { id, ok: false, error: { code: 'internal', message } };
  }
}
