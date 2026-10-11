/**
 * The compare card (docs/v7/CONTRACTS_V7.md §2.2, §5): next to the object (a sheet on phones), the maker's drawing,
 * cleaned up, and Claude's versions, large enough to judge. A hero preview crossfades between them; hovering a tile
 * also previews it on the canvas in place. "Use this" / "Keep mine" / "Try again"; choosing is one `set_art` step and
 * marks the variants as asked. Several objects waiting queue up ("1 of 3").
 */
import type { ArtVariant } from '../../core/types.gen.ts';
import { h } from '../../app/dom.ts';
import { kidText, t } from '../../app/messages.ts';
import { chooseEdit } from '../model/art_plan.ts';
import { displayName } from '../model/doc.ts';
import type { SObj } from '../model/types.ts';
import type { ArtDirector } from './art_director.ts';
import type { StudioCanvas } from './canvas.ts';
import { sicon } from './icons.ts';
import { docLook, sketchTile, svgUrl } from './look.ts';
import type { Studio } from './studio.ts';

interface Choice { id: string | null; label: string; note: string; tile: () => HTMLElement }

export class CompareCard {
  private el: HTMLElement | null = null;
  private objId: string | null = null;
  private queue: string[] = [];
  private fresh = new Map<string, string[]>();
  private picked: string | null = null;
  private offs: (() => void)[] = [];
  private onKey = (e: KeyboardEvent): void => this.key(e);

  constructor(private readonly studio: Studio, private readonly canvas: StudioCanvas, private readonly host: HTMLElement, private readonly director: ArtDirector) {
    this.offs.push(studio.on((c) => {
      if (c.kind === 'scene') this.close(false);
      if (c.kind === 'doc' && this.objId && !studio.object(this.objId)) this.close(false);
      if (c.kind === 'art' && this.objId) this.refreshBusy();
    }));
    const prev = canvas.onView;
    canvas.onView = () => { prev?.(); this.place(); };
  }

  /** Is the card showing (for this object)? */
  isOpen(id?: string): boolean {
    return !!this.el && (!id || this.objId === id);
  }

  /** Show the card for an object (queued behind the one showing). `fresh` = the newest variant ids. */
  open(id: string, fresh?: string[]): void {
    if (fresh?.length) this.fresh.set(id, fresh);
    if (this.objId && this.objId !== id) {
      if (!this.queue.includes(id)) this.queue.push(id);
      this.renderCount();
      return;
    }
    const o = this.studio.object(id);
    if (!o?.art?.variants.length) return;
    this.objId = id;
    this.render(o, true);
  }

  /** Review several objects one after another (the restyle card's "Review one by one"). */
  review(ids: string[], fresh?: Map<string, string[]>): void {
    if (fresh) for (const [k, v] of fresh) this.fresh.set(k, v);
    const list = ids.filter((id) => this.studio.object(id)?.art?.variants.length);
    if (!list.length) return;
    if (this.objId) { for (const id of list) if (id !== this.objId && !this.queue.includes(id)) this.queue.push(id); this.renderCount(); return; }
    const [first, ...rest] = list;
    this.queue = rest;
    this.open(first);
  }

  private choices(o: SObj): Choice[] {
    const theme = this.studio.doc.theme;
    const all = o.art?.variants ?? [];
    const newest = (this.fresh.get(o.id) ?? []).map((id) => all.find((v) => v.id === id)).filter((v): v is ArtVariant => !!v);
    const shown = (newest.length ? newest : all).slice(0, 4);
    if (o.art?.use === 'ai' && o.art.chosen && !shown.some((v) => v.id === o.art!.chosen)) {
      const cur = all.find((v) => v.id === o.art!.chosen);
      if (cur) shown.push(cur);
    }
    const mine: Choice = {
      id: null, label: t('studio.cmp.yours'), note: t('studio.cmp.yours_note'),
      tile: () => { const c = sketchTile(o, theme, 360); c.className = 'st-cmp-img'; return c; },
    };
    return [mine, ...shown.map((v, i): Choice => ({
      id: v.id, label: t('studio.cmp.take', { n: i + 1 }), note: v.note ?? '',
      tile: () => h('img', { class: 'st-cmp-img', src: svgUrl(v.svg), alt: v.note ?? t('studio.cmp.take', { n: i + 1 }), draggable: false }),
    }))];
  }

  private stageBg(): string {
    const d = this.studio.doc;
    const sky = docLook(d) === 'game' ? ((d.backdrop?.sky ?? []) as string[]) : [];
    const bg = d.theme.palette?.bg ?? '#f6f1e7';
    if (sky.length > 1) return `linear-gradient(180deg, ${sky.join(', ')})`;
    return sky[0] ?? bg;
  }

  private render(o: SObj, fresh: boolean): void {
    const s = this.studio;
    const choices = this.choices(o);
    const playing = o.art?.use === 'ai' ? o.art.chosen : null;
    if (fresh || !choices.some((c) => c.id === this.picked)) this.picked = choices.find((c) => c.id && c.id === playing)?.id ?? choices[1]?.id ?? null;
    const bg = this.stageBg();

    const heroA = h('div', { class: 'st-cmp-hero-layer on' });
    const heroB = h('div', { class: 'st-cmp-hero-layer' });
    const caption = h('div', { class: 'st-cmp-caption' });
    const hero = h('div', { class: 'st-cmp-hero', style: `background:${bg}` }, heroA, heroB, caption);
    let front = heroA;
    const showHero = (c: Choice, instant = false): void => {
      const back = front === heroA ? heroB : heroA;
      back.replaceChildren(c.tile());
      if (instant) { front.classList.remove('on'); back.classList.add('on'); }
      else requestAnimationFrame(() => { front.classList.remove('on'); back.classList.add('on'); });
      front = back;
      caption.replaceChildren(h('span', { class: 'st-cmp-cap-label' }, c.label), ...(c.note ? [h('span', { class: 'st-cmp-cap-note' }, kidText(c.note))] : []));
    };

    const strip = h('div', { class: 'st-cmp-strip', role: 'radiogroup', 'aria-label': t('studio.cmp.pick') });
    const tiles = choices.map((c) => {
      const b = h('button', { type: 'button', role: 'radio', class: 'st-cmp-tile', 'aria-checked': String(c.id === this.picked), title: c.note || c.label, style: `background:${bg}` },
        c.tile(), h('span', { class: 'st-cmp-tile-label' }, c.id ? String(choices.indexOf(c)) : t('studio.cmp.yours_short')),
        c.id && c.id === playing ? h('span', { class: 'st-cmp-badge' }, t('studio.cmp.playing')) : null,
        h('span', { class: 'st-cmp-check', 'aria-hidden': 'true' }, sicon('check')));
      b.onclick = () => select(c);
      b.onmouseenter = () => s.setPreview({ id: o.id, variant: c.id });
      b.onfocus = () => s.setPreview({ id: o.id, variant: c.id });
      return b;
    });
    strip.onmouseleave = () => s.setPreview(this.picked === playing ? null : { id: o.id, variant: this.picked });
    strip.append(...tiles);
    const select = (c: Choice): void => {
      if (c.id === this.picked) return;
      this.picked = c.id;
      tiles.forEach((tl, i) => tl.setAttribute('aria-checked', String(choices[i].id === c.id)));
      showHero(c);
      useBtn.replaceChildren(sicon('check'), t(c.id ? 'studio.cmp.use' : 'studio.cmp.keep'));
      s.setPreview({ id: o.id, variant: c.id });
    };

    const useBtn = h('button', { type: 'button', class: 'st-btn primary st-cmp-use' }, sicon('check'), t(this.picked ? 'studio.cmp.use' : 'studio.cmp.keep'));
    useBtn.onclick = () => this.decide(this.picked);
    const keepBtn = h('button', { type: 'button', class: 'st-btn st-cmp-keep' }, sicon('pen'), t('studio.cmp.keep'));
    keepBtn.onclick = () => this.decide(null);
    const againBtn = h('button', { type: 'button', class: 'st-btn ghost st-cmp-again' }, sicon('restart'), t('studio.cmp.again'));
    againBtn.onclick = () => {
      void this.director.drawOne(o.id);
      this.refreshBusy();
    };
    const head = h('div', { class: 'st-cmp-head' },
      h('span', { class: 'st-cmp-eyebrow' }, sicon('sparkle'), t('studio.cmp.eyebrow')),
      h('span', { class: 'st-cmp-count' }),
      h('button', { type: 'button', class: 'st-cmp-x', title: t('studio.cmp.later'), 'aria-label': t('studio.cmp.later'), onclick: () => this.close(true) }, sicon('close')));
    const title = h('div', { class: 'st-cmp-title' }, t('studio.cmp.title', { name: displayName(o).toLowerCase() }));
    const body = h('div', { class: 'st-cmp-body' }, title, hero, strip,
      h('div', { class: 'st-cmp-actions' }, useBtn, keepBtn, h('span', { class: 'st-grow' }), againBtn));
    const card = h('div', { class: 'st-cmp', role: 'dialog', 'aria-label': t('studio.cmp.label', { name: displayName(o) }) }, head, body);

    if (!this.el) {
      this.el = card;
      this.host.append(card);
      document.addEventListener('keydown', this.onKey, true);
    } else {
      this.el.replaceWith(card);
      this.el = card;
    }
    const first = choices.find((c) => c.id === this.picked) ?? choices[0];
    showHero(first, true);
    if (this.picked !== playing) s.setPreview({ id: o.id, variant: this.picked });
    this.renderCount();
    this.refreshBusy();
    this.place();
    requestAnimationFrame(() => this.place());
  }

  private renderCount(): void {
    const c = this.el?.querySelector('.st-cmp-count');
    if (c) c.textContent = this.queue.length ? t('studio.cmp.count', { n: this.queue.length }) : '';
  }

  /** "Drawing new takes…" while a Try again runs for this object. */
  private refreshBusy(): void {
    if (!this.el || !this.objId) return;
    const busy = this.director.busy(this.objId);
    this.el.classList.toggle('busy', busy);
    const again = this.el.querySelector<HTMLButtonElement>('.st-cmp-again');
    if (again) {
      again.disabled = busy;
      again.replaceChildren(busy ? h('span', { class: 'st-spin', 'aria-hidden': 'true' }) : sicon('restart'), t(busy ? 'studio.cmp.drawing' : 'studio.cmp.again'));
    }
  }

  /** A variant id plays it; null keeps the maker's drawing. One undo step. */
  private decide(variantId: string | null): void {
    const id = this.objId;
    if (!id) return;
    this.studio.setPreview(null);
    this.studio.apply([chooseEdit(this.studio.sceneId, id, variantId)], { label: 'art' });
    this.studio.seal();
    this.next();
  }

  private next(): void {
    const id = this.objId;
    if (id) this.fresh.delete(id);
    this.objId = null;
    while (this.queue.length) {
      const n = this.queue.shift()!;
      const o = this.studio.object(n);
      if (o?.art?.variants.length) {
        this.objId = n;
        this.render(o, true);
        return;
      }
    }
    this.close(false);
  }

  /** Close; `later` = the maker dismissed it (the variants count as seen, the look stays as it is). */
  close(later = false): void {
    const id = this.objId;
    this.studio.setPreview(null);
    if (later && id) {
      const o = this.studio.object(id);
      if (o?.art && !o.art.asked) {
        this.studio.apply([{ action: 'set_art', target: id, scene: this.studio.sceneId, data: { asked: true } }], { label: 'art', quiet: true });
        this.studio.seal();
      }
      if (this.queue.length) { this.next(); return; }
    }
    this.objId = null;
    this.queue = [];
    document.removeEventListener('keydown', this.onKey, true);
    const el = this.el;
    this.el = null;
    if (el) {
      el.classList.add('out');
      window.setTimeout(() => el.remove(), 200);
    }
  }

  private key(e: KeyboardEvent): void {
    if (!this.el) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(true); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const tiles = [...this.el.querySelectorAll<HTMLButtonElement>('.st-cmp-tile')];
      if (!tiles.length) return;
      const at = tiles.findIndex((x) => x.getAttribute('aria-checked') === 'true');
      const n = (at + (e.key === 'ArrowRight' ? 1 : -1) + tiles.length) % tiles.length;
      tiles[n].click();
      tiles[n].focus();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter' && (!tgt || !tgt.closest('.st-cmp-actions'))) {
      e.preventDefault();
      e.stopPropagation();
      this.decide(this.picked);
    }
  }

  private place(): void {
    if (!this.el || !this.objId) return;
    if (window.innerWidth <= 760) { this.el.style.transform = ''; return; }
    const box = this.canvas.objectClientBox(this.objId);
    const host = this.host.getBoundingClientRect();
    if (!box) return;
    const bw = this.el.offsetWidth || 380;
    const bh = this.el.offsetHeight || 460;
    const top = 60;
    const bottom = host.height - 12;
    const bl = box.left - host.left;
    const bt = box.top - host.top;
    const clampY = (v: number): number => Math.max(top, Math.min(bottom - bh, v));
    const clampX = (v: number): number => Math.max(12, Math.min(host.width - bw - 12, v));
    let x: number;
    let y: number;
    if (bl + box.width + 16 + bw <= host.width - 12) { x = bl + box.width + 16; y = clampY(bt + box.height / 2 - bh / 2); }
    else if (bl - 16 - bw >= 12) { x = bl - 16 - bw; y = clampY(bt + box.height / 2 - bh / 2); }
    else { x = clampX(host.width - bw - 12); y = clampY(top); }
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  dispose(): void {
    this.close(false);
    for (const f of this.offs) f();
  }
}
