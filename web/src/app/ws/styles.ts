/**
 * #/styles — the game styles the player can apply (lane D). A style is a game's look: its style picture (the game
 * book's, made with the creative style API from words or a picture) and its paper theme. Your games' styles are
 * listed; "Use on another game" makes the same style for a game you pick (from the words when there are some, else
 * from the picture) and records it in that game's book. Paper themes apply through the game's rules.
 * A calm empty state when none of your games has a style yet.
 */
import type { Theme } from '../../core/types.gen.ts';
import { api } from '../api.ts';
import { collab, type Bible } from '../collab/api.ts';
import { h, toast } from '../dom.ts';
import { currentPlayer, ensurePlayer } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { THEME_PAPER, THEMES } from '../screens/rules.ts';
import { withDefaults } from './gw_ctx.ts';
import { myGames, pickGame, type MyGame } from './pick_game.ts';
import { btn, calm, emptyState, enc, note } from './ui.ts';

/** Make `src`'s style for `target` and keep it in the target's game book (its other book fields stay as they were). */
async function applyStyle(src: Bible, target: MyGame): Promise<void> {
  let made: { style_id: string; image_url: string | null };
  if (src.style_prompt) made = await collab.styleFromText(target.id, src.style_prompt);
  else {
    const r = await fetch(src.style_image_url ?? '');
    made = await collab.styleFromImage(target.id, await r.blob());
  }
  const tb = await collab.bible(target.id).catch(() => null);
  await collab.putBible(target.id, {
    pitch: tb?.pitch ?? '', mechanics_text: tb?.mechanics_text ?? '', starter_type_ids: tb?.starter_type_ids ?? [], open_for: tb?.open_for ?? 'everyone',
    style_id: made.style_id || null, style_prompt: src.style_prompt,
  });
}

export function stylesScreen(root: HTMLElement): () => void {
  let disposed = false;
  const list = h('div', { class: 'st-grid', 'aria-live': 'polite' }, note(t('ui.loading'), 'muted'));
  const themes = h('div', { class: 'st-grid' });

  root.append(h('div', { class: 'w-page st-page' },
    h('div', { class: 'w-head' },
      h('div', { class: 'w-head-text' },
        h('h1', { class: 'w-h1' }, t('gw.st.styles_title')),
        h('p', { class: 'w-sub' }, t('gw.st.styles_sub')))),
    h('section', { 'aria-labelledby': 'st-styles-h' }, h('h2', { id: 'st-styles-h', class: 'w-h4' }, t('gw.st.your_styles')), list),
    h('section', { class: 'w-section', 'aria-labelledby': 'st-themes-h' },
      h('h2', { id: 'st-themes-h', class: 'w-h4' }, t('gw.st.themes')),
      h('p', { class: 'small muted' }, t('gw.st.themes_help')),
      themes)));

  // ---- paper themes: pick a game, its rules get the theme ----
  themes.append(...THEMES.map((th) => h('div', { class: 'st-card st-theme' },
    h('div', { class: 'st-pic', style: { background: THEME_PAPER[th].css }, 'aria-hidden': 'true' }),
    h('span', { class: 'st-title' }, t(`theme.${th}`)),
    h('div', null, btn(t('gw.st.use_on_game'), { cls: 'small', onclick: () => void useTheme(th) })))));

  async function useTheme(th: Theme): Promise<void> {
    const g = await pickGame(t('gw.st.pick_game'), t('gw.st.theme_pick_help', { theme: t(`theme.${th}`) }));
    if (!g || disposed) return;
    try {
      const cur = withDefaults(await api.rules(g.id).catch(() => null));
      await api.putRules(g.id, { ...cur, theme: th });
      toast(t('gw.st.theme_done', { theme: t(`theme.${th}`), game: kidText(g.title || t('ui.untitled')) }));
    } catch (e) {
      toast(calm(e));
    }
  }

  // ---- your games' styles ----
  void (async () => {
    if (!currentPlayer()) {
      list.replaceChildren(emptyState(t('gw.st.need_player'), btn(t('studio4.who'), {
        cls: 'small primary', icon: 'person', onclick: () => void ensurePlayer().then(() => navigate(location.hash), () => undefined),
      })));
      return;
    }
    const games = await myGames();
    const books = await Promise.all(games.map((g) => collab.bible(g.id).catch(() => null)));
    if (disposed) return;
    const styled = games.map((g, i) => ({ g, b: books[i] })).filter((x): x is { g: MyGame; b: Bible } => !!x.b && !!(x.b.style_image_url || x.b.style_prompt));
    if (!styled.length) {
      list.replaceChildren(emptyState(t('gw.st.styles_empty'), games[0] ? btn(t('gw.st.make_style'), { href: `#/bible/${enc(games[0].id)}`, cls: 'small primary' }) : btn(t('nav.new_game'), { href: '#/new', cls: 'small primary' })));
      return;
    }
    list.replaceChildren(...styled.map(({ g, b }) => h('div', { class: 'st-card' },
      b.style_image_url ? h('img', { class: 'st-pic', src: b.style_image_url, alt: t('gw.st.style_of', { game: kidText(g.title || t('ui.untitled')) }), loading: 'lazy' })
        : h('div', { class: 'st-pic' }, h('span', { class: 'small' }, '“', kidText(b.style_prompt ?? ''), '”')),
      h('a', { class: 'st-title', href: `#/game/${enc(g.id)}?tab=style` }, kidText(g.title || t('ui.untitled'))),
      b.style_prompt && b.style_image_url ? h('span', { class: 'small muted' }, '“', kidText(b.style_prompt), '”') : '',
      h('div', { class: 'row wrap' },
        btn(t('gw.st.use_on_other'), {
          cls: 'small', onclick: async (e) => {
            const el = e.currentTarget as HTMLButtonElement;
            const target = await pickGame(t('gw.st.pick_game'), t('gw.st.style_pick_help'));
            if (!target || disposed) return;
            el.disabled = true;
            const close = toast(t('gw.st.style_working'), { ms: 60_000 });
            try {
              await applyStyle(b, target);
              toast(t('gw.st.style_done', { game: kidText(target.title || t('ui.untitled')) }));
            } catch (err) {
              toast(calm(err));
            } finally {
              close();
              el.disabled = false;
            }
          },
        }),
        btn(t('gw.style_change'), { href: `#/bible/${enc(g.id)}`, cls: 'small quiet' })))));
  })();

  return () => {
    disposed = true;
  };
}
