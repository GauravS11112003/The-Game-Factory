/**
 * Intent invariants I1-I8 (§3.6), checked after every edit; a violation rejects the edit.
 * Geometric invariants (I1, I2, I4, I5, I7-geometry, I8) are checked here on the Work; the bot-backed ones
 * (I3 route order, I6 solvable + no new hard flag, I7 C ≥ C_faithful) on the reports, by checkReport().
 */
import { EDIT_BOUNDS, FLAGS, INVARIANTS } from '../params.ts';
import type { EditClass, EditOp, Flag, MessageRef, PlaytestReport, SceneObject, Tier } from '../types.gen.ts';
import { roleFamily } from '../scene/roles.ts';
import { objBBox, objLength, isKid, screenOfX } from './work.ts';
import type { Work } from './work.ts';

const EXEMPT_I1: ReadonlySet<EditOp['op']> = new Set(['coin_from_dot', 'dedupe', 'form_goal', 'make_mine', 'detach']);
const R_ADDED = /^e_(step|spring)_/;

function rej(key: string, args: MessageRef['args'] = {}): MessageRef {
  return { key, args };
}

/** I1: every kid object survives with its role family (roles change only through U-ops). */
function i1(before: Work, after: Work, op: EditOp, cls: EditClass): MessageRef | null {
  if (cls === 'U' || cls === 'K' || EXEMPT_I1.has(op.op)) return null;
  const fam = new Map(after.objs.map((o) => [o.id, roleFamily(o.role)] as const));
  for (const o of before.objs) {
    if (!isKid(o)) continue;
    const f = fam.get(o.id);
    if (f === undefined || f !== roleFamily(o.role)) return rej('reject.intent', { what: o.id });
  }
  return null;
}

/** I2: drift budgets (R ≤ 3 per object, ≤ 8 per level; designer Polished 0 / Normal ≤ 1 / Hard ≤ 2, ≤ 10 per level). */
function i2(after: Work, tier: Tier, cls: EditClass, op: EditOp): MessageRef | null {
  const I = INVARIANTS.I2;
  for (const [k, v] of Object.entries(after.st.drift)) {
    const [kind] = k.split(':');
    if (kind === 'r' && v > I.repair_per_object_c) return rej('reject.out_of_bounds', { cells: I.repair_per_object_c });
    if (kind === 'd') {
      const lim = I.designer_per_object_c[tier === 'faithful' ? 'polished' : tier];
      if (v > lim) return rej('reject.out_of_bounds', { cells: lim });
    }
  }
  if (after.st.drift_r > I.repair_per_level_c) return rej('reject.out_of_bounds', { cells: I.repair_per_level_c });
  if (after.st.drift_d > I.designer_per_level_c) return rej('reject.out_of_bounds', { cells: I.designer_per_level_c });
  if (cls === 'C' && op.op === 'shift_platform' && tier === 'polished') return rej('reject.out_of_bounds');
  return null;
}

function behaviorParams(o: SceneObject): Record<string, unknown> {
  const b = o.behavior as unknown as Record<string, unknown> | null;
  if (!b) return { kind: 'static' };
  const flat: Record<string, unknown> = { ...b };
  if (b.params && typeof b.params === 'object') Object.assign(flat, b.params as Record<string, unknown>);
  return flat;
}

/** I4: text-pinned params never change (except by the kid). */
function i4(before: Work, after: Work, cls: EditClass, by: string): MessageRef | null {
  if (by === 'kid' || cls === 'U') return null;
  const idx = new Map(after.objs.map((o) => [o.id, o] as const));
  for (const o of before.objs) {
    if (!o.pinned.length) continue;
    const n = idx.get(o.id);
    if (!n) continue;
    if (o.pinned.includes('role') && n.role !== o.role) return rej('reject.pinned');
    const bp = behaviorParams(o);
    const np = behaviorParams(n);
    for (const p of o.pinned) {
      if (p === 'role') continue;
      const key = p === 'archetype' ? 'archetype' : p;
      if (key === 'archetype') {
        if ((bp.archetype ?? bp.kind) !== (np.archetype ?? np.kind)) return rej('reject.pinned');
      } else if (JSON.stringify(bp[key]) !== JSON.stringify(np[key])) return rej('reject.pinned');
    }
  }
  return null;
}

/** I5: added content looks added (designer origin and role_by). */
function i5(after: Work): MessageRef | null {
  for (const id of after.st.added) {
    const o = after.objs.find((x) => x.id === id);
    if (o && o.origin !== 'designer' && o.origin !== 'kid') return rej('reject.intent');
  }
  return null;
}

/** I7 (geometry): designer tiers never shrink or remove kid hazards or enemies. */
function i7geom(base: Work | null, after: Work, cls: EditClass): MessageRef | null {
  if (!base || (cls !== 'P' && cls !== 'C')) return null;
  const idx = new Map(after.objs.map((o) => [o.id, o] as const));
  for (const o of base.objs) {
    if (!isKid(o) || (o.role !== 'spikes' && o.role !== 'enemy' && o.role !== 'saw' && o.role !== 'lava')) continue;
    const n = idx.get(o.id);
    if (!n || n.role !== o.role) return rej('reject.easier');
    if (o.role === 'spikes' && objLength(n) + 1e-6 < objLength(o)) return rej('reject.easier');
    const ob = o.behavior;
    const nb = n.behavior;
    if (ob && ob.kind === 'enemy' && (!nb || nb.kind !== 'enemy')) return rej('reject.easier');
  }
  return null;
}

/** I8: the drawing stays the star. */
function i8(after: Work, tier: Tier): MessageRef | null {
  const added = after.objs.filter((o) => o.origin === 'designer' && o.role !== 'coin' && o.role !== 'big_coin' && !R_ADDED.test(o.id) && !o.rel.part_of);
  if (!added.length) return null;
  const kid = after.objs.filter((o) => isKid(o) && !o.rel.part_of).length;
  const lim = Math.max(EDIT_BOUNDS.added_non_coin.min, Math.floor(EDIT_BOUNDS.added_non_coin.kid_frac * kid));
  if (added.length > lim) return rej('reject.budget');
  const per = tier === 'polished' ? EDIT_BOUNDS.added_non_coin.polished_per_screen : EDIT_BOUNDS.added_non_coin.challenging_per_screen;
  const n = new Map<number, number>();
  for (const o of added) {
    const b = objBBox(o);
    const s = screenOfX((b[0] + b[2]) / 2);
    n.set(s, (n.get(s) ?? 0) + 1);
  }
  // checkpoints are pacing, not content: they have their own per-screen bound (P1)
  for (const [s, c] of n) {
    const cps = added.filter((o) => o.role === 'checkpoint' && screenOfX(objBBox(o)[0]) === s).length;
    if (c - cps > per) return rej('reject.budget');
  }
  return null;
}

export interface InvariantCtx {
  base: Work | null; // the Faithful base (I2 drift reference, I7)
  tier: Tier;
  cls: EditClass;
  by: string;
}

/** Geometric invariants after one op; null when they hold. */
export function checkGeometry(before: Work, after: Work, op: EditOp, c: InvariantCtx): MessageRef | null {
  return i1(before, after, op, c.cls) ?? i2(after, c.tier, c.cls, op) ?? i4(before, after, c.cls, c.by) ?? i5(after) ?? i7geom(c.base, after, c.cls) ?? (c.cls === 'P' || c.cls === 'C' ? i8(after, c.tier) : null);
}

export function hardFlags(r: PlaytestReport): Flag[] {
  return (r.flags ?? []).filter((f) => f.severity === 'hard' || f.severity === 'block');
}

function flagKey(f: Flag): string {
  return `${f.code}|${[...(f.object_ids ?? [])].sort().join(',')}|${f.at ? `${Math.round(f.at[0])}` : ''}`;
}

/** Hard flags in `r` that the Faithful report did not have (I6). */
export function newHardFlags(base: PlaytestReport | null, r: PlaytestReport): Flag[] {
  const had = new Set((base ? hardFlags(base) : []).map(flagKey));
  const hadCodes = new Set((base ? hardFlags(base) : []).map((f) => f.code));
  return hardFlags(r).filter((f) => f.code !== 'unsolvable' && !had.has(flagKey(f)) && !(f.code === 'long_segment' && hadCodes.has('long_segment')));
}

/** I3: setpieces appear on the new critical path in the same order (ordered subsequence). */
export function setpieceOrderHolds(base: PlaytestReport | null, r: PlaytestReport): boolean {
  if (!base || !base.setpiece_order?.length) return true;
  const seq = r.setpiece_order ?? [];
  let j = 0;
  for (const s of seq) if (j < base.setpiece_order.length && s === base.setpiece_order[j]) j++;
  return j === base.setpiece_order.length;
}

export interface ReportCheck {
  base: PlaytestReport | null; // Faithful report
  designer: boolean; // P/C tiers: I7 C floor applies
  approx: boolean; // the bot was unavailable: only structural checks
}

/** Bot-backed invariants (I3, I6, I7) for a candidate report. */
export function checkReport(r: PlaytestReport, c: ReportCheck): MessageRef | null {
  if (!r.solvable) return rej('reject.unsolvable');
  if (c.approx) return null;
  const nf = newHardFlags(c.base, r);
  if (nf.length) return rej('reject.new_hard_flag', { flag: nf[0].code });
  if (!setpieceOrderHolds(c.base, r)) return rej('reject.setpiece', { setpiece: c.base?.setpiece_order?.[0] ?? '' });
  if (c.designer && c.base && r.C + 1e-6 < c.base.C && c.base.C >= FLAGS.trivial_C) return rej('reject.easier');
  return null;
}
