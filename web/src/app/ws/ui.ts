/**
 * Small building blocks for the v4 workspace panels (lane D): status and kind chips, tab bars, a dialog, ink
 * thumbnails and calm error sentences. The look is the calm paper-and-ink workspace (ws.css): cream page, 1px-bordered
 * cards, ink primary buttons, small coloured status chips.
 */
import './ws.css';
import type { GameMode, InkStroke, LevelV2 } from '../../core/types.gen.ts';
import { strokesBBox } from '../../editor/geom.ts';
import { paintFit } from '../../editor/paint.ts';
import { ApiError } from '../api.ts';
import { errText } from '../collab/ui.ts';
import { h, icon, type Child } from '../dom.ts';
import { t } from '../messages.ts';
import { levelStatus, statusText } from './model.ts';

export const enc = encodeURIComponent;

export function chip(label: Child, cls = 'plain'): HTMLSpanElement {
  return h('span', { class: `w-chip ${cls}` }, label);
}

/** Beatable (green), N to fix (amber) or not checked yet (grey). */
export function statusChip(level: LevelV2 | null | undefined): HTMLSpanElement {
  const s = levelStatus(level);
  return chip(statusText(s), s.kind);
}

export function modeName(m: GameMode | null | undefined): string {
  return t(`gw.mode.${m ?? 'platformer'}`);
}

/** A workspace button (`primary` = ink). Links when `href` is given. */
export function btn(label: Child, o: { href?: string; onclick?: (e: MouseEvent) => void; cls?: string; icon?: string; title?: string; disabled?: boolean; type?: 'button' | 'submit' } = {}): HTMLButtonElement | HTMLAnchorElement {
  const kids = [o.icon ? icon(o.icon) : null, label];
  const cls = `w-btn${o.cls ? ` ${o.cls}` : ''}`;
  if (o.href) return h('a', { class: cls, href: o.href, title: o.title }, ...kids);
  return h('button', { type: o.type ?? 'button', class: cls, onclick: o.onclick, title: o.title, disabled: o.disabled }, ...kids);
}

/** A square icon-only button with an accessible name. */
export function iconBtn(name: string, label: string, onclick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: `w-icon-btn${cls ? ` ${cls}` : ''}`, title: label, 'aria-label': label, onclick }, icon(name));
}

/** A row of toggle chips (one choice); `aria-pressed` marks the chosen one. */
export function pickRow<T extends string>(items: readonly T[], value: T | null, label: (v: T) => string, onPick: (v: T) => void, o: { name?: string; disabled?: boolean } = {}): HTMLElement {
  return h('div', { class: 'w-picks', role: 'group', 'aria-label': o.name },
    ...items.map((v) => h('button', {
      type: 'button', class: `w-pick${v === value ? ' on' : ''}`, 'aria-pressed': String(v === value), disabled: o.disabled,
      onclick: () => onPick(v),
    }, label(v))));
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
}

export interface Tabs<T extends string> {
  readonly el: HTMLElement;
  readonly panel: HTMLElement;
  select(id: T): void;
  setCount(id: T, n: number | undefined): void;
}

/** An accessible tab bar (arrow keys move between tabs) with one panel; `render` fills the panel for a tab. */
export function tabs<T extends string>(items: TabItem<T>[], first: T, render: (id: T, panel: HTMLElement) => void, o: { label: string; onSelect?: (id: T) => void }): Tabs<T> {
  const uid = `w${Math.random().toString(36).slice(2, 8)}`;
  const bar = h('div', { class: 'w-tabs', role: 'tablist', 'aria-label': o.label });
  const panel = h('div', { class: 'w-tab-panel', role: 'tabpanel', tabIndex: 0 });
  let cur = first;
  const counts = new Map<T, number>();
  for (const it of items) if (it.count) counts.set(it.id, it.count);
  const draw = (): void => {
    bar.replaceChildren(...items.map((it, i) => {
      const on = it.id === cur;
      const n = counts.get(it.id);
      const b = h('button', {
        type: 'button', role: 'tab', id: `${uid}-${it.id}`, class: `w-tab${on ? ' on' : ''}`, 'aria-selected': String(on), tabIndex: on ? 0 : -1,
        onclick: () => select(it.id),
      }, it.label, n ? h('span', { class: 'w-count' }, String(n)) : '');
      b.onkeydown = (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const next = items[(i + d + items.length) % items.length];
        select(next.id);
        bar.querySelector<HTMLButtonElement>(`#${uid}-${next.id}`)?.focus();
      };
      return b;
    }));
    panel.setAttribute('aria-labelledby', `${uid}-${cur}`);
  };
  function select(id: T): void {
    cur = id;
    draw();
    panel.replaceChildren();
    render(id, panel);
    o.onSelect?.(id);
  }
  select(first);
  return {
    el: h('div', { class: 'w-tabbed' }, bar, panel), panel, select,
    setCount: (id, n) => {
      if (n) counts.set(id, n);
      else counts.delete(id);
      draw();
    },
  };
}

/** A dialog over the page (route changes remove it with the other .modal-back sheets). Escape closes it. */
export function dialog(title: string, body: Child, o: { onClose?: () => void; wide?: boolean } = {}): { el: HTMLElement; close(): void } {
  const back = h('div', { class: 'modal-back w-dialog-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const close = (): void => {
    window.removeEventListener('keydown', onKey);
    back.remove();
    o.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  back.onclick = (e) => {
    if (e.target === back) close();
  };
  back.append(h('div', { class: `w-dialog${o.wide ? ' wide' : ''}` },
    h('div', { class: 'w-dialog-head' }, h('h2', { class: 'w-h2' }, title), iconBtn('close', t('ui.close'), close)),
    body));
  document.body.append(back);
  window.addEventListener('keydown', onKey);
  window.setTimeout(() => back.querySelector<HTMLElement>('input, textarea, button:not(.w-icon-btn)')?.focus(), 0);
  return { el: back, close };
}

/** Kid ink fitted into a small canvas (block art, legend symbols). */
export function inkThumb(strokes: InkStroke[], w = 112, hgt = 96, cls = 'w-ink-thumb'): HTMLCanvasElement {
  const c = h('canvas', { class: cls, width: w * 2, height: hgt * 2, role: 'img' });
  c.style.width = `${w}px`;
  c.style.height = `${hgt}px`;
  paintFit(c, strokes, atLeast(strokesBBox(strokes), 5 * (w / hgt), 5), { pad: 0.25, bg: '#FBF6EA' });
  return c;
}

/** Grow a bbox (around its centre) to at least `minW` × `minH` cells, so a tiny drawing is not zoomed into a blob
 * of marker: a 2-cell star keeps thin lines and sits in the middle of its card. */
function atLeast(box: [number, number, number, number] | null, minW: number, minH: number): [number, number, number, number] | null {
  if (!box) return box;
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = Math.max(x1 - x0, minW) / 2;
  const hh = Math.max(y1 - y0, minH) / 2;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

export function emptyState(text: string, ...actions: Child[]): HTMLElement {
  return h('div', { class: 'w-empty' }, h('p', null, text), actions.length ? h('div', { class: 'row wrap' }, ...actions) : '');
}

/** The route is not live yet (lane C still building it): a 404 / 405 / 501 that carries no sentence of its own. */
export function notReady(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 501 || e.status === 405 || (e.status === 404 && e.messageKey === 'error.not_found'));
}

/** A calm sentence for an error: "not switched on yet" for missing routes, else the error's own sentence. */
export function calm(e: unknown, notReadyKey = 'gw.not_ready'): string {
  return notReady(e) ? t(notReadyKey) : errText(e);
}

export function note(text: string, cls = 'muted small'): HTMLParagraphElement {
  return h('p', { class: cls }, text);
}
