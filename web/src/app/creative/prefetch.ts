/**
 * Background art while the kid draws (CONTRACTS_V3 "Firefly timing"): every settled object worth a sprite is
 * rendered to a PNG crop (white paper, ≤ 512 px, colours as drawn) and sent to POST /creative/jobs. Unchanged
 * pictures are not sent twice, erased objects are dropped (a late answer for them is ignored), and once the level
 * has about a screen of ground a backdrop is requested. Nothing is sent when the provider is "none", the art budget
 * is spent, or the kid turned "Bring to life" off (for the game or for that object).
 */
import type { InkStroke, RectCells, Role, SceneObject } from '../../core/types.gen.ts';
import { WORLD } from '../../core/params.ts';
import { paintFit } from '../../editor/paint.ts';
import type { GroupEvent, StrokeGrouper, StrokeGroup } from '../../editor/groups.ts';
import { artAvailable, budgetResting, type CreativeDoc } from './session.ts';
import type { CreativeStatus } from './types.ts';

/** Roles that get a sprite. Terrain, coins, text and markers keep the engine's own drawing. */
const ART_ROLES: ReadonlySet<Role> = new Set<Role>(['enemy', 'goal', 'decoration', 'key', 'door', 'spring', 'checkpoint', 'big_coin', 'saw', 'spikes', 'unknown']);
const MAX_SIDE_C = 14;
const CROP_MAX_PX = 512;

export function eligible(g: StrokeGroup, strokes: readonly InkStroke[]): boolean {
  const own = strokes.filter((s) => g.stroke_ids.includes(s.id));
  if (!own.length) return false;
  if (own.some((s) => s.lib) || own.every((s) => s.stamp && s.stamp !== 'library')) return false; // stamps and library things already have art
  const [x0, y0, x1, y1] = g.bbox_cells;
  const w = x1 - x0;
  const hgt = y1 - y0;
  if (Math.max(w, hgt) > MAX_SIDE_C || Math.max(w, hgt) < 0.9) return false;
  if (own.length === 1 && own[0].kind === 'dot') return false; // a tapped coin
  if (g.role) {
    if (!ART_ROLES.has(g.role)) return false;
    if (g.role === 'spikes' && w > 6) return false;
    return true;
  }
  // no perception yet: coloured drawings and closed black shapes
  return own.some((s) => s.color !== 'black' && s.color !== 'pencil') || own.some((s) => s.closed);
}

/** The strokes on white paper, aspect kept, ≤ 512 px on the long side. */
export async function renderCrop(strokes: readonly InkStroke[], box: RectCells): Promise<{ blob: Blob; dataUrl: string } | null> {
  const pad = 0.5;
  const bw = box[2] - box[0] + pad * 2;
  const bh = box[3] - box[1] + pad * 2;
  const ppc = Math.max(8, Math.min(48, CROP_MAX_PX / Math.max(bw, bh)));
  const c = document.createElement('canvas');
  c.width = Math.max(16, Math.min(CROP_MAX_PX, Math.ceil(bw * ppc)));
  c.height = Math.max(16, Math.min(CROP_MAX_PX, Math.ceil(bh * ppc)));
  paintFit(c, [...strokes], box, { pad, bg: '#ffffff' });
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) return null;
  let dataUrl = '';
  try {
    dataUrl = c.toDataURL('image/png');
  } catch {
    dataUrl = '';
  }
  return { blob, dataUrl };
}

/** Cells of ground across the level (union of ground objects' x extents; black low lines when perception is missing). */
export function groundCells(strokes: readonly InkStroke[], objects: readonly SceneObject[] | null): number {
  const spans: [number, number][] = [];
  if (objects && objects.length) {
    const ids = new Set(objects.filter((o) => o.role === 'ground').flatMap((o) => o.strokes));
    for (const s of strokes) if (ids.has(s.id)) spans.push(xSpan(s));
  } else {
    for (const s of strokes) {
      if (s.color !== 'black' || s.kind !== 'line') continue;
      const [a, b] = xSpan(s);
      const ys = s.pts.map((p) => p[1]);
      if (Math.min(...ys) >= WORLD.h * 0.45 && b - a >= 3) spans.push([a, b]);
    }
  }
  spans.sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const sp of spans) {
    if (cur && sp[0] <= cur[1] + 1) cur[1] = Math.max(cur[1], sp[1]);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [sp[0], sp[1]];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

function xSpan(s: InkStroke): [number, number] {
  let a = Infinity;
  let b = -Infinity;
  for (const p of s.pts) {
    a = Math.min(a, p[0]);
    b = Math.max(b, p[0]);
  }
  return [a, b];
}

export interface PrefetchOptions {
  doc: CreativeDoc;
  grouper: StrokeGrouper;
  strokes: () => readonly InkStroke[];
  objects: () => readonly SceneObject[] | null;
  screens: () => number;
  theme: () => string | null;
  status: () => CreativeStatus | null;
}

export class Prefetcher {
  private readonly o: PrefetchOptions;
  private offs: (() => void)[] = [];
  private destroyed = false;
  private backdropTimer = 0;
  private backdropBusy = false;
  /** Groups whose crop is being painted (not yet in the session's queue). */
  private rendering = new Set<string>();

  constructor(o: PrefetchOptions) {
    this.o = o;
    this.offs.push(o.grouper.on((e) => this.onGroup(e)));
    // status arrived, "Bring to life" turned back on, an object switched to life: send what is missing
    this.offs.push(o.doc.on(() => {
      this.kick();
      this.checkBackdrop();
    }));
    o.doc.senders++;
    this.offs.push(() => o.doc.senders--);
  }

  /** Stop listening. Submissions already queued still go out (the kid may have just pressed "Make my level!"). */
  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.backdropTimer);
    for (const f of this.offs) f();
    this.offs = [];
  }

  /** Re-check every settled object (cheap; nothing is sent twice). */
  kick(): void {
    if (this.destroyed || !this.enabled()) return;
    for (const g of this.o.grouper.groups()) {
      if (!g.fp || !this.o.grouper.isSettled(g.group_id)) continue; // (a remembered group not seen again yet)
      const rec = this.o.doc.objects.get(g.group_id);
      if (!rec || rec.error) continue;
      this.maybeSend(g);
    }
  }

  private enabled(): boolean {
    const s = this.o.status();
    return artAvailable(s) && !budgetResting(s) && this.o.doc.life;
  }

  private maybeSend(g: StrokeGroup): void {
    const { doc } = this.o;
    const rec = doc.objects.get(g.group_id);
    if (!rec || rec.mode === 'ink' || !this.enabled() || doc.sending.has(g.group_id) || this.rendering.has(g.group_id)) return;
    if (rec.job_id && rec.fp === g.fp) return; // same picture: keep its art
    void this.send(g);
  }

  private onGroup(e: GroupEvent): void {
    if (this.destroyed) return;
    if (e.kind === 'settled') this.scheduleBackdrop(); // ground alone can earn a backdrop
    const { doc } = this.o;
    switch (e.kind) {
      case 'removed':
        doc.drop(e.group.group_id);
        break;
      case 'changed':
        // redrawn before it was sent: wait for it to settle again
        doc.unqueue(e.group.group_id);
        break;
      case 'settled': {
        if (!eligible(e.group, this.o.strokes())) {
          doc.drop(e.group.group_id);
          break;
        }
        const rec = doc.upsert(e.group);
        if (rec.error) rec.error = null; // a new settle is a new try
        this.maybeSend(e.group);
        break;
      }
    }
  }

  private async send(g: StrokeGroup): Promise<void> {
    if (!this.enabled()) return;
    const ids = new Set(g.stroke_ids);
    const strokes = this.o.strokes().filter((s) => ids.has(s.id));
    if (!strokes.length || this.rendering.has(g.group_id)) return;
    this.rendering.add(g.group_id);
    let crop: Awaited<ReturnType<typeof renderCrop>> = null;
    try {
      crop = await renderCrop(strokes, g.bbox_cells);
    } finally {
      this.rendering.delete(g.group_id);
    }
    if (!crop || !this.o.doc.objects.has(g.group_id)) return;
    this.o.doc.submit({ group_id: g.group_id, fp: g.fp, crop: crop.blob, stroke_ids: g.stroke_ids, bbox_cells: g.bbox_cells, hint: g.hint }, crop.dataUrl || null);
  }

  private scheduleBackdrop(): void {
    window.clearTimeout(this.backdropTimer);
    this.backdropTimer = window.setTimeout(() => this.checkBackdrop(), 1200);
  }

  /** Once there is about a screen of ground: one backdrop per level width. */
  private checkBackdrop(): void {
    if (this.destroyed || this.backdropBusy || !this.enabled()) return;
    const { doc } = this.o;
    const screens = this.o.screens();
    if (doc.backdrop && doc.backdrop.screens >= screens) return;
    if (groundCells(this.o.strokes(), this.o.objects()) < WORLD.screen_w * 0.8) return;
    this.backdropBusy = true;
    void doc.requestBackdrop({ screens, theme: this.o.theme() }).finally(() => (this.backdropBusy = false));
  }
}
