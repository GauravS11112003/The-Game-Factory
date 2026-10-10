/**
 * The reveal on Build (CONTRACTS_V3 "Firefly timing"): once the preview shows its first level, the art made while
 * the kid drew flies from the creative tray onto its objects, one by one (≈350 ms apart): an arc with a scale-up
 * and a spin, a squash and a sparkle on landing, then the engine swaps that object to its skin. Art that is still
 * being made flies in when it is ready; "Bring it to life" replays it; reduced motion fades instead.
 *
 * The draft's skin (PUT /drafts/{id}/skin) always holds every object with the kid's choice (life | ink); the stage
 * only shows the objects that have landed. Every level the preview puts on stage is dressed with that landed skin,
 * so tier swaps and Play test keep the art.
 */
import type { InkDoc, LevelV2, RectCells, SceneObject } from '../../core/types.gen.ts';
import { CAMERA, WORLD } from '../../core/params.ts';
import { strokesBBox } from '../../editor/geom.ts';
import { loadSkinImage } from '../../engine/index.ts';
import { h, prefersReducedMotion } from '../dom.ts';
import { currentPlayer } from '../identity.ts';
import type { Stage, StageShow } from '../stage.ts';
import { store } from '../store.ts';
import { creativeApi } from './api.ts';
import { creativeDoc, creativeStatus, docIdOf } from './session.ts';
import { CreativeTray } from './tray.ts';
import type { CreativeStatus, Credit, Job, Skin, SkinMode, SkinObject } from './types.ts';

const STAGGER_MS = 350;
const FLIGHT_MS = 760;
const READY_WAIT_MS = 2500;

interface Entry {
  key: string; // group_id (job_id when restored from the server's list alone)
  stroke_ids: string[];
  bbox: RectCells | null;
  job: Job;
  mode: SkinMode;
  hint: string | null;
}

interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
  off?: boolean;
}

type RectLike = { x: number; y: number; width?: number; height?: number; w?: number; h?: number };

function toScreenRect(r: RectLike | null | undefined): ScreenRect | null {
  if (!r) return null;
  const w = r.width ?? r.w ?? 0;
  const hh = r.height ?? r.h ?? 0;
  return w > 0 && hh > 0 && Number.isFinite(r.x) && Number.isFinite(r.y) ? { x: r.x, y: r.y, w, h: hh } : null;
}

export interface CreativePreview {
  destroy(): void;
}

/** The level with this skin (or with none); the gameplay fields are shared, not copied. */
function dressLevel(level: LevelV2, skin: Skin | null): LevelV2 {
  if (!skin) {
    if (level.skin === undefined) return level;
    const copy: LevelV2 = { ...level };
    delete copy.skin;
    return copy;
  }
  return { ...level, skin };
}

function author(): string | null {
  try {
    const p = currentPlayer();
    if (p?.name) return p.name;
  } catch {
    /* identity not ready */
  }
  return store.author() || null;
}

function toolName(provider: string | null | undefined): string {
  return provider === 'firefly' ? 'Adobe Firefly' : 'Claude';
}

function creditOf(job: Job): Credit {
  return {
    by: job.credit?.by ?? author(),
    tool: job.credit?.tool ?? toolName(job.provider),
    prompt: job.credit?.prompt ?? job.prompt ?? null,
  };
}

function bestObject(level: LevelV2, strokeIds: readonly string[]): SceneObject | null {
  const objs = level.objects ?? [];
  if (!objs.length) return null;
  const want = new Set(strokeIds);
  const byId = new Map(objs.map((o) => [o.id, o]));
  const score = new Map<string, number>();
  for (const o of objs) {
    const n = o.strokes.reduce((a, id) => a + (want.has(id) ? 1 : 0), 0);
    if (!n) continue;
    const root = o.rel?.part_of && byId.has(o.rel.part_of) ? o.rel.part_of : o.id;
    score.set(root, (score.get(root) ?? 0) + n);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of score) if (n > bestN) [best, bestN] = [id, n];
  return best ? byId.get(best) ?? null : null;
}

function shapeBox(o: SceneObject): RectCells | null {
  const s = o.shape;
  switch (s.k) {
    case 'body':
      return s.bbox;
    case 'point':
      return [s.p[0] - 0.5, s.p[1] - 0.5, s.p[0] + 0.5, s.p[1] + 0.5];
    case 'strip':
      return [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]) - 0.5, Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1]) + 0.5];
    case 'wall':
      return [s.x, Math.min(s.y0, s.y1), s.x + (s.w ?? 1), Math.max(s.y0, s.y1)];
    case 'surface': {
      if (!s.segs.length) return null;
      const xs = s.segs.flatMap((g) => [g.a[0], g.b[0]]);
      const ys = s.segs.flatMap((g) => [g.a[1], g.b[1]]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys) + 1];
    }
    default:
      return null;
  }
}

function easeOut(k: number): number {
  return 1 - (1 - k) * (1 - k) * (1 - k);
}

function easeInOut(k: number): number {
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

export function mountCreativePreview(o: { draftId: string; stage: Stage; ink: () => InkDoc | null }): CreativePreview {
  const draftDoc = store.draftDoc(o.draftId);
  const docId = docIdOf(draftDoc);
  if (!docId) return { destroy: () => undefined };
  const doc = creativeDoc(docId, draftDoc?.gameId ?? null);
  const stage = o.stage;
  let status: CreativeStatus | null = null;
  let destroyed = false;
  let lastShow: StageShow | null = null;
  let revealStarted = false;
  let backdropLanded = false;
  let runToken = 0;
  let nextFlightAt = 0;
  let shownSig = '';
  const landed = new Set<string>();
  const flying = new Set<string>();
  const queued = new Set<string>();
  const timers = new Set<number>();
  const reduced = prefersReducedMotion();
  const layer = h('div', { class: 'cr-fly-layer', 'aria-hidden': 'true' });
  document.body.append(layer);

  const later = (ms: number, fn: () => void): void => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (!destroyed) fn();
    }, Math.max(0, ms));
    timers.add(id);
  };

  // ---- what is on stage -------------------------------------------------------------------------------------------
  function currentInk(): InkDoc | null {
    return o.ink() ?? lastShow?.ink ?? null;
  }

  function inkIds(): Set<string> | null {
    const ink = currentInk();
    return ink ? new Set(ink.strokes.map((s) => s.id)) : null;
  }

  function backdropJob(): Job | null {
    const own = doc.backdropJob();
    if (own) return own;
    if (doc.objects.size) return null;
    // no local record (another device): the newest finished job without strokes is the backdrop
    const all = [...doc.jobs.values()].filter((j) => j.kind === 'backdrop' && j.status === 'done' && j.url);
    return all[all.length - 1] ?? null;
  }

  function entries(): Entry[] {
    const ids = inkIds();
    const out: Entry[] = [];
    const recs = doc.list();
    if (recs.length) {
      for (const r of recs) {
        const job = doc.jobOf(r);
        if (!job || job.status !== 'done' || !job.url) continue;
        if (ids && !r.stroke_ids.some((id) => ids.has(id))) continue;
        out.push({ key: r.group_id, stroke_ids: r.stroke_ids, bbox: r.bbox_cells, job, mode: r.mode, hint: r.hint });
      }
      return out;
    }
    // restored from the server's list: the newest finished job for each set of strokes
    const taken = new Set<string>();
    const jobs = [...doc.jobs.values()].filter((j) => j.kind === 'object' && j.status === 'done' && j.url && j.stroke_ids.length && (!ids || j.stroke_ids.every((id) => ids.has(id))));
    for (const j of jobs.reverse()) {
      if (j.stroke_ids.some((id) => taken.has(id))) continue;
      for (const id of j.stroke_ids) taken.add(id);
      out.push({ key: j.job_id, stroke_ids: j.stroke_ids, bbox: j.bbox_cells, job: j, mode: 'life', hint: null });
    }
    return out.sort((a, b) => (a.bbox?.[0] ?? 0) - (b.bbox?.[0] ?? 0));
  }

  function styleId(es: Entry[]): string | null {
    return es.find((e) => e.job.style_id)?.job.style_id ?? backdropJob()?.style_id ?? null;
  }

  function provider(es: Entry[]): Skin['provider'] {
    for (const e of es) if (e.job.provider === 'firefly' || e.job.provider === 'claude-svg') return e.job.provider;
    return status?.provider === 'firefly' ? 'firefly' : 'claude-svg';
  }

  function skinObject(e: Entry, level: LevelV2, mode: SkinMode): SkinObject {
    return {
      stroke_ids: e.stroke_ids.slice(), object_id: bestObject(level, e.stroke_ids)?.id ?? null, url: e.job.url!,
      label: e.job.label ?? e.hint ?? '', credit: creditOf(e.job), mode,
    };
  }

  function backdropSkin(): Skin['backdrop'] {
    const b = backdropJob();
    return b && b.status === 'done' && b.url ? { url: b.url, credit: creditOf(b) } : null;
  }

  /** The skin the stage shows: only what has landed. */
  function shownSkin(level: LevelV2): Skin | null {
    if (!doc.life) return null;
    const es = entries();
    const objs = es.filter((e) => e.mode === 'life' && landed.has(e.key)).map((e) => skinObject(e, level, 'life'));
    const bd = backdropLanded ? backdropSkin() : null;
    if (!objs.length && !bd) return null;
    return { provider: provider(es), style_id: styleId(es), backdrop: bd, objects: objs };
  }

  /** The skin the draft keeps: every object with the kid's choice. */
  function fullSkin(level: LevelV2): Skin | null {
    const life = doc.life;
    const es = entries();
    const objs = es.map((e) => skinObject(e, level, life ? e.mode : 'ink'));
    const bd = life ? backdropSkin() : null;
    if (!objs.length && !bd) return null;
    return { provider: provider(es), style_id: styleId(es), backdrop: bd, objects: objs };
  }

  // ---- dress every level the preview shows ------------------------------------------------------------------------
  const rawShow = stage.show.bind(stage);
  const dress = (s: StageShow): StageShow => ({ ...s, level: dressLevel(s.level, shownSkin(s.level)) });
  stage.show = (s: StageShow, opt?: { when?: 'now' | 'safe' }): void => {
    lastShow = s;
    const d = dress(s);
    shownSig = sigOf(d.level);
    rawShow(d, opt);
    schedulePut();
    tray.render(); // the ink may have arrived: the tray lists this level's objects
    if (!revealStarted) armStart();
  };

  function sigOf(level: LevelV2): string {
    const sk = level.skin;
    return sk ? JSON.stringify([sk.backdrop?.url ?? '', (sk.objects ?? []).map((x) => `${x.url}|${x.mode}|${(x.stroke_ids ?? []).join(',')}`)]) : '';
  }

  /** Re-skin the level on stage with what has landed: in place, the sim keeps running (Stage.setSkin). */
  function reshow(): void {
    if (!lastShow || destroyed) return;
    const d = dress(lastShow);
    const sig = sigOf(d.level);
    if (sig === shownSig) return;
    shownSig = sig;
    stage.setSkin(d.level.skin ?? null);
  }

  // ---- the draft's skin ---------------------------------------------------------------------------------------------
  let putTimer = 0;
  let lastPut = '';
  function schedulePut(): void {
    window.clearTimeout(putTimer);
    putTimer = window.setTimeout(() => void doPut(), 500);
  }

  async function doPut(): Promise<void> {
    const level = lastShow?.level;
    if (!level || destroyed) return;
    const skin = fullSkin(level);
    if (!skin && !lastPut) return; // nothing made, nothing stored
    const sig = skin ? JSON.stringify(skin) : 'null';
    if (sig === lastPut) return;
    const prev = lastPut;
    lastPut = sig;
    try {
      await creativeApi.putSkin(o.draftId, skin); // null clears a skin stored earlier
    } catch {
      lastPut = prev; // try again on the next change
    }
  }

  // ---- the tray (the launch pad) ------------------------------------------------------------------------------------
  const tray = new CreativeTray({
    doc, mode: 'preview',
    strokes: () => currentInk()?.strokes ?? [],
    status: () => status,
    include: (r) => {
      const ids = inkIds();
      return !ids || r.stroke_ids.some((id) => ids.has(id));
    },
    landed: (id) => landed.has(id) || flying.has(id),
    onReplay: () => {
      revealStarted = true;
      reveal(true);
    },
  });
  stage.el.prepend(tray.el); // a bar across the top of the stage: the sprites fly down from it

  // ---- start: the first level is on stage and the engine is ready --------------------------------------------------
  let armed = false;
  let engineReady = false;
  stage.on('ready', () => {
    engineReady = true;
    if (armed && !revealStarted) later(450, () => void start());
  });

  function armStart(): void {
    if (armed) return;
    armed = true;
    if (engineReady) later(450, () => void start());
    else later(READY_WAIT_MS, () => void start()); // the engine never said ready: reveal anyway
  }

  async function start(): Promise<void> {
    if (revealStarted || destroyed) return;
    revealStarted = true;
    await Promise.all([doc.load(), creativeStatus().then((s) => (status = s))]);
    if (destroyed) return;
    tray.render();
    reveal(false);
  }

  // ---- the reveal ---------------------------------------------------------------------------------------------------
  function reveal(replay: boolean): void {
    if (destroyed) return;
    const token = ++runToken;
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    flying.clear();
    queued.clear();
    layer.replaceChildren();
    nextFlightAt = 0;
    if (replay) {
      landed.clear();
      backdropLanded = false;
      reshow();
    }
    tray.render();
    schedulePut();
    if (!doc.life) return;
    later(replay ? 450 : 0, () => {
      if (token !== runToken) return;
      landBackdrop();
      for (const e of entries()) if (e.mode === 'life' && !landed.has(e.key)) queueFlight(e, token);
    });
  }

  function landBackdrop(): void {
    const bd = backdropSkin();
    if (backdropLanded || !bd) return;
    backdropLanded = true;
    const token = runToken;
    void Promise.race([loadSkinImage(bd.url, 'backdrop').catch(() => null), new Promise((r) => window.setTimeout(r, 2500))]).then(() => {
      if (destroyed || token !== runToken || !backdropLanded) return;
      reshow();
      if (!reduced) {
        stage.el.classList.add('cr-bd-flash');
        later(700, () => stage.el.classList.remove('cr-bd-flash'));
      }
    });
  }

  function queueFlight(e: Entry, token: number): void {
    if (queued.has(e.key) || flying.has(e.key) || landed.has(e.key)) return;
    queued.add(e.key);
    const now = performance.now();
    const at = Math.max(now, nextFlightAt);
    nextFlightAt = at + STAGGER_MS;
    later(at - now, () => {
      queued.delete(e.key);
      void fly(e, token);
    });
  }

  function land(key: string): void {
    flying.delete(key);
    landed.add(key);
    reshow();
    tray.render();
    schedulePut();
  }

  async function fly(e: Entry, token: number): Promise<void> {
    if (destroyed || token !== runToken || landed.has(e.key) || flying.has(e.key) || !e.job.url) return;
    const level = lastShow?.level;
    if (!level) return;
    if (stage.playing || stage.failed) {
      land(e.key);
      return;
    }
    const from = tray.thumbRect(e.key) ?? stageCorner();
    const to = targetRect(e, level);
    if (!from || !to) {
      land(e.key);
      return;
    }
    flying.add(e.key);
    tray.render();
    const img = h('img', { class: 'cr-flyer', src: e.job.url, alt: '', draggable: false });
    // the flyer's picture and the engine's sprite both ready (no ink flash on landing), but never wait long
    await Promise.race([
      Promise.all([img.decode().catch(() => undefined), loadSkinImage(e.job.url).catch(() => null)]),
      new Promise((r) => window.setTimeout(r, 1500)),
    ]);
    if (destroyed || token !== runToken) {
      flying.delete(e.key);
      return;
    }
    animateFlight(img, from, to, () => {
      if (token === runToken) land(e.key);
      else flying.delete(e.key); // replayed mid-flight: it flies again
    });
  }

  function stageCorner(): DOMRect | null {
    const r = stage.el.getBoundingClientRect();
    return r.width ? new DOMRect(r.left + 12, r.top + 12, 40, 40) : null;
  }

  // ---- where an object is on screen -----------------------------------------------------------------------------------
  function objectCells(e: Entry, level: LevelV2, ob: SceneObject | null): RectCells | null {
    const body = ob?.shape.k === 'body' ? shapeBox(ob) : null;
    if (body) return body;
    const ids = new Set(e.stroke_ids);
    const strokes = (currentInk()?.strokes ?? level.ink?.strokes ?? []).filter((s) => ids.has(s.id));
    return strokesBBox(strokes) ?? (ob ? shapeBox(ob) : null) ?? e.bbox;
  }

  function targetRect(e: Entry, level: LevelV2): ScreenRect | null {
    const ob = bestObject(level, e.stroke_ids);
    const cells = objectCells(e, level, ob);
    // the engine knows where things are (camera, zoom, canvas scaling); the stage geometry is the fallback
    const r = toScreenRect(ob ? stage.objectScreenRect(ob.id) : null) ?? toScreenRect(cells ? stage.worldToScreen(cells) : null);
    if (r) return onStage(r);
    if (!cells) return null;
    const canvas = stage.el.querySelector<HTMLCanvasElement>('.dalg-stage canvas') ?? stage.el.querySelector<HTMLCanvasElement>('.stage-host canvas');
    const cr = canvas?.getBoundingClientRect();
    if (!cr || !cr.width || !cr.height) return null;
    // the preview camera: horizontal only, full height, starting at the player's spawn (core/sim/camera.ts initCamera)
    const viewW = CAMERA.view_w_c;
    const kx = cr.width / viewW;
    const ky = cr.height / WORLD.h;
    const start = level.compiled.entities.find((x) => x.type === 'player_start') as { x: number } | undefined;
    const camX = Math.max(0, Math.min(Math.max(0, level.world.w - viewW), (start?.x ?? 2) + CAMERA.look_ahead_c - viewW / 2));
    let x = cr.left + (cells[0] - camX) * kx;
    const y = cr.top + cells[1] * ky;
    const w = Math.max(8, (cells[2] - cells[0]) * kx);
    const hh = Math.max(8, (cells[3] - cells[1]) * ky);
    let off = false;
    if (x + w < cr.left + 4) {
      x = cr.left;
      off = true;
    } else if (x > cr.right - 4) {
      x = cr.right - w;
      off = true;
    }
    return { x, y, w, h: hh, off };
  }

  /** A rect outside the visible stage lands on its edge and fades there (the camera shows another part of the level). */
  function onStage(r: ScreenRect): ScreenRect {
    const canvas = stage.el.querySelector<HTMLCanvasElement>('.dalg-stage canvas') ?? stage.el.querySelector<HTMLCanvasElement>('.stage-host canvas');
    const cr = canvas?.getBoundingClientRect();
    if (!cr || !cr.width) return r;
    if (r.x + r.w < cr.left + 4) return { ...r, x: cr.left, off: true };
    if (r.x > cr.right - 4) return { ...r, x: cr.right - r.w, off: true };
    return r;
  }

  // ---- the flight -----------------------------------------------------------------------------------------------------
  function animateFlight(img: HTMLImageElement, from: DOMRect, to: ScreenRect, onLand: () => void): void {
    Object.assign(img.style, { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px` });
    layer.append(img);
    const tx = to.x + to.w / 2;
    const ty = to.y + to.h / 2;
    const finish = (sparkles: boolean): void => {
      onLand();
      if (to.off) {
        img.remove(); // already faded out at the stage's edge
        return;
      }
      if (sparkles) sparkle(tx, ty, Math.max(to.w, to.h));
      // the engine's sprite takes over: fade the flyer out
      const fade = img.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, delay: 220, fill: 'forwards' });
      fade.finished.then(() => img.remove(), () => img.remove());
    };
    if (typeof img.animate !== 'function') {
      img.remove();
      onLand();
      return;
    }
    if (reduced) {
      img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: 'forwards' }).finished.then(() => finish(false), () => finish(false));
      return;
    }
    const fx = from.left + from.width / 2;
    const fy = from.top + from.height / 2;
    const dir = tx >= fx ? 1 : -1;
    const cx = (fx + tx) / 2;
    const cy = Math.min(fy, ty) - Math.max(70, Math.abs(tx - fx) * 0.3);
    const s0 = Math.max(0.12, Math.min(3, Math.min(from.width / Math.max(1, to.w), from.height / Math.max(1, to.h))));
    const frames: Keyframe[] = [];
    const N = 18;
    for (let i = 0; i <= N; i++) {
      const k = i / N;
      const p = easeInOut(k);
      const x = (1 - p) * (1 - p) * fx + 2 * (1 - p) * p * cx + p * p * tx;
      const y = (1 - p) * (1 - p) * fy + 2 * (1 - p) * p * cy + p * p * ty;
      const s = k < 0.78 ? s0 + (1.16 - s0) * easeOut(k / 0.78) : 1.16 - 0.16 * ((k - 0.78) / 0.22);
      const rot = dir * -220 * (1 - easeOut(k));
      frames.push({
        offset: k, transform: `translate(${(x - tx).toFixed(1)}px, ${(y - ty).toFixed(1)}px) rotate(${rot.toFixed(1)}deg) scale(${s.toFixed(3)})`,
        opacity: to.off && k > 0.8 ? Math.max(0, 1 - (k - 0.8) / 0.2) : 1,
      });
    }
    const a = img.animate(frames, { duration: FLIGHT_MS, easing: 'linear', fill: 'forwards' });
    a.finished.then(() => {
      if (to.off) {
        finish(false);
        return;
      }
      // squash and stretch on landing, feet down
      img.style.transformOrigin = '50% 100%';
      const sq = img.animate([
        { transform: 'scale(1, 1)' }, { transform: 'scale(1.22, 0.78)', offset: 0.35 }, { transform: 'scale(0.93, 1.08)', offset: 0.7 }, { transform: 'scale(1, 1)' },
      ], { duration: 280, easing: 'ease-out', fill: 'forwards' });
      sq.finished.then(() => finish(true), () => finish(true));
    }, () => finish(false));
  }

  function sparkle(x: number, y: number, size: number): void {
    const n = 9;
    const r = Math.max(26, Math.min(90, size * 0.75));
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const star = h('span', { class: `cr-spark-bit c${i % 3}` }, i % 2 ? '✦' : '✧');
      Object.assign(star.style, { left: `${x}px`, top: `${y}px` });
      layer.append(star);
      const dx = Math.cos(ang) * r;
      const dy = Math.sin(ang) * r;
      star.animate([
        { transform: 'translate(-50%, -50%) scale(0.3)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx * 0.7}px), calc(-50% + ${dy * 0.7}px)) scale(1.1)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.2)`, opacity: 0 },
      ], { duration: 560, easing: 'ease-out', fill: 'forwards' }).finished.then(() => star.remove(), () => star.remove());
    }
  }

  // ---- late art, toggles, variants ----------------------------------------------------------------------------------
  const offDoc = doc.on(() => {
    if (destroyed) return;
    if (revealStarted) {
      if (doc.life) {
        landBackdrop();
        for (const e of entries()) {
          if (e.mode === 'ink') landed.delete(e.key); // back to "My drawing": switching again flies it in again
          else if (!landed.has(e.key)) queueFlight(e, runToken);
        }
      } else if (landed.size || backdropLanded) {
        landed.clear();
        backdropLanded = false;
      }
    }
    reshow(); // an object switched to "My drawing", a new variant was picked, the game toggle changed
    schedulePut();
  });

  void creativeStatus().then((s) => {
    status = s;
    tray.render();
  });
  void doc.load();

  return {
    destroy(): void {
      destroyed = true;
      runToken++;
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      window.clearTimeout(putTimer);
      offDoc();
      tray.destroy();
      layer.remove();
      Reflect.deleteProperty(stage, 'show'); // back to Stage.prototype.show
    },
  };
}
