/**
 * #/templates — start from a template (docs/v6/CONTRACTS_V6.md §9): the Studio templates (hill climb racer, fighter,
 * shooter, puzzle…) from GET /studio/templates; each opens a new Studio game made from it. A blank canvas is always
 * there, so the page works with no server.
 */
import { h, icon } from '../dom.ts';
import { t } from '../messages.ts';
import { studioCardEl, studioTemplates } from '../studio_cards.ts';
import { btn, enc } from './ui.ts';

export function templatesScreen(root: HTMLElement): () => void {
  let disposed = false;
  const grid = h('div', { class: 'ws-games' }, h('p', { class: 'muted' }, t('ws.loading')));
  root.append(h('div', { class: 'w-page st-page' },
    h('div', { class: 'w-head' },
      h('div', { class: 'w-head-text' },
        h('h1', { class: 'w-h1' }, t('gw.st.templates_title')),
        h('p', { class: 'w-sub' }, t('ws.templates_sub_v6'))),
      btn(t('ws.start_blank'), { href: '#/new?blank=1', icon: 'pencil' })),
    grid));

  void studioTemplates().then((list) => {
    if (disposed) return;
    const real = list.filter((c) => c.id !== 'tpl_blank');
    grid.replaceChildren(...(real.length
      ? real.map((c) => studioCardEl(c, `#/new?template=${enc(c.id)}`))
      : [h('div', { class: 'ws-empty' }, h('p', null, t('ws.templates_none')),
        h('a', { class: 'pill primary small', href: '#/new?blank=1' }, icon('plus'), t('ws.start_blank')))]));
  });
  return () => {
    disposed = true;
  };
}
