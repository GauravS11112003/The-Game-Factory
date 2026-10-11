/**
 * The Blocks drawer (docs/v6/CONTRACTS_V6.md §9): drawn objects and themes other makers shared, dropped straight into
 * this game. An object lands in the middle of the view with its behaviours, rules and items; a theme restyles the
 * game. Both are one undo step, and the block's author is credited in this game (POST …/blocks/{id}/use).
 */
import { h, toast } from '../../app/dom.ts';
import { kidText, t } from '../../app/messages.ts';
import { isLocalId, studioApi } from '../../app/studio_api.ts';
import { v4 } from '../../app/v4api.ts';
import type { BlockCard, StudioEdit } from '../../core/types.gen.ts';
import { normalizeObject } from '../model/types.ts';
import type { StudioCanvas } from './canvas.ts';
import { sicon } from './icons.ts';
import type { Studio } from './studio.ts';
import { closePopover, popover } from './ui.ts';
import { renderDrawing } from '../theme/render.ts';

function thumb(b: BlockCard): HTMLElement {
  const box = h('span', { class: 'st-bd-thumb' });
  if (b.kind === 'theme' && b.theme) {
    const p = b.theme.palette ?? {};
    box.style.background = p.bg ?? '#f6f1e7';
    for (const k of ['ink', 'accent', 'accent2']) if (p[k]) box.append(h('i', { style: `background:${p[k]}` }));
    box.classList.add('theme');
    return box;
  }
  const d = b.object?.drawing;
  if (d?.strokes?.length) {
    const c = renderDrawing(normalizeObject(b.object).drawing, null, { pad: 4 });
    c.className = 'st-bd-canvas';
    box.append(c);
  }
  return box;
}

export function openBlocksDrawer(anchor: HTMLElement, studio: Studio, canvas: StudioCanvas, gameId: () => string): void {
  const list = h('div', { class: 'st-bd-list' }, h('p', { class: 'st-bd-note' }, t('studio.blocks.loading')));
  const search = h('input', { type: 'search', class: 'st-bd-search', placeholder: t('studio.blocks.search'), 'aria-label': t('studio.blocks.search') });
  let kind: 'object' | 'theme' = 'object';
  const tabs = h('div', { class: 'st-bd-tabs', role: 'tablist' });
  let seq = 0;

  const use = (b: BlockCard): void => {
    if (b.kind === 'object' && b.object) {
      const r = canvas.rect();
      const [x, y] = canvas.screenToWorld(r.width / 2, r.height / 2);
      const o = { ...normalizeObject(b.object), x: Math.round(x), y: Math.round(y) };
      studio.paste([o], 0);
    } else if (b.kind === 'theme' && b.theme) {
      const edit: StudioEdit = { action: 'set_theme', data: b.theme as unknown as Record<string, unknown> };
      studio.apply([edit], { label: 'theme' });
    } else return;
    closePopover();
    toast(t('studio.blocks.added', { name: kidText(b.name), author: b.author || t('ui.someone') }));
    const id = gameId();
    if (!isLocalId(id)) void studioApi.useBlock(id, b.id).catch(() => undefined);
  };

  const load = async (): Promise<void> => {
    const mine = ++seq;
    list.replaceChildren(h('p', { class: 'st-bd-note' }, t('studio.blocks.loading')));
    try {
      const r = await v4.blocks({ kind, q: search.value.trim() || undefined, sort: 'popular', limit: 40 });
      if (mine !== seq) return;
      const items = r.blocks.filter((b) => (kind === 'object' ? !!b.object : !!b.theme));
      list.replaceChildren(...(items.length ? items.map((b) => h('button', { type: 'button', class: 'st-bd-item', onclick: () => use(b), title: b.description ?? b.name },
        thumb(b),
        h('span', { class: 'st-bd-text' }, h('span', { class: 'st-bd-name' }, kidText(b.name)), h('span', { class: 'st-bd-by' }, t('studio.blocks.by', { author: b.author || t('ui.someone') }))))) :
        [h('p', { class: 'st-bd-note' }, t(kind === 'object' ? 'studio.blocks.none_objects' : 'studio.blocks.none_themes'))]));
    } catch {
      if (mine === seq) list.replaceChildren(h('p', { class: 'st-bd-note' }, t('studio.blocks.offline')));
    }
  };

  const renderTabs = (): void => {
    tabs.replaceChildren(...(['object', 'theme'] as const).map((k) => h('button', {
      type: 'button', role: 'tab', class: `st-bd-tab${k === kind ? ' on' : ''}`, 'aria-selected': String(k === kind),
      onclick: () => { kind = k; renderTabs(); void load(); },
    }, t(`studio.blocks.tab_${k}`))));
  };
  let timer = 0;
  search.oninput = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 250); };
  search.onkeydown = (e) => e.stopPropagation();
  renderTabs();
  void load();
  popover(anchor, h('div', { class: 'st-bd' },
    h('div', { class: 'st-bd-head' }, sicon('stamp'), h('span', null, t('studio.blocks.title'))),
    h('p', { class: 'st-bd-note' }, t('studio.blocks.help')),
    tabs, search, list), window.innerWidth <= 760 ? { side: 'above', align: 'end', cls: 'st-pop-bd' } : { side: 'right', cls: 'st-pop-bd' });
}
