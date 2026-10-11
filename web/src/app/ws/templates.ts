/**
 * #/templates — start from a template (lane D, docs/v4/CONTRACTS_V4.md §7): a small gallery of starting points per
 * game mode (each opens "Tell me a level" with words and a mode filled in, or a blank page), plus the printable sheets
 * (a level pack, the rules sheet and the library sheet of one of your games). `?game=<id>` keeps the game.
 */
import type { GameMode } from '../../core/types.gen.ts';
import { h, icon } from '../dom.ts';
import { t } from '../messages.ts';
import { parseHash } from '../router.ts';
import { openPdf } from '../screens/scan.ts';
import { pickGame } from './pick_game.ts';
import { btn, enc, modeName } from './ui.ts';

interface Template {
  id: string;
  mode: GameMode;
  icon: string;
}

/** Starting points: each has `gw.st.tpl.<id>` (title), `_sub` (one line) and `_text` (the words put in the prompt box). */
export const TEMPLATES: readonly Template[] = [
  { id: 'climb', mode: 'platformer', icon: 'flag' },
  { id: 'flip', mode: 'platformer', icon: 'retry' },
  { id: 'maze', mode: 'topdown', icon: 'grid' },
  { id: 'collect', mode: 'topdown', icon: 'coin' },
  { id: 'rooftops', mode: 'runner', icon: 'next' },
  { id: 'flap', mode: 'flappy', icon: 'drop' },
];

/** The prompt link for a template: its words, its mode, and the game when there is one. */
export function templateHref(tp: Template, gameId: string | null): string {
  const q = new URLSearchParams({ text: t(`gw.st.tpl.${tp.id}_text`), mode: tp.mode });
  if (gameId) q.set('game', gameId);
  return `#/prompt?${q.toString()}`;
}

export function templatesScreen(root: HTMLElement): () => void {
  const gameId = parseHash().query.get('game');
  const withGame = (href: string): string => (gameId ? `${href}${href.includes('?') ? '&' : '?'}game=${enc(gameId)}` : href);
  const sheet = (titleKey: string, helpKey: string, run: () => void): HTMLElement =>
    h('div', { class: 'st-card' },
      h('span', { class: 'st-title' }, t(titleKey)),
      h('span', { class: 'small muted' }, t(helpKey)),
      h('div', null, btn(t('gw.st.print'), { cls: 'small', icon: 'rules', onclick: run })));
  const gameSheet = (kind: 'rules' | 'library'): void => {
    const open = (id: string): void => void openPdf(`/api/v2/templates/${kind}.pdf?game=${enc(id)}`);
    if (gameId) open(gameId);
    else void pickGame(t('gw.st.pick_game'), t('gw.st.pick_game_help')).then((g) => g && open(g.id));
  };

  root.append(h('div', { class: 'w-page st-page' },
    h('div', { class: 'w-head' },
      h('div', { class: 'w-head-text' },
        h('h1', { class: 'w-h1' }, t('gw.st.templates_title')),
        h('p', { class: 'w-sub' }, t('gw.st.templates_sub'))),
      btn(t('gw.st.blank'), { href: withGame('#/draw?new=1'), icon: 'marker' })),
    h('section', { 'aria-labelledby': 'st-start-h' },
      h('h2', { id: 'st-start-h', class: 'w-h4' }, t('gw.st.starting_points')),
      h('div', { class: 'st-grid' }, ...TEMPLATES.map((tp) => h('div', { class: 'st-card st-tpl' },
        h('a', { class: 'st-pic', href: templateHref(tp, gameId), 'aria-label': t(`gw.st.tpl.${tp.id}`), data: { mode: tp.mode } }, icon(tp.icon)),
        h('div', { class: 'row between wrap' }, h('a', { class: 'st-title', href: templateHref(tp, gameId) }, t(`gw.st.tpl.${tp.id}`)), h('span', { class: 'w-chip kind' }, modeName(tp.mode))),
        h('span', { class: 'small muted' }, t(`gw.st.tpl.${tp.id}_sub`)),
        h('div', { class: 'row wrap' },
          btn(t('gw.st.use'), { href: templateHref(tp, gameId), cls: 'small primary', icon: 'pencil' }),
          gameId ? '' : btn(t('gw.st.new_game_as', { mode: modeName(tp.mode) }), { href: `#/new?mode=${tp.mode}`, cls: 'small quiet' })))))),
    h('section', { class: 'w-section', 'aria-labelledby': 'st-print-h' },
      h('h2', { id: 'st-print-h', class: 'w-h4' }, t('gw.st.sheets')),
      h('p', { class: 'small muted' }, t('gw.st.sheets_help')),
      h('div', { class: 'st-sheets' },
        h('div', { class: 'st-card' },
          h('span', { class: 'st-title' }, t('gw.st.sheet_pack')),
          h('span', { class: 'small muted' }, t('gw.st.sheet_pack_help')),
          h('div', null, btn(t('gw.st.print'), { cls: 'small', icon: 'camera', href: withGame('#/scan') }))),
        sheet('gw.st.sheet_rules', 'gw.st.sheet_rules_help', () => gameSheet('rules')),
        sheet('gw.st.sheet_library', 'gw.st.sheet_library_help', () => gameSheet('library'))))));
  return () => {};
}
