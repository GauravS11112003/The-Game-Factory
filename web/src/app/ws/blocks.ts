/**
 * #/blocks — the public blocks library (docs/v4/CONTRACTS_V4.md §6, §7). Search, kind chips, newest or most used,
 * a grid of block cards (the maker's own ink, name, author, uses, kind, what it does) and a detail panel: what the
 * block is made of (behaviour and rule cards), its versions and uses, "Add to a game" (straight to ?game=<id> when the
 * page was opened from a game, else a game picker) → POST /games/{id}/blocks, and "Remix" → #/blocks/new?from=<id>.
 * `?open=<id>` opens a block's panel (kept in the URL). Until lane C serves the routes, a calm "not open yet".
 */
import type { BlockCard, BlockKind } from '../../core/types.gen.ts';
import { api } from '../api.ts';
import { h, icon, toast } from '../dom.ts';
import { currentPlayer, ensurePlayer } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { navigate, parseHash } from '../router.ts';
import { v4, type BlockSort } from '../v4api.ts';
import { ruleCard } from './logic.ts';
import { pickGame, type MyGame } from './pick_game.ts';
import { BLOCK_KINDS, blockDoes, filterBlocks, sortBlocks } from './model.ts';
import { btn, calm, chip, emptyState, enc, iconBtn, inkThumb, note, notReady, pickRow } from './ui.ts';
import { renderDrawing } from '../../studio/theme/render.ts';
import type { StudioTheme } from '../../core/types.gen.ts';

const PAGE = 24;

/** A block's art (its own ink), or its first letter on paper when it has none (a rules-only block). */
export function blockArt(b: Pick<BlockCard, 'name' | 'art' | 'object' | 'theme'>, w = 180, hgt = 128): HTMLElement {
  if (b.object?.drawing?.strokes?.length) return h('div', { class: 'bk-art bk-art-studio' }, fitCanvas(renderDrawing(b.object.drawing, null), w, hgt, kidText(b.name)));
  if (b.theme) return h('div', { class: 'bk-art bk-art-studio' }, themeSwatch(b.theme, w, hgt));
  if (b.art?.strokes.length) {
    const c = inkThumb(b.art.strokes, w, hgt);
    c.setAttribute('aria-label', kidText(b.name));
    return h('div', { class: 'bk-art' }, c);
  }
  return h('div', { class: 'bk-art', 'aria-hidden': 'true' }, h('span', { class: 'bk-art-empty' }, (b.name.trim()[0] ?? '?').toUpperCase()));
}

/** A Studio drawing scaled to fit a w × h card (v6 object blocks). */
function fitCanvas(src: HTMLCanvasElement, w: number, hgt: number, label: string): HTMLCanvasElement {
  const c = h('canvas', { class: 'w-ink-thumb', width: w * 2, height: hgt * 2, role: 'img', 'aria-label': label });
  c.style.width = `${w}px`;
  c.style.height = `${hgt}px`;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#FBF6EA';
    ctx.fillRect(0, 0, c.width, c.height);
    const k = Math.min((c.width * 0.8) / src.width, (c.height * 0.8) / src.height, 3);
    ctx.drawImage(src, (c.width - src.width * k) / 2, (c.height - src.height * k) / 2, src.width * k, src.height * k);
  }
  return c;
}

/** A theme block's card: its background colour with the palette as dots and its name in the theme's ink. */
function themeSwatch(th: StudioTheme, w: number, hgt: number): HTMLElement {
  const p = th.palette ?? {};
  const dots = ['ink', 'accent', 'accent2', 'good', 'danger'].map((k) => p[k]).filter(Boolean) as string[];
  return h('div', { class: 'bk-theme', style: `width:${w}px;height:${hgt}px;background:${p.bg ?? th.background?.colors?.[0] ?? '#f6f1e7'};color:${p.ink ?? '#1f1b18'}` },
    h('span', { class: 'bk-theme-name' }, kidText(th.name ?? '')),
    h('span', { class: 'bk-theme-dots' }, ...dots.map((c) => h('span', { style: `background:${c}` }))));
}

export function usesText(n: number | undefined): string {
  return n === 1 ? t('blocks.uses_one') : t('blocks.uses_n', { n: n ?? 0 });
}

/** Put a block in a game (a new library type and/or game-wide rules), then offer to open the game. */
export async function addBlockTo(b: BlockCard, g: { id: string; title: string }): Promise<boolean> {
  try {
    await ensurePlayer();
  } catch {
    return false;
  }
  try {
    await v4.useBlock(g.id, { block_id: b.id, version: b.version });
    toast(t('blocks.added', { name: kidText(b.name), game: kidText(g.title || t('ui.untitled')) }), {
      ms: 7000, action: { label: t('blocks.open_game'), run: () => navigate(`#/game/${enc(g.id)}?tab=blocks`) },
    });
    return true;
  } catch (e) {
    toast(calm(e, 'blocks.not_ready'));
    return false;
  }
}

export function blocksScreen(root: HTMLElement, query: URLSearchParams): () => void {
  let disposed = false;
  const gameId = query.get('game');
  let game: { id: string; title: string } | null = gameId ? { id: gameId, title: '' } : null;
  let q = query.get('q') ?? '';
  let kind: BlockKind | null = null;
  let sort: BlockSort = query.get('sort') === 'popular' ? 'popular' : 'new';
  let blocks: BlockCard[] = [];
  let total = 0;
  let openId: string | null = query.get('open');
  let seq = 0;

  const withGame = (href: string): string => (gameId ? `${href}${href.includes('?') ? '&' : '?'}game=${enc(gameId)}` : href);
  const search = h('input', { type: 'search', value: q, maxLength: 80, placeholder: t('blocks.search_placeholder'), 'aria-label': t('blocks.search') });
  const kinds = h('div');
  const sorts = h('div');
  const grid = h('div', { class: 'bk-grid', 'aria-live': 'polite' });
  const more = h('div', { class: 'bk-more' });
  const detail = h('aside', { class: 'bk-detail w-card hidden', 'aria-label': t('blocks.detail') });
  const layout = h('div', { class: 'bk-layout closed' }, h('div', null, grid, more), detail);
  const banner = h('div');

  root.append(h('div', { class: 'w-page bk-page' },
    h('div', { class: 'w-head' },
      h('div', { class: 'w-head-text' },
        h('h1', { class: 'w-h1' }, t('blocks.title')),
        h('p', { class: 'w-sub' }, t('blocks.sub'))),
      btn(t('blocks.make'), { href: withGame('#/blocks/new'), icon: 'plus', cls: 'primary' })),
    banner,
    h('div', { class: 'bk-tools' }, h('label', { class: 'bk-search' }, icon('search'), search), sorts),
    kinds,
    layout));

  function renderBanner(): void {
    banner.replaceChildren(game ? h('div', { class: 'w-note bk-banner' },
      h('span', null, t('blocks.for_game', { game: kidText(game.title || t('ui.untitled')) })),
      btn(t('blocks.back_to_game'), { href: `#/game/${enc(game.id)}?tab=blocks`, cls: 'small' })) : '');
  }

  function renderFilters(): void {
    kinds.replaceChildren(h('div', { style: { marginBottom: '14px' } },
      pickRow<'all' | BlockKind>(['all', ...BLOCK_KINDS], kind ?? 'all', (k) => (k === 'all' ? t('blocks.kind_all') : t(`blocks.kind_${k}`)),
        (k) => { kind = k === 'all' ? null : k; renderFilters(); void load(true); }, { name: t('blocks.kind_filter') })));
    sorts.replaceChildren(pickRow<BlockSort>(['new', 'popular'], sort, (s) => t(`blocks.sort_${s}`),
      (s) => { sort = s; renderFilters(); void load(true); }, { name: t('blocks.sort') }));
  }

  function keepUrl(): void {
    const { path, query: qq } = parseHash();
    if (openId) qq.set('open', openId);
    else qq.delete('open');
    const s = qq.toString();
    try {
      history.replaceState(null, '', `#/${path.map(enc).join('/')}${s ? `?${s}` : ''}`);
    } catch {
      /* ignore */
    }
  }

  async function load(reset: boolean): Promise<void> {
    const my = ++seq;
    if (reset) {
      grid.replaceChildren(note(t('ui.loading')));
      more.replaceChildren();
    }
    try {
      const r = await v4.blocks({ q: q.trim() || undefined, kind, sort, limit: PAGE, offset: reset ? 0 : blocks.length });
      if (disposed || my !== seq) return;
      const page = sortBlocks(filterBlocks(r.blocks ?? [], { q, kind }), sort);
      blocks = reset ? page : [...blocks, ...page.filter((b) => !blocks.some((x) => x.id === b.id))];
      total = Math.max(r.total ?? 0, blocks.length);
    } catch (e) {
      if (disposed || my !== seq) return;
      grid.replaceChildren(emptyState(notReady(e) ? t('blocks.not_ready') : calm(e)));
      more.replaceChildren(btn(t('blocks.retry'), { cls: 'small', icon: 'retry', onclick: () => void load(true) }));
      return;
    }
    renderGrid();
  }

  function renderGrid(): void {
    if (!blocks.length) {
      grid.replaceChildren(q.trim() || kind
        ? emptyState(t('blocks.empty_search'))
        : emptyState(t('blocks.empty'), btn(t('blocks.make'), { href: withGame('#/blocks/new'), icon: 'plus', cls: 'primary small' })));
      more.replaceChildren();
      return;
    }
    grid.replaceChildren(...blocks.map((b) => h('button', {
      type: 'button', class: 'bk-card', 'aria-current': String(b.id === openId), onclick: () => open(b),
    },
    blockArt(b),
    h('span', { class: 'bk-name' }, kidText(b.name)),
    h('span', { class: 'bk-meta' }, chip(t(`blocks.kind_${b.kind}`), 'kind'), t('blocks.by', { author: b.author || t('ui.someone') })),
    h('span', { class: 'bk-does' }, blockDoes(b)),
    h('span', { class: 'bk-meta' }, usesText(b.uses)))));
    more.replaceChildren(blocks.length < total ? btn(t('blocks.more'), { cls: 'small', onclick: () => void load(false) }) : '');
  }

  // ---- the detail panel ----
  function open(b: BlockCard): void {
    openId = b.id;
    keepUrl();
    renderGrid();
    renderDetail(b, true);
    // the newest card from the server (versions, uses), unless another block was opened meanwhile
    v4.block(b.id).then((full) => {
      if (!disposed && openId === b.id) renderDetail({ ...b, ...full }, false);
    }, () => undefined);
  }

  function close(): void {
    openId = null;
    keepUrl();
    detail.classList.add('hidden');
    layout.classList.add('closed');
    renderGrid();
  }

  function renderDetail(b: BlockCard, focus: boolean): void {
    const me = currentPlayer();
    const mine = !!me && !!b.author_id && b.author_id === me.id;
    const versions = Math.max(b.versions ?? 1, b.version);
    const versionPick = versions > 1 ? h('select', {
      class: 'w-input', 'aria-label': t('blocks.version_pick'),
      onchange: (e: Event) => {
        const v = Number((e.target as HTMLSelectElement).value);
        v4.block(b.id, v).then((x) => { if (!disposed && openId === b.id) renderDetail({ ...b, ...x, versions }, false); }, (err) => toast(calm(err, 'blocks.not_ready')));
      },
    }, ...Array.from({ length: versions }, (_, i) => versions - i).map((v) => h('option', { value: String(v), selected: v === b.version }, t('blocks.version_n', { v })))) : '';
    const addBtn = btn(game ? t('blocks.add_to', { game: kidText(game.title || t('ui.untitled')) }) : t('blocks.add_to_game'), {
      cls: 'primary', icon: 'plus',
      onclick: async (e) => {
        const el = e.currentTarget as HTMLButtonElement;
        const g: MyGame | { id: string; title: string } | null = game ?? await pickGame(t('blocks.pick_game'), t('blocks.pick_game_help', { name: kidText(b.name) }));
        if (!g || disposed) return;
        el.disabled = true;
        await addBlockTo(b, g);
        el.disabled = false;
      },
    });
    detail.replaceChildren(
      h('div', { class: 'bk-detail-head' },
        h('div', null, h('h2', { class: 'w-h2' }, kidText(b.name)),
          h('p', { class: 'w-sub small' }, t('blocks.by', { author: b.author || t('ui.someone') }), ' · ', usesText(b.uses))),
        iconBtn('close', t('ui.close'), close)),
      blockArt(b, 320, 240),
      h('div', { class: 'row wrap', style: { margin: '10px 0' } },
        chip(t(`blocks.kind_${b.kind}`), 'kind'),
        chip(t('blocks.version_of', { v: b.version, n: versions }), 'plain'),
        b.collision && b.kind !== 'rules' ? chip(t(`blocks.collision_${b.collision}`), 'plain') : '',
        b.spiky ? chip(t('creature.spiky_short'), 'fix') : ''),
      versionPick,
      b.description ? h('p', null, kidText(b.description)) : '',
      b.tags?.length ? h('div', { class: 'bk-tags' }, ...b.tags.map((x) => chip(`#${kidText(x)}`, 'plain'))) : '',
      h('h3', { class: 'w-h4' }, t('blocks.made_of')),
      h('p', { class: 'small' }, blockDoes(b)),
      b.logic?.length ? h('div', { class: 'w-rule-cards' }, ...b.logic.map((r) => ruleCard(r))) : '',
      b.symbol ? h('div', null, h('h3', { class: 'w-h4' }, t('blocks.symbol')), inkThumb(b.symbol.samples[0], 64, 56)) : '',
      b.parent ? h('p', { class: 'small muted' }, t('blocks.remix_of'), ' ', h('a', { href: `#/blocks?open=${enc(b.parent.block_id)}` }, t('blocks.see_original'))) : '',
      h('div', { class: 'row wrap', style: { marginTop: '12px' } },
        addBtn,
        btn(t('blocks.remix'), { href: withGame(`#/blocks/new?from=${enc(b.id)}`), icon: 'remix' }),
        mine ? btn(t('blocks.change'), { href: withGame(`#/blocks/${enc(b.id)}`), icon: 'pencil' }) : ''));
    detail.classList.remove('hidden');
    layout.classList.remove('closed');
    if (focus) {
      window.setTimeout(() => {
        detail.querySelector<HTMLElement>('.w-icon-btn')?.focus({ preventScroll: true });
        // narrow pages show the panel above the grid: bring it into view
        if (getComputedStyle(detail).position === 'static') detail.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 0);
    }
  }

  // ---- wiring ----
  let timer = 0;
  search.oninput = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      q = search.value;
      void load(true);
    }, 300);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && openId && !document.querySelector('.w-dialog-back')) close();
  };
  window.addEventListener('keydown', onKey);

  renderBanner();
  renderFilters();
  void load(true);
  if (gameId) {
    api.game(gameId).then((g) => {
      if (disposed) return;
      game = { id: g.id, title: g.title };
      renderBanner();
      if (openId) {
        const b = blocks.find((x) => x.id === openId);
        if (b) renderDetail(b, false);
      }
    }, () => undefined);
  }
  if (openId) {
    const id = openId;
    v4.block(id).then((b) => {
      if (disposed || openId !== id) return;
      renderDetail(b, false);
      renderGrid();
    }, () => undefined);
  }

  return () => {
    disposed = true;
    window.clearTimeout(timer);
    window.removeEventListener('keydown', onKey);
  };
}
