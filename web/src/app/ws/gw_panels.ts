/**
 * The workspace's Legend, Blocks, Style and Bot tabs (lane D, docs/v4/CONTRACTS_V4.md §7).
 * - Legend: the marker colours, then every library type with a paper symbol (symbol, letter, name, what it does);
 *   types without one get "Add a symbol" (three small cells → a new version of the type).
 * - Blocks: the game's library types (blocks added from the public library carry a `block` ref), with the ways to add.
 * - Style: the game book's style picture and words, and the paper theme (GameRules.theme).
 * - Bot: the chosen level's design report: verdict, band, the designer's note and every flag with its sentence.
 */
import type { InkColor, LibraryType, Theme } from '../../core/types.gen.ts';
import { api } from '../api.ts';
import { verdictEl } from '../collab/ui.ts';
import { h, toast } from '../dom.ts';
import { kidText, t, tRef } from '../messages.ts';
import { store } from '../store.ts';
import { typeDoes, typeThumb } from '../screens/library.ts';
import { THEME_PAPER, THEMES } from '../screens/rules.ts';
import { openPdf } from '../screens/scan.ts';
import { openCreatureStudio, symbolCells } from '../../editor/creature.ts';
import { INK } from '../../editor/paint.ts';
import type { GwCtx } from './gw_ctx.ts';
import { designPill, flagRef } from './model.ts';
import { btn, calm, chip, dialog, emptyState, enc, inkThumb, note, statusChip } from './ui.ts';

const COLORS: InkColor[] = ['black', 'red', 'green', 'blue'];

function typeRow(lt: LibraryType, lead: HTMLElement, action: HTMLElement | ''): HTMLElement {
  return h('div', { class: 'gw-type' }, lead,
    h('div', { style: { minWidth: '0' } },
      h('div', { class: 'gw-type-name' }, h('span', { class: 'gw-letter', title: t('creature.letter', { letter: lt.letter }) }, lt.letter), kidText(lt.name)),
      h('div', { class: 'small muted' }, typeDoes(lt)),
      lt.block ? chip(t('gw.from_blocks'), 'pub') : ''),
    action);
}

// ---- Legend ------------------------------------------------------------------------------------------------------------

export function legendPanel(ctx: GwCtx, panel: HTMLElement): void {
  const lib = ctx.library().slice().sort((a, b) => a.name.localeCompare(b.name));
  const withSym = lib.filter((x) => x.symbol);
  const without = lib.filter((x) => !x.symbol && x.kind !== 'player');
  const redraw = (): void => {
    panel.replaceChildren();
    legendPanel(ctx, panel);
  };
  panel.append(
    h('h3', { class: 'w-h4' }, t('legend.colors')),
    h('div', { class: 'gw-colors' }, ...COLORS.map((c) => h('span', null, h('span', { class: 'gw-dot', style: { background: INK[c] }, 'aria-hidden': 'true' }), t(`color.${c}`)))),
    h('h3', { class: 'w-h4' }, t('legend.symbols')),
    h('p', { class: 'small muted' }, t('legend.help')),
    withSym.length
      ? h('div', { class: 'gw-types' }, ...withSym.map((lt) => {
        const sym = inkThumb(lt.symbol!.samples[0], 56, 48);
        sym.setAttribute('aria-label', t('legend.symbol_of', { name: kidText(lt.name) }));
        return typeRow(lt, sym, '');
      }))
      : note(t('legend.none')),
    without.length ? h('h3', { class: 'w-h4' }, t('legend.no_symbol')) : '',
    without.length ? h('div', { class: 'gw-types' }, ...without.map((lt) => typeRow(lt, typeThumb(lt, 56, 48),
      btn(t('legend.add'), { cls: 'small', icon: 'pencil', onclick: () => addSymbol(ctx, lt, redraw) })))) : '',
    lib.length ? '' : emptyState(t('legend.empty'), btn(t('gw.blocks_add'), { href: `#/blocks?game=${enc(ctx.game.id)}`, cls: 'small' })),
    h('div', { class: 'row wrap', style: { marginTop: '12px' } },
      btn(t('library.print'), { cls: 'small', icon: 'rules', onclick: () => void openPdf(`/api/v2/templates/library.pdf?game=${enc(ctx.game.id)}`) })));
}

/** Draw a type's symbol three times, then save it as the type's next version. */
function addSymbol(ctx: GwCtx, lt: LibraryType, done: () => void): void {
  const cells = symbolCells({ bare: true });
  const status = h('p', { class: 'small muted', role: 'status' });
  const save = btn(t('legend.save'), { cls: 'primary', icon: 'check' }) as HTMLButtonElement;
  const d = dialog(t('legend.add_title', { name: kidText(lt.name) }), h('div', { class: 'bs-draw' },
    h('p', { class: 'w-sub' }, t('legend.add_help')), cells.el, status, h('div', { class: 'bs-actions' }, save)));
  save.onclick = async () => {
    const symbol = cells.value();
    if (!symbol) {
      status.textContent = t('creature.symbol_more', { n: 3 - cells.filled() });
      return;
    }
    save.disabled = true;
    status.textContent = t('ui.saving');
    const next: LibraryType = { ...lt, version: lt.version + 1, symbol, author: store.author() || lt.author || t('ui.someone'), created_at: new Date().toISOString() };
    try {
      const saved = await api.newLibraryVersion(ctx.game.id, next);
      const out: LibraryType = saved && typeof saved === 'object' && 'id' in saved ? { ...next, ...saved } : next;
      if (ctx.gone()) return;
      ctx.setLibrary([...ctx.library().filter((x) => x.id !== lt.id), out]);
      d.close();
      toast(t('legend.saved', { name: kidText(lt.name) }));
      done();
    } catch (e) {
      status.textContent = calm(e);
      save.disabled = false;
    }
  };
}

// ---- Blocks ------------------------------------------------------------------------------------------------------------

export function blocksPanel(ctx: GwCtx, panel: HTMLElement): void {
  const gid = enc(ctx.game.id);
  const lib = ctx.library().filter((x) => x.kind !== 'player').sort((a, b) => a.name.localeCompare(b.name));
  const make = (): void => {
    openCreatureStudio({
      gameId: ctx.game.id, library: ctx.library(),
      onSaved: (lt) => {
        ctx.setLibrary([...ctx.library().filter((x) => x.id !== lt.id), lt]);
        panel.replaceChildren();
        blocksPanel(ctx, panel);
      },
    });
  };
  panel.append(
    h('p', { class: 'small muted' }, t('gw.blocks_help')),
    h('div', { class: 'row wrap' },
      btn(t('gw.blocks_add'), { href: `#/blocks?game=${gid}`, icon: 'plus', cls: 'primary small' }),
      btn(t('gw.blocks_make'), { href: `#/blocks/new?game=${gid}`, icon: 'pencil', cls: 'small' }),
      btn(t('library.make'), { onclick: make, icon: 'star', cls: 'small' })),
    h('h3', { class: 'w-h4' }, t('gw.blocks_in_game', { n: lib.length })),
    lib.length
      ? h('div', { class: 'gw-types' }, ...lib.map((lt) => typeRow(lt, typeThumb(lt, 56, 48),
        btn(t('library.use'), { href: `#/draw?game=${gid}&stamp=${enc(lt.id)}`, cls: 'small', icon: 'stamp' }))))
      : emptyState(t('gw.blocks_empty')),
    h('div', { class: 'row wrap', style: { marginTop: '12px' } }, btn(t('gw.blocks_library_page'), { href: `#/game/${gid}/library`, cls: 'small quiet' })));
}

// ---- Style -------------------------------------------------------------------------------------------------------------

export function stylePanel(ctx: GwCtx, panel: HTMLElement): void {
  const bible = ctx.team?.bible ?? null;
  const status = h('p', { class: 'small muted', role: 'status' });
  const themes = h('div', { class: 'gw-themes', role: 'group', 'aria-label': t('gw.style_paper') });
  const renderThemes = (): void => {
    const cur: Theme = ctx.rules().theme ?? 'sketchbook';
    themes.replaceChildren(...THEMES.map((th) => h('button', {
      type: 'button', class: `gw-theme${th === cur ? ' on' : ''}`, 'aria-pressed': String(th === cur),
      onclick: () => void setTheme(th),
    }, h('span', { class: 'gw-theme-swatch', style: { background: THEME_PAPER[th].css }, 'aria-hidden': 'true' }), t(`theme.${th}`))));
  };
  async function setTheme(th: Theme): Promise<void> {
    if ((ctx.rules().theme ?? 'sketchbook') === th) return;
    status.textContent = t('ui.saving');
    try {
      const next = { ...ctx.rules(), theme: th };
      const r = await api.putRules(ctx.game.id, next);
      if (ctx.gone()) return;
      ctx.setRules(r.rules ?? next);
      status.textContent = '';
      renderThemes();
      toast(t('gw.style_theme_saved', { theme: t(`theme.${th}`) }));
    } catch (e) {
      status.textContent = calm(e);
    }
  }
  renderThemes();
  panel.append(
    h('h3', { class: 'w-h4' }, t('collab.bible.style')),
    bible?.style_image_url
      ? h('img', { class: 'gw-style-img', src: bible.style_image_url, alt: t('collab.bible.style') })
      : emptyState(t('collab.bible.no_style')),
    bible?.style_prompt ? h('p', { class: 'small' }, '“', kidText(bible.style_prompt), '”') : '',
    h('div', { class: 'row wrap' },
      btn(t('gw.style_change'), { href: `#/bible/${enc(ctx.game.id)}`, cls: 'small', icon: 'pencil' }),
      btn(t('gw.style_all'), { href: '#/styles', cls: 'small quiet' })),
    h('h3', { class: 'w-h4' }, t('gw.style_paper')),
    themes, status,
    note(t('gw.style_paper_help')));
}

// ---- Bot ---------------------------------------------------------------------------------------------------------------

export function botPanel(ctx: GwCtx, panel: HTMLElement): void {
  const card = ctx.levelCard();
  if (!card) {
    panel.append(emptyState(t('gw.bot_no_level')));
    return;
  }
  const level = ctx.level();
  const d = level?.design ?? null;
  panel.append(h('div', { class: 'row between wrap' },
    h('strong', null, kidText(card.title || t('ui.untitled'))), statusChip(level)));
  if (!level) {
    panel.append(note(t('ui.loading')));
    return;
  }
  panel.append(verdictEl(level));
  if (!d) {
    panel.append(h('p', { class: 'w-note' }, t('gw.bot_unchecked')));
    return;
  }
  panel.append(h('p', { class: 'small' }, designPill(d)));
  if (d.designer_note) panel.append(h('p', { class: 'small w-note' }, kidText(d.designer_note)));
  const flags = d.flags.slice().sort((a, b) => rank(a.severity) - rank(b.severity));
  panel.append(h('h3', { class: 'w-h4' }, t('gw.bot_flags', { n: flags.length })),
    flags.length
      ? h('ul', { class: 'gw-flags' }, ...flags.map((f) => h('li', null,
        chip(f.severity === 'block' || f.severity === 'hard' ? t('gw.flag_fix') : t('gw.flag_note'), f.severity === 'block' || f.severity === 'hard' ? 'fix' : 'plain'),
        h('span', null, tRef(flagRef(f))))))
      : h('p', { class: 'w-note ok' }, t('gw.bot_clean')),
    h('div', { class: 'row wrap', style: { marginTop: '10px' } },
      btn(t('ui.play'), { href: `#/play/${enc(card.id)}`, icon: 'play', cls: 'small' }),
      btn(t('gw.level_remix'), { href: `#/draw?remix=${enc(card.id)}`, icon: 'remix', cls: 'small' })));
}

function rank(s: string): number {
  return ['block', 'hard', 'warn', 'info', 'target'].indexOf(s);
}
