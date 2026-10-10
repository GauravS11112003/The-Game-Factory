/**
 * Resume a build from its BuildResult (graph + level carry everything: `x_work` state, ink, rules, library),
 * and evaluate designer edits in a sandbox. Used by candidates(), greedy and applyPlan.
 */
import type { BuildResult } from '../index.ts';
import type { EditOp, EditRecord, InkDoc, PlaytestReport, Tier } from '../types.gen.ts';
import { compileWork } from '../build/compile.ts';
import { lightLevel, resolveRules } from '../build/level.ts';
import type { AssembleInput } from '../build/level.ts';
import { Runner } from '../build/runner.ts';
import type { Applied } from '../build/runner.ts';
import { OP_CLASS } from '../edits/vocabulary.ts';
import { cloneWork, profileOf, workFromGraph } from '../edits/work.ts';
import type { Ctx, Work } from '../edits/work.ts';
import { analyzeSafe } from './playtest.ts';

export interface Resumed {
  a: AssembleInput;
  ctx: Ctx;
  w: Work;
  report: PlaytestReport;
}

export function inkOfResult(r: BuildResult): InkDoc {
  const lv = r.level;
  const li = lv.ink ?? { strokes: [], components: [] };
  return {
    v: 2, source: lv.source.kind, world: { screens: lv.world.screens, w: lv.world.w, h: 27 }, strokes: li.strokes ?? [],
    components: li.components ?? [], character: li.character ?? null, typed_rules: li.typed_rules ?? [], rules_ink: li.rules_ink ?? [],
    sheets: (lv.source.sheets ?? []).map((s) => ({ index: s.index, photo_url: s.photo_url ?? null, qr: s.qr ?? null, warnings: [] })),
    noise: li.noise ?? { count: 0 }, parent: null,
  };
}

export function resume(r: BuildResult, tier: Tier): Resumed {
  const ink = inkOfResult(r);
  const rules = resolveRules(r.level.rules);
  const profile = profileOf(rules);
  const a: AssembleInput = { ink, rules, library: r.level.embedded_library ?? [], parent: null };
  const w = workFromGraph(r.graph, { w: r.level.world.w, h: 27, screens: r.level.world.screens });
  return { a, ctx: { ink, library: a.library, rules, profile, tier, report: r.report }, w, report: r.report };
}

export interface Trial {
  w: Work;
  applied: Applied[];
  failed: boolean;
  report: PlaytestReport | null;
  approx: boolean;
}

/** Apply ops on a copy of the work (designer stage) and optionally analyze the result. */
export function trial(res: Resumed, base: Work, ops: EditOp[], tier: Tier, o: { analyze: false | 'fast' | 'full'; ids?: string[] } = { analyze: 'fast' }): Trial {
  const R = new Runner(cloneWork(res.w), { ...res.ctx, tier }, [], base);
  const applied: Applied[] = [];
  let failed = false;
  for (const op of ops) {
    const a = R.run(op, { by: 'greedy', stage: 'designed', tier, cls: OP_CLASS[op.op], recordFailures: true });
    if (!a || a.rec.status !== 'applied') {
      failed = true;
      break;
    }
    applied.push(a);
  }
  if (failed || !o.analyze) return { w: R.w, applied, failed, report: null, approx: false };
  const rr = analyzeSafe(lightLevel(res.a, compileWork(R.w), R.w), o.analyze, res.ctx.profile);
  return { w: R.w, applied, failed, report: rr.report, approx: rr.approx };
}

export function recOps(recs: readonly EditRecord[]): EditOp[] {
  return recs.filter((r) => r.status === 'applied').map((r) => r.op);
}
