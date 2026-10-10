/**
 * The designer's menu (§3.8, `core/design/candidates.ts`): ≤ 40 pre-verified moves generated from a build and
 * its report. Each is applied in a sandbox, checked against the invariants and fast-verified by the bot; the top
 * 12 are fully measured for dC, dT and dF. Candidate ids are `op:target:hash6(params)`, stable across rebuilds
 * and stages because object ids and slot ids are (D9 transfer).
 */
import type { BuildResult } from '../index.ts';
import { DESIGN, EDIT_BOUNDS } from '../params.ts';
import type { Candidate, EditOp, MessageArgs, PlaytestReport, Tier } from '../types.gen.ts';
import { apexOf, gMax } from '../edits/envelope.ts';
import { checkReport } from '../edits/invariants.ts';
import { arcId, gapId, slotId } from '../edits/slots.ts';
import type { SlotSpec } from '../edits/slots.ts';
import { OP_CLASS } from '../edits/vocabulary.ts';
import { cloneWork, floorBelow, isKid, objBBox } from '../edits/work.ts';
import type { Work } from '../edits/work.ts';
import { roleNoun } from '../scene/roles.ts';
import { editId } from '../util/ids.ts';
import { resume, trial } from './context.ts';
import type { Resumed } from './context.ts';
import { gatherSites } from './sites.ts';
import type { Sites } from './sites.ts';

const P_TIERS: Tier[] = ['polished', 'normal', 'hard'];
const C_TIERS: Tier[] = ['normal', 'hard'];
const H_TIERS: Tier[] = ['hard'];

interface Raw {
  generator: string;
  op: EditOp;
  extra?: EditOp[];
  tiers: Tier[];
  alts?: string | null;
  summary_key: string;
  summary_args?: MessageArgs;
  dC: number; // predicted (analytic) ΔC, for ranking before measuring
  fixes?: string[];
  prio: number; // generator priority (lower first)
}

/** Analytic ΔC predictions (§3.8 table), used for ranking and when the bot is unavailable. */
export const PREDICT = {
  enemy: { walker: 0.1, hopper: 0.12, flyer: 0.15, shooter: 0.15, chaser: 0.2, crusher: 0.15 } as Record<string, number>,
  spikes: 0.08,
  saw: 0.12,
  firebar: 0.2,
  lava: 0.1,
  widen_per_cell: 0.06,
  shrink_per_cell: 0.04,
  shift_per_cell: 0.04,
  crumble: 0.08,
  tune_per_step: 0.03,
  animate: 0.06,
  reprise: 0.15,
};

function segmentsNeedingCheckpoints(r: PlaytestReport | null): Set<string> {
  const out = new Set<string>();
  for (const s of r?.segments ?? []) if (s.F_s > EDIT_BOUNDS.checkpoint.max_F_s || s.T_ms / 1000 > EDIT_BOUNDS.checkpoint.max_T_s) out.add(s.id);
  return out;
}

function nearestSlot(list: readonly SlotSpec[], x: number, pred: (s: SlotSpec) => boolean = () => true): SlotSpec | null {
  let best: SlotSpec | null = null;
  for (const s of list) if (pred(s) && (!best || Math.abs(s.x - x) < Math.abs(best.x - x))) best = s;
  return best;
}

function generate(res: Resumed, w: Work, r: PlaytestReport | null, sites: Sites): Raw[] {
  const out: Raw[] = [];
  const flags = r?.flags ?? [];
  const screens = w.world.screens;
  // --- fix_flag ---
  for (const f of flags) {
    const fx = f.at?.[0] ?? 0;
    if (f.code === 'long_segment') {
      const s = nearestSlot(sites.slots.cp, fx, (x) => x.x >= EDIT_BOUNDS.checkpoint.none_before_c);
      if (s) out.push({ generator: 'fix_flag', op: { op: 'add_checkpoint', slot: slotId(s) }, tiers: P_TIERS, summary_key: 'polish.checkpoint', summary_args: { seconds: 30 }, dC: 0, fixes: [f.id], prio: 1 });
    } else if (f.code === 'blind_jump' || f.code === 'leap_of_faith') {
      const j = sites.jumps.find((x) => Math.abs(x.from[0] - fx) <= 2);
      if (j) out.push(trailRaw(res, j.from, j.to, j.kind, [f.id]));
      const s = nearestSlot(sites.slots.hint, fx);
      if (s) out.push({ generator: 'fix_flag', op: { op: 'add_hint_arrow', slot: slotId(s), dir: f.code === 'leap_of_faith' ? 'down' : 'right' }, tiers: P_TIERS, summary_key: 'polish.hint_arrow', dC: 0, fixes: [f.id], prio: 1 });
    } else if (f.code === 'unreachable_drawn') {
      for (const id of f.object_ids ?? []) {
        const o = w.objs.find((x) => x.id === id);
        if (!o || !(o.role === 'coin' || o.role === 'big_coin' || o.role === 'key')) continue;
        for (const dy of [1, 2]) out.push({ generator: 'fix_flag', op: { op: 'nudge', group: id, dx: 0, dy }, tiers: P_TIERS, summary_key: 'repair.nudged', summary_args: { cells: dy }, dC: 0, fixes: [f.id], prio: 1 });
      }
    } else if (f.code === 'head_bonk') {
      for (const id of f.object_ids ?? []) {
        const o = w.objs.find((x) => x.id === id);
        if (o && o.role === 'platform' && o.collision === 'solid') out.push({ generator: 'fix_flag', op: { op: 'set_collision', target: id, mode: 'one_way' }, tiers: ['faithful', ...P_TIERS], summary_key: 'repair.bonk_oneway', dC: 0, fixes: [f.id], prio: 1 });
      }
    } else if (f.code === 'skippable_setpiece') {
      for (const id of f.object_ids ?? []) {
        const o = w.objs.find((x) => x.id === id);
        if (!o) continue;
        const b = objBBox(o);
        const host = floorBelow(w, (b[0] + b[2]) / 2, b[3] - 0.25, 4)?.o;
        if (host && host.role === 'platform') {
          for (const dy of [1, -1]) out.push({ generator: 'matter', op: { op: 'shift_platform', group: host.id, dx: 0, dy }, tiers: C_TIERS, summary_key: 'challenge.shift_platform', dC: PREDICT.shift_per_cell, fixes: [f.id], prio: 3 });
          out.push({ generator: 'matter', op: { op: 'shrink_landing', surface: host.id, side: 'left', cells: 1 }, tiers: C_TIERS, summary_key: 'challenge.shrink_landing', dC: PREDICT.shrink_per_cell, fixes: [f.id], prio: 3 });
        }
        const s = nearestSlot(sites.slots.spikes, (b[0] + b[2]) / 2, (x) => Math.abs(x.x - (b[0] + b[2]) / 2) <= 6);
        if (s) out.push({ generator: 'matter', op: { op: 'add_spikes', slot: slotId(s) }, tiers: C_TIERS, summary_key: 'challenge.add_spikes', dC: PREDICT.spikes, fixes: [f.id], prio: 3 });
      }
    }
  }
  // --- checkpoint (segments with F_s > 30 s or T_s > 40 s; or long levels with no report metrics) ---
  const needSeg = segmentsNeedingCheckpoints(r);
  const cps = sites.slots.cp.filter((s) => s.x >= EDIT_BOUNDS.checkpoint.none_before_c);
  for (let sc = 0; sc < screens; sc++) {
    const inScreen = cps.filter((s) => Math.floor(s.x / 48) === sc);
    if (!inScreen.length) continue;
    const segOk = r && r.segments.length ? needSeg.size > 0 : screens >= 2 && sc >= 1;
    if (!segOk) continue;
    // prefer the first flat after the screen's middle: rest after the hard part (sawtooth)
    const s = [...inScreen].sort((a, b) => Math.abs(a.x - (sc * 48 + 30)) - Math.abs(b.x - (sc * 48 + 30)))[0];
    out.push({ generator: 'checkpoint', op: { op: 'add_checkpoint', slot: slotId(s) }, tiers: P_TIERS, summary_key: 'polish.checkpoint', summary_args: { seconds: 9 }, dC: 0, prio: 1 });
  }
  // --- trail: run-up gaps, jumps > 5 cells, blind jumps ---
  if (sites.jumps.length) {
    for (const j of sites.jumps) if (j.kind === 'runjump' || Math.abs(j.to[0] - j.from[0]) > 5 || j.blind) out.push(trailRaw(res, j.from, j.to, j.kind, []));
  } else {
    for (const g of sites.gaps) if (g.gap >= 4) out.push(trailRaw(res, [g.x0 - 0.5, g.ya], [g.x1 + 0.5, g.yb], g.gap >= 5 ? 'runjump' : 'jump', []));
  }
  // --- risk_coin (big coins: detours and stomp-only spots) ---
  for (const s of sites.slots.risk.slice(0, 6)) out.push({ generator: 'risk_coin', op: { op: 'add_big_coin', slot: slotId(s) }, tiers: P_TIERS, summary_key: 'polish.big_coin', dC: 0, prio: 2 });
  // --- animate: static kid creatures on a host ≥ 4 cells ---
  for (const o of w.objs) {
    if (o.role !== 'enemy' || !isKid(o) || o.rel.part_of || o.pinned.includes('archetype')) continue;
    if (o.behavior && o.behavior.kind !== 'static') continue;
    out.push({ generator: 'animate', op: { op: 'animate', target: o.id, archetype: 'walker' }, tiers: P_TIERS, summary_key: 'polish.monster_walks', dC: PREDICT.animate, prio: 2 });
  }
  // --- speed_up: kid enemies and movers (P6 +1/+2) ---
  for (const o of w.objs) {
    const b = o.behavior;
    if (!b || o.rel.part_of) continue;
    const param = b.kind === 'enemy' ? (b.archetype === 'hopper' || b.archetype === 'shooter' ? 'interval' : b.archetype === 'crusher' ? 'warn' : 'speed') : b.kind === 'move' || b.kind === 'saw' ? 'speed' : b.kind === 'crumble' ? 'delay' : null;
    if (!param || o.pinned.includes(param)) continue;
    for (const step of [1, 2] as const) out.push({ generator: 'speed_up', op: { op: 'tune', entity: o.id, param, step }, tiers: step === 1 ? P_TIERS : C_TIERS, summary_key: 'polish.tune', summary_args: { what: roleNoun(o.role) }, dC: PREDICT.tune_per_step * step, prio: 3 });
  }
  // --- tighten_jump: widen gaps (never beyond g_max − 1), shrink landings ---
  for (const g of sites.gaps) {
    const gm = gMax(res.ctx.profile, Math.min(3, g.runway));
    for (const cells of [1, 2]) {
      if (g.gap + cells > gm - 1) continue;
      out.push({ generator: 'tighten_jump', op: { op: 'widen_gap', gap: gapId(g.a, g.b), cells }, tiers: cells === 1 ? C_TIERS : H_TIERS, summary_key: 'challenge.widen_gap', summary_args: { cells }, dC: PREDICT.widen_per_cell * cells * (g.gap + cells >= 5 ? 1.5 : 1), prio: 4 });
    }
    const land = w.objs.find((o) => o.id === g.b);
    if (land && land.role === 'platform') for (const cells of [1, 2]) out.push({ generator: 'tighten_jump', op: { op: 'shrink_landing', surface: g.b, side: 'right', cells }, tiers: cells === 1 ? C_TIERS : H_TIERS, summary_key: 'challenge.shrink_landing', dC: PREDICT.shrink_per_cell * cells, prio: 4 });
    if (land && land.role === 'platform') for (const [dx, dy] of [[1, 0], [0, -1], [2, 0], [1, -1]] as const) out.push({ generator: 'tighten_jump', op: { op: 'shift_platform', group: g.b, dx, dy }, tiers: Math.abs(dx) + Math.abs(dy) > 1 ? H_TIERS : C_TIERS, summary_key: 'challenge.shift_platform', dC: PREDICT.shift_per_cell * (Math.abs(dx) + Math.abs(dy)), prio: 4 });
  }
  // --- guard_flat: route flats ≥ 8 cells with no threat ---
  const longFlat = new Set(flags.filter((f) => f.code === 'long_flat').map((f) => Math.round(f.at?.[0] ?? -99)));
  for (const s of sites.slots.enemy) {
    const len = s.w ?? 0;
    const flat = sites.flats.find((f) => f.host === s.host && s.x >= f.x0 && s.x <= f.x1);
    if (flat?.threat) continue;
    const target = longFlat.size ? [...longFlat].some((x) => Math.abs(x - s.x) <= 12) : true;
    if (!target) continue;
    if (len >= EDIT_BOUNDS.add_enemy.walker_flat_c) out.push(enemyRaw(s, 'walker', C_TIERS));
    if (len >= EDIT_BOUNDS.add_enemy.hopper_flat_c) out.push(enemyRaw(s, 'hopper', C_TIERS));
    if (len >= 12) out.push(enemyRaw(s, 'chaser', H_TIERS));
    out.push(enemyRaw({ ...s, y: s.y - 3.5, host: null, face: null }, 'flyer', H_TIERS));
  }
  // --- arm_landing: undrawn top faces the route lands on ---
  for (const s of sites.slots.spikes) out.push({ generator: 'arm_landing', op: { op: 'add_spikes', slot: slotId(s) }, tiers: C_TIERS, summary_key: 'challenge.add_spikes', dC: PREDICT.spikes, prio: 5 });
  // --- crumble_landing: landings ≤ 6 cells ---
  for (const g of sites.gaps) {
    const land = w.objs.find((o) => o.id === g.b);
    if (land && land.role === 'platform' && objBBox(land)[2] - objBBox(land)[0] <= EDIT_BOUNDS.make_crumble_max_c) out.push({ generator: 'crumble_landing', op: { op: 'make_crumble', surface: land.id }, tiers: C_TIERS, summary_key: 'challenge.make_crumble', dC: PREDICT.crumble, prio: 5 });
  }
  // --- saw_window: the apex region of gap jumps ---
  for (const s of sites.slots.hazard) {
    out.push({ generator: 'saw_window', op: { op: 'add_hazard', slot: slotId(s), kind: 'saw' }, tiers: C_TIERS, summary_key: 'challenge.add_hazard', summary_args: { what: 'saw' }, dC: PREDICT.saw, prio: 6 });
    if ((s.w ?? 0) > 0) out.push({ generator: 'saw_window', op: { op: 'add_hazard', slot: slotId(s), kind: 'firebar' }, tiers: H_TIERS, summary_key: 'challenge.add_hazard', summary_args: { what: 'fire bar' }, dC: PREDICT.firebar, prio: 6 });
  }
  // --- reprise: an empty stretch ≥ 10 cells after a drawn setpiece (≥ 3 screens) ---
  if (screens >= EDIT_BOUNDS.reprise.min_screens) {
    for (const sp of w.setpieces) {
      const xs = sp.ids.map((id) => w.objs.find((o) => o.id === id)).filter((o) => !!o).map((o) => objBBox(o!)[2]);
      if (!xs.length) continue;
      const after = Math.max(...xs);
      const f = sites.flats.find((x) => x.x0 > after + 4 && x.x1 - x.x0 >= EDIT_BOUNDS.reprise.min_empty_c && !x.threat);
      if (!f) continue;
      const slot = slotId({ kind: 'enemy', x: f.x0 + 2, y: f.y, host: f.host, face: 'top', x0: f.x0, x1: f.x1, w: f.x1 - f.x0 });
      for (const escalation of ['faster', 'plus_spikes', 'plus_saw', 'narrower'] as const) out.push({ generator: 'reprise', op: { op: 'reprise', setpiece: sp.name, slot, escalation }, tiers: C_TIERS, summary_key: 'challenge.reprise', summary_args: { setpiece: sp.name }, dC: PREDICT.reprise, prio: 7 });
    }
  }
  // dedupe by cid
  const seen = new Set<string>();
  return out.filter((c) => {
    const id = editId(c.op);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function trailRaw(res: Resumed, from: [number, number], to: [number, number], kind: string, fixes: string[]): Raw {
  const h = Math.max(1, apexOf(res.ctx.profile, kind) - Math.max(0, from[1] - to[1]) * 0.5);
  const n = Math.max(3, Math.min(7, Math.round(Math.abs(to[0] - from[0]) / 1.5)));
  return { generator: 'trail', op: { op: 'add_coin_trail', action: arcId({ from, to, h: Math.round(h * 4) / 4 }), n }, tiers: P_TIERS, summary_key: 'polish.coin_trail', dC: 0, fixes, prio: 2 };
}

function enemyRaw(s: SlotSpec, archetype: 'walker' | 'hopper' | 'flyer' | 'shooter' | 'chaser' | 'crusher', tiers: Tier[]): Raw {
  return { generator: 'guard_flat', op: { op: 'add_enemy', slot: slotId(s), archetype }, tiers, summary_key: 'challenge.add_enemy', summary_args: { what: archetype }, dC: PREDICT.enemy[archetype] ?? 0.1, prio: 5 };
}

export interface MenuOpts {
  max: number;
  measured?: number;
  maxVerify?: number;
  /** wall-clock budget (ms) for verification; the menu is cut short rather than blowing the tier deadline */
  deadlineMs?: number;
}

/** candidates(base) (§11.3b): the pre-verified menu for a build. */
export function candidates(base: BuildResult, o: MenuOpts): Candidate[] {
  const max = Math.max(1, Math.min(DESIGN.menu_max, o.max ?? DESIGN.menu_max));
  const res = resume(base, 'hard');
  const baseWork = cloneWork(res.w);
  const sites = gatherSites(res.w, base.report);
  const raw = generate(res, res.w, base.report, sites).sort((a, b) => a.prio - b.prio || b.dC - a.dC || editId(a.op).localeCompare(editId(b.op)));
  const verifyCap = o.maxVerify ?? max + 8;
  const out: Candidate[] = [];
  const C0 = base.report.C;
  const F0 = base.report.F;
  const T0 = base.report.fastest_ms;
  const approxBase = !!base.report.approx;
  // repair alternatives (DESIGN repair_choices) were verified by the repair search; they replace each other
  for (const alt of res.w.st.repair_alts) {
    for (const op of alt.options) {
      if (out.length >= max) break;
      out.push({
        cid: editId(op.ops[0]), generator: 'repair', op: op.ops[0], extra_ops: op.ops.slice(1), tiers: ['faithful'], alts: alt.group,
        summary_key: 'repair.required', summary_args: { kind: alt.kind }, dC: 0, dT_s: 0, dF_s: 0, drift: 0,
        intent_cost: Math.round(op.cost * 100) / 100, fixes: [], measured: false,
      });
    }
  }
  let verified = 0;
  const t0 = Date.now();
  const late = (): boolean => o.deadlineMs !== undefined && Date.now() - t0 > o.deadlineMs;
  for (const c of raw) {
    if (out.length >= max || verified >= verifyCap || late()) break;
    const lowest: Tier = c.tiers[0];
    const ops = [c.op, ...(c.extra ?? [])];
    const t = trial(res, baseWork, ops, lowest, { analyze: 'fast' });
    verified++;
    if (t.failed || !t.report) continue;
    const designer = OP_CLASS[c.op.op] === 'P' || OP_CLASS[c.op.op] === 'C';
    const v = checkReport(t.report, { base: base.report, designer, approx: t.approx || approxBase });
    if (v) continue;
    const cost = t.applied.reduce((a, x) => a + x.cost, 0);
    const drift = t.applied.reduce((a, x) => Math.max(a, x.rec.validation?.drift_cells ?? 0), 0);
    const measured = !(t.approx || approxBase);
    out.push({
      cid: editId(c.op), generator: c.generator, op: c.op, extra_ops: c.extra ?? [], tiers: c.tiers, alts: c.alts ?? null,
      summary_key: c.summary_key, summary_args: c.summary_args ?? {},
      dC: Math.round((measured ? t.report.C - C0 : c.dC) * 1000) / 1000,
      dT_s: Math.round((measured ? (t.report.fastest_ms - T0) / 1000 : 0) * 100) / 100,
      dF_s: Math.round((measured ? t.report.F - F0 : 0) * 100) / 100,
      drift, intent_cost: Math.round(cost * 100) / 100, fixes: c.fixes ?? [], measured: false,
    });
  }
  // the top 12 by |dC| are fully measured
  const top = [...out].sort((a, b) => Math.abs(b.dC) - Math.abs(a.dC) || a.cid.localeCompare(b.cid)).slice(0, o.measured ?? DESIGN.measured_top);
  for (const c of top) {
    if (approxBase || late()) break;
    const t = trial(res, baseWork, [c.op, ...(c.extra_ops ?? [])], c.tiers[c.tiers.length - 1], { analyze: 'full' });
    if (!t.report || t.approx) continue;
    c.dC = Math.round((t.report.C - C0) * 1000) / 1000;
    c.dT_s = Math.round(((t.report.fastest_ms - T0) / 1000) * 100) / 100;
    c.dF_s = Math.round((t.report.F - F0) * 100) / 100;
    c.measured = true;
  }
  return out;
}
