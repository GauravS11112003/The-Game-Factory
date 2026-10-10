/**
 * Greedy tiers (§3.8 `core/design/greedy.ts`) and model plan application (`core/design/picks.ts`).
 * Tiers are nested (polished ⊂ normal ⊂ hard); all four are precomputed so the dial is an instant swap (D10).
 *
 *   for tier in [polished, normal, hard]:            each tier starts from the previous tier's result
 *     loop until C ∈ target(tier) or the budget is spent or nothing improves:
 *       score(c) = progress_toward_target(c) / max(0.25, intent_cost(c)) − 0.5·[same op used ≥ 3]
 *                  + 0.2·[c sits in the later 60% of its segment]
 *       apply best → invariants → analyze → commit
 *     on overshoot pop ops from the end; if C < band min: reach[tier] = false ("goes up to {band}")
 *
 * Polished raises C only with P6/P7, up to max(C_f, 0.3), after checkpoints → trails → big coins → par.
 */
import type { BuildInput, BuildResult, TierSet } from '../index.ts';
import { DESIGN, DIAL, EDIT_BOUNDS } from '../params.ts';
import type { Band, Candidate, DesignPlanJson, EditOp, EditRecord, MessageRef, NovelOp, Tier } from '../types.gen.ts';
import { finish, prepare } from '../build/build.ts';
import type { Faithful } from '../build/build.ts';
import { checkReport } from '../edits/invariants.ts';
import { OP_CLASS, explain, tierRank } from '../edits/vocabulary.ts';
import { cloneWork, screenOfX } from '../edits/work.ts';
import { parseSlot } from '../edits/slots.ts';
import { editId } from '../util/ids.ts';
import { candidates } from './candidates.ts';
import { resume, trial } from './context.ts';
import type { Resumed } from './context.ts';

type DTier = 'polished' | 'normal' | 'hard';
const DTIERS: DTier[] = ['polished', 'normal', 'hard'];

interface Target {
  lo: number;
  hi: number;
  aim: number;
}

export function targetOf(tier: DTier, Cf: number, wish: string | null | undefined): Target {
  if (tier === 'polished') {
    const lo = Math.max(Cf, DIAL.polished.C_min);
    const hi = Math.max(Cf, wish === 'easy' ? DIAL.wish_easy_C_max : DIAL.polished.C_raise_max);
    return { lo, hi, aim: lo };
  }
  const t = tier === 'normal' ? DIAL.normal : DIAL.hard;
  return { lo: Math.max(t.C[0], Cf), hi: Math.max(t.C[1], Cf + 0.05), aim: Math.max(t.aim, Cf) };
}

function bandName(C: number): Band {
  return C < 0.05 ? 'trivial' : C < 0.3 ? 'easy' : C < 1 ? 'normal' : C < 3 ? 'hard' : 'expert';
}

function opX(op: EditOp): number {
  for (const v of Object.values(op)) {
    if (typeof v !== 'string') continue;
    const s = parseSlot(v);
    if (s) return s.x;
    const m = /^arc\.([0-9.]+)-/.exec(v);
    if (m) return Number(m[1]);
  }
  return 0;
}

function recordOf(c: Candidate, op: EditOp, tier: Tier, by: 'greedy' | 'model', reasonText: string | null, group: string | null): EditRecord {
  const ex = explain(op, null);
  return {
    id: editId(op), op, class: OP_CLASS[op.op], by, stage: 'designed', tier, status: 'applied', reason_key: c.summary_key || ex.reason_key,
    reason_args: c.summary_args ?? {}, reason_text: reasonText, depends_on: [], required: false, group: group ?? ex.group, validation: null,
    ghost: null, reject_reason: null, cid: c.cid,
  };
}

function candRecords(c: Candidate, tier: Tier, by: 'greedy' | 'model', reasonText: string | null = null): EditRecord[] {
  const ops = [c.op, ...(c.extra_ops ?? [])];
  const group = ops.length > 1 ? `cand:${c.cid}` : null;
  return ops.map((op) => recordOf(c, op, tier, by, reasonText, group));
}

interface Eval {
  C: number;
  ok: boolean;
  why: MessageRef | null;
  approx: boolean;
  fastest: number;
  segments: { id: string; F_s: number; T_ms: number }[];
}

class TierRunner {
  readonly res: Resumed;
  readonly base: ReturnType<typeof cloneWork>;
  readonly faithful: BuildResult;
  readonly Cf: number;
  readonly approx: boolean;
  readonly t0: number;
  readonly deadline: number;
  constructor(faithful: BuildResult, deadlineMs: number) {
    this.faithful = faithful;
    this.res = resume(faithful, 'hard');
    this.base = cloneWork(this.res.w);
    this.Cf = faithful.report.C;
    this.approx = !!faithful.report.approx;
    this.t0 = Date.now();
    this.deadline = deadlineMs;
  }
  late(): boolean {
    return Date.now() - this.t0 > this.deadline;
  }
  eval(recs: readonly EditRecord[], tier: Tier, predicted: number): Eval {
    const ops = recs.filter((r) => r.status === 'applied').map((r) => r.op);
    const t = trial(this.res, this.base, ops, tier, { analyze: 'fast' });
    if (t.failed || !t.report) return { C: 0, ok: false, why: { key: 'reject.not_applicable', args: {} }, approx: t.approx, fastest: 0, segments: [] };
    const v = checkReport(t.report, { base: this.faithful.report, designer: true, approx: t.approx || this.approx });
    const approx = t.approx || this.approx;
    return { C: approx ? this.Cf + predicted : t.report.C, ok: !v, why: v, approx, fastest: t.report.fastest_ms, segments: t.report.segments.map((s) => ({ id: s.id, F_s: s.F_s, T_ms: s.T_ms })) };
  }
}

interface Budget {
  pPerScreen: Map<number, number>;
  cPerScreen: Map<number, number>;
  tunes: number;
  opCount: Map<string, number>;
}

function budgetOk(b: Budget, c: Candidate, tier: DTier): boolean {
  const x = opX(c.op);
  const s = screenOfX(x);
  const cls = OP_CLASS[c.op.op];
  const isCoin = c.op.op === 'add_coin' || c.op.op === 'add_coin_trail' || c.op.op === 'add_big_coin';
  if (cls === 'P' && !isCoin) {
    if (c.op.op === 'tune' && b.tunes >= DESIGN.budgets.polished_tune) return false;
    if (c.op.op !== 'tune' && c.op.op !== 'set_par' && (b.pPerScreen.get(s) ?? 0) >= DESIGN.budgets.polished_P_per_screen) return false;
  }
  if (cls === 'C' && (b.cPerScreen.get(s) ?? 0) >= DESIGN.budgets.challenging_C_per_screen) return false;
  void tier;
  return true;
}

function charge(b: Budget, c: Candidate): void {
  const s = screenOfX(opX(c.op));
  const cls = OP_CLASS[c.op.op];
  if (c.op.op === 'tune') b.tunes++;
  if (cls === 'P' && c.op.op !== 'add_coin' && c.op.op !== 'add_coin_trail' && c.op.op !== 'add_big_coin' && c.op.op !== 'tune') b.pPerScreen.set(s, (b.pPerScreen.get(s) ?? 0) + 1);
  if (cls === 'C') b.cPerScreen.set(s, (b.cPerScreen.get(s) ?? 0) + 1);
  b.opCount.set(c.op.op, (b.opCount.get(c.op.op) ?? 0) + 1);
}

const POLISH_PHASES: readonly string[][] = [['checkpoint', 'fix_flag'], ['trail'], ['risk_coin'], ['animate', 'speed_up']];

/** Greedy completion of one tier, starting from `start` records. Returns the tier's own records. */
function greedyTier(T: TierRunner, menu: Candidate[], tier: DTier, start: EditRecord[], wish: string | null | undefined, band: Band | undefined, used: Set<string>, startPred: number): { recs: EditRecord[]; C: number; pred: number } {
  const tgt = targetOf(tier, T.Cf, wish);
  void band;
  const recs: EditRecord[] = [];
  const all = (): EditRecord[] => [...start, ...recs];
  let pred = startPred;
  let cur = T.eval(all(), tier, pred);
  let C = cur.ok ? cur.C : T.Cf;
  const b: Budget = { pPerScreen: new Map(), cPerScreen: new Map(), tunes: 0, opCount: new Map() };
  for (const r of start) {
    const c = menu.find((m) => m.cid === r.cid);
    if (c) charge(b, c);
  }
  const allowed = (c: Candidate): boolean => c.tiers.includes(tier) && !used.has(c.cid) && c.alts == null && budgetOk(b, c, tier);
  const commit = (c: Candidate): boolean => {
    const add = candRecords(c, tier, 'greedy');
    const ev = T.eval([...all(), ...add], tier, pred + c.dC);
    used.add(c.cid);
    if (!ev.ok) return false;
    if (!ev.approx && tier !== 'polished' && ev.C <= C + 1e-4 && c.dC > 0) return false;
    recs.push(...add);
    pred += c.dC;
    C = ev.C;
    cur = ev;
    charge(b, c);
    return true;
  };
  if (tier === 'polished') {
    for (const phase of POLISH_PHASES) {
      if (T.late()) break;
      const pool = menu.filter((c) => phase.includes(c.generator) && allowed(c)).sort((a, c) => a.intent_cost - c.intent_cost || a.cid.localeCompare(c.cid));
      for (const c of pool) {
        if (T.late()) break;
        if (!allowed(c)) continue;
        const raises = c.generator === 'animate' || c.generator === 'speed_up';
        if (raises && (C >= tgt.lo || C + c.dC > tgt.hi + 1e-6)) continue;
        if (c.generator === 'checkpoint' && !cur.approx && cur.segments.length && !cur.segments.some((s) => s.F_s > EDIT_BOUNDS.checkpoint.max_F_s || s.T_ms / 1000 > EDIT_BOUNDS.checkpoint.max_T_s)) continue;
        // a few strong moves: at most one big star per screen from the greedy designer
        if (c.generator === 'risk_coin' && recs.filter((r) => r.op.op === 'add_big_coin').length >= Math.max(1, T.res.w.world.screens)) continue;
        commit(c);
      }
    }
    return { recs, C, pred };
  }
  for (let step = 0; step < 10 && C < tgt.lo - 1e-6 && !T.late(); step++) {
    const scored = menu.filter(allowed).map((c) => {
      const progress = Math.min(Math.max(0, c.dC), Math.max(0, tgt.hi - C));
      const repeat = (b.opCount.get(c.op.op) ?? 0) >= 3 ? 0.5 : 0;
      const late = 0.2 * (lateInSegment(c) ? 1 : 0);
      return { c, s: progress / Math.max(DESIGN.greedy.min_cost, c.intent_cost) - repeat + late };
    }).filter((x) => x.c.dC > 0).sort((a, b2) => b2.s - a.s || a.c.cid.localeCompare(b2.c.cid));
    let done = false;
    for (const { c } of scored.slice(0, 3)) {
      if (commit(c)) {
        done = true;
        break;
      }
    }
    if (!done) break;
  }
  // overshoot: pop from the end while above the band
  while (C >= tgt.hi && recs.length) {
    const last = recs[recs.length - 1];
    const group = last.group?.startsWith('cand:') ? last.group : null;
    while (recs.length && (group ? recs[recs.length - 1].group === group : recs[recs.length - 1] === last)) recs.pop();
    const c = menu.find((m) => m.cid === last.cid);
    pred -= c?.dC ?? 0;
    const ev = T.eval(all(), tier, pred);
    C = ev.ok ? ev.C : C;
  }
  return { recs, C, pred };
}

function lateInSegment(c: Candidate): boolean {
  const x = opX(c.op);
  const local = x - Math.floor(x / 48) * 48;
  return local >= 48 * (1 - DESIGN.greedy.late_frac);
}

/** Each flag carries the menu rows that fix it, so "How it plays" can offer Fix it (§4.3). */
function attachFixes(r: BuildResult, menu: readonly Candidate[]): void {
  for (const f of r.report.flags) f.fix_cids = menu.filter((c) => (c.fixes ?? []).includes(f.id)).map((c) => c.cid);
  if (r.level.design) r.level.design.flags = r.report.flags;
}

function nested(recsByTier: Record<DTier, EditRecord[]>, tier: Tier): EditRecord[] {
  const r = tierRank(tier);
  return DTIERS.filter((t) => tierRank(t) <= r).flatMap((t) => recsByTier[t]);
}

function assembleTiers(i: Omit<BuildInput, 'tier'>, f: Faithful, faithful: BuildResult, recsByTier: Record<DTier, EditRecord[]>, menu: Candidate[], extra: EditRecord[], o: { band?: Band }, t0: number): TierSet {
  const base = [...(i.edits ?? []), ...extra];
  const res: Partial<Record<DTier, BuildResult>> = {};
  for (const t of DTIERS) res[t] = finish({ ...i, tier: t, edits: [...base, ...nested(recsByTier, t)] }, f, t0);
  const Cs = { polished: res.polished!.report.C, normal: res.normal!.report.C, hard: res.hard!.report.C };
  const reach = {
    polished: true,
    normal: res.normal!.report.approx ? recsByTier.normal.length > 0 || faithful.report.C >= DIAL.normal.C[0] : Cs.normal >= DIAL.normal.C[0] - 1e-6,
    hard: res.hard!.report.approx ? recsByTier.hard.length > 0 || faithful.report.C >= DIAL.hard.C[0] : Cs.hard >= DIAL.hard.C[0] - 1e-6,
  };
  const top = Math.max(Cs.polished, Cs.normal, Cs.hard);
  const why: MessageRef | undefined = !reach.normal || !reach.hard ? { key: 'reach.goes_up_to', args: { band: bandName(top) } } : undefined;
  void o;
  return { faithful, polished: res.polished!, normal: res.normal!, hard: res.hard!, reach, ...(why ? { why } : {}), menu };
}

/** buildTiers (§11.3b): the Faithful build, its menu, and the three nested greedy tiers. */
export function buildTiers(i: Omit<BuildInput, 'tier'>, o: { deadlineMs: number; band?: Band }): TierSet {
  const t0 = Date.now();
  const input: BuildInput = { ...i, tier: 'faithful' } as BuildInput;
  const f = prepare(input);
  const faithful = finish(input, f, t0);
  const D = Math.max(1000, o.deadlineMs ?? 3000);
  const menu = candidates(faithful, { max: DESIGN.menu_max, deadlineMs: Math.max(300, D * 0.4 - (Date.now() - t0)) });
  const T = new TierRunner(faithful, Math.max(300, D * 0.8 - (Date.now() - t0)));
  // what the kid undid is never re-picked; accepted suggestions are part of every tier they belong to
  const used = new Set<string>((i.edits ?? []).filter((e) => e.status === 'undone').flatMap((e) => [e.id, e.cid ?? '']).filter(Boolean));
  const fixed = (i.edits ?? []).filter((e) => (e.class === 'P' || e.class === 'C') && e.status === 'applied');
  for (const e of fixed) {
    used.add(e.id);
    if (e.cid) used.add(e.cid);
  }
  const recsByTier: Record<DTier, EditRecord[]> = { polished: [], normal: [], hard: [] };
  let pred = 0;
  const wish = faithful.graph.difficulty_wish;
  for (const t of DTIERS) {
    const prev = nested(recsByTier, t === 'polished' ? 'faithful' : t === 'normal' ? 'polished' : 'normal');
    const start = [...fixed.filter((e) => tierRank(e.tier) <= tierRank(t)), ...prev];
    const g = greedyTier(T, menu, t, start, wish, o.band, used, pred);
    recsByTier[t] = g.recs;
    pred = g.pred;
  }
  attachFixes(faithful, menu);
  return assembleTiers(i, f, faithful, recsByTier, menu, [], o, t0);
}

// ---- applyPlan (model picks) ---------------------------------------------------------------------

function tierOfPick(t: string): DTier {
  return t === 'polish' || t === 'polished' ? 'polished' : t === 'hard' ? 'hard' : 'normal';
}

function novelToOp(n: NovelOp): EditOp | null {
  switch (n.op) {
    case 'add_enemy':
      return { op: 'add_enemy', slot: n.slot, archetype: n.archetype };
    case 'add_spikes':
      return { op: 'add_spikes', slot: n.slot };
    case 'add_big_coin':
      return { op: 'add_big_coin', slot: n.slot };
    case 'add_checkpoint':
      return { op: 'add_checkpoint', slot: n.slot };
    case 'tune':
      return { op: 'tune', entity: n.target, param: n.param, step: n.step };
    case 'make_crumble':
      return { op: 'make_crumble', surface: n.target };
    case 'reprise':
      return { op: 'reprise', setpiece: n.setpiece, slot: n.slot, escalation: n.escalation };
  }
}

function novelTier(n: NovelOp): DTier {
  return 'tier' in n ? tierOfPick(n.tier) : 'polished';
}

/** applyPlan (§3.8 apply per tier): model picks in order, invariants per op, the bot every 3rd op, greedy completes. */
export function applyPlan(i: Omit<BuildInput, 'tier'>, menu: Candidate[], plan: DesignPlanJson): TierSet & { rejected: { cid: string; why: string }[] } {
  const t0 = Date.now();
  const rejected: { cid: string; why: string }[] = [];
  const byCid = new Map(menu.map((c) => [c.cid, c] as const));
  // repair choices and vetoes become input edit statuses (the Faithful base changes)
  const extra: EditRecord[] = [];
  const pre: BuildInput = { ...i, tier: 'faithful' } as BuildInput;
  let f = prepare(pre);
  for (const rc of plan.repair_choices ?? []) {
    const alt = f.work.st.repair_alts.find((a) => a.group === rc.alts);
    const opt = alt?.options.find((x) => x.cid === rc.cid);
    if (!alt || !opt) {
      rejected.push({ cid: rc.cid, why: 'unknown_alt' });
      continue;
    }
    if (alt.chosen.includes(rc.cid)) continue;
    for (const id of alt.chosen) {
      const rec = f.records.find((r) => r.id === id);
      if (rec) extra.push({ ...rec, status: 'undone' });
    }
    for (const op of opt.ops) extra.push({ id: editId(op), op, class: OP_CLASS[op.op], by: 'model', stage: 'designed', tier: 'faithful', status: 'applied', reason_key: 'repair.required', reason_args: {}, reason_text: rc.reason ?? null, depends_on: [], required: true, group: 'repair', validation: null, ghost: null, reject_reason: null, cid: rc.cid });
  }
  for (const v of plan.vetoes ?? []) {
    const rec = f.records.find((r) => r.id === v.edit_id);
    if (!rec || rec.required || rec.class !== 'N') {
      rejected.push({ cid: v.edit_id, why: 'not_vetoable' });
      continue;
    }
    extra.push({ ...rec, status: 'undone', reason_text: v.reason ?? null });
  }
  const iWith = { ...i, edits: [...(i.edits ?? []), ...extra] };
  if (extra.length) f = prepare({ ...iWith, tier: 'faithful' } as BuildInput);
  const faithful = finish({ ...iWith, tier: 'faithful' } as BuildInput, f, t0);
  const T = new TierRunner(faithful, 4000);
  const used = new Set<string>();
  const recsByTier: Record<DTier, EditRecord[]> = { polished: [], normal: [], hard: [] };
  let pred = 0;
  const seenAlts = new Set<string>();
  for (const t of DTIERS) {
    const start = nested(recsByTier, t === 'polished' ? 'faithful' : t === 'normal' ? 'polished' : 'normal');
    const mine: EditRecord[] = [];
    let since = 0;
    const tgt = targetOf(t, faithful.report.C, faithful.graph.difficulty_wish);
    let C = faithful.report.C;
    const tryAdd = (recs: EditRecord[], cid: string, dC: number, force: boolean): void => {
      const cand = [...start, ...mine, ...recs];
      since++;
      if (force || since >= 3) {
        const ev = T.eval(cand, t, pred + dC);
        since = 0;
        if (!ev.ok) {
          rejected.push({ cid, why: ev.why?.key ?? 'rejected' });
          return;
        }
        C = ev.C;
      } else {
        const tr = trial(T.res, T.base, cand.map((r) => r.op), t, { analyze: false });
        if (tr.failed) {
          rejected.push({ cid, why: 'reject.not_applicable' });
          return;
        }
      }
      mine.push(...recs);
      pred += dC;
    };
    const picks = (plan.picks ?? []).filter((p) => tierOfPick(p.tier) === t);
    picks.forEach((p, k) => {
      const c = byCid.get(p.cid);
      if (!c) {
        rejected.push({ cid: p.cid, why: 'unknown_cid' });
        return;
      }
      if (used.has(c.cid)) return;
      if (c.alts && seenAlts.has(c.alts)) {
        rejected.push({ cid: p.cid, why: 'alts_conflict' });
        return;
      }
      if (!c.tiers.includes(t)) {
        rejected.push({ cid: p.cid, why: 'tier' });
        return;
      }
      used.add(c.cid);
      if (c.alts) seenAlts.add(c.alts);
      tryAdd(candRecords(c, t, 'model', (p.reason ?? '').slice(0, 90) || null), c.cid, c.dC, k === picks.length - 1);
    });
    const novel = (plan.novel ?? []).filter((n) => novelTier(n) === t).slice(0, 3);
    novel.forEach((n, k) => {
      const op = novelToOp(n);
      if (!op) return;
      const cid = editId(op);
      if (used.has(cid)) return;
      used.add(cid);
      const pseudo: Candidate = { cid, generator: 'novel', op, extra_ops: [], tiers: [t], alts: null, summary_key: explain(op, null).reason_key, summary_args: {}, dC: 0.08, dT_s: 0, dF_s: 0, drift: 0, intent_cost: 1, fixes: [], measured: false };
      tryAdd(candRecords(pseudo, t, 'model', (n.reason ?? '').slice(0, 90) || null), cid, 0.08, k === novel.length - 1);
    });
    // undershoot → greedy completes; overshoot → pop model ops from the end
    if (t !== 'polished' && C < tgt.lo) {
      const g = greedyTier(T, menu, t, [...start, ...mine], faithful.graph.difficulty_wish, undefined, used, pred);
      mine.push(...g.recs);
      pred = g.pred;
      C = g.C;
    }
    while (t !== 'polished' && C >= tgt.hi && mine.length) {
      const last = mine.pop()!;
      rejected.push({ cid: last.cid ?? last.id, why: 'overshoot' });
      const ev = T.eval([...start, ...mine], t, pred);
      C = ev.ok ? ev.C : C;
    }
    recsByTier[t] = mine;
  }
  const ts = assembleTiers(iWith, f, faithful, recsByTier, menu, [], {}, t0);
  return { ...ts, rejected };
}
