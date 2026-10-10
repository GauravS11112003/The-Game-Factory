/**
 * The edit runner: applies ops to the Work as EditRecords with stable ids (D6), honouring the statuses the caller
 * passed in (an `undone` edit is recorded but never applied), clamping bounds, checking the geometric invariants,
 * and rolling back on failure (status `rejected` with a reason). Every stage of build() goes through it.
 */
import type { EditBy, EditClass, EditOp, EditRecord, EditStatus, MessageArgs, Stage, Tier } from '../types.gen.ts';
import { applyOp, clampOp } from '../edits/apply.ts';
import type { Outcome } from '../edits/apply.ts';
import { intentCost } from '../edits/cost.ts';
import { checkGeometry } from '../edits/invariants.ts';
import { OP_CLASS, explain } from '../edits/vocabulary.ts';
import { cloneWork } from '../edits/work.ts';
import type { Ctx, Work } from '../edits/work.ts';
import { editId } from '../util/ids.ts';

export interface RunMeta {
  by: EditBy;
  stage: Stage;
  tier?: Tier;
  cls?: EditClass;
  required?: boolean;
  depends_on?: string[];
  group?: string | null;
  reason_text?: string | null;
  reason_key?: string;
  reason_args?: MessageArgs;
  cid?: string | null;
  /** record a failed precondition as `rejected` (designer and model edits); N edits that do not apply are silent */
  recordFailures?: boolean;
  /** skip the geometric invariants (the normalizer's own bounded ops) */
  skipInvariants?: boolean;
}

export interface Applied {
  rec: EditRecord;
  outcome: Outcome | null;
  cost: number;
}

export class Runner {
  w: Work;
  readonly ctx: Ctx;
  base: Work | null;
  readonly records: EditRecord[] = [];
  readonly rejected: EditRecord[] = [];
  private readonly statuses: Map<string, EditStatus>;
  private readonly seen = new Set<string>();

  constructor(w: Work, ctx: Ctx, input: readonly EditRecord[], base: Work | null = null) {
    this.w = w;
    this.ctx = ctx;
    this.base = base;
    // statuses by record id, and by the op's own stable id (in case a producer keyed the record differently)
    this.statuses = new Map<string, EditStatus>();
    for (const e of input) {
      this.statuses.set(e.id, e.status);
      try {
        const k = editId(e.op);
        if (!this.statuses.has(k) || e.status === 'undone') this.statuses.set(k, e.status);
      } catch {
        /* a malformed op keeps its record id only */
      }
    }
  }

  statusOf(id: string): EditStatus | undefined {
    return this.statuses.get(id);
  }

  isUndone(op: EditOp): boolean {
    return this.statuses.get(editId(op)) === 'undone';
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** Apply one op. Returns null when it was skipped silently (an N op that does not apply, or a duplicate). */
  run(opIn: EditOp, m: RunMeta): Applied | null {
    const tier = m.tier ?? this.ctx.tier;
    const op = clampOp(opIn, tier);
    const id = editId(opIn);
    if (this.seen.has(id)) return null;
    const cls = m.cls ?? OP_CLASS[op.op];
    const recBase = (status: EditStatus): EditRecord => ({
      id, op, class: cls, by: m.by, stage: m.stage, tier, status, reason_key: m.reason_key ?? explain(op, null).reason_key,
      reason_args: m.reason_args ?? {}, reason_text: m.reason_text ?? null, depends_on: m.depends_on ?? [],
      required: !!m.required, group: m.group ?? explain(op, null).group, validation: null, ghost: null, reject_reason: null,
      cid: m.cid ?? null,
    });
    if (this.statuses.get(id) === 'undone') {
      this.seen.add(id);
      const r = recBase('undone');
      this.records.push(r);
      return { rec: r, outcome: null, cost: 0 };
    }
    const before = cloneWork(this.w);
    const res = applyOp(this.w, op, this.ctx, { id, by: m.by, tier, cls });
    if (!res.ok) {
      this.w = before;
      if (!m.recordFailures) return null;
      this.seen.add(id);
      const r = { ...recBase('rejected'), reject_reason: res.why };
      this.rejected.push(r);
      return { rec: r, outcome: null, cost: 0 };
    }
    if (res.noop) {
      this.w = before;
      return null;
    }
    if (!m.skipInvariants) {
      const v = checkGeometry(before, this.w, op, { base: this.base, tier, cls, by: m.by });
      if (v) {
        this.w = before;
        if (!m.recordFailures) return null;
        this.seen.add(id);
        const r = { ...recBase('rejected'), reject_reason: v };
        this.rejected.push(r);
        return { rec: r, outcome: null, cost: 0 };
      }
    }
    this.seen.add(id);
    const ex = explain(op, res);
    const drift = res.moved.reduce((a, mv) => Math.max(a, Math.abs(mv.dx) + Math.abs(mv.dy)), 0);
    const rec: EditRecord = {
      ...recBase('applied'),
      reason_key: m.reason_key ?? ex.reason_key,
      reason_args: { ...ex.reason_args, ...(m.reason_args ?? {}) },
      group: m.group !== undefined ? m.group : ex.group,
      validation: { solvable: true, flags: [], drift_cells: Math.round(drift * 100) / 100, dC: 0 },
      ghost: res.ghost,
    };
    this.records.push(rec);
    return { rec, outcome: res, cost: intentCost(before, op, res) };
  }

  /** Take over records produced by an earlier runner on the same work (the Faithful snapshot). */
  adopt(records: readonly EditRecord[], rejected: readonly EditRecord[]): void {
    for (const r of records) {
      this.records.push(r);
      this.seen.add(r.id);
    }
    for (const r of rejected) {
      this.rejected.push(r);
      this.seen.add(r.id);
    }
  }

  /** Remove a record (and its effect is the caller's business: used when a sandbox is discarded). */
  forget(id: string): void {
    this.seen.delete(id);
    const i = this.records.findIndex((r) => r.id === id);
    if (i >= 0) this.records.splice(i, 1);
  }
}
