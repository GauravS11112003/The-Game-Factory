/**
 * Strokes → objects while the kid draws (v3 lane 2, "Firefly brings it to life").
 *
 * Groups follow what the kid sees: when the live hints are current, a group is one perceived object (its parts
 * folded in, the same objects the role chips label); strokes the hints have not seen yet are clustered by touch.
 * Without hints at all, strokes cluster by touch and colour (black detail inside a coloured shape joins it).
 *
 * A group is "settled" once none of its strokes changed for `settleMs` (800 ms) and the hints caught up (or have
 * been resting for a while). Events: `changed` (new or edited group, not settled), `settled`, `removed`
 * (erased, or merged into another group). Group ids are stable across edits: a regrouped object keeps the id of the
 * previous group it shares the most strokes with, and ids can be seeded from a saved session.
 */
import type { InkStroke, RectCells, Role, SceneObject } from '../core/types.gen.ts';
import { roleChip } from '../app/messages.ts';
import { bindingTag } from './chips.ts';
import { strokeBBox, unionBBox } from './geom.ts';
import type { EditorHandle } from './index.ts';

export interface StrokeGroup {
  group_id: string;
  stroke_ids: string[];
  bbox_cells: RectCells;
  /** The role chip label the kid sees ("Monster"), plus a binding tag or a typed rule bound to it. */
  hint: string | null;
  role: Role | null;
  /** Geometry + binding fingerprint: equal fingerprints draw the same picture. */
  fp: string;
}

export type GroupEventKind = 'settled' | 'changed' | 'removed';

export interface GroupEvent {
  kind: GroupEventKind;
  group: StrokeGroup;
}

export interface GrouperSource {
  strokes(): readonly InkStroke[];
  /** Perceived objects of the current drawing; null while the hints are out of date (or not available). */
  objects?(): readonly SceneObject[] | null;
  /** A typed rule bound to one of these strokes, if any. */
  ruleText?(strokeIds: ReadonlySet<string>): string | null;
  onChange(fn: () => void): () => void;
}

export interface GrouperOptions {
  settleMs?: number;
  /** Groups remembered from an earlier session (ids are reused for the same strokes). */
  seed?: { group_id: string; stroke_ids: string[] }[];
  /** How long to wait for the hints before settling on touch clustering alone. */
  staleMaxMs?: number;
}

interface Tracked {
  group: StrokeGroup;
  changedAt: number;
  settled: boolean;
}

const TICK_MS = 250;

let idSeq = 0;
function newGroupId(): string {
  idSeq++;
  return `g${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** FNV-1a, 32-bit, hex. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const strokeFpCache = new WeakMap<InkStroke, string>();
function strokeFp(s: InkStroke): string {
  let fp = strokeFpCache.get(s);
  if (fp) return fp;
  let sx = 0;
  let sy = 0;
  for (const p of s.pts) {
    sx += p[0];
    sy += p[1];
  }
  const w = s.w.reduce((a, b) => a + b, 0);
  const f = s.pts[0];
  const l = s.pts[s.pts.length - 1];
  fp = [s.id, s.color, s.kind, s.closed ? 1 : 0, s.pts.length, f?.[0], f?.[1], l?.[0], l?.[1], sx.toFixed(2), sy.toFixed(2), w.toFixed(2),
    s.label ?? '', s.rule ? JSON.stringify(s.rule) : '', s.lib?.type_id ?? ''].join('|');
  strokeFpCache.set(s, fp);
  return fp;
}

function pad(b: RectCells, p: number): RectCells {
  return [b[0] - p, b[1] - p, b[2] + p, b[3] + p];
}

function touches(a: RectCells, b: RectCells): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Fraction of `a`'s area inside `b`. */
function insideFrac(a: RectCells, b: RectCells): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = Math.max(1e-6, (a[2] - a[0]) * (a[3] - a[1]));
  return (ix * iy) / area;
}

class UnionFind {
  private p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.p[i] !== i) {
      this.p[i] = this.p[this.p[i]];
      i = this.p[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[rb] = ra;
  }
}

/** Touch clustering: coloured strokes join coloured strokes they touch; black joins black, or a coloured shape it sits inside. */
function clusterByTouch(strokes: readonly InkStroke[]): InkStroke[][] {
  const n = strokes.length;
  if (!n) return [];
  const boxes = strokes.map((s) => strokeBBox(s));
  const black = strokes.map((s) => s.color === 'black' || s.color === 'pencil');
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!touches(pad(boxes[i], 0.35), pad(boxes[j], 0.35))) continue;
      if (black[i] === black[j]) {
        if (black[i] || strokes[i].color === strokes[j].color) uf.union(i, j);
        else if (insideFrac(boxes[i], boxes[j]) > 0.7 || insideFrac(boxes[j], boxes[i]) > 0.7) uf.union(i, j);
      } else {
        // black detail (eyes, a mouth) inside a coloured body belongs to it
        const [b, c] = black[i] ? [i, j] : [j, i];
        if (insideFrac(boxes[b], pad(boxes[c], 0.3)) > 0.7) uf.union(b, c);
      }
    }
  }
  const out = new Map<number, InkStroke[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    const g = out.get(r);
    if (g) g.push(strokes[i]);
    else out.set(r, [strokes[i]]);
  }
  return [...out.values()];
}

function rootOf(o: SceneObject, byId: Map<string, SceneObject>): SceneObject {
  let cur = o;
  for (let i = 0; i < 6; i++) {
    const up = cur.rel?.part_of;
    const next = up ? byId.get(up) : undefined;
    if (!next || next === cur) break;
    cur = next;
  }
  return cur;
}

interface RawGroup {
  strokes: InkStroke[];
  role: Role | null;
}

function computeRaw(src: GrouperSource, objects: readonly SceneObject[] | null): RawGroup[] {
  const strokes = src.strokes().filter((s) => s.origin !== 'draft' && s.pts.length > 0);
  if (!objects || !objects.length) return clusterByTouch(strokes).map((g) => ({ strokes: g, role: null }));
  const byId = new Map(objects.map((o) => [o.id, o]));
  const rootOfStroke = new Map<string, SceneObject>();
  for (const o of objects) {
    const r = rootOf(o, byId);
    for (const id of o.strokes) if (!rootOfStroke.has(id)) rootOfStroke.set(id, r);
  }
  const byRoot = new Map<string, RawGroup>();
  const loose: InkStroke[] = [];
  for (const s of strokes) {
    const r = rootOfStroke.get(s.id);
    if (!r) {
      loose.push(s);
      continue;
    }
    const g = byRoot.get(r.id);
    if (g) g.strokes.push(s);
    else byRoot.set(r.id, { strokes: [s], role: r.role });
  }
  return [...byRoot.values(), ...clusterByTouch(loose).map((g) => ({ strokes: g, role: null }))];
}

function hintFor(raw: RawGroup, src: GrouperSource): string | null {
  const bits: string[] = [];
  const role = raw.role ?? raw.strokes.find((s) => s.label)?.label ?? null;
  if (role && role !== 'unknown') bits.push(roleChip(role));
  const bound = raw.strokes.find((s) => s.rule);
  const tag = bound ? bindingTag(bound) : null;
  if (tag && !bits.includes(tag)) bits.push(tag);
  const typed = src.ruleText?.(new Set(raw.strokes.map((s) => s.id)));
  if (typed) bits.push(typed);
  return bits.length ? bits.join(', ').slice(0, 160) : null;
}

export class StrokeGrouper {
  private readonly src: GrouperSource;
  private readonly settleMs: number;
  private readonly staleMaxMs: number;
  private tracked = new Map<string, Tracked>();
  private listeners = new Set<(e: GroupEvent) => void>();
  private off: () => void;
  private timer = 0;
  private staleSince: number | null = null;
  /** The last perceived objects: while the hints catch up, known strokes keep their objects (no flip-flopping). */
  private lastObjects: readonly SceneObject[] | null = null;
  private destroyed = false;

  constructor(src: GrouperSource, o: GrouperOptions = {}) {
    this.src = src;
    this.settleMs = o.settleMs ?? 800;
    this.staleMaxMs = o.staleMaxMs ?? 2500;
    // seeded groups count as settled until the first pass says otherwise (no spurious "changed")
    for (const s of o.seed ?? []) {
      if (!s.stroke_ids.length) continue;
      this.tracked.set(s.group_id, {
        group: { group_id: s.group_id, stroke_ids: s.stroke_ids.slice(), bbox_cells: [0, 0, 0, 0], hint: null, role: null, fp: '' },
        changedAt: 0, settled: true,
      });
    }
    this.off = src.onChange(() => this.update());
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    // first pass after the caller has subscribed (so seeded groups that are gone report `removed`)
    queueMicrotask(() => this.update());
  }

  on(fn: (e: GroupEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  groups(): StrokeGroup[] {
    return [...this.tracked.values()].map((t) => t.group);
  }

  isSettled(groupId: string): boolean {
    return this.tracked.get(groupId)?.settled ?? false;
  }

  /** Settle everything now (the kid pressed "Make my level!"). */
  flush(): void {
    this.update(true);
  }

  destroy(): void {
    this.destroyed = true;
    this.off();
    window.clearInterval(this.timer);
    this.listeners.clear();
  }

  private emit(kind: GroupEventKind, group: StrokeGroup): void {
    for (const fn of [...this.listeners]) {
      try {
        fn({ kind, group });
      } catch (e) {
        console.warn('group listener failed', e);
      }
    }
  }

  private tick(): void {
    if (this.destroyed) return;
    const pending = [...this.tracked.values()].some((t) => !t.settled);
    if (pending || this.staleSince !== null) this.update();
  }

  private update(force = false): void {
    if (this.destroyed) return;
    const now = performance.now();
    const hasObjects = typeof this.src.objects === 'function';
    const objects = hasObjects ? this.src.objects!() : null;
    if (hasObjects && !objects) this.staleSince ??= now;
    else this.staleSince = null;
    if (objects) this.lastObjects = objects;

    const raw = computeRaw(this.src, objects ?? this.lastObjects);
    const next: StrokeGroup[] = raw.map((r) => {
      const ids = r.strokes.map((s) => s.id).sort();
      const box = unionBBox(r.strokes.map((s) => strokeBBox(s))) ?? [0, 0, 0, 0];
      const q = (v: number): number => Math.round(v * 16) / 16;
      return {
        group_id: '', stroke_ids: ids, bbox_cells: [q(box[0]), q(box[1]), q(box[2]), q(box[3])] as RectCells,
        hint: hintFor(r, this.src), role: r.role ?? r.strokes.find((s) => s.label)?.label ?? null,
        fp: hash(r.strokes.map(strokeFp).sort().join('#')),
      };
    });

    // match to the previous groups by shared strokes (most shared first), each previous id used once
    const prevOf = new Map<string, string>();
    for (const [id, t] of this.tracked) for (const s of t.group.stroke_ids) prevOf.set(s, id);
    const pairs: { i: number; id: string; n: number }[] = [];
    next.forEach((g, i) => {
      const count = new Map<string, number>();
      for (const s of g.stroke_ids) {
        const p = prevOf.get(s);
        if (p) count.set(p, (count.get(p) ?? 0) + 1);
      }
      for (const [id, n] of count) pairs.push({ i, id, n });
    });
    pairs.sort((a, b) => b.n - a.n);
    const usedPrev = new Set<string>();
    const idOf = new Map<number, string>();
    for (const p of pairs) {
      if (usedPrev.has(p.id) || idOf.has(p.i)) continue;
      usedPrev.add(p.id);
      idOf.set(p.i, p.id);
    }

    const fresh = new Map<string, Tracked>();
    const changed: StrokeGroup[] = [];
    next.forEach((g, i) => {
      const id = idOf.get(i) ?? newGroupId();
      g.group_id = id;
      const old = this.tracked.get(id);
      const same = old && old.group.fp === g.fp && old.group.stroke_ids.join() === g.stroke_ids.join();
      if (old && (same || old.group.fp === '')) {
        // same picture (or a seeded group meeting its strokes again): keep its settle state, refresh the hint
        const seededDiff = old.group.fp === '' && old.group.stroke_ids.join() !== g.stroke_ids.join();
        fresh.set(id, { group: g, changedAt: seededDiff ? now : old.changedAt, settled: seededDiff ? false : old.settled });
        if (seededDiff) changed.push(g);
      } else {
        fresh.set(id, { group: g, changedAt: now, settled: false });
        changed.push(g);
      }
    });
    const removed = [...this.tracked.entries()].filter(([id]) => !fresh.has(id)).map(([, t]) => t.group);
    this.tracked = fresh;

    for (const g of removed) this.emit('removed', g);
    for (const g of changed) this.emit('changed', g);

    const hintsOk = !hasObjects || objects !== null || (this.staleSince !== null && now - this.staleSince >= this.staleMaxMs);
    for (const t of this.tracked.values()) {
      if (t.settled) continue;
      if (force || (hintsOk && now - t.changedAt >= this.settleMs)) {
        t.settled = true;
        this.emit('settled', t.group);
      }
    }
  }
}

/** The grouper's view of a live editor: its strokes, its current perceived objects (the role chips) and typed rules. */
export function groupSourceFromEditor(editor: EditorHandle): GrouperSource {
  return {
    strokes: () => editor.doc.data.strokes,
    objects: () => editor.lastBuild()?.level.objects ?? null,
    ruleText: (ids) => {
      const r = editor.doc.data.rules.find((x) => x.strokeId && ids.has(x.strokeId));
      return r ? r.text.trim().slice(0, 80) : null;
    },
    onChange: (fn) => editor.doc.on(() => fn()),
  };
}
