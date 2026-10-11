/**
 * The restyle card in the copilot chat (docs/v7/CONTRACTS_V7.md §2.3, §5): before/after of the whole scene with a
 * draggable split, live while Claude draws ("Drawing 4 of 9…"), then "Use the new look" / "Keep the old one". The
 * old variants, backdrop, direction and theme are kept until the maker decides. Sketch objects that got variants can
 * be reviewed one by one in the compare card.
 */
import { h } from '../../app/dom.ts';
import { kidText, t } from '../../app/messages.ts';
import { sceneOf } from '../model/doc.ts';
import { unasked } from '../model/art_plan.ts';
import type { SDoc } from '../model/types.ts';
import type { ArtDirector, RestyleSession } from './art_director.ts';
import type { CompareCard } from './compare.ts';
import { sicon } from './icons.ts';
import { sceneLookCanvas, startRegion } from './look.ts';
import type { Studio } from './studio.ts';

const W = 640;
const H = 360;

export function restyleCard(studio: Studio, director: ArtDirector, first: RestyleSession, compare: CompareCard | null): HTMLElement {
  let sess = first;
  let off: (() => void) | null = null;
  let pct = 50;
  let afterAt = 0;
  let afterTimer = 0;
  let renderedBefore: SDoc | null = null;

  const beforeBox = h('div', { class: 'st-rs-pane before' });
  const afterBox = h('div', { class: 'st-rs-pane after' });
  const handle = h('div', { class: 'st-rs-handle', role: 'slider', tabindex: '0', 'aria-label': t('studio.rs.compare'), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span', { class: 'st-rs-knob' }, sicon('back'), sicon('chevron')));
  const progress = h('div', { class: 'st-rs-progress' }, h('span', { class: 'st-rs-progress-text' }), h('span', { class: 'st-rs-bar' }, h('i')));
  const viewer = h('div', { class: 'st-rs-viewer' }, beforeBox, afterBox, handle,
    h('span', { class: 'st-rs-chip left' }, t('studio.rs.before')), h('span', { class: 'st-rs-chip right' }, t('studio.rs.after')), progress);
  const title = h('div', { class: 'st-rs-title' });
  const summary = h('div', { class: 'st-rs-summary' });
  const actions = h('div', { class: 'st-rs-actions' });
  const status = h('div', { class: 'st-rs-status', 'aria-live': 'polite' });
  const el = h('div', { class: 'st-rs' },
    h('div', { class: 'st-rs-head' }, h('span', { class: 'st-rs-eyebrow' }, sicon('sparkle'), t('studio.rs.eyebrow')), title, summary),
    viewer, status, actions);

  const setPct = (v: number): void => {
    pct = Math.max(0, Math.min(100, v));
    afterBox.style.clipPath = `inset(0 0 0 ${pct}%)`;
    handle.style.left = `${pct}%`;
    handle.setAttribute('aria-valuenow', String(Math.round(pct)));
  };
  setPct(pct);
  let dragging = false;
  const fromEvent = (e: PointerEvent): void => {
    const r = viewer.getBoundingClientRect();
    setPct(((e.clientX - r.left) / Math.max(1, r.width)) * 100);
  };
  viewer.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.st-rs-progress')) return;
    dragging = true;
    viewer.classList.add('dragging');
    try { viewer.setPointerCapture(e.pointerId); } catch { /* fine */ }
    fromEvent(e);
  });
  viewer.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  const stop = (): void => { dragging = false; viewer.classList.remove('dragging'); };
  viewer.addEventListener('pointerup', stop);
  viewer.addEventListener('pointercancel', stop);
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { setPct(pct - 5); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setPct(pct + 5); e.preventDefault(); }
    e.stopPropagation();
  });

  /** Ease the split to `to` (the reveal when the new look is ready). */
  const sweep = (to: number): void => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setPct(to); return; }
    const from = pct;
    const t0 = performance.now();
    const step = (now: number): void => {
      if (dragging) return;
      const k = Math.min(1, (now - t0) / 900);
      setPct(from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const sceneId = (): string => sess.plan?.scene ?? studio.sceneId;
  const paint = async (box: HTMLElement, doc: SDoc): Promise<void> => {
    const sc = sceneOf(doc, sceneId());
    try {
      const c = await sceneLookCanvas(doc, sc, W, H, { region: startRegion(sc.world) });
      c.className = 'st-rs-canvas';
      box.replaceChildren(c);
      box.classList.add('ready');
    } catch {
      /* keep the old picture */
    }
  };
  const paintAfter = (): void => {
    window.clearTimeout(afterTimer);
    const wait = Math.max(0, 1100 - (Date.now() - afterAt));
    afterTimer = window.setTimeout(() => { afterAt = Date.now(); void paint(afterBox, studio.doc); }, wait);
  };

  const btn = (label: string, ico: string, cls: string, run: () => void, disabled = false): HTMLButtonElement =>
    h('button', { type: 'button', class: `st-btn ${cls}`, onclick: run, disabled }, sicon(ico), label);

  const update = (): void => {
    if (renderedBefore !== sess.before) { renderedBefore = sess.before; void paint(beforeBox, sess.before); }
    title.textContent = sess.prompt ? `“${kidText(sess.prompt)}”` : t('studio.rs.make_real');
    summary.textContent = sess.summary ? kidText(sess.summary) : '';
    summary.hidden = !sess.summary;
    el.dataset.state = sess.state;
    const drawing = sess.state === 'planning' || sess.state === 'drawing';
    viewer.classList.toggle('working', drawing);
    const pt = progress.querySelector('.st-rs-progress-text')!;
    const bar = progress.querySelector<HTMLElement>('.st-rs-bar i')!;
    if (sess.state === 'planning') { pt.textContent = t('studio.art.planning'); bar.style.width = '6%'; }
    else if (sess.state === 'drawing') {
      pt.textContent = t('studio.art.drawing', { n: Math.min(sess.total, sess.done + 1), total: Math.max(1, sess.total) });
      bar.style.width = `${Math.max(6, Math.round((sess.done / Math.max(1, sess.total)) * 100))}%`;
    }
    progress.hidden = !drawing;
    status.textContent = sess.state === 'failed' ? sess.error ?? t('studio.art.err_failed')
      : sess.state === 'used' ? t('studio.rs.used') : sess.state === 'kept' ? t('studio.rs.kept') : sess.state === 'replaced' ? t('studio.rs.replaced') : '';
    status.className = `st-rs-status ${sess.state}`;
    const kids: HTMLElement[] = [];
    if (drawing || sess.state === 'done') {
      kids.push(btn(t('studio.rs.use'), 'check', 'primary', () => director.confirm(sess.id), sess.state !== 'done'));
      kids.push(btn(t('studio.rs.keep'), 'undo', '', () => director.revert(sess.id)));
      const waiting = sess.state === 'done' && compare ? unasked(studio.doc, sceneId()).filter((id) => sess.fresh.has(id)) : [];
      if (waiting.length) kids.push(h('button', { type: 'button', class: 'st-link', onclick: () => compare!.review(waiting, sess.fresh) }, t('studio.rs.review', { n: waiting.length })));
    } else if (sess.state === 'failed') {
      kids.push(btn(t('studio.rs.retry'), 'restart', 'primary', () => bind(director.restyle(sess.prompt || null))));
      if (sess.plan) kids.push(btn(t('studio.rs.keep'), 'undo', '', () => director.revert(sess.id)));
    }
    actions.replaceChildren(...kids);
    actions.hidden = !kids.length;
    if (sess.state !== 'planning') paintAfter();
  };

  let lastState = sess.state;
  const bind = (s: RestyleSession): void => {
    off?.();
    sess = s;
    lastState = s.state;
    off = s.on(() => {
      if (lastState !== 'done' && sess.state === 'done') window.setTimeout(() => sweep(50), 1200);
      lastState = sess.state;
      update();
    });
    setPct(sess.state === 'done' ? 50 : 88);
    update();
  };
  bind(first);
  return el;
}
