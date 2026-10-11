/**
 * Recognize (docs/v6/CONTRACTS_V6.md §6): when the maker finishes an object that is still a "thing", ask the server
 * what it looks like and show a small bubble beside it: "Is this a car? Yes · No, it's… · ×". Yes applies the edits
 * as one undo step; "No, it's…" goes to the copilot with the object selected. Offline, the bubble offers quick picks.
 * Also the banners at the top of the canvas: pending ask_draw prompts and "click the thing to attach".
 */
import type { StudioEdit } from '../../core/types.gen.ts';
import { h } from '../../app/dom.ts';
import { kidText, t } from '../../app/messages.ts';
import { studioApi } from '../../app/studio_api.ts';
import { archetypeEdits, archetypeFor } from '../model/edits.ts';
import { asGameDoc } from '../model/types.ts';
import type { StudioCanvas } from './canvas.ts';
import { sicon } from './icons.ts';
import { kindEmoji } from './inspector.ts';
import { objectPng } from './snapshot.ts';
import type { Studio } from './studio.ts';

const QUICK = ['player', 'ground', 'platform', 'coin', 'enemy', 'car', 'goal', 'decoration'];

export class Recognizer {
  private bubble: HTMLElement | null = null;
  private objId: string | null = null;
  private seq = 0;
  private offs: (() => void)[] = [];

  constructor(private readonly studio: Studio, private readonly canvas: StudioCanvas, private readonly host: HTMLElement, private readonly askCopilot: (text: string, id: string) => void) {
    this.offs.push(studio.on((c) => {
      if (c.kind === 'finished' && c.id) void this.recognize(c.id);
      if (c.kind === 'doc' && this.objId && !studio.object(this.objId)) this.close();
      if (c.kind === 'scene') this.close();
    }));
    const prev = canvas.onView;
    canvas.onView = () => { prev?.(); this.place(); };
  }

  private async recognize(id: string): Promise<void> {
    const s = this.studio;
    const o = s.object(id);
    if (!o || o.kind !== 'thing' || !o.drawing.strokes.length) return;
    const n = ++this.seq;
    this.show(id, h('div', { class: 'st-bubble-row' }, h('span', { class: 'st-typing small' }, h('i'), h('i'), h('i')), h('span', { class: 'st-bubble-q muted' }, t('studio.rec.looking'))));
    const png = objectPng(o, s.doc);
    try {
      if (!png) throw new Error('no picture');
      const r = await studioApi.recognize({ game: asGameDoc(s.doc), scene: s.sceneId, object_id: id, image_png: png });
      if (n !== this.seq || !s.object(id)) return;
      if (!r.edits?.length) { this.offerPicks(id, r.question || t('studio.rec.what')); return; }
      this.offerGuess(id, r.question, r.kind, r.edits, r.name);
    } catch {
      if (n !== this.seq || !s.object(id)) return;
      this.offerPicks(id, t('studio.rec.what'));
    }
  }

  private offerGuess(id: string, question: string, kind: string, edits: StudioEdit[], name: string): void {
    const s = this.studio;
    const yes = h('button', { type: 'button', class: 'st-btn primary small', onclick: () => {
      const extra: StudioEdit[] = name && !s.object(id)?.name ? [{ action: 'update_object', target: id, data: { name: name.slice(0, 32) } }] : [];
      s.apply([...edits, ...extra], { label: 'recognize' });
      s.seal();
      s.select([id]);
      this.close();
    } }, sicon('check'), t('studio.rec.yes'));
    const no = h('button', { type: 'button', class: 'st-btn small', onclick: () => this.askWhat(id) }, t('studio.rec.no'));
    this.show(id, h('div', { class: 'st-bubble-col' },
      h('div', { class: 'st-bubble-row' }, h('span', { class: 'st-bubble-emo', 'aria-hidden': 'true' }, kindEmoji(kind)), h('span', { class: 'st-bubble-q' }, kidText(question))),
      h('div', { class: 'st-bubble-row' }, yes, no)));
  }

  private offerPicks(id: string, question: string): void {
    const s = this.studio;
    const pick = (k: string): void => {
      s.apply(archetypeEdits(s.doc, s.sceneId, id, k), { label: 'recognize' });
      s.seal();
      s.select([id]);
      this.close();
    };
    this.show(id, h('div', { class: 'st-bubble-col' },
      h('div', { class: 'st-bubble-row' }, h('span', { class: 'st-bubble-q' }, kidText(question))),
      h('div', { class: 'st-bubble-picks' }, ...QUICK.map((k) => h('button', { type: 'button', class: 'st-qchip', onclick: () => pick(k) }, h('span', { class: 'emo' }, kindEmoji(k)), archetypeFor(k)?.label ?? k)),
        h('button', { type: 'button', class: 'st-qchip more', onclick: () => this.askWhat(id) }, t('studio.rec.other')))));
  }

  private askWhat(id: string): void {
    const input = h('input', { type: 'text', class: 'st-text', maxLength: 120, placeholder: t('studio.rec.its_ph'), 'aria-label': t('studio.rec.its_ph') });
    const go = (): void => {
      const v = input.value.trim();
      if (!v) return;
      this.close();
      this.studio.select([id]);
      this.askCopilot(t('studio.rec.its_msg', { what: v }), id);
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); if (e.key === 'Escape') this.close(); };
    this.show(id, h('div', { class: 'st-bubble-row' }, h('span', { class: 'st-bubble-q' }, t('studio.rec.its')), input,
      h('button', { type: 'button', class: 'st-btn primary small', onclick: go }, sicon('send'))));
    window.setTimeout(() => input.focus(), 20);
  }

  private show(id: string, content: HTMLElement): void {
    this.objId = id;
    if (!this.bubble) {
      this.bubble = h('div', { class: 'st-bubble', role: 'dialog', 'aria-label': t('studio.rec.label') });
      this.host.append(this.bubble);
    }
    this.bubble.replaceChildren(content, h('button', { type: 'button', class: 'st-bubble-x', title: t('studio.rec.ignore'), 'aria-label': t('studio.rec.ignore'), onclick: () => this.close() }, sicon('close')));
    this.place();
  }

  private place(): void {
    if (!this.bubble || !this.objId) return;
    const box = this.canvas.objectClientBox(this.objId);
    const host = this.host.getBoundingClientRect();
    if (!box) { this.close(); return; }
    const bw = this.bubble.offsetWidth || 260;
    const bh = this.bubble.offsetHeight || 80;
    const top = 64;
    const bottom = host.height - 80;
    const bl = box.left - host.left;
    const bt = box.top - host.top;
    const clampX = (v: number): number => Math.max(8, Math.min(host.width - bw - 8, v));
    const clampY = (v: number): number => Math.max(top, Math.min(bottom - bh, v));
    let x: number;
    let y: number;
    if (bl + box.width + 12 + bw <= host.width - 8) { x = bl + box.width + 12; y = clampY(bt - 8); }
    else if (bl - 12 - bw >= 8) { x = bl - 12 - bw; y = clampY(bt - 8); }
    else if (bt - 12 - bh >= top) { x = clampX(bl + box.width / 2 - bw / 2); y = bt - 12 - bh; }
    else if (bt + box.height + 12 + bh <= bottom) { x = clampX(bl + box.width / 2 - bw / 2); y = bt + box.height + 12; }
    else { x = clampX(bl + box.width + 12); y = top; }
    this.bubble.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  close(): void {
    this.seq++;
    this.bubble?.remove();
    this.bubble = null;
    this.objId = null;
  }

  dispose(): void {
    this.close();
    for (const f of this.offs) f();
  }
}

/** Banners at the top of the canvas: the current ask_draw ("✏️ Draw your car · skip") or a pick request. */
export function mountBanners(studio: Studio, host: HTMLElement): () => void {
  const el = h('div', { class: 'st-banners', 'aria-live': 'polite' });
  host.append(el);
  const render = (): void => {
    const kids: HTMLElement[] = [];
    if (studio.pick) {
      kids.push(h('div', { class: 'st-banner pick' }, sicon('link'), h('span', null, studio.pick.prompt),
        h('button', { type: 'button', class: 'st-banner-btn', onclick: () => studio.cancelPick() }, t('studio.ui.cancel'))));
    }
    const asks = studio.asks.filter((a) => a.scene === studio.sceneId);
    if (asks.length) {
      const a = asks[0];
      kids.push(h('div', { class: 'st-banner ask' }, h('span', { class: 'emo', 'aria-hidden': 'true' }, '✏️'), h('span', { class: 'st-banner-text' }, kidText(a.prompt)),
        asks.length > 1 ? h('span', { class: 'st-banner-count' }, t('studio.ask.more', { n: asks.length - 1 })) : null,
        h('button', { type: 'button', class: 'st-banner-btn', onclick: () => studio.skipAsk() }, t('studio.ask.skip'))));
    }
    el.replaceChildren(...kids);
  };
  render();
  return studio.on((c) => { if (c.kind === 'asks' || c.kind === 'pick' || c.kind === 'scene') render(); });
}
