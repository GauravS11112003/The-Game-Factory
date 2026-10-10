/**
 * Tiny DOM helpers so the screens stay framework-free (PLAN.md section 10). Owned by lane D.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

type Attrs = Record<string, unknown> | null | undefined;

function appendChild(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
    return;
  }
  parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
}

/** el('button', { className: 'primary', onclick: fn }, 'Play') */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'className') node.className = String(value);
      else if (key === 'style' && typeof value === 'string') node.setAttribute('style', value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'dataset' && typeof value === 'object') {
        Object.assign(node.dataset, value as Record<string, string>);
      } else if (key in node && typeof value !== 'object' && !key.startsWith('aria')) {
        (node as unknown as Record<string, unknown>)[key] = value;
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  for (const child of children) appendChild(node, child);
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function button(label: Child, onClick: (ev: MouseEvent) => void, className = ''): HTMLButtonElement {
  return el('button', { type: 'button', className, onclick: onClick }, label);
}

export function link(href: string, label: Child, className = ''): HTMLAnchorElement {
  return el('a', { href, className }, label);
}

export function externalLink(href: string, label: Child, className = ''): HTMLAnchorElement {
  return el('a', { href, className, target: '_blank', rel: 'noopener' }, label);
}

export function navigate(hash: string): void {
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}

export function setTitle(title?: string): void {
  document.title = title ? `${title} · Draw a Level` : 'Draw a Level';
}

export function spinner(message: string): HTMLElement {
  return el('div', { className: 'progress', role: 'status' }, el('span', { className: 'spinner' }), el('span', { className: 'progress-text' }, message));
}

export function errorBox(message: string, ...actions: Child[]): HTMLElement {
  return el('div', { className: 'card error' }, el('p', null, message), actions.length ? el('div', { className: 'row' }, ...actions) : null);
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const AUTHOR_KEY = 'dal.author';

export function rememberedAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberAuthor(name: string): void {
  try {
    localStorage.setItem(AUTHOR_KEY, name);
  } catch {
    /* private mode: nothing to remember */
  }
}

/** Query string for #/scan and #/draw links: only the params that are set. */
export function qs(params: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
}
