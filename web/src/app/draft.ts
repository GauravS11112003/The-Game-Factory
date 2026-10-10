/**
 * The preview's state: §3.11 build events reduced into stages, ink, "What I saw", edits (upsert by id), 4 tiers per
 * stage, asks, the designer note, suggestions, cost, warnings and errors; plus the kid's local decisions (Keep/Undo
 * statuses, re-labels, answers, Fix it, Make it mine) and local rebuild results that override a tier until the server
 * sends a newer one.
 */
import type {
  AskCard, BuildEvent, EditClass, EditOp, EditRecord, EditStatus, EvCost, EvError, EvHello, EvNote, EvSaw, EvStage,
  EvTier, EvWarning, InkDoc, LevelV2, Morph, PlaytestReport, SceneGraph, SceneObject, Stage, StageName, Tier,
} from '../core/types.gen.ts';
import { editId as coreEditId } from '../core/util/ids.ts';

export const TIERS: readonly Tier[] = ['faithful', 'polished', 'normal', 'hard'];
export const STAGES: readonly Stage[] = ['ink', 'understood', 'designed'];
const TIER_RANK: Record<Tier, number> = { faithful: 0, polished: 1, normal: 2, hard: 3 };
const CLASS_ORDER: Record<EditClass, number> = { U: 0, N: 1, R: 2, P: 3, C: 4, K: 5 };

export function tierRank(t: Tier): number {
  return TIER_RANK[t];
}

export interface TierView {
  stage: Stage;
  tier: Tier;
  level: LevelV2;
  report: PlaytestReport;
  editIds: string[];
  reach: boolean;
  morphs: Morph[];
  local: boolean;
  seq: number;
}

export type Change = 'stage' | 'ink' | 'saw' | 'edits' | 'tier' | 'ask' | 'note' | 'suggestions' | 'cost' | 'warning' | 'error' | 'done' | 'hello' | 'kid';

const OP_CLASS: Record<EditOp['op'], EditClass> = {
  set_role: 'U', group: 'U', detach: 'U', bind: 'U', link: 'U', set_start: 'U', use_library: 'U',
  straighten: 'N', close_gap: 'N', snap: 'N', orient: 'N', form_goal: 'N', set_collision: 'N', place_start: 'N', clear_spawn: 'N',
  coin_from_dot: 'N', dedupe: 'N', join_seam: 'N', fix_behavior: 'N', fit_creature: 'N',
  nudge: 'R', trim: 'R', extend: 'R', add_step: 'R', add_spring: 'R',
  add_checkpoint: 'P', add_coin_trail: 'P', add_coin: 'P', add_big_coin: 'P', add_hint_arrow: 'P', tune: 'P', animate: 'P', set_par: 'P',
  widen_gap: 'C', shrink_landing: 'C', shift_platform: 'C', add_spikes: 'C', add_enemy: 'C', add_hazard: 'C', make_crumble: 'C',
  set_timer: 'C', reprise: 'C', make_mine: 'K',
};

export function classOf(op: EditOp): EditClass {
  return OP_CLASS[op.op] ?? 'U';
}

/** The object an op is about (for ids and ghosts). */
export function targetOf(op: EditOp): string {
  const o = op as unknown as Record<string, unknown>;
  for (const k of ['target', 'group', 'flag', 'entity', 'gap', 'surface', 'root', 'key', 'a', 'slot', 'setpiece', 'keep', 'near']) {
    if (typeof o[k] === 'string') return o[k] as string;
  }
  return 'level';
}

/**
 * Stable edit id `op:target:hash6(identity)` (D6): the core's own function, so a kid edit made here carries the same
 * id in the browser core, the Node worker and the server's records (statuses match by id).
 */
export function editId(op: EditOp): string {
  return coreEditId(op);
}

export class DraftModel {
  readonly draftId: string;
  buildId: string | null;
  hello: EvHello | null = null;
  stages = new Map<StageName, EvStage>();
  ink: InkDoc | null = null;
  graph0: SceneGraph | null = null;
  saw: EvSaw | null = null;
  edits = new Map<string, EditRecord>();
  tiers: Partial<Record<Stage, Partial<Record<Tier, EvTier & { seq: number }>>>> = {};
  asks = new Map<string, AskCard>();
  note: EvNote | null = null;
  suggestions = new Map<string, EditRecord>();
  suggestionSource: string | null = null;
  cost: EvCost | null = null;
  warnings: EvWarning[] = [];
  errors: EvError[] = [];
  done = false;
  lastSeq = 0;
  /** The last `tier` event was a rebuild with the kid's edits (server `x_kid`), not a new stage. */
  lastTierFromKid = false;

  // ---- the kid's local state ----
  statuses: Record<string, 'applied' | 'undone'> = {};
  kidEdits = new Map<string, EditRecord>();
  answers: Record<string, string> = {};
  local: Partial<Record<Tier, TierView & { atSeq: number }>> = {};
  tier: Tier = 'polished';
  entityErrors: string[] = [];
  deaths: { x: number; y: number; cause: string; frame: number; segment: string }[] = [];
  attempts = 0;
  /** seq at the time of the kid's last change; server tiers newer than this replace local rebuilds. */
  kidSeq = 0;

  private listeners = new Set<(c: Change) => void>();

  constructor(draftId: string, buildId: string | null) {
    this.draftId = draftId;
    this.buildId = buildId;
  }

  on(fn: (c: Change) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(c: Change): void {
    for (const fn of this.listeners) fn(c);
  }

  apply(e: BuildEvent): void {
    if (e.seq <= this.lastSeq) return;
    this.lastSeq = e.seq;
    this.reduce(e);
  }

  /** Reduce one event without the seq check (events from a side build's own log: critic, redesign). */
  reduce(e: BuildEvent): void {
    switch (e.event) {
      case 'hello':
        this.hello = e.data;
        break;
      case 'stage':
        this.stages.set(e.data.stage, e.data);
        break;
      case 'ink':
        this.ink = e.data.ink;
        this.graph0 = e.data.graph0;
        break;
      case 'saw':
        this.saw = e.data;
        break;
      case 'edits':
        for (const ed of e.data.edits) this.edits.set(ed.id, ed);
        break;
      case 'tier': {
        this.lastTierFromKid = !!(e.data as { x_kid?: boolean }).x_kid;
        const byTier = (this.tiers[e.data.stage] ??= {});
        byTier[e.data.tier] = { ...e.data, seq: e.seq };
        const loc = this.local[e.data.tier];
        if (loc && e.seq > this.kidSeq) delete this.local[e.data.tier];
        break;
      }
      case 'ask':
        this.asks.set(e.data.ask.id, e.data.ask);
        break;
      case 'note':
        this.note = { ...e.data, critique: e.data.critique?.length ? e.data.critique : this.note?.critique ?? [] };
        break;
      case 'suggestions':
        for (const ed of e.data.edits) this.suggestions.set(ed.id, ed);
        this.suggestionSource = e.data.source;
        break;
      case 'cost':
        this.cost = e.data;
        break;
      case 'warning':
        this.warnings.push(e.data);
        break;
      case 'error':
        this.errors.push(e.data);
        if (e.data.message_key === 'error.entity') this.entityErrors.push(e.data.message_key);
        break;
      case 'done':
        this.done = true;
        break;
    }
    this.emit(e.event);
  }

  /** The newest stage that has this tier. */
  stageOf(tier: Tier): Stage | null {
    for (let i = STAGES.length - 1; i >= 0; i--) if (this.tiers[STAGES[i]]?.[tier]) return STAGES[i];
    return null;
  }

  latestStage(): Stage | null {
    for (let i = STAGES.length - 1; i >= 0; i--) if (this.tiers[STAGES[i]] && Object.keys(this.tiers[STAGES[i]]!).length) return STAGES[i];
    return null;
  }

  hasTier(tier: Tier): boolean {
    return this.stageOf(tier) !== null;
  }

  server(tier: Tier): TierView | null {
    const st = this.stageOf(tier);
    const ev = st ? this.tiers[st]![tier]! : null;
    if (!ev || !st) return null;
    return { stage: st, tier, level: ev.level, report: ev.report, editIds: ev.edit_ids, reach: ev.reach, morphs: ev.morphs ?? [], local: false, seq: ev.seq };
  }

  view(tier: Tier = this.tier): TierView | null {
    return this.local[tier] ?? this.server(tier);
  }

  // ---- edits as the kid sees them -----------------------------------------------------------------------------------

  allEdits(): EditRecord[] {
    return [...this.edits.values(), ...this.kidEdits.values()];
  }

  statusOf(e: EditRecord): EditStatus {
    return this.statuses[e.id] ?? e.status;
  }

  /** Edits shown for a tier: everything up to that tier (nested), except suggestions. */
  editsFor(tier: Tier): EditRecord[] {
    const v = this.view(tier);
    const inBuild = new Set(v?.editIds ?? []);
    return this.allEdits()
      .filter((e) => e.status !== 'suggested' || this.statuses[e.id] === 'applied')
      .filter((e) => tierRank(e.tier) <= tierRank(tier) || inBuild.has(e.id))
      .sort((a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || a.id.localeCompare(b.id));
  }

  /** The edit records with the kid's statuses, as `build()` input. */
  buildEdits(): EditRecord[] {
    const out: EditRecord[] = [];
    for (const e of this.edits.values()) {
      const st = this.statuses[e.id];
      if (e.status === 'suggested' && st !== 'applied') continue;
      out.push(st ? { ...e, status: st } : e);
    }
    for (const e of this.suggestions.values()) {
      if (this.statuses[e.id] === 'applied' && !this.edits.has(e.id)) out.push({ ...e, status: 'applied' });
    }
    for (const e of this.kidEdits.values()) out.push(this.statuses[e.id] ? { ...e, status: this.statuses[e.id] } : e);
    return out;
  }

  /** Effective statuses of every applied/undone edit, for PUT /edits and publishing. */
  effectiveStatuses(): Record<string, 'applied' | 'undone'> {
    const out: Record<string, 'applied' | 'undone'> = {};
    for (const e of this.buildEdits()) {
      const s = this.statuses[e.id] ?? e.status;
      if (s === 'applied' || s === 'undone') out[e.id] = s;
    }
    return out;
  }

  setStatus(ids: string[], s: 'applied' | 'undone'): void {
    for (const id of ids) this.statuses[id] = s;
    this.kidSeq = this.lastSeq;
    this.local = {};
    this.emit('kid');
  }

  addKidEdit(op: EditOp, o: { reason_key: string; reason_args?: Record<string, string | number | boolean | null>; tier?: Tier; cid?: string }): EditRecord {
    const id = o.cid ?? editId(op);
    const rec: EditRecord = {
      id, op, class: classOf(op), by: 'kid', stage: this.latestStage() ?? 'ink', tier: o.tier ?? 'faithful', status: 'applied',
      reason_key: o.reason_key, reason_args: o.reason_args ?? {}, reason_text: null, depends_on: [], required: false, group: null,
      validation: null, ghost: null, cid: o.cid ?? null,
    };
    // A new re-label of the same object replaces the old one.
    if (op.op === 'set_role') {
      for (const [k, e] of this.kidEdits) if (e.op.op === 'set_role' && (e.op as { target: string }).target === op.target) this.kidEdits.delete(k);
    }
    this.kidEdits.set(id, rec);
    delete this.statuses[id];
    this.kidSeq = this.lastSeq;
    this.local = {};
    this.emit('kid');
    return rec;
  }

  kidOps(): EditOp[] {
    return [...this.kidEdits.values()].filter((e) => (this.statuses[e.id] ?? 'applied') === 'applied').map((e) => e.op);
  }

  // ---- objects --------------------------------------------------------------------------------------------------------

  objects(tier: Tier = this.tier): SceneObject[] {
    const lv = this.view(tier)?.level;
    return lv?.objects?.length ? lv.objects : this.graph0?.objects ?? [];
  }

  object(id: string): SceneObject | undefined {
    return this.objects().find((o) => o.id === id) ?? this.graph0?.objects.find((o) => o.id === id);
  }

  unansweredAsks(): AskCard[] {
    return [...this.asks.values()].filter((a) => !a.answer && !this.answers[a.id] && !a.default_option);
  }

  /** Safety: from the level meta, else the graph. */
  safety(): string {
    const v = this.view();
    return v?.level.meta?.safety ?? this.graph0?.safety ?? 'unchecked';
  }

  modelMode(): 'live' | 'fake' | 'off' {
    return this.hello?.model ?? 'off';
  }
}
