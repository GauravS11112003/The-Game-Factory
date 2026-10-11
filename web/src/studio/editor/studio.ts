/**
 * The Studio editor state (docs/v6/CONTRACTS_V6.md §6): the doc, the scene being edited, the selection, tools,
 * pending ask_draw prompts, stroke grouping and undo/redo. Every change goes through `commit` (a new immutable doc
 * plus a history entry); copilot edits and inspector controls both go through `apply` → applyEdits.
 */
import type { Stroke, StudioEdit, StudioTheme } from '../../core/types.gen.ts';
import { addWorldStrokes, allObjectIds, freshId, mergeObjects, objectFromWorldStrokes, sceneOf, splitObject, strokesBox, withObjects, withoutObjects, worldBox } from '../model/doc.ts';
import { applyEdits, fulfilAsk, type ApplyResult } from '../model/edits.ts';
import { History } from '../model/history.ts';
import type { AskDraw, SDoc, SObj, SScene } from '../model/types.ts';
import { GROUP_GAP_MS, joinsGroup, type PendingGroup } from './grouping.ts';

export type Tool = 'select' | 'pen' | 'line' | 'rect' | 'circle' | 'eraser' | 'hand';

export type ChangeKind = 'doc' | 'selection' | 'scene' | 'tool' | 'asks' | 'history' | 'pending' | 'finished' | 'pick';

export interface Change {
  kind: ChangeKind;
  /** A continuous edit (slider scrub, typing, dragging): panels need not rebuild. */
  quiet?: boolean;
  /** The object that was just finished (kind 'finished'). */
  id?: string;
}

export interface PickRequest { prompt: string; onPick: (id: string) => void; filter?: (o: SObj) => boolean }

export class Studio {
  doc: SDoc;
  sceneId: string;
  selection: string[] = [];
  tool: Tool = 'pen';
  color = '#1f1b18';
  width = 6;
  asks: AskDraw[] = [];
  themes: StudioTheme[] = [];
  pending: PendingGroup | null = null;
  /** The canvas is waiting for the maker to click an object (attach a joint, pick a target). */
  pick: PickRequest | null = null;
  readonly history = new History<SDoc>(200, 900);
  private listeners = new Set<(c: Change) => void>();
  private pendingTimer = 0;

  constructor(doc: SDoc, sceneId?: string) {
    this.doc = doc;
    this.sceneId = sceneOf(doc, sceneId).id;
  }

  on(fn: (c: Change) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(c: Change): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(c);
      } catch (e) {
        console.error('studio listener failed', e);
      }
    }
  }

  get scene(): SScene {
    return sceneOf(this.doc, this.sceneId);
  }

  object(id: string): SObj | undefined {
    return this.scene.objects.find((o) => o.id === id);
  }

  get selected(): SObj[] {
    return this.selection.map((id) => this.object(id)).filter((o): o is SObj => !!o);
  }

  /** Replace the doc as one undoable step (`coalesce`: same key within ~1 s = same step). */
  commit(next: SDoc, o: { label?: string; coalesce?: string; quiet?: boolean } = {}): void {
    if (next === this.doc) return;
    this.history.push(this.doc, o.label ?? '', o.coalesce ?? null);
    this.doc = next;
    this.fixSelection();
    this.emit({ kind: 'doc', quiet: o.quiet });
    this.emit({ kind: 'history' });
  }

  /** StudioEdits as one undoable step; new asks queue up behind the current ones. */
  apply(edits: StudioEdit[], o: { label?: string; coalesce?: string; quiet?: boolean } = {}): ApplyResult {
    const r = applyEdits(this.doc, this.sceneId, edits, { themes: this.themes });
    if (r.warnings.length) console.info('studio edits:', r.warnings);
    this.commit(r.doc, o);
    if (r.asks.length) {
      this.asks = [...this.asks, ...r.asks.filter((a) => !this.asks.some((x) => x.id === a.id))];
      this.emit({ kind: 'asks' });
    }
    return r;
  }

  seal(): void {
    this.history.seal();
  }

  undo(): void {
    this.finishPending(false);
    const e = this.history.undo(this.doc);
    if (!e) return;
    this.doc = e.doc;
    this.fixSelection();
    this.emit({ kind: 'doc' });
    this.emit({ kind: 'history' });
  }

  redo(): void {
    const e = this.history.redo(this.doc);
    if (!e) return;
    this.doc = e.doc;
    this.fixSelection();
    this.emit({ kind: 'doc' });
    this.emit({ kind: 'history' });
  }

  private fixSelection(): void {
    if (!this.doc.scenes.some((s) => s.id === this.sceneId)) {
      this.sceneId = this.doc.scenes[0].id;
      this.emit({ kind: 'scene' });
    }
    const ids = new Set(this.scene.objects.map((o) => o.id));
    const sel = this.selection.filter((id) => ids.has(id));
    if (sel.length !== this.selection.length) {
      this.selection = sel;
      this.emit({ kind: 'selection' });
    }
    if (this.pending && !ids.has(this.pending.id)) this.pending = null;
  }

  select(ids: string[]): void {
    const next = [...new Set(ids)].filter((id) => this.object(id));
    if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
    this.selection = next;
    this.emit({ kind: 'selection' });
  }

  setScene(id: string): void {
    if (id === this.sceneId || !this.doc.scenes.some((s) => s.id === id)) return;
    this.finishPending();
    this.sceneId = id;
    this.selection = [];
    this.emit({ kind: 'scene' });
    this.emit({ kind: 'selection' });
  }

  setTool(tool: Tool): void {
    if (tool !== this.tool) this.finishPending();
    this.tool = tool;
    this.cancelPick();
    this.emit({ kind: 'tool' });
  }

  setInk(o: { color?: string; width?: number }): void {
    if (o.color) this.color = o.color;
    if (o.width) this.width = o.width;
    this.emit({ kind: 'tool' });
  }

  // ---- drawing and grouping ----

  /** A finished stroke in world px: joins the pending object when close in time and space, else starts a new one. */
  addStroke(stroke: Stroke): void {
    const box = strokesBox([stroke]);
    if (!box) return;
    const now = Date.now();
    const pend = this.pending && this.object(this.pending.id) ? this.pending : null;
    if (pend && joinsGroup(pend, box, now)) {
      const o = addWorldStrokes(this.object(pend.id)!, [stroke]);
      this.commit(withObjects(this.doc, this.sceneId, [o]), { label: 'draw' });
      this.pending = { id: o.id, box: worldBox(o), lastAt: now };
    } else {
      this.finishPending();
      const id = freshId('o', allObjectIds(this.doc));
      const top = this.scene.objects.reduce((m, o) => Math.max(m, o.layer), 0);
      const o = objectFromWorldStrokes(id, [stroke], { layer: Math.min(10, Math.max(0, top)) });
      this.commit(withObjects(this.doc, this.sceneId, [o]), { label: 'draw' });
      this.pending = { id, box: worldBox(o), lastAt: now };
    }
    this.emit({ kind: 'pending' });
    window.clearTimeout(this.pendingTimer);
    this.pendingTimer = window.setTimeout(() => this.finishPending(), GROUP_GAP_MS);
  }

  /** Finish the pending object: it takes a waiting ask_draw, or the UI asks "is this a …?" (`finished`). */
  finishPending(announce = true): void {
    window.clearTimeout(this.pendingTimer);
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.emit({ kind: 'pending' });
    const o = this.object(p.id);
    if (!o || !announce) return;
    const ask = this.asks.find((a) => a.scene === this.sceneId) ?? null;
    if (ask) {
      const r = fulfilAsk(this.doc, this.sceneId, o.id, ask);
      this.commit(r.doc, { label: 'ask' });
      this.asks = this.asks.filter((a) => a !== ask);
      this.emit({ kind: 'asks' });
      this.emit({ kind: 'finished', id: r.id });
      return;
    }
    this.emit({ kind: 'finished', id: o.id });
  }

  skipAsk(): void {
    this.asks = this.asks.slice(1);
    this.emit({ kind: 'asks' });
  }

  /** Remove strokes (by index) from objects; objects left without strokes are deleted. */
  eraseStroke(objId: string, index: number, coalesce: string): void {
    const o = this.object(objId);
    if (!o || index < 0 || index >= o.drawing.strokes.length) return;
    if (o.drawing.strokes.length === 1) {
      this.commit(applyEdits(this.doc, this.sceneId, [{ action: 'delete_object', target: o.id, data: {} }]).doc, { label: 'erase', coalesce });
      return;
    }
    const strokes = o.drawing.strokes.filter((_, i) => i !== index);
    const next = { ...o, drawing: { ...o.drawing, strokes } };
    // recentre keeps the remaining strokes in place
    this.commit(withObjects(this.doc, this.sceneId, [addWorldStrokes(next, [])]), { label: 'erase', coalesce });
  }

  deleteSelection(): void {
    const ids = this.selection;
    if (!ids.length) return;
    this.apply(ids.map((id) => ({ action: 'delete_object', target: id, data: {} })), { label: 'delete' });
    this.select([]);
  }

  duplicateSelection(): void {
    const ids = this.selection;
    if (!ids.length) return;
    const r = this.apply(ids.map((id) => ({ action: 'duplicate_object', target: id, data: { dx: 32, dy: 32 } })), { label: 'duplicate' });
    this.select(r.created);
  }

  mergeSelection(): void {
    if (this.selection.length < 2) return;
    const r = mergeObjects(this.doc, this.sceneId, this.selection);
    this.commit(r.doc, { label: 'merge' });
    if (r.id) this.select([r.id]);
  }

  splitSelection(): void {
    if (this.selection.length !== 1) return;
    const r = splitObject(this.doc, this.sceneId, this.selection[0]);
    this.commit(r.doc, { label: 'split' });
    this.select(r.ids);
  }

  /** Paste objects (deep copies with fresh ids, offset). */
  paste(objs: SObj[], offset = 32): void {
    if (!objs.length) return;
    const taken = allObjectIds(this.doc);
    const copies = objs.map((o) => {
      const id = freshId(o.id.replace(/\d+$/, '') || 'o', taken);
      taken.add(id);
      return { ...(JSON.parse(JSON.stringify(o)) as SObj), id, x: o.x + offset, y: o.y + offset, joints: [] };
    });
    this.commit(withObjects(this.doc, this.sceneId, copies), { label: 'paste' });
    this.select(copies.map((c) => c.id));
  }

  /** Bring forward / send back (layer ± 1, clamped to −10…10). */
  shiftLayer(delta: number): void {
    const objs = this.selected.map((o) => ({ ...o, layer: Math.max(-10, Math.min(10, o.layer + delta)) }));
    if (objs.length) this.commit(withObjects(this.doc, this.sceneId, objs), { label: 'layer' });
  }

  removeObjects(ids: string[]): void {
    this.commit(withoutObjects(this.doc, this.sceneId, ids), { label: 'delete' });
  }

  // ---- picking an object on the canvas ----

  startPick(req: PickRequest): void {
    this.finishPending();
    this.pick = req;
    this.emit({ kind: 'pick' });
  }

  cancelPick(): void {
    if (!this.pick) return;
    this.pick = null;
    this.emit({ kind: 'pick' });
  }

  completePick(id: string): void {
    const p = this.pick;
    if (!p) return;
    const o = this.object(id);
    if (!o || (p.filter && !p.filter(o))) return;
    this.pick = null;
    this.emit({ kind: 'pick' });
    p.onPick(id);
  }

  dispose(): void {
    window.clearTimeout(this.pendingTimer);
    this.listeners.clear();
  }
}
