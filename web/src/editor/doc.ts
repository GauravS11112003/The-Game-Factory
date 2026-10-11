/**
 * The editor document and its command stack (§6.3): vector strokes in cells on a 48·k × 27 strip, the Character
 * Studio doodle, typed rules (bound to a stroke when one was selected, §7.11), and the "play from here" flag.
 * Undo/redo is a patch stack of 200 steps; a patch removes and adds whole strokes by id, so moves keep ids.
 */
import type { CellXY, InkStroke, LibraryType, ParentRef } from '../core/types.gen.ts';
import { CANVAS, WORLD } from '../core/params.ts';

export interface TypedRuleDraft {
  id: string;
  text: string;
  strokeId: string | null; // the stroke selected while the rule was typed → its component id at build time
}

export interface EditorDocData {
  v: 1;
  screens: number;
  strokes: InkStroke[];
  character: InkStroke[];
  rules: TypedRuleDraft[];
  startAt: CellXY | null; // "play from here" flag (test-play only; not part of the level)
  gameId: string | null;
  parent: ParentRef | null; // remix: parent strokes arrive with origin 'parent' and stay locked until unlocked
  parentUnlocked: boolean;
  title: string;
  imaginationContext?: string;
  betterGraphics?: boolean;
  multiplayer?: boolean;
  nextId: number;
  /** Edit statuses kept from the preview when going back to the drawing (edits are kept by stable id, §7.10). */
  keptStatuses: Record<string, 'applied' | 'undone'>;
  /** Library types available for stamps (cached from the game). */
  library: LibraryType[];
  /** Remix: the parent's strokes as published, to show what the kid moved or removed (§6.5). */
  parentStrokes?: InkStroke[];
}

export function emptyDoc(o: Partial<EditorDocData> = {}): EditorDocData {
  return {
    v: 1, screens: 1, strokes: [], character: [], rules: [], startAt: null, gameId: null, parent: null,
    parentUnlocked: false, title: '', nextId: 1, keptStatuses: {}, library: [], ...o,
  };
}

/** Loose structural check for documents restored from storage. */
export function isDoc(x: unknown): x is EditorDocData {
  const d = x as EditorDocData | null;
  return !!d && d.v === 1 && Array.isArray(d.strokes) && typeof d.screens === 'number' && Array.isArray(d.character);
}

export function normalizeDoc(d: EditorDocData): EditorDocData {
  const screens = Math.max(1, Math.min(WORLD.max_screens, Math.round(d.screens) || 1));
  let maxId = 0;
  for (const s of [...d.strokes, ...d.character]) {
    const m = /^[sc](\d+)$/.exec(s.id);
    if (m) maxId = Math.max(maxId, Number(m[1]));
  }
  return {
    ...emptyDoc(), ...d, screens, strokes: sortByT(d.strokes), rules: d.rules ?? [], keptStatuses: d.keptStatuses ?? {},
    library: d.library ?? [], nextId: Math.max(d.nextId || 1, maxId + 1),
  };
}

function sortByT(strokes: InkStroke[]): InkStroke[] {
  return strokes.slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

export interface Patch {
  removed: InkStroke[];
  added: InkStroke[];
  screens?: [number, number];
  character?: [InkStroke[], InkStroke[]];
  rules?: [TypedRuleDraft[], TypedRuleDraft[]];
  startAt?: [CellXY | null, CellXY | null];
}

export type DocChange = 'edit' | 'undo' | 'redo' | 'load' | 'meta';
type Listener = (why: DocChange) => void;

export class EditorDoc {
  data: EditorDocData;
  /** Bumped on every change; the hints worker answers per revision. */
  rev = 0;
  private undoStack: Patch[] = [];
  private redoStack: Patch[] = [];
  private listeners = new Set<Listener>();

  constructor(data: EditorDocData) {
    this.data = normalizeDoc(data);
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(why: DocChange): void {
    if (why !== 'meta') this.rev++;
    for (const fn of this.listeners) fn(why);
  }

  load(data: EditorDocData): void {
    this.data = normalizeDoc(data);
    this.undoStack = [];
    this.redoStack = [];
    this.emit('load');
  }

  get world(): { screens: number; w: number; h: 27 } {
    return { screens: this.data.screens, w: WORLD.screen_w * this.data.screens, h: 27 };
  }

  newId(prefix: 's' | 'c' | 'note' = 's'): string {
    return `${prefix}${this.data.nextId++}`;
  }

  /** Creation order (`t`) for a new stroke. */
  nextT(): number {
    let t = 0;
    for (const s of this.data.strokes) t = Math.max(t, s.t ?? 0);
    return t + 1;
  }

  stroke(id: string): InkStroke | undefined {
    return this.data.strokes.find((s) => s.id === id);
  }

  isLocked(s: InkStroke): boolean {
    return s.origin === 'parent' && !this.data.parentUnlocked;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Apply and record a patch (no-op patches are dropped). */
  apply(p: Patch): void {
    if (!p.removed.length && !p.added.length && !p.screens && !p.character && !p.rules && !p.startAt) return;
    this.applyRaw(p, false);
    this.undoStack.push(p);
    if (this.undoStack.length > CANVAS.undo_steps) this.undoStack.shift();
    this.redoStack = [];
    this.emit('edit');
  }

  undo(): void {
    const p = this.undoStack.pop();
    if (!p) return;
    this.applyRaw(p, true);
    this.redoStack.push(p);
    this.emit('undo');
  }

  redo(): void {
    const p = this.redoStack.pop();
    if (!p) return;
    this.applyRaw(p, false);
    this.undoStack.push(p);
    this.emit('redo');
  }

  /** Set fields that are not part of the drawing (title, unlock, kept statuses) without an undo step. */
  setMeta(m: Partial<Pick<EditorDocData, 'title' | 'parentUnlocked' | 'gameId' | 'library' | 'keptStatuses'>>): void {
    const inkChanged = 'parentUnlocked' in m || 'library' in m;
    Object.assign(this.data, m);
    this.emit(inkChanged ? 'edit' : 'meta');
  }

  private applyRaw(p: Patch, inverse: boolean): void {
    const remove = inverse ? p.added : p.removed;
    const add = inverse ? p.removed : p.added;
    if (remove.length || add.length) {
      const gone = new Set(remove.map((s) => s.id));
      this.data.strokes = sortByT([...this.data.strokes.filter((s) => !gone.has(s.id)), ...add.map(clone)]);
    }
    if (p.screens) this.data.screens = p.screens[inverse ? 0 : 1];
    if (p.character) this.data.character = p.character[inverse ? 0 : 1].map(clone);
    if (p.rules) this.data.rules = p.rules[inverse ? 0 : 1].map((r) => ({ ...r }));
    if (p.startAt) this.data.startAt = p.startAt[inverse ? 0 : 1];
  }

  /** Whether the last screen holds no ink (it can be trimmed, §6.3). */
  lastScreenEmpty(): boolean {
    if (this.data.screens <= 1) return false;
    const x0 = WORLD.screen_w * (this.data.screens - 1);
    const inkThere = this.data.strokes.some((s) => s.pts.some((p) => p[0] >= x0));
    const flagThere = !!this.data.startAt && this.data.startAt[0] >= x0;
    return !inkThere && !flagThere;
  }

  snapshot(): EditorDocData {
    return JSON.parse(JSON.stringify(this.data)) as EditorDocData;
  }
}

function clone(s: InkStroke): InkStroke {
  return { ...s, pts: s.pts.map((p) => [p[0], p[1]] as CellXY), w: s.w.slice() };
}
