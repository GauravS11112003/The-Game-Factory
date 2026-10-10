/**
 * The creative tray: a small dock that fills with thumbnails while the kid draws (a shimmer while the art is being
 * made, "3 ready" when it lands). Tap a thumbnail: the kid's drawing next to the new art, "My drawing / Bring to
 * life" for that object, "Try again" (three variations → pick one) and "Save to library" with a name. The dock's
 * switch is the game-level "Bring to life". The preview uses the same tray as the launch pad for the fly-in.
 */
import type { InkStroke } from '../../core/types.gen.ts';
import { paintFit } from '../../editor/paint.ts';
import { ApiError } from '../api.ts';
import { card, h, toast } from '../dom.ts';
import { kidText, t, tMaybe } from '../messages.ts';
import { artAvailable, budgetResting, type CreativeDoc, type ObjRec } from './session.ts';
import { isWorking, type CreativeStatus, type Job } from './types.ts';

export interface TrayOptions {
  doc: CreativeDoc;
  mode: 'draw' | 'preview';
  /** Strokes to paint the kid's drawing when no crop is in memory. */
  strokes: () => readonly InkStroke[];
  status: () => CreativeStatus | null;
  /** Preview: which objects belong to the level on stage (others are hidden). */
  include?: (r: ObjRec) => boolean;
  /** Preview: thumbnails whose sprite already flew onto the stage. */
  landed?: (groupId: string) => boolean;
  /** Preview: the "Bring it to life" replay. */
  onReplay?: () => void;
}

const PLACEHOLDER_SPARK = '✨';

export class CreativeTray {
  readonly el: HTMLDivElement;
  private readonly o: TrayOptions;
  private readonly head: HTMLButtonElement;
  private readonly sw: HTMLButtonElement;
  private readonly strip: HTMLDivElement;
  private readonly replay: HTMLButtonElement | null;
  private thumbs = new Map<string, HTMLButtonElement>();
  private backdropThumb: HTMLDivElement | null = null;
  private inkCache = new Map<string, string>();
  private off: () => void;
  private raf = 0;
  private closeSheet: (() => void) | null = null;

  constructor(o: TrayOptions) {
    this.o = o;
    this.head = h('button', { type: 'button', class: 'cr-head', onclick: () => this.el.classList.toggle('is-open') });
    this.sw = h('button', {
      type: 'button', class: 'cr-switch', role: 'switch', title: t('creative.life_help'),
      onclick: () => o.doc.setLife(!o.doc.life),
    });
    this.strip = h('div', { class: 'cr-strip', role: 'list' });
    this.replay = o.mode === 'preview' && o.onReplay
      ? h('button', { type: 'button', class: 'pill small cr-replay', onclick: () => o.onReplay?.() }, PLACEHOLDER_SPARK, ' ', t('creative.replay'))
      : null;
    this.el = h('div', { class: `cr-tray cr-tray--${o.mode}`, 'aria-label': t('creative.tray_title') },
      h('div', { class: 'cr-bar' }, this.head, this.sw, this.replay), this.strip);
    this.off = o.doc.on(() => this.render());
    this.render();
  }

  /** Where a thumbnail sits on screen (the fly-in's start); the dock itself when the thumbnail is hidden. */
  thumbRect(groupId: string): DOMRect | null {
    const el = this.thumbs.get(groupId);
    const r = el?.isConnected ? el.getBoundingClientRect() : null;
    if (r && r.width > 0) return r;
    const d = this.el.isConnected ? this.el.getBoundingClientRect() : null;
    return d && d.width > 0 ? d : null;
  }

  /** Re-render on the next frame (the preview calls this when a sprite lands). */
  render(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.off();
    this.closeSheet?.();
    this.el.remove();
  }

  private items(): ObjRec[] {
    const inc = this.o.include;
    return this.o.doc.list().filter((r) => !inc || inc(r));
  }

  private paint(): void {
    const { doc } = this.o;
    const st = this.o.status();
    const items = this.items();
    const anyArt = items.some((r) => !!doc.jobOf(r)) || !!doc.backdropJob();
    // no provider and nothing made earlier: no tray at all
    const hidden = (!artAvailable(st) && !anyArt) || (this.o.mode === 'preview' && !items.length && !doc.backdropJob());
    this.el.classList.toggle('hidden', hidden);
    if (hidden) return;
    const life = doc.life;
    this.el.classList.toggle('is-off', !life);

    const ready = items.filter((r) => doc.jobOf(r)?.status === 'done' && doc.jobOf(r)?.url).length;
    const working = items.filter((r) => doc.sending.has(r.group_id) || isWorking(doc.jobOf(r))).length;
    let label: string;
    if (!life) label = t('creative.my_drawings');
    else if (budgetResting(st) && !ready) label = t('creative.resting');
    else if (working) label = t('creative.working', { n: working });
    else if (ready) label = t('creative.ready', { n: ready });
    else label = t('creative.life_on');
    this.head.replaceChildren(h('span', { class: `cr-spark${working && life ? ' is-busy' : ''}` }, PLACEHOLDER_SPARK), h('span', { class: 'cr-count' }, label));
    this.head.title = items.length ? t('creative.tap_hint') : t('creative.empty');
    this.sw.classList.toggle('on', life);
    this.sw.setAttribute('aria-checked', life ? 'true' : 'false');
    this.sw.replaceChildren(h('span', { class: 'cr-knob' }), h('span', { class: 'cr-sw-label' }, t(life ? 'creative.life_on' : 'creative.my_drawing')));
    if (this.replay) this.replay.disabled = !life || !ready;

    // thumbnails, keyed by object
    const keep = new Set<string>();
    for (const r of items) {
      keep.add(r.group_id);
      let el = this.thumbs.get(r.group_id);
      if (!el) {
        const id = r.group_id;
        el = h('button', { type: 'button', class: 'cr-thumb', role: 'listitem', onclick: () => this.openSheet(id) });
        this.thumbs.set(r.group_id, el);
      }
      this.paintThumb(el, r, doc.jobOf(r));
      this.strip.append(el); // (re)append keeps reading order
    }
    for (const [id, el] of this.thumbs) {
      if (keep.has(id)) continue;
      el.remove();
      this.thumbs.delete(id);
    }
    const bj = doc.backdropJob();
    if (bj && life) {
      this.backdropThumb ??= h('div', { class: 'cr-thumb cr-thumb--wide', title: t('creative.backdrop') });
      const url = bj.status === 'done' ? bj.url : null;
      this.backdropThumb.classList.toggle('is-working', isWorking(bj));
      this.backdropThumb.classList.toggle('is-failed', bj.status === 'failed');
      const img = this.backdropThumb.querySelector('img');
      if (url && img?.getAttribute('src') !== url) this.backdropThumb.replaceChildren(h('img', { src: url, alt: t('creative.backdrop'), draggable: false }));
      else if (!url && !this.backdropThumb.querySelector('.cr-shimmer')) this.backdropThumb.replaceChildren(h('span', { class: 'cr-shimmer' }));
      this.strip.append(this.backdropThumb);
    } else this.backdropThumb?.remove();
    this.strip.classList.toggle('is-empty', !items.length && !bj);
  }

  private inkPicture(r: ObjRec): string {
    const mem = this.o.doc.crops.get(r.group_id);
    if (mem) return mem;
    const key = `${r.group_id}:${r.stroke_ids.join(',')}:${r.bbox_cells.join(',')}`;
    const hit = this.inkCache.get(key);
    if (hit) return hit;
    const ids = new Set(r.stroke_ids);
    const strokes = this.o.strokes().filter((s) => ids.has(s.id));
    if (!strokes.length) return ''; // the ink is not here yet: try again on the next paint
    const c = h('canvas', { width: 96, height: 96 });
    paintFit(c, strokes, r.bbox_cells, { pad: 0.4, bg: '#ffffff' });
    let url = '';
    try {
      url = c.toDataURL('image/png');
    } catch {
      url = '';
    }
    this.inkCache.set(key, url);
    return url;
  }

  private paintThumb(el: HTMLButtonElement, r: ObjRec, job: Job | null): void {
    const life = this.o.doc.life && r.mode === 'life';
    const working = this.o.doc.sending.has(r.group_id) || isWorking(job);
    const art = job?.status === 'done' ? job.url : null;
    const failed = !working && (job?.status === 'failed' || (!job && !!r.error));
    const showArt = life && !!art;
    const src = showArt ? art! : this.inkPicture(r);
    el.classList.toggle('is-working', life && working);
    el.classList.toggle('is-done', showArt);
    el.classList.toggle('is-failed', life && failed);
    el.classList.toggle('is-ink', !life);
    el.classList.toggle('is-landed', showArt && !!this.o.landed?.(r.group_id));
    const name = job?.label ? kidText(job.label) : r.hint ?? t('creative.your_drawing');
    el.title = name;
    el.setAttribute('aria-label', name);
    el.dataset.g = r.group_id;
    const img = el.querySelector('img');
    if (!img || img.getAttribute('src') !== src) {
      el.replaceChildren(
        src ? h('img', { src, alt: '', draggable: false }) : h('span', { class: 'cr-blank' }),
        h('span', { class: 'cr-shimmer' }),
        h('span', { class: 'cr-badge', 'aria-hidden': 'true' }));
    }
    const badge = el.querySelector('.cr-badge');
    if (badge) badge.textContent = !life ? '✎' : failed ? '!' : r.pinned ? '★' : '';
  }

  // ---- the object sheet ----------------------------------------------------------------------------------------------
  private openSheet(groupId: string): void {
    this.closeSheet?.();
    const { doc } = this.o;
    let busy = false;
    let naming = false;
    const back = h('div', { class: 'modal-back cr-sheet-back' });
    const body = card('narrow cr-sheet');
    back.append(body);
    back.addEventListener('click', (e) => {
      if (e.target === back) close();
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    const run = async (fn: () => Promise<unknown>): Promise<void> => {
      if (busy) return;
      busy = true;
      draw();
      try {
        await fn();
      } catch (e) {
        toast(t(e instanceof ApiError ? e.messageKey : 'creative.failed', e instanceof ApiError ? e.args : {}));
      } finally {
        busy = false;
        draw();
      }
    };

    const draw = (): void => {
      const r = doc.objects.get(groupId);
      if (!r) {
        close();
        return;
      }
      const job = doc.jobOf(r);
      const working = doc.sending.has(groupId) || isWorking(job);
      const art = job?.status === 'done' ? job.url : null;
      const title = job?.label ? kidText(job.label) : r.hint ?? t('creative.your_drawing');
      const mine = h('figure', { class: 'cr-pic' }, h('img', { src: this.inkPicture(r), alt: '' }), h('figcaption', null, t('creative.your_drawing')));
      const theirs = h('figure', { class: `cr-pic${working ? ' is-working' : ''}` },
        art ? h('img', { src: art, alt: '' }) : h('span', { class: 'cr-blank' }, working ? '' : '?'),
        h('span', { class: 'cr-shimmer' }),
        h('figcaption', null, working ? t('creative.working_one')
          : job?.status === 'failed' || (!job && r.error) ? tMaybe(job?.error_key ?? r.error) ?? t('creative.failed') : t('creative.new_art')));
      const seg = h('div', { class: 'cr-seg', role: 'radiogroup' },
        ...(['ink', 'life'] as const).map((m) => h('button', {
          type: 'button', role: 'radio', class: `chip${r.mode === m ? ' on' : ''}`, 'aria-checked': r.mode === m ? 'true' : 'false',
          onclick: () => doc.setMode(groupId, m),
        }, m === 'ink' ? '✎ ' : `${PLACEHOLDER_SPARK} `, t(m === 'ink' ? 'creative.my_drawing' : 'creative.life_on'))));
      const variants = job && job.variants.length > 1
        ? h('div', { class: 'cr-variants' }, h('p', { class: 'small muted' }, t('creative.pick_one')),
          h('div', { class: 'row wrap' }, ...job.variants.map((v, i) => h('button', {
            type: 'button', class: `cr-thumb is-done${v.url === job.url ? ' on' : ''}`, disabled: busy, title: t('creative.pick_one'),
            onclick: () => void run(() => doc.choose(groupId, i)),
          }, h('img', { src: v.url, alt: '' })))))
        : null;
      const canReroll = !!job && !working;
      const actions = h('div', { class: 'row wrap' },
        canReroll
          ? h('button', { type: 'button', class: 'pill small', disabled: busy, onclick: () => void run(() => doc.reroll(groupId)) }, '🎲 ', t('creative.try_again'))
          : !job && r.error && !working && doc.senders > 0
            ? h('button', { type: 'button', class: 'pill small', onclick: () => doc.retry(groupId) }, '🎲 ', t('creative.try_again'))
            : null,
        art ? h('button', {
          type: 'button', class: `pill small${naming ? ' on' : ''}`, disabled: busy || !doc.gameId, title: doc.gameId ? '' : t('creative.needs_game'),
          onclick: () => { naming = !naming; draw(); },
        }, '★ ', t(r.pinned ? 'creative.saved_short' : 'creative.save_library')) : null);
      let nameRow: HTMLElement | null = null;
      if (naming && art && doc.gameId) {
        const input = h('input', { type: 'text', class: 'text', maxLength: 16, value: (r.pinned?.name ?? (job?.label ? kidText(job.label) : r.hint ?? '')).slice(0, 16), placeholder: t('creative.name_it') });
        const save = (): void => {
          const name = input.value.trim();
          if (!name) return;
          void run(async () => {
            await doc.pin(groupId, name, this.o.strokes());
            naming = false;
            toast(t('creative.saved'));
          });
        };
        input.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') save();
        };
        nameRow = h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'pill small primary', disabled: busy, onclick: save }, t('creative.save_library')));
        queueMicrotask(() => input.focus());
      }
      const credit = art ? h('p', { class: 'small muted cr-credit' }, creditText(job)) : null;
      const parts: (HTMLElement | null)[] = [
        h('div', { class: 'row between' }, h('h3', null, title), h('button', { type: 'button', class: 'tool', 'aria-label': t('ui.close'), onclick: close }, '✕')),
        h('div', { class: 'cr-pics' }, mine, h('span', { class: 'cr-arrow', 'aria-hidden': 'true' }, '➜'), theirs),
        seg, variants, actions, nameRow, !doc.gameId && art ? h('p', { class: 'small muted' }, t('creative.needs_game')) : null, credit,
      ];
      body.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
    };

    // keep a half-typed name: while naming, only a vanished object redraws the sheet
    const offDoc = doc.on(() => {
      if (!naming || !doc.objects.has(groupId)) draw();
    });
    function close(): void {
      offDoc();
      window.removeEventListener('keydown', onKey);
      back.remove();
    }
    this.closeSheet = close;
    document.body.append(back);
    draw();
  }
}

export function creditText(job: Job | null): string {
  const tool = job?.credit?.tool ?? (job?.provider === 'firefly' ? 'Adobe Firefly' : null);
  if (tool && /firefly/i.test(tool)) return t('creative.by_firefly');
  return t('creative.by_claude');
}
