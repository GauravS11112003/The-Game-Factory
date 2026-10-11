/**
 * The runtime's DOM overlay (docs/v6/CONTRACTS_V6.md §4.1): HUD items (number, bar, hearts, icons from the item's
 * pickup drawing), timer, title, 2-player health bars in the top corners, speech toasts, win / lose / pause cards and
 * on-screen touch buttons. Styled by runtime.css with the theme's palette and font as CSS variables.
 */
import { t } from '../../app/messages.ts';
import { renderDrawing } from '../theme/render.ts';
import { objectBitmap } from '../theme/art.ts';
import { fontStack, isDark, mix, type FullTheme } from '../theme/color.ts';
import type { NDoc, NHudItem } from './normalize.ts';
import type { Ent, World } from './world.ts';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 5.3 3.1 1.7-1.9 3.2-3.1 5.3-3.1 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>';

export interface CardAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export class Hud {
  root: HTMLDivElement;
  private items: HTMLDivElement;
  private center: HTMLDivElement;
  private timer: HTMLDivElement;
  private duel: HTMLDivElement;
  private toastBox: HTMLDivElement;
  private card: HTMLDivElement | null = null;
  private touch: HTMLDivElement | null = null;
  private rows: { item: NHudItem; node: HTMLElement; last: string }[] = [];
  private duelBars: { fill: HTMLElement; ghost: HTMLElement; p: 1 | 2; last: number }[] = [];
  private icons = new Map<string, string | null>();
  private doc: NDoc;
  muteBtn: HTMLButtonElement;
  pauseBtn: HTMLButtonElement;

  constructor(parent: HTMLElement, doc: NDoc, theme: FullTheme, o: { onMute: () => void; onPause: () => void }) {
    this.doc = doc;
    this.root = el('div', 'rt-hud');
    const P = theme.palette;
    const dark = isDark(P.bg);
    const s = this.root.style;
    s.setProperty('--rt-font', fontStack(theme.font));
    s.setProperty('--rt-ink', P.text);
    s.setProperty('--rt-bg', P.bg);
    s.setProperty('--rt-accent', P.accent);
    s.setProperty('--rt-accent2', P.accent2);
    s.setProperty('--rt-good', P.good);
    s.setProperty('--rt-danger', P.danger);
    s.setProperty('--rt-chip', dark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.78)');
    s.setProperty('--rt-chip-ink', dark ? '#ffffff' : P.text);
    s.setProperty('--rt-card', dark ? mix(P.bg, '#ffffff', 0.08) : '#fffdf8');
    if (theme.font === 'pixel') this.root.classList.add('rt-pixel');
    this.items = el('div', 'rt-items');
    this.center = el('div', 'rt-center');
    this.timer = el('div', 'rt-chip rt-timer');
    this.timer.hidden = true;
    this.duel = el('div', 'rt-duel');
    this.toastBox = el('div', 'rt-toasts');
    const btns = el('div', 'rt-btns');
    this.muteBtn = el('button', 'rt-btn');
    this.muteBtn.type = 'button';
    this.muteBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      o.onMute();
    });
    this.pauseBtn = el('button', 'rt-btn');
    this.pauseBtn.type = 'button';
    this.pauseBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>';
    this.pauseBtn.title = t('rt.pause');
    this.pauseBtn.setAttribute('aria-label', t('rt.pause'));
    this.pauseBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      o.onPause();
    });
    btns.append(this.muteBtn, this.pauseBtn);
    this.center.append(this.timer);
    this.root.append(this.items, this.center, btns, this.duel, this.toastBox);
    parent.append(this.root);
    this.setMuted(false);
  }

  setMuted(m: boolean): void {
    this.muteBtn.innerHTML = m
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
    this.muteBtn.title = t(m ? 'rt.unmute' : 'rt.mute');
    this.muteBtn.setAttribute('aria-label', this.muteBtn.title);
  }

  /** Build the rows for a scene (2P bars when both players exist). */
  setup(world: World): void {
    this.items.textContent = '';
    this.rows = [];
    if (this.doc.hud.title) this.items.append(el('div', 'rt-chip rt-title', this.doc.hud.title));
    for (const item of this.doc.hud.items) {
      const node = el('div', `rt-chip rt-item rt-${item.style}`);
      this.items.append(node);
      this.rows.push({ item, node, last: '' });
    }
    this.timer.hidden = !this.doc.hud.timer;
    this.duel.textContent = '';
    this.duelBars = [];
    const p1 = world.playerEnt(1);
    const p2 = world.playerEnt(2);
    if (p1 && p2 && (p1.player === 1) && ('health' in p1.counters || 'health' in p2.counters)) {
      for (const p of [1, 2] as const) {
        const box = el('div', `rt-duelbar rt-p${p}`);
        const name = el('div', 'rt-duelname', (p === 1 ? p1 : p2).def.name || t(p === 1 ? 'rt.player1' : 'rt.player2'));
        const track = el('div', 'rt-track');
        const ghost = el('div', 'rt-ghost');
        const fill = el('div', 'rt-fill');
        track.append(ghost, fill);
        box.append(name, track);
        this.duel.append(box);
        this.duelBars.push({ fill, ghost, p, last: -1 });
      }
    }
  }

  private subjectEnt(world: World, subject: string): Ent | null {
    if (subject === 'player1' || subject === 'player') return world.playerEnt(1);
    if (subject === 'player2') return world.playerEnt(2);
    const e = world.byId.get(subject);
    return e && e.alive ? e : null;
  }

  private iconFor(counter: string): string | null {
    if (this.icons.has(counter)) return this.icons.get(counter)!;
    let url: string | null = null;
    for (const sc of this.doc.scenes) {
      const o = sc.objects.find((x) => x.behaviors.some((b) => b.type === 'pickup' && b.params.item === counter) && x.drawing?.strokes?.length);
      if (o) {
        try {
          const big = Math.max(o.w, o.h, 1);
          const scale = Math.min(2, 48 / big);
          // the icon shows the same look as the game (AI art or the cleaned-up sketch)
          const bmp = this.doc.look === 'game' ? objectBitmap(o, this.doc, this.doc.theme, { scale, pad: 2 }) : null;
          url = (bmp ? bmp.canvas : renderDrawing(o.drawing, this.doc.theme, { scale, pad: 2 })).toDataURL();
        } catch {
          url = null;
        }
        break;
      }
    }
    this.icons.set(counter, url);
    return url;
  }

  /** Refresh from the world (cheap: DOM is touched only when a value changes). */
  update(world: World, time: number): void {
    for (const r of this.rows) {
      const { item } = r;
      const ent = item.subject === 'game' ? null : this.subjectEnt(world, item.subject);
      const v = item.subject === 'game' ? world.game[item.counter] ?? 0 : ent?.counters[item.counter] ?? 0;
      let max = item.max ?? 0;
      if (!max && item.counter === 'health' && ent) max = world.healthMax(ent);
      if (!max) max = Math.max(1, item.subject === 'game' ? world.doc.counters[item.counter] ?? v : ent?.def.counters[item.counter] ?? v);
      const label = item.label ?? (item.counter.charAt(0).toUpperCase() + item.counter.slice(1));
      const key = `${Math.round(v * 10)}|${max}|${label}`;
      if (key === r.last) continue;
      const grew = r.last && Number(r.last.split('|')[0]) < Math.round(v * 10);
      r.last = key;
      const n = r.node;
      n.textContent = '';
      const lab = el('span', 'rt-label', label);
      if (item.style === 'number') {
        n.append(lab, el('b', 'rt-num', fmt(v)));
      } else if (item.style === 'bar') {
        const track = el('span', 'rt-track');
        const fill = el('span', 'rt-fill');
        fill.style.width = `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
        if (v / max < 0.3) fill.classList.add('rt-low');
        track.append(fill);
        n.append(lab, track);
      } else if (item.style === 'hearts') {
        const total = Math.min(12, Math.max(Math.ceil(max), Math.ceil(v)));
        n.append(lab);
        for (let i = 0; i < total; i++) {
          const h = el('i', i < Math.round(v) ? 'rt-heart' : 'rt-heart rt-empty');
          h.innerHTML = HEART;
          n.append(h);
        }
      } else {
        const url = this.iconFor(item.counter);
        n.append(lab);
        const count = Math.max(0, Math.round(v));
        if (count > 8 || !url || count === 0) {
          if (url) n.append(Object.assign(el('img', 'rt-icon'), { src: url, alt: '' }));
          n.append(el('b', 'rt-num', `×${count}`));
        } else for (let i = 0; i < count; i++) n.append(Object.assign(el('img', 'rt-icon'), { src: url, alt: '' }));
      }
      if (grew) {
        n.classList.remove('rt-pop');
        void n.offsetWidth;
        n.classList.add('rt-pop');
      }
    }
    if (this.doc.hud.timer) {
      const s = Math.floor(time);
      const txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (this.timer.textContent !== txt) this.timer.textContent = txt;
    }
    for (const b of this.duelBars) {
      const e = world.playerEnt(b.p);
      const max = e ? world.healthMax(e) : 1;
      const v = e ? Math.max(0, e.counters.health ?? 0) : 0;
      const pct = Math.max(0, Math.min(100, (v / max) * 100));
      if (pct !== b.last) {
        b.last = pct;
        b.fill.style.width = `${pct}%`;
        b.ghost.style.width = `${pct}%`;
        b.fill.classList.toggle('rt-low', pct < 30);
      }
    }
  }

  toast(text: string, ms = 2500): void {
    const n = el('div', 'rt-toast', text);
    this.toastBox.append(n);
    setTimeout(() => {
      n.classList.add('rt-out');
      setTimeout(() => n.remove(), 400);
    }, ms);
  }

  banner(text: string): void {
    const n = el('div', 'rt-banner', text);
    this.root.append(n);
    setTimeout(() => n.remove(), 2200);
  }

  showCard(kind: 'win' | 'lose' | 'pause' | 'level', title: string, sub: string, actions: CardAction[]): void {
    this.hideCard();
    const wrap = el('div', `rt-cardwrap rt-${kind}`);
    const c = el('div', 'rt-card');
    c.append(el('h2', 'rt-cardtitle', title));
    if (sub) c.append(el('p', 'rt-cardsub', sub));
    const row = el('div', 'rt-cardbtns');
    for (const a of actions) {
      const b = el('button', a.primary ? 'rt-cbtn rt-primary' : 'rt-cbtn', a.label);
      b.type = 'button';
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        a.run();
      });
      row.append(b);
    }
    if (actions.length) c.append(row);
    wrap.append(c);
    this.root.append(wrap);
    this.card = wrap;
    const first = row.querySelector('button');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 50);
  }

  hideCard(): void {
    this.card?.remove();
    this.card = null;
  }

  get cardShown(): boolean {
    return !!this.card;
  }

  /** On-screen buttons for the keys the game uses (touch devices). */
  setTouch(keys: { left: boolean; right: boolean; up: boolean; down: boolean; jump: boolean; action: boolean; action2: boolean },
    press: (codes: string[], down: boolean) => void): void {
    this.touch?.remove();
    this.touch = null;
    const coarse = typeof window !== 'undefined' && ('ontouchstart' in window || (window.matchMedia?.('(pointer: coarse)').matches ?? false));
    if (!coarse) return;
    const box = el('div', 'rt-touch');
    const left = el('div', 'rt-tleft');
    const right = el('div', 'rt-tright');
    const mk = (label: string, codes: string[], into: HTMLElement): void => {
      const b = el('button', 'rt-tbtn', label);
      b.type = 'button';
      const on = (ev: Event): void => {
        ev.preventDefault();
        ev.stopPropagation();
        b.classList.add('rt-on');
        press(codes, true);
      };
      const off = (ev: Event): void => {
        ev.preventDefault();
        b.classList.remove('rt-on');
        press(codes, false);
      };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      b.addEventListener('pointerleave', off);
      into.append(b);
    };
    if (keys.left) mk('◀', ['ArrowLeft'], left);
    if (keys.right) mk('▶', ['ArrowRight'], left);
    if (keys.down) mk('▼', ['ArrowDown'], left);
    if (keys.up || keys.jump) mk('▲', ['ArrowUp', 'Space'], right);
    if (keys.action) mk('●', ['KeyE'], right);
    if (keys.action2) mk('✦', ['KeyQ'], right);
    if (!left.childElementCount && !right.childElementCount) return;
    box.append(left, right);
    this.root.append(box);
    this.touch = box;
  }

  destroy(): void {
    this.root.remove();
  }
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}
