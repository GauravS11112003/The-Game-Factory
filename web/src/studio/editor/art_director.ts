/**
 * v7 art in the Studio (docs/v7/CONTRACTS_V7.md §2, §5): makes sure the game has an art direction, starts art jobs,
 * polls them while the maker keeps working, applies the results as quiet `set_art` / `set_backdrop` steps, makes the
 * objects being drawn shimmer, and shows a small progress pill ("Drawing 4 of 9…").
 *
 * - `restyle(prompt)`: the copilot's art_prompt, "Restyle everything", ✨ Make it real (prompt null = the current
 *   direction, or one from the game). New direction (+ theme), then one job for every drawn object and the backdrop.
 *   Returns a session the restyle card follows; "Use the new look" / "Keep the old one" are `confirm` / `revert`.
 * - `drawOne(id)`: recognize → art, Try again, Redraw: one object, 3 variants, then the compare card.
 */
import type { ArtJobStatus, StudioEdit, StudioTheme } from '../../core/types.gen.ts';
import { h, toast } from '../../app/dom.ts';
import { t } from '../../app/messages.ts';
import { isOffline, isTimeout, StudioApiError, studioApi } from '../../app/studio_api.ts';
import { artTargets, confirmEdits, isDrawn, itemEdits, itemKey, newlyFinished, revertEdits, stillDrawing, type JobPlan } from '../model/art_plan.ts';
import { sceneOf } from '../model/doc.ts';
import { jobDoc, slimDoc } from '../model/payload.ts';
import { asGameDoc, normalizeTheme, type SDoc } from '../model/types.ts';
import { sicon } from './icons.ts';
import { objectPng } from './snapshot.ts';
import type { Studio } from './studio.ts';

const POLL_MS = 1500;
const VARIANTS = 2; // v7-fast

export type SessionState = 'planning' | 'drawing' | 'done' | 'failed' | 'used' | 'kept' | 'replaced';

export interface RestyleSession {
  readonly id: number;
  readonly prompt: string;
  readonly before: SDoc;
  state: SessionState;
  plan: JobPlan | null;
  /** Variant ids each object got in this restyle (for "Use the new look"). */
  fresh: Map<string, string[]>;
  done: number;
  total: number;
  themeChanged: boolean;
  error: string | null;
  summary: string;
  on(fn: () => void): () => void;
}

interface Session extends RestyleSession {
  listeners: Set<() => void>;
  job: Job | null;
}

interface Job {
  id: string | null;
  plan: JobPlan;
  seen: Set<string>;
  done: number;
  total: number;
  last: ArtJobStatus | null;
  timer: number;
  misses: number;
  stopped: boolean;
  session: Session | null;
  failedItems: number;
}

let nextSession = 1;

export class ArtDirector {
  private jobs: Job[] = [];
  private sessions = new Map<number, Session>();
  private current: Session | null = null;
  private planning = 0;
  private pill: HTMLElement;
  private disposed = false;
  /** Called when a single-object job brings variants the maker has not judged yet (opens the compare card). */
  onVariants: ((id: string, fresh: string[]) => void) | null = null;

  constructor(private readonly studio: Studio, host: HTMLElement) {
    this.pill = h('div', { class: 'st-artpill', role: 'status', 'aria-live': 'polite', hidden: true });
    host.append(this.pill);
  }

  /** Is an object (or anything at all) being drawn? */
  busy(id?: string): boolean {
    return id ? this.studio.artBusy.has(id) : this.studio.artBusy.size > 0 || this.studio.backdropBusy || this.planning > 0;
  }

  session(id: number): RestyleSession | undefined {
    return this.sessions.get(id);
  }

  // ---- art direction ----

  /** A new art direction from words (or from the game when `prompt` is empty). Throws on failure. */
  private async direction(prompt: string): Promise<{ edits: StudioEdit[]; theme: StudioTheme | null; summary: string }> {
    const s = this.studio;
    const r = await studioApi.artDirection({ game: asGameDoc(slimDoc(s.doc)), prompt: prompt.slice(0, 300) });
    const rev = Math.max(1, (s.doc.art_direction?.rev ?? 0) + 1);
    const dir = { ...r.direction, rev: Math.max(rev, r.direction.rev ?? 1), prompt: r.direction.prompt || prompt.slice(0, 300) };
    return { edits: [{ action: 'set_art_direction', data: dir as unknown as Record<string, unknown> }], theme: r.theme ?? null, summary: dir.summary ?? '' };
  }

  private failText(e: unknown): string {
    if (isTimeout(e)) return t('studio.art.err_timeout');
    if (isOffline(e)) return t('studio.art.err_offline');
    if (e instanceof StudioApiError && e.status === 429) return t('studio.art.err_busy');
    return t('studio.art.err_failed');
  }

  // ---- restyle (copilot, panel, Make it real) ----

  /**
   * Restyle everything: `prompt` = the new look in words; null = the current direction (or one from the game).
   * Returns the session the restyle card follows.
   */
  restyle(prompt: string | null): RestyleSession {
    const s = this.studio;
    const words = (prompt ?? '').trim();
    const sess: Session = {
      id: nextSession++, prompt: words || s.doc.art_direction?.prompt || '', before: s.doc, state: 'planning', plan: null, fresh: new Map(),
      done: 0, total: 0, themeChanged: false, error: null, summary: s.doc.art_direction?.summary ?? '', listeners: new Set(), job: null,
      on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    };
    if (this.current && (this.current.state === 'planning' || this.current.state === 'drawing')) {
      this.current.state = 'replaced';
      if (this.current.job) this.stopJob(this.current.job);
      this.ping(this.current);
    }
    this.current = sess;
    this.sessions.set(sess.id, sess);
    void this.runRestyle(sess, prompt === null ? null : words);
    return sess;
  }

  private async runRestyle(sess: Session, words: string | null): Promise<void> {
    const s = this.studio;
    this.planning++;
    this.renderPill();
    try {
      const edits: StudioEdit[] = [];
      const fresh = words !== null || !s.doc.art_direction;
      if (fresh) {
        const d = await this.direction(words ?? '');
        if (this.disposed || sess.state === 'replaced') return;
        edits.push(...d.edits);
        sess.summary = d.summary;
        if (d.theme) {
          // the matching theme (HUD palette, font, particles) without dropping the theme's id-less custom bits
          edits.push({ action: 'set_theme', data: { ...normalizeTheme(d.theme), id: d.theme.id ?? null } as Record<string, unknown> });
          sess.themeChanged = true;
        }
      }
      if ((s.doc.look ?? 'game') !== 'game') edits.push({ action: 'set_look', data: { look: 'game' } });
      if (edits.length) {
        s.apply(edits, { label: 'restyle' });
        s.seal();
      }
    } catch (e) {
      if (sess.state === 'replaced') return;
      sess.state = 'failed';
      sess.error = this.failText(e);
      this.ping(sess);
      return;
    } finally {
      this.planning--;
      this.renderPill();
    }
    const plan: JobPlan = { kind: 'restyle', scene: s.sceneId, objects: artTargets(s.doc, s.sceneId), backdrop: true };
    sess.plan = plan;
    sess.state = 'drawing';
    sess.total = plan.objects.length + 1;
    this.ping(sess);
    const job = this.startJob(plan, sess);
    sess.job = job;
  }

  /** "Use the new look": everything the restyle drew plays, the old variants go. */
  confirm(id: number): void {
    const sess = this.sessions.get(id);
    if (!sess || !sess.plan) return;
    const edits = confirmEdits(this.studio.doc, sess.plan, sess.fresh);
    if (edits.length) {
      this.studio.apply(edits, { label: 'restyle' });
      this.studio.seal();
    }
    sess.state = 'used';
    this.ping(sess);
  }

  /** "Keep the old one": stop drawing and put the old art, backdrop, direction and theme back. */
  revert(id: number): void {
    const sess = this.sessions.get(id);
    if (!sess) return;
    if (sess.job) this.stopJob(sess.job);
    const plan = sess.plan ?? { kind: 'restyle' as const, scene: this.studio.sceneId, objects: [], backdrop: false };
    const edits = revertEdits(sess.before, this.studio.doc, { ...plan, backdrop: true }, { theme: sess.themeChanged });
    this.studio.apply(edits, { label: 'restyle' });
    this.studio.seal();
    sess.state = 'kept';
    this.ping(sess);
  }

  // ---- one object (recognize, Try again, Redraw) ----

  /** Draw one object (3 variants); the compare card opens when they arrive. Quietly does nothing offline. */
  async drawOne(id: string, o: { quiet?: boolean } = {}): Promise<boolean> {
    const s = this.studio;
    const obj = s.object(id);
    if (!obj || !isDrawn(obj)) return false;
    if (this.jobs.some((j) => !j.stopped && j.plan.kind === 'single' && j.plan.objects.includes(id))) return true;
    s.setArtBusy([...s.artBusy, id], s.backdropBusy);
    if (!s.doc.art_direction) {
      this.planning++;
      this.renderPill();
      try {
        const d = await this.direction('');
        if (this.disposed) return false;
        if (!s.doc.art_direction) {
          s.apply(d.edits, { label: 'art', quiet: true });
          s.seal();
        }
      } catch (e) {
        this.refreshBusy();
        if (!o.quiet) toast(this.failText(e));
        return false;
      } finally {
        this.planning--;
        this.renderPill();
      }
    }
    this.startJob({ kind: 'single', scene: s.sceneId, objects: [id], backdrop: false }, null, o.quiet);
    return true;
  }

  // ---- jobs ----

  private startJob(plan: JobPlan, session: Session | null, quiet = false): Job {
    const job: Job = { id: null, plan, seen: new Set(), done: 0, total: plan.objects.length + (plan.backdrop ? 1 : 0), last: null, timer: 0, misses: 0, stopped: false, session, failedItems: 0 };
    this.jobs.push(job);
    this.refreshBusy();
    void this.post(job, quiet);
    return job;
  }

  private async post(job: Job, quiet: boolean): Promise<void> {
    const s = this.studio;
    const images: Record<string, string> = {};
    for (const id of job.plan.objects) {
      const o = sceneOf(s.doc, job.plan.scene).objects.find((x) => x.id === id);
      const png = o ? objectPng(o, s.doc, 512) : null;
      if (png) images[id] = png;
    }
    try {
      const r = await studioApi.startArtJob({
        game: asGameDoc(jobDoc(s.doc, job.plan.objects)), scene: job.plan.scene, objects: job.plan.objects, backdrop: job.plan.backdrop, variants: VARIANTS, images,
      });
      if (job.stopped || this.disposed) return;
      job.id = r.id;
      job.timer = window.setTimeout(() => void this.poll(job), POLL_MS);
    } catch (e) {
      this.finish(job, quiet ? null : this.failText(e));
    }
  }

  private async poll(job: Job): Promise<void> {
    if (job.stopped || this.disposed || !job.id) return;
    let st: ArtJobStatus;
    try {
      st = await studioApi.artJob(job.id);
      job.misses = 0;
    } catch (e) {
      if (job.stopped || this.disposed) return;
      job.misses++;
      // a lost job (server restarted, an hour passed) will not come back; a flaky network might
      if ((e instanceof StudioApiError && e.status === 404) || job.misses > 10) { this.finish(job, t('studio.art.err_lost')); return; }
      job.timer = window.setTimeout(() => void this.poll(job), POLL_MS * Math.min(4, 1 + job.misses / 2));
      return;
    }
    if (job.stopped || this.disposed) return;
    job.last = st;
    job.total = Math.max(job.total, st.total || 0);
    this.take(job, st);
    if (st.status === 'running') {
      job.timer = window.setTimeout(() => void this.poll(job), POLL_MS);
      this.refreshBusy();
      return;
    }
    this.finish(job, st.status === 'failed' && !job.done ? t('studio.art.err_failed') : null);
  }

  /** Apply everything that finished since the last poll, as one quiet undo step. */
  private take(job: Job, st: ArtJobStatus): void {
    const s = this.studio;
    const items = newlyFinished(st, job.seen);
    if (!items.length) return;
    const edits: StudioEdit[] = [];
    const arrived: [string, string[]][] = [];
    for (const it of items) {
      job.seen.add(itemKey(it));
      job.done++;
      if (it.status !== 'done') { job.failedItems++; continue; }
      const r = itemEdits(s.doc, job.plan, it);
      edits.push(...r.edits);
      if (it.object_id && r.fresh.length) arrived.push([it.object_id, r.fresh]);
      if (it.object_id && job.session) job.session.fresh.set(it.object_id, r.fresh);
    }
    if (edits.length) {
      s.apply(edits, { label: 'art', quiet: true });
      s.seal();
    }
    if (job.session) {
      job.session.done = job.done;
      job.session.total = job.total;
      this.ping(job.session);
    }
    if (job.plan.kind === 'single') {
      for (const [id, fresh] of arrived) {
        const o = s.object(id);
        if (o?.art && !o.art.asked) this.onVariants?.(id, fresh);
      }
    }
    s.emit({ kind: 'art' });
  }

  private finish(job: Job, error: string | null): void {
    job.stopped = true;
    window.clearTimeout(job.timer);
    this.jobs = this.jobs.filter((j) => j !== job);
    if (job.session && job.session.state === 'drawing') {
      job.session.state = error && !job.done ? 'failed' : 'done';
      job.session.error = error;
      this.ping(job.session);
    }
    if (error) toast(error);
    else if (job.failedItems && job.plan.kind === 'single') toast(t('studio.art.err_one'));
    this.refreshBusy();
  }

  private stopJob(job: Job): void {
    job.stopped = true;
    window.clearTimeout(job.timer);
    this.jobs = this.jobs.filter((j) => j !== job);
    this.refreshBusy();
  }

  private refreshBusy(): void {
    const ids = new Set<string>();
    let backdrop = false;
    for (const j of this.jobs) {
      for (const id of stillDrawing(j.last, j.plan)) ids.add(id);
      if (j.plan.backdrop && !j.seen.has('@backdrop')) backdrop = true;
    }
    this.studio.setArtBusy(ids, backdrop);
    this.renderPill();
  }

  private ping(sess: Session): void {
    for (const fn of [...sess.listeners]) {
      try { fn(); } catch (e) { console.warn('restyle listener failed', e); }
    }
  }

  // ---- progress pill ----

  private pillTimer = 0;
  private renderPill(): void {
    const total = this.jobs.reduce((n, j) => n + j.total, 0);
    const done = this.jobs.reduce((n, j) => n + j.done, 0);
    window.clearTimeout(this.pillTimer);
    if (!this.jobs.length && !this.planning) {
      if (!this.pill.hidden && !this.pill.classList.contains('out')) {
        this.pill.classList.add('out');
        this.pillTimer = window.setTimeout(() => { this.pill.hidden = true; this.pill.classList.remove('out'); }, 260);
      }
      return;
    }
    this.pill.classList.remove('out');
    this.pill.hidden = false;
    const label = this.planning && !this.jobs.length ? t('studio.art.planning') : t('studio.art.drawing', { n: Math.min(total, done + 1), total: Math.max(1, total) });
    const pct = total ? Math.round((done / total) * 100) : 6;
    this.pill.replaceChildren(
      h('span', { class: 'st-artpill-spark', 'aria-hidden': 'true' }, sicon('sparkle')),
      h('span', { class: 'st-artpill-text' }, label),
      h('span', { class: 'st-artpill-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.max(6, pct)}%` })));
    this.pill.title = t('studio.art.pill_help');
  }

  dispose(): void {
    this.disposed = true;
    for (const j of this.jobs) { j.stopped = true; window.clearTimeout(j.timer); }
    this.jobs = [];
    window.clearTimeout(this.pillTimer);
    this.pill.remove();
  }
}
