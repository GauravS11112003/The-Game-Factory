/**
 * v7 look controls (docs/v7/CONTRACTS_V7.md §5): the inspector's "Look" section (what plays now, Claude's versions to
 * pick from, "Keep my drawing", "Redraw", the ground's land preview) and the Game panel's "Art style" (the direction's
 * summary, new words + "Restyle everything", the Sketch ↔ Game look, the backdrop). Everything is a StudioEdit.
 */
import type { ArtVariant } from '../../core/types.gen.ts';
import { h } from '../../app/dom.ts';
import { kidText, t } from '../../app/messages.ts';
import { isDrawn } from '../model/art_plan.ts';
import type { SObj } from '../model/types.ts';
import { sicon } from './icons.ts';
import { chosenVariant, docLook, isGroundObj, plainSkin, sketchTile, svgUrl } from './look.ts';
import type { Studio } from './studio.ts';
import { row, segmented } from './ui.ts';

const setArt = (s: Studio, id: string, data: Record<string, unknown>): void => {
  s.setPreview(null);
  s.apply([{ action: 'set_art', target: id, data }], { label: 'art' });
};

function stageBg(s: Studio): string {
  const sky = docLook(s.doc) === 'game' ? ((s.doc.backdrop?.sky ?? []) as string[]) : [];
  if (sky.length > 1) return `linear-gradient(180deg, ${sky.join(', ')})`;
  return sky[0] ?? s.doc.theme.palette?.bg ?? '#f6f1e7';
}

function variantImg(v: ArtVariant, cls: string): HTMLImageElement {
  return h('img', { class: cls, src: svgUrl(v.svg), alt: v.note ?? '', draggable: false });
}

/** A gradient chip of a terrain skin (fill top → bottom under a surface band). */
function landSwatch(fill: string[], surface: string): HTMLElement {
  const g = fill.length > 1 ? `linear-gradient(180deg, ${fill.join(', ')})` : fill[0] ?? '#8d6e63';
  return h('div', { class: 'st-land' }, h('i', { class: 'st-land-surface', style: `background:${surface}` }), h('i', { class: 'st-land-fill', style: `background:${g}` }));
}

/** The inspector's Look section for one object (null for invisible boxes). */
export function lookSection(s: Studio, o: SObj): HTMLElement | null {
  if (!isDrawn(o)) return null;
  const hooks = s.artHooks;
  const busy = hooks?.busy(o.id) ?? false;
  const art = o.art ?? null;
  const usingAi = art?.use === 'ai';
  const kids: HTMLElement[] = [];
  const bg = stageBg(s);

  if (docLook(s.doc) === 'sketch') {
    kids.push(h('div', { class: 'st-look-hint' }, sicon('eye'), h('span', null, t('studio.look.sketch_on')),
      h('button', { type: 'button', class: 'st-link', onclick: () => s.apply([{ action: 'set_look', data: { look: 'game' } }], { label: 'look' }) }, t('studio.look.show_game'))));
  }

  if (isGroundObj(o)) {
    const skin = usingAi && art?.terrain ? art.terrain : plainSkin(o, s.doc.theme);
    kids.push(h('div', { class: `st-look-hero ground${busy ? ' busy' : ''}`, style: `background:${bg}` },
      landSwatch((skin.fill ?? []) as string[], skin.surface ?? '#3bb273'),
      h('span', { class: 'st-look-badge' }, t(usingAi ? 'studio.look.claude_ground' : 'studio.look.plain_ground'))));
    const btns: HTMLElement[] = [];
    if (art?.terrain) {
      btns.push(segmented([{ value: 'ai', label: t('studio.look.claude_ground') }, { value: 'sketch', label: t('studio.look.plain_ground') }], usingAi ? 'ai' : 'sketch', (v) => setArt(s, o.id, { use: v, asked: true }), { cls: 'small' }));
    }
    btns.push(h('button', { type: 'button', class: 'st-btn small', disabled: busy || !hooks, onclick: () => hooks?.redraw(o.id) },
      busy ? h('span', { class: 'st-spin', 'aria-hidden': 'true' }) : sicon('sparkle'), t(busy ? 'studio.look.drawing' : art?.terrain ? 'studio.look.redraw_ground' : 'studio.look.make_ground')));
    kids.push(h('div', { class: 'st-row-btns wrap' }, ...btns));
    return h('div', { class: 'st-stack st-look' }, ...kids);
  }

  // the hero: what plays now
  const playing = usingAi ? chosenVariant(o) : null;
  const heroPic = playing ? variantImg(playing, 'st-look-img') : (() => { const c = sketchTile(o, s.doc.theme, 300); c.className = 'st-look-img'; return c; })();
  kids.push(h('div', { class: `st-look-hero${busy ? ' busy' : ''}`, style: `background:${bg}` }, heroPic,
    h('span', { class: 'st-look-badge' }, t(playing ? 'studio.look.claude' : 'studio.look.yours')),
    playing?.note ? h('span', { class: 'st-look-note' }, kidText(playing.note)) : null));

  // the strip: mine + Claude's versions
  const variants = art?.variants ?? [];
  if (variants.length) {
    const tile = (v: ArtVariant | null): HTMLElement => {
      const on = v ? usingAi && art?.chosen === v.id : !usingAi;
      const b = h('button', { type: 'button', class: `st-look-tile${on ? ' on' : ''}`, 'aria-pressed': String(on), title: v?.note ?? t('studio.look.yours'), style: `background:${bg}` },
        v ? variantImg(v, 'st-look-timg') : (() => { const c = sketchTile(o, s.doc.theme, 120); c.className = 'st-look-timg'; return c; })());
      b.onclick = () => (v ? setArt(s, o.id, { use: 'ai', chosen: v.id, asked: true }) : setArt(s, o.id, { use: 'sketch', asked: true }));
      b.onmouseenter = () => s.setPreview({ id: o.id, variant: v?.id ?? null });
      b.onmouseleave = () => s.setPreview(null);
      return b;
    };
    kids.push(h('div', { class: 'st-look-strip', role: 'group', 'aria-label': t('studio.look.versions') }, tile(null), ...variants.map(tile)));
  }

  const btns: HTMLElement[] = [];
  if (usingAi) btns.push(h('button', { type: 'button', class: 'st-btn small', onclick: () => setArt(s, o.id, { use: 'sketch', asked: true }) }, sicon('pen'), t('studio.look.keep_mine')));
  if (variants.length && hooks) btns.push(h('button', { type: 'button', class: 'st-btn small', onclick: () => hooks.compare(o.id) }, sicon('layers'), t('studio.look.compare')));
  btns.push(h('button', { type: 'button', class: `st-btn small${variants.length ? '' : ' primary'}`, disabled: busy || !hooks, onclick: () => hooks?.redraw(o.id) },
    busy ? h('span', { class: 'st-spin', 'aria-hidden': 'true' }) : sicon('sparkle'), t(busy ? 'studio.look.drawing' : variants.length ? 'studio.look.redraw' : 'studio.look.make_real')));
  kids.push(h('div', { class: 'st-row-btns wrap' }, ...btns));
  if (!variants.length && !busy) kids.push(h('p', { class: 'st-sec-hint' }, t('studio.look.hint')));
  return h('div', { class: 'st-stack st-look' }, ...kids);
}

/** The Game panel's Art style section. */
export function artStyleSection(s: Studio): HTMLElement {
  const dir = s.doc.art_direction ?? null;
  const hooks = s.artHooks;
  const busy = hooks?.busy() ?? false;
  const input = h('textarea', { class: 'st-text st-art-in', rows: 2, maxLength: 300, placeholder: t('studio.art.prompt_ph'), 'aria-label': t('studio.art.prompt_ph') });
  input.value = '';
  const go = h('button', { type: 'button', class: 'st-btn primary small', disabled: busy || !hooks }, busy ? h('span', { class: 'st-spin', 'aria-hidden': 'true' }) : sicon('sparkle'), t(busy ? 'studio.art.busy' : 'studio.art.restyle_all'));
  const run = (): void => {
    const v = input.value.trim();
    hooks?.restyle(v || null);
    input.value = '';
  };
  go.onclick = run;
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } };
  const palette = (dir?.palette ?? []) as string[];
  const card = dir
    ? h('div', { class: 'st-art-dir' },
      h('div', { class: 'st-art-dir-top' }, h('span', { class: 'st-art-dir-label' }, t('studio.art.current')), palette.length ? h('span', { class: 'st-art-pal' }, ...palette.map((c) => h('i', { style: `background:${c}` }))) : null),
      dir.summary ? h('div', { class: 'st-art-dir-sum' }, kidText(dir.summary)) : null,
      dir.prompt ? h('div', { class: 'st-art-dir-prompt' }, `“${kidText(dir.prompt)}”`) : null)
    : h('p', { class: 'st-sec-hint' }, t('studio.art.none'));
  const look = row(t('studio.look.title'), segmented([{ value: 'game', label: t('studio.look.game') }, { value: 'sketch', label: t('studio.look.sketch') }], docLook(s.doc),
    (v) => s.apply([{ action: 'set_look', data: { look: v } }], { label: 'look' }), { cls: 'small' }), { help: t('studio.look.help') });
  const back = s.doc.backdrop;
  const backdrop = back
    ? row(t('studio.art.backdrop'), h('div', { class: 'st-row-btns' },
      h('span', { class: 'st-art-sky', style: `background:${((back.sky ?? []) as string[]).length > 1 ? `linear-gradient(180deg, ${(back.sky as string[]).join(', ')})` : (back.sky as string[])[0] ?? '#ccc'}` }),
      h('button', { type: 'button', class: 'st-btn small ghost', onclick: () => s.apply([{ action: 'set_backdrop', data: {} }], { label: 'art' }) }, sicon('trash'), t('studio.art.backdrop_remove'))))
    : null;
  return h('div', { class: 'st-stack' }, card, h('div', { class: 'st-art-ask' }, input, go), look, backdrop);
}
