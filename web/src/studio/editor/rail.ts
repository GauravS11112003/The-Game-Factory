/** The floating tool rail (docs/v6/CONTRACTS_V6.md §6): tools with shortcuts, ink colour (theme palette + custom), widths. */
import { h } from '../../app/dom.ts';
import { t } from '../../app/messages.ts';
import { sicon } from './icons.ts';
import type { Studio, Tool } from './studio.ts';
import { popover } from './ui.ts';

export const TOOLS: { tool: Tool; icon: string; key: string; label: string }[] = [
  { tool: 'select', icon: 'cursor', key: 'V', label: 'studio.tool.select' },
  { tool: 'hand', icon: 'hand', key: 'H', label: 'studio.tool.hand' },
  { tool: 'pen', icon: 'pen', key: 'P', label: 'studio.tool.pen' },
  { tool: 'line', icon: 'line', key: 'L', label: 'studio.tool.line' },
  { tool: 'rect', icon: 'rect', key: 'R', label: 'studio.tool.rect' },
  { tool: 'circle', icon: 'circle', key: 'O', label: 'studio.tool.circle' },
  { tool: 'eraser', icon: 'eraser', key: 'E', label: 'studio.tool.eraser' },
];

export const WIDTHS = [3, 6, 11, 20];
const EXTRA = ['#1f1b18', '#e4572e', '#f2a541', '#3bb273', '#2e86ab', '#6a4c93', '#d7263d', '#8d6e63', '#ffffff'];

export function inkColors(studio: Studio): string[] {
  const pal = studio.doc.theme.palette ?? {};
  const out: string[] = [];
  for (const k of ['ink', 'accent', 'accent2', 'good', 'danger', 'text']) {
    const c = pal[k];
    if (c && /^#[0-9a-f]{6}$/i.test(c) && !out.includes(c.toLowerCase())) out.push(c.toLowerCase());
  }
  for (const c of EXTRA) if (!out.includes(c) && out.length < 12) out.push(c);
  return out;
}

export function mountRail(studio: Studio, extra: HTMLElement[] = []): { el: HTMLElement; dispose: () => void } {
  const el = h('div', { class: 'st-rail', role: 'toolbar', 'aria-label': t('studio.tool.rail'), 'aria-orientation': 'vertical' });
  const render = (): void => {
    const buttons = TOOLS.map((x) => h('button', {
      type: 'button', class: `st-tool${studio.tool === x.tool ? ' on' : ''}`, 'aria-pressed': String(studio.tool === x.tool),
      title: `${t(x.label)} (${x.key})`, 'aria-label': t(x.label), onclick: () => studio.setTool(x.tool),
    }, sicon(x.icon), h('kbd', null, x.key)));
    const ink = h('button', { type: 'button', class: 'st-ink-btn', title: t('studio.tool.ink'), 'aria-label': t('studio.tool.ink') },
      h('span', { class: 'st-ink-dot', style: `background:${studio.color};--w:${Math.min(20, 4 + studio.width * 0.8)}px` }));
    ink.onclick = () => openInk(ink, studio);
    el.replaceChildren(...buttons.slice(0, 2), h('span', { class: 'st-rail-sep' }), ...buttons.slice(2), h('span', { class: 'st-rail-sep' }), ink, ...extra);
  };
  render();
  const off = studio.on((c) => { if (c.kind === 'tool' || (c.kind === 'doc' && !c.quiet)) render(); });
  return { el, dispose: off };
}

function openInk(anchor: HTMLElement, studio: Studio): void {
  const body = h('div', { class: 'st-ink' });
  const render = (): void => {
    const sw = inkColors(studio).map((c) => h('button', {
      type: 'button', class: `st-swatch${c === studio.color.toLowerCase() ? ' on' : ''}`, style: `--c:${c}`, title: c, 'aria-label': c,
      onclick: () => { studio.setInk({ color: c }); if (!['pen', 'line', 'rect', 'circle'].includes(studio.tool)) studio.setTool('pen'); render(); },
    }));
    const custom = h('input', { type: 'color', class: 'st-color-in', value: studio.color, title: t('studio.tool.custom_color'), 'aria-label': t('studio.tool.custom_color') });
    custom.oninput = () => { studio.setInk({ color: custom.value }); };
    custom.onchange = () => render();
    const widths = WIDTHS.map((w) => h('button', {
      type: 'button', class: `st-width${w === studio.width ? ' on' : ''}`, title: t('studio.tool.width', { n: w }), 'aria-label': t('studio.tool.width', { n: w }),
      onclick: () => { studio.setInk({ width: w }); render(); },
    }, h('span', { style: `height:${Math.max(2, w * 0.7)}px;background:${studio.color}` })));
    body.replaceChildren(
      h('div', { class: 'st-ink-label' }, t('studio.tool.colors')),
      h('div', { class: 'st-swatches' }, ...sw, h('label', { class: 'st-swatch custom', title: t('studio.tool.custom_color') }, custom, sicon('plus'))),
      h('div', { class: 'st-ink-label' }, t('studio.tool.widths')),
      h('div', { class: 'st-widths' }, ...widths));
  };
  render();
  popover(anchor, body, window.innerWidth <= 760 ? { side: 'above', align: 'end', cls: 'st-pop-ink' } : { side: 'right', cls: 'st-pop-ink' });
}
