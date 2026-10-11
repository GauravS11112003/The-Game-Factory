/**
 * Small Studio widgets (no framework): popovers and menus, segmented controls, switches, slider + number fields,
 * collapsible sections, comboboxes. Everything is built with dom.ts `h()` and styled by studio.css (st-*).
 */
import { h, type Child } from '../../app/dom.ts';
import { t } from '../../app/messages.ts';
import { sicon } from './icons.ts';

// ---- popovers --------------------------------------------------------------------------------------------------

let open: { el: HTMLElement; close: () => void } | null = null;

export interface PopoverOpts { align?: 'start' | 'end' | 'center'; side?: 'below' | 'above' | 'right' | 'left'; cls?: string; onClose?: () => void; width?: number }

/** A floating panel anchored to an element; closes on outside click, Esc, resize. One at a time. */
export function popover(anchor: Element, content: Child, o: PopoverOpts = {}): { el: HTMLElement; close: () => void; place: () => void } {
  open?.close();
  const el = h('div', { class: `st-pop${o.cls ? ` ${o.cls}` : ''}`, role: 'dialog' }, content);
  if (o.width) el.style.width = `${o.width}px`;
  document.body.append(el);
  const place = (): void => {
    const r = anchor.getBoundingClientRect();
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x: number;
    let y: number;
    const side = o.side ?? 'below';
    if (side === 'right' || side === 'left') {
      x = side === 'right' ? r.right + 8 : r.left - pw - 8;
      if (x + pw > vw - 8) x = r.left - pw - 8;
      if (x < 8) x = Math.min(vw - pw - 8, r.right + 8);
      y = r.top;
    } else {
      x = o.align === 'end' ? r.right - pw : o.align === 'center' ? r.left + r.width / 2 - pw / 2 : r.left;
      y = side === 'above' ? r.top - ph - 6 : r.bottom + 6;
      if (y + ph > vh - 8 && r.top - ph - 6 > 8) y = r.top - ph - 6;
      if (y < 8) y = Math.min(vh - ph - 8, r.bottom + 6);
    }
    el.style.left = `${Math.max(8, Math.min(vw - pw - 8, x))}px`;
    el.style.top = `${Math.max(8, Math.min(vh - ph - 8, y))}px`;
  };
  const onDown = (e: PointerEvent): void => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 120);
    if (open?.el === el) open = null;
    o.onClose?.();
  }
  requestAnimationFrame(place);
  place();
  window.setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
  }, 0);
  open = { el, close };
  return { el, close, place };
}

export function closePopover(): void {
  open?.close();
}

export interface MenuItem { label: string; sub?: string; icon?: string; group?: string; on?: boolean; danger?: boolean; swatch?: string; onPick: () => void }

/** A list menu in a popover (with a filter box when long). */
export function menu(anchor: Element, items: MenuItem[], o: PopoverOpts & { search?: boolean; title?: string } = {}): void {
  const list = h('div', { class: 'st-menu-list', role: 'menu' });
  let pop: { close: () => void } | null = null;
  const render = (q: string): void => {
    const ql = q.trim().toLowerCase();
    const shown = items.filter((i) => !ql || i.label.toLowerCase().includes(ql) || (i.sub ?? '').toLowerCase().includes(ql));
    const kids: HTMLElement[] = [];
    let group: string | undefined;
    for (const it of shown) {
      if (it.group && it.group !== group) {
        group = it.group;
        kids.push(h('div', { class: 'st-menu-group' }, it.group));
      }
      kids.push(h('button', {
        type: 'button', role: 'menuitem', class: `st-menu-item${it.on ? ' on' : ''}${it.danger ? ' danger' : ''}`,
        onclick: () => { pop?.close(); it.onPick(); },
      },
      it.swatch ? h('span', { class: 'st-swatch-dot', style: `background:${it.swatch}` }) : it.icon ? sicon(it.icon) : null,
      h('span', { class: 'st-menu-text' }, h('span', { class: 'st-menu-label' }, it.label), it.sub ? h('span', { class: 'st-menu-sub' }, it.sub) : null),
      it.on ? sicon('check', 'ico st-menu-check') : null));
    }
    if (!kids.length) kids.push(h('div', { class: 'st-menu-empty' }, t('studio.ui.nothing_found')));
    list.replaceChildren(...kids);
  };
  const search = o.search ?? items.length > 9;
  const q = h('input', { type: 'search', class: 'st-menu-search', placeholder: t('studio.ui.search'), 'aria-label': t('studio.ui.search') });
  q.oninput = () => render(q.value);
  q.onkeydown = (e) => {
    if (e.key === 'Enter') (list.querySelector('.st-menu-item') as HTMLButtonElement | null)?.click();
  };
  render('');
  pop = popover(anchor, h('div', { class: 'st-menu' }, o.title ? h('div', { class: 'st-menu-title' }, o.title) : null, search ? q : null, list), { cls: 'st-pop-menu', ...o });
  if (search) window.setTimeout(() => q.focus(), 10);
}

// ---- controls ---------------------------------------------------------------------------------------------------

export interface SegOption<T> { value: T; label: string; icon?: string; title?: string }

export function segmented<T>(opts: SegOption<T>[], value: T, onChange: (v: T) => void, o: { cls?: string; label?: string } = {}): HTMLElement {
  const el = h('div', { class: `st-seg${o.cls ? ` ${o.cls}` : ''}`, role: 'radiogroup', 'aria-label': o.label });
  for (const op of opts) {
    const on = op.value === value;
    el.append(h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(on), class: on ? 'on' : '', title: op.title ?? op.label,
      onclick: () => { if (!on) onChange(op.value); },
    }, op.icon ? sicon(op.icon) : null, h('span', null, op.label)));
  }
  return el;
}

export function toggle(checked: boolean, onChange: (v: boolean) => void, label?: string): HTMLElement {
  const b = h('button', { type: 'button', role: 'switch', class: `st-switch${checked ? ' on' : ''}`, 'aria-checked': String(checked), 'aria-label': label ?? '' },
    h('span', { class: 'st-switch-knob' }));
  b.onclick = (e) => { e.stopPropagation(); onChange(!checked); };
  return b;
}

/** A row: label (+ help) on the left, control on the right. */
export function row(label: Child, control: Child, o: { help?: string; stack?: boolean; cls?: string } = {}): HTMLElement {
  return h('div', { class: `st-row${o.stack ? ' stack' : ''}${o.cls ? ` ${o.cls}` : ''}` },
    h('div', { class: 'st-row-label' }, label, o.help ? h('span', { class: 'st-help', title: o.help, tabindex: '0', 'aria-label': o.help }, '?') : null),
    h('div', { class: 'st-row-ctl' }, control));
}

const roundTo = (v: number, step: number): number => Math.round(v / step) * step;

function niceStep(min: number, max: number, int: boolean): number {
  if (int) return 1;
  const span = max - min;
  if (span <= 2) return 0.01;
  if (span <= 20) return 0.1;
  if (span <= 200) return 1;
  return 5;
}

/**
 * Slider + number field. `onInput(v, done)` fires while scrubbing (done = false) and once on release / commit
 * (done = true), so callers can coalesce a scrub into one undo step.
 */
export function numberControl(o: { value: number; min?: number; max?: number; step?: number; int?: boolean; unit?: string; slider?: boolean; onInput: (v: number, done: boolean) => void }): HTMLElement {
  const hasRange = o.min !== undefined && o.max !== undefined && o.slider !== false && o.max - o.min <= 100000;
  const step = o.step ?? (hasRange ? niceStep(o.min!, o.max!, !!o.int) : o.int ? 1 : 0.1);
  const clampV = (v: number): number => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, o.int ? Math.round(v) : v));
  const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);
  const num = h('input', { type: 'number', class: 'st-num', value: fmt(o.value), step: String(step), 'aria-label': t('studio.ui.value') });
  if (o.min !== undefined) num.min = String(o.min);
  if (o.max !== undefined) num.max = String(o.max);
  const kids: HTMLElement[] = [];
  let range: HTMLInputElement | null = null;
  let paint = (): void => undefined;
  if (hasRange) {
    range = h('input', { type: 'range', class: 'st-range', min: String(o.min), max: String(o.max), step: String(step), value: String(o.value), 'aria-label': t('studio.ui.value') });
    paint = (): void => {
      const p = ((Number(range!.value) - o.min!) / (o.max! - o.min! || 1)) * 100;
      range!.style.setProperty('--p', `${p}%`);
    };
    paint();
    range.oninput = () => {
      const v = clampV(roundTo(Number(range!.value), step));
      num.value = fmt(v);
      paint();
      o.onInput(v, false);
    };
    range.onchange = () => o.onInput(clampV(Number(range!.value)), true);
    kids.push(range);
  }
  const commitNum = (done: boolean): void => {
    if (num.value.trim() === '' || !Number.isFinite(Number(num.value))) return;
    const v = clampV(Number(num.value));
    if (range) { range.value = String(v); paint(); }
    o.onInput(v, done);
  };
  num.oninput = () => commitNum(false);
  num.onchange = () => { commitNum(true); num.value = fmt(clampV(Number(num.value) || 0)); };
  num.onkeydown = (e) => { if (e.key === 'Enter') num.blur(); };
  kids.push(num);
  if (o.unit) kids.push(h('span', { class: 'st-unit' }, o.unit));
  return h('div', { class: `st-numctl${hasRange ? '' : ' plain'}` }, ...kids);
}

/** Text input that reports while typing (done = false) and on blur / Enter (done = true). */
export function textInput(o: { value: string; placeholder?: string; max?: number; list?: string[]; cls?: string; onInput: (v: string, done: boolean) => void; label?: string }): HTMLElement {
  const id = o.list ? `st-dl-${Math.random().toString(36).slice(2, 8)}` : undefined;
  const inp = h('input', { type: 'text', class: `st-text${o.cls ? ` ${o.cls}` : ''}`, value: o.value, placeholder: o.placeholder ?? '', maxLength: o.max ?? 200, 'aria-label': o.label ?? o.placeholder ?? '' });
  if (id) inp.setAttribute('list', id);
  inp.oninput = () => o.onInput(inp.value, false);
  inp.onchange = () => o.onInput(inp.value, true);
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') inp.blur();
  };
  if (!id) return inp;
  return h('span', { class: 'st-combo' }, inp, h('datalist', { id }, ...o.list!.map((v) => h('option', { value: v }))));
}

export function select<T extends string>(opts: { value: T; label: string }[], value: T, onChange: (v: T) => void, label?: string): HTMLSelectElement {
  const s = h('select', { class: 'st-select', 'aria-label': label ?? '' }, ...opts.map((op) => h('option', { value: op.value, selected: op.value === value }, op.label)));
  s.onchange = () => onChange(s.value as T);
  return s;
}

const openSections = new Map<string, boolean>();

/** A collapsible inspector section; its open state is remembered per key for this session. */
export function section(key: string, title: string, ico: string, content: Child, o: { open?: boolean; count?: number | string; action?: HTMLElement; hint?: string } = {}): HTMLElement {
  const isOpen = openSections.get(key) ?? o.open ?? true;
  const body = h('div', { class: 'st-sec-body' }, content);
  const head = h('button', { type: 'button', class: 'st-sec-head', 'aria-expanded': String(isOpen) },
    sicon('chevron', 'ico st-sec-chev'), sicon(ico, 'ico st-sec-ico'), h('span', { class: 'st-sec-title' }, title),
    o.count !== undefined && o.count !== 0 && o.count !== '' ? h('span', { class: 'st-sec-count' }, String(o.count)) : null);
  const el = h('section', { class: `st-sec${isOpen ? ' open' : ''}`, data: { key } }, h('div', { class: 'st-sec-bar' }, head, o.action ?? null), o.hint ? h('p', { class: 'st-sec-hint' }, o.hint) : null, body);
  head.onclick = () => {
    const now = !el.classList.contains('open');
    el.classList.toggle('open', now);
    head.setAttribute('aria-expanded', String(now));
    openSections.set(key, now);
  };
  return el;
}

export function iconButton(ico: string, title: string, onclick: (e: MouseEvent) => void, o: { cls?: string; disabled?: boolean; pressed?: boolean } = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', class: `st-ibtn${o.cls ? ` ${o.cls}` : ''}`, title, 'aria-label': title, onclick, disabled: o.disabled }, sicon(ico));
  if (o.pressed !== undefined) b.setAttribute('aria-pressed', String(o.pressed));
  return b;
}

export function btn(label: Child, onclick: (e: MouseEvent) => void, o: { cls?: string; icon?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: `st-btn${o.cls ? ` ${o.cls}` : ''}`, onclick, title: o.title, disabled: o.disabled }, o.icon ? sicon(o.icon) : null, label);
}

/** Is the keyboard focus in a text field (so shortcuts should stay out of the way)? */
export function typingIn(e: Event): boolean {
  const el = (e.target as HTMLElement | null) ?? document.activeElement;
  if (!el || !(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type));
}
