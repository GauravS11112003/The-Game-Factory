/**
 * One creative session per editor document (doc_id), shared by the draw screen (prefetch + tray) and the preview
 * (tray + fly-in) inside the single-page app: the objects the kid drew and the art job for each, the per-object and
 * per-game "My drawing / Bring to life" choices, the backdrop job, a one-at-a-time submission queue and the
 * 1.5 s batch poll while any job is working. The small parts that must survive a reload live in localStorage.
 */
import type { Behavior, InkStroke, RectCells, Role } from '../../core/types.gen.ts';
import type { EditorDocData } from '../../editor/doc.ts';
import { ApiError } from '../api.ts';
import { creativeApi, type BackdropBody, type LibraryKind } from './api.ts';
import { isWorking, type CreativeStatus, type Job, type SkinMode } from './types.ts';

const P = 'dal.v3.creative.';

/** Perceived role → the library kind a pinned picture is saved as (the server guesses when it is missing). */
const ROLE_KIND: Partial<Record<Role, LibraryKind>> = {
  enemy: 'creature', platform: 'platform', spikes: 'hazard', lava: 'hazard', saw: 'hazard', coin: 'pickup', big_coin: 'pickup',
  key: 'pickup', door: 'prop', goal: 'prop', spring: 'prop', checkpoint: 'prop', decoration: 'prop',
};
const POLL_MS = 1500;
const QUEUE_GAP_MS = 250;

function get<T>(k: string): T | null {
  try {
    const v = localStorage.getItem(P + k);
    return v === null ? null : (JSON.parse(v) as T);
  } catch {
    return null;
  }
}

function set(k: string, v: unknown): void {
  try {
    if (v === null || v === undefined) localStorage.removeItem(P + k);
    else localStorage.setItem(P + k, JSON.stringify(v));
  } catch {
    /* storage full or disabled: the session still works in memory */
  }
}

// ---- doc ids ------------------------------------------------------------------------------------------------------

/**
 * The editor document's id (the creative `doc_id`; lane 6 uses the same id as its live room). Kept on the document
 * data as `id`, so it travels with every snapshot (the working drawing and the per-draft copy for the preview).
 */
export function docIdOf(d: EditorDocData | null | undefined, create = false): string | null {
  if (!d) return null;
  const x = d as EditorDocData & { id?: unknown; doc_id?: unknown; docId?: unknown };
  // same reading as the live room id (editor/live.ts), so both lanes agree on the id
  for (const v of [x.id, x.doc_id, x.docId]) if (typeof v === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(v)) return v;
  if (!create) return null;
  const id = `doc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  (x as { id?: string }).id = id;
  return id;
}

// ---- provider status (cached for a minute) --------------------------------------------------------------------------

let statusCache: { at: number; p: Promise<CreativeStatus> } | null = null;

export function creativeStatus(): Promise<CreativeStatus> {
  const now = Date.now();
  if (!statusCache || now - statusCache.at > 60_000) {
    statusCache = { at: now, p: creativeApi.status().catch((): CreativeStatus => ({ provider: 'none', budget_left_usd: null })) };
  }
  return statusCache.p;
}

export function artAvailable(s: CreativeStatus | null): boolean {
  return !!s && s.provider !== 'none';
}

export function budgetResting(s: CreativeStatus | null): boolean {
  return !!s && s.budget_left_usd !== null && s.budget_left_usd <= 0;
}

// ---- the game-level toggle ------------------------------------------------------------------------------------------

export function gameLife(gameId: string | null): boolean {
  return get<boolean>(`life.${gameId ?? '_'}`) !== false;
}

export function setGameLife(gameId: string | null, on: boolean): void {
  set(`life.${gameId ?? '_'}`, on);
}

// ---- the session ----------------------------------------------------------------------------------------------------

export interface ObjRec {
  group_id: string;
  stroke_ids: string[];
  bbox_cells: RectCells;
  hint: string | null;
  /** The perceived role when the group settled (the library kind when pinned). */
  role?: Role | null;
  /** Fingerprint of the picture the current job was made from ('' = nothing sent yet). */
  fp: string;
  job_id: string | null;
  mode: SkinMode;
  /** Saved to the game's library. */
  pinned?: { type_id: string; name: string } | null;
  /** The last submission failed (shown as "Try again"). */
  error?: string | null;
}

interface Persisted {
  v: 1;
  objects: Record<string, ObjRec>;
  backdrop: { job_id: string; screens: number } | null;
}

interface QueueItem {
  group_id: string;
  fp: string;
  crop: Blob;
  stroke_ids: string[];
  bbox_cells: RectCells;
  hint: string | null;
}

export class CreativeDoc {
  readonly docId: string;
  gameId: string | null;
  readonly objects = new Map<string, ObjRec>();
  backdrop: { job_id: string; screens: number } | null = null;
  readonly jobs = new Map<string, Job>();
  /** group_id → the kid's drawing as a data URL (memory only; the tray paints strokes when it is missing). */
  readonly crops = new Map<string, string>();
  /** group_ids with a submission waiting or in flight. */
  readonly sending = new Set<string>();
  private listeners = new Set<() => void>();
  private queue: QueueItem[] = [];
  private busy = false;
  private pollTimer = 0;
  private pollPending = false;
  /** Referenced job ids the server did not list, by consecutive polls (given up after a few). */
  private missing = new Map<string, number>();
  private emitQueued = false;
  private loaded: Promise<void> | null = null;

  constructor(docId: string, gameId: string | null) {
    this.docId = docId;
    this.gameId = gameId;
    const p = get<Persisted>(`doc.${docId}`);
    if (p && p.v === 1) {
      for (const r of Object.values(p.objects ?? {})) if (r && typeof r.group_id === 'string' && Array.isArray(r.stroke_ids)) this.objects.set(r.group_id, { ...r });
      this.backdrop = p.backdrop ?? null;
    }
  }

  // ---- events ----
  on(fn: () => void): () => void {
    this.listeners.add(fn);
    this.schedulePoll();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) {
        window.clearTimeout(this.pollTimer);
        this.pollPending = false;
      }
    };
  }

  /** Coalesced change notification (one per microtask). */
  emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      for (const fn of [...this.listeners]) {
        try {
          fn();
        } catch (e) {
          console.warn('creative listener failed', e);
        }
      }
      this.schedulePoll();
    });
  }

  save(): void {
    const objects: Record<string, ObjRec> = {};
    for (const [id, r] of this.objects) objects[id] = r;
    set(`doc.${this.docId}`, { v: 1, objects, backdrop: this.backdrop } satisfies Persisted);
  }

  // ---- the game-level toggle ----
  get life(): boolean {
    return gameLife(this.gameId);
  }

  setLife(on: boolean): void {
    setGameLife(this.gameId, on);
    this.emit();
  }

  // ---- reading ----
  jobOf(r: ObjRec | null | undefined): Job | null {
    return r?.job_id ? this.jobs.get(r.job_id) ?? null : null;
  }

  /** Objects in reading order (left to right). */
  list(): ObjRec[] {
    return [...this.objects.values()].sort((a, b) => a.bbox_cells[0] - b.bbox_cells[0] || a.bbox_cells[1] - b.bbox_cells[1]);
  }

  backdropJob(): Job | null {
    return this.backdrop ? this.jobs.get(this.backdrop.job_id) ?? null : null;
  }

  anyWorking(): boolean {
    if (this.sending.size) return true;
    const waiting = (id: string | null | undefined): boolean => {
      if (!id) return false;
      const j = this.jobs.get(id);
      return j ? isWorking(j) : (this.missing.get(id) ?? 0) < 4;
    };
    for (const r of this.objects.values()) if (waiting(r.job_id)) return true;
    return waiting(this.backdrop?.job_id);
  }

  // ---- server state ----
  /** GET /jobs?doc_id (once per session unless forced; polling forces). */
  load(force = false): Promise<void> {
    if (!this.loaded || force) {
      this.loaded = creativeApi.jobs(this.docId).then((jobs) => {
        for (const j of jobs) this.jobs.set(j.job_id, j);
        const listed = new Set(jobs.map((j) => j.job_id));
        for (const id of [...[...this.objects.values()].map((r) => r.job_id), this.backdrop?.job_id]) {
          if (id && !listed.has(id) && !this.jobs.has(id)) this.missing.set(id, (this.missing.get(id) ?? 0) + 1);
        }
        this.emit();
      }).catch(() => undefined);
    }
    return this.loaded;
  }

  setJob(j: Job): void {
    this.jobs.set(j.job_id, j);
    this.emit();
  }

  private schedulePoll(): void {
    if (this.pollPending || !this.listeners.size || !this.anyWorking()) return;
    this.pollPending = true;
    this.pollTimer = window.setTimeout(() => {
      this.pollPending = false;
      if (!this.listeners.size) return;
      if (document.hidden) {
        this.schedulePoll();
        return;
      }
      void this.load(true).then(() => this.schedulePoll());
    }, POLL_MS);
  }

  // ---- objects ----
  /** Track a settled group (keeps the job and the kid's choice when the same strokes come back). */
  upsert(g: { group_id: string; stroke_ids: string[]; bbox_cells: RectCells; hint: string | null; role: Role | null }): ObjRec {
    const cur = this.objects.get(g.group_id);
    const rec: ObjRec = cur
      ? { ...cur, stroke_ids: g.stroke_ids.slice(), bbox_cells: g.bbox_cells, hint: g.hint ?? cur.hint, role: g.role ?? cur.role ?? null }
      : { group_id: g.group_id, stroke_ids: g.stroke_ids.slice(), bbox_cells: g.bbox_cells, hint: g.hint, role: g.role, fp: '', job_id: null, mode: 'life', pinned: null };
    this.objects.set(g.group_id, rec);
    this.save();
    this.emit();
    return rec;
  }

  /** The kid erased it (or it merged into another object): forget it and ignore its job. */
  drop(groupId: string): void {
    this.queue = this.queue.filter((q) => q.group_id !== groupId);
    this.sending.delete(groupId);
    this.crops.delete(groupId);
    if (this.objects.delete(groupId)) {
      this.save();
      this.emit();
    }
  }

  setMode(groupId: string, mode: SkinMode): void {
    const r = this.objects.get(groupId);
    if (!r || r.mode === mode) return;
    r.mode = mode;
    this.save();
    this.emit();
  }

  // ---- submission queue (one at a time; a newer picture of the same object replaces a waiting one) ----
  submit(item: QueueItem, cropUrl: string | null): void {
    this.queue = this.queue.filter((q) => q.group_id !== item.group_id);
    this.queue.push(item);
    this.sending.add(item.group_id);
    if (cropUrl) this.crops.set(item.group_id, cropUrl);
    const r = this.objects.get(item.group_id);
    if (r) r.error = null;
    this.emit();
    void this.pump();
  }

  /** Cancel a waiting submission (the object changed again before it was sent). */
  unqueue(groupId: string): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.group_id !== groupId);
    if (before !== this.queue.length) {
      this.sending.delete(groupId);
      this.emit();
    }
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const it = this.queue.shift()!;
        if (!this.objects.has(it.group_id)) {
          this.sending.delete(it.group_id);
          continue;
        }
        try {
          const { job_id, job } = await creativeApi.createJob({
            crop: it.crop, doc_id: this.docId, stroke_ids: it.stroke_ids, bbox_cells: it.bbox_cells, game_id: this.gameId, hint: it.hint,
          });
          const r = this.objects.get(it.group_id);
          // erased or redrawn meanwhile: ignore this answer (a newer submission may be waiting)
          if (r && !this.queue.some((q) => q.group_id === it.group_id)) {
            r.job_id = job_id;
            r.fp = it.fp;
            r.error = null;
            this.save();
            if (job) this.jobs.set(job.job_id, job);
            else creativeApi.job(job_id).then((j) => this.setJob(j)).catch(() => undefined);
          }
        } catch (e) {
          const r = this.objects.get(it.group_id);
          if (r) {
            r.error = e instanceof ApiError ? e.messageKey : 'creative.failed';
            this.save();
          }
          if (e instanceof ApiError && (e.status === 429 || e.status === 503)) await sleep(4000);
        } finally {
          if (!this.queue.some((q) => q.group_id === it.group_id)) this.sending.delete(it.group_id);
          this.emit();
        }
        await sleep(QUEUE_GAP_MS);
      }
    } finally {
      this.busy = false;
    }
  }

  // ---- backdrop ----
  async requestBackdrop(body: Omit<BackdropBody, 'doc_id' | 'game_id'>): Promise<void> {
    try {
      const { job_id } = await creativeApi.backdrop({ ...body, doc_id: this.docId, game_id: this.gameId });
      this.backdrop = { job_id, screens: body.screens };
      this.save();
      this.emit();
      creativeApi.job(job_id).then((j) => this.setJob(j)).catch(() => undefined);
    } catch {
      /* no backdrop: the paper stays */
    }
  }

  // ---- variants, choose, pin ----
  async reroll(groupId: string): Promise<void> {
    const r = this.objects.get(groupId);
    if (!r?.job_id) return;
    const { job_id } = await creativeApi.reroll(r.job_id);
    r.job_id = job_id;
    this.save();
    const cur = this.jobs.get(job_id);
    if (cur) this.jobs.set(job_id, { ...cur, status: 'working' });
    this.emit();
    creativeApi.job(job_id).then((j) => this.setJob(j)).catch(() => undefined);
  }

  async choose(groupId: string, variant: number): Promise<void> {
    const r = this.objects.get(groupId);
    if (!r?.job_id) return;
    const j = await creativeApi.choose(r.job_id, variant);
    if (j.job_id !== r.job_id) {
      r.job_id = j.job_id;
      this.save();
    }
    this.setJob(j);
  }

  /** Save to the game's library: the art plus the kid's own strokes (so the creature keeps its ink), kind from the role. */
  async pin(groupId: string, name: string, strokes: readonly InkStroke[]): Promise<string | null> {
    const r = this.objects.get(groupId);
    if (!r?.job_id || !this.gameId) return null;
    const ids = new Set(r.stroke_ids);
    const own = strokes.filter((s) => ids.has(s.id)).map((s) => ({ ...s, pts: s.pts.map((p) => [p[0], p[1]] as [number, number]), w: s.w.slice() }));
    const behavior: Behavior | null = own.find((s) => s.rule)?.rule ?? null;
    const kind = r.role ? ROLE_KIND[r.role] : undefined;
    const { type_id } = await creativeApi.pin(r.job_id, {
      game_id: this.gameId, name, ...(own.length ? { strokes: own } : {}), ...(kind ? { kind } : {}), ...(behavior ? { behavior } : {}),
    });
    r.pinned = { type_id, name };
    this.save();
    this.emit();
    return type_id;
  }

  /** Live prefetchers (the draw screen): only they can re-send a drawing, so "Try again" needs one. */
  senders = 0;

  /** Re-send an object whose submission failed (the tray's "Try again" before any art exists); the prefetcher sends it. */
  retry(groupId: string): void {
    const r = this.objects.get(groupId);
    if (!r) return;
    r.fp = '';
    r.error = null;
    this.save();
    this.emit();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

const sessions = new Map<string, CreativeDoc>();

export function creativeDoc(docId: string, gameId: string | null): CreativeDoc {
  let d = sessions.get(docId);
  if (!d) {
    d = new CreativeDoc(docId, gameId);
    sessions.set(docId, d);
  } else if (gameId && d.gameId !== gameId) d.gameId = gameId;
  return d;
}
