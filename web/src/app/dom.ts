/** Tiny DOM helpers for the v2 app: `h()` element builder, doodle icons, toasts. */

export type Child = Node | string | number | null | undefined | false | Child[];

type Handler<E extends Event = Event> = (e: E) => void;

export interface Props {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  data?: Record<string, string>;
  title?: string;
  [k: string]: unknown;
}

function append(el: Element, kids: Child[]): void {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k === 'data') for (const [dk, dv] of Object.entries(v as Record<string, string>)) el.dataset[dk] = dv;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as Handler);
      else if (k in el && k !== 'list' && k !== 'form') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

const SVGNS = 'http://www.w3.org/2000/svg';

/** Hand-drawn style icons (24 × 24 viewBox, round marker strokes). */
const ICONS: Record<string, string> = {
  marker: 'M4 20l3-1 11-11-2-2L5 17l-1 3zM14 6l2-2 4 4-2 2',
  eraser: 'M4 16l8-8 6 6-6 6H8l-4-4zM10 20h10',
  select: 'M5 4c5-2 13 0 14 5s-6 9-11 8M8 17l-2 4M4 4l1 7',
  stamp: 'M9 4h6v5l3 3v3H6v-3l3-3V4zM5 19h14',
  pan: 'M8 13V6a1.5 1.5 0 013 0v5V4a1.5 1.5 0 013 0v7V6a1.5 1.5 0 013 0v8c0 4-2 7-6 7s-6-2-8-6l-1-3a1.5 1.5 0 012.5-1.5L8 13',
  undo: 'M9 7L4 12l5 5M4 12h10a6 6 0 010 12',
  redo: 'M15 7l5 5-5 5M20 12H10a6 6 0 000 12',
  play: 'M7 4l13 8-13 8V4z',
  pencil: 'M4 20l2-6L16 4l4 4-10 10-6 2zM14 6l4 4',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  eye: 'M2 12c3-5 7-7 10-7s7 2 10 7c-3 5-7 7-10 7S5 17 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeoff: 'M3 3l18 18M10 6c1-.5 1.5-.5 2-.5 3 0 7 2 10 6.5-1 1.5-2 3-3.5 4M6.5 7C4.5 8.5 3 10 2 12c3 5 7 7 10 7 1.5 0 3-.5 4.5-1.2',
  person: 'M12 4a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM12 9v7M8 21l4-5 4 5M7 12h10',
  rules: 'M6 4h12v16H6zM9 8h6M9 12h6M9 16h4',
  trash: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13',
  check: 'M4 13l5 5L20 6',
  close: 'M6 6l12 12M18 6L6 18',
  flag: 'M6 21V4M6 4c4-2 7 2 12 0v8c-5 2-8-2-12 0',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 10a4 4 0 100 8 4 4 0 000-8z',
  home: 'M3 12l9-8 9 8M6 10v10h12V10',
  tree: 'M12 3v18M12 8l-6 4M12 12l6 4M6 12v3M18 16v3',
  share: 'M16 6l-8 5 8 5M18 4a2 2 0 110 4 2 2 0 010-4zM6 9.5a2 2 0 110 4 2 2 0 010-4zM18 16a2 2 0 110 4 2 2 0 010-4z',
  retry: 'M4 12a8 8 0 108-8H8M8 4l-3 3 3 3',
  ghost: 'M6 20V10a6 6 0 0112 0v10l-2-2-2 2-2-2-2 2-2-2-2 2zM10 10h.01M14 10h.01',
  bot: 'M7 8h10v10H7zM12 4v4M9.5 12h.01M14.5 12h.01M10 15h4M4 12h3M17 12h3',
  lock: 'M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z',
  unlock: 'M7 11V8a5 5 0 019.5-2M5 11h14v10H5z',
  snap: 'M4 18h16M8 18V8M16 18v-6M4 6h16',
  question: 'M9 9a3 3 0 116 0c0 2-3 2.5-3 5M12 18h.01',
  star: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z',
  drop: 'M12 3c3 5 6 8 6 11a6 6 0 01-12 0c0-3 3-6 6-11z',
  skull: 'M5 11a7 7 0 0114 0v4h-2v4H7v-4H5zM9 12h.01M15 12h.01M11 16h2',
  clock: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4l3 2',
  coin: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v8',
  next: 'M5 5l8 7-8 7M14 5v14',
  remix: 'M4 7h11l-3-3M20 17H9l3 3M15 7a5 5 0 015 5M9 17a5 5 0 01-5-5',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4', // v4 workspace (lane D)
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
};

export function icon(name: keyof typeof ICONS | string, cls = 'ico'): SVGSVGElement {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.question);
  svg.append(path);
  return svg;
}

let toastHost: HTMLElement | null = null;

export function toast(text: string, o: { action?: { label: string; run: () => void }; ms?: number } = {}): () => void {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: 'toast' }, h('span', null, text));
  if (o.action) {
    const a = o.action;
    t.append(h('button', { type: 'button', class: 'pill small', onclick: () => { a.run(); close(); } }, a.label));
  }
  toastHost.append(t);
  const timer = window.setTimeout(close, o.ms ?? 4000);
  function close(): void {
    window.clearTimeout(timer);
    t.classList.add('out');
    window.setTimeout(() => t.remove(), 250);
  }
  return close;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function isPhone(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px), (max-height: 500px)').matches;
}

/** A paper card with tape corners. */
export function card(cls: string | null, ...kids: Child[]): HTMLDivElement {
  return h('div', { class: `card paper${cls ? ` ${cls}` : ''}` }, ...kids);
}

export function pill(label: Child, onclick: (e: MouseEvent) => void, o: { cls?: string; icon?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: `pill${o.cls ? ` ${o.cls}` : ''}`, onclick, title: o.title, disabled: o.disabled },
    o.icon ? icon(o.icon) : null, label);
}

/** Save a blob as a file (export zips, share cards). */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = h('a', { href, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
