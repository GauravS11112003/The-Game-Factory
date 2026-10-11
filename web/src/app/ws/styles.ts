/**
 * #/styles — themes (docs/v6/CONTRACTS_V6.md §9). A theme restyles the maker's own strokes (marker, neon, pixel,
 * comic…) and paints the world behind them; no AI art. The gallery shows every preset (shared/studio/themes.json
 * through GET /studio/themes) as a live preview; "Describe a theme" asks the copilot for a new one from a few words.
 * Any theme can go on one of your Studio games or be shared as a block.
 */
import type { StudioTheme } from '../../core/types.gen.ts';
import { h, toast } from '../dom.ts';
import { ensurePlayer } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { loadThemes, studioApi } from '../studio_api.ts';
import { v4 } from '../v4api.ts';
import { themePreview } from '../../studio/editor/theme_preview.ts';
import { pickStudioGame } from './pick_game.ts';
import { btn, enc } from './ui.ts';

async function useOnGame(theme: StudioTheme): Promise<void> {
  const g = await pickStudioGame(t('styles6.pick_game'), t('styles6.pick_game_help', { name: kidText(theme.name ?? '') }));
  if (!g) return;
  try {
    const doc = await studioApi.game(g.id);
    doc.theme = theme;
    await studioApi.saveGame(doc);
    toast(t('styles6.applied', { name: kidText(theme.name ?? ''), game: kidText(g.title || t('ui.untitled')) }), {
      ms: 7000, action: { label: t('blocks.open_game'), run: () => navigate(`#/studio/${enc(g.id)}`) },
    });
  } catch {
    toast(t('styles6.failed'));
  }
}

async function share(theme: StudioTheme): Promise<void> {
  try {
    await ensurePlayer();
    await v4.createBlock({ name: (theme.name ?? 'Theme').slice(0, 40), kind: 'theme', theme, description: null } as never);
    toast(t('styles6.shared', { name: kidText(theme.name ?? '') }));
  } catch {
    toast(t('styles6.failed'));
  }
}

function themeCard(theme: StudioTheme, fresh = false): HTMLElement {
  return h('div', { class: `th-card${fresh ? ' fresh' : ''}` },
    h('div', { class: 'th-pic' }, themePreview(theme, 320, 180)),
    h('div', { class: 'th-body' },
      h('div', { class: 'th-head' },
        h('span', { class: 'th-name' }, kidText(theme.name ?? '')),
        h('span', { class: 'th-tags' }, t(`styles6.stroke_${theme.stroke?.style ?? 'marker'}`))),
      h('div', { class: 'row wrap' },
        btn(t('styles6.use'), { cls: 'small primary', icon: 'plus', onclick: () => void useOnGame(theme) }),
        btn(t('styles6.share'), { cls: 'small quiet', onclick: () => void share(theme) }))));
}

export function stylesScreen(root: HTMLElement): () => void {
  let disposed = false;
  const grid = h('div', { class: 'th-grid' }, h('p', { class: 'muted' }, t('ws.loading')));
  const madeBox = h('div', { class: 'th-made' });
  const input = h('input', { type: 'text', class: 'w-input th-in', maxLength: 300, placeholder: t('styles6.describe_placeholder'), 'aria-label': t('styles6.describe') });
  const go = h('button', { type: 'submit', class: 'pill primary' }, t('styles6.make'));
  const form = h('form', { class: 'th-form' }, input, go);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    go.disabled = true;
    madeBox.replaceChildren(h('p', { class: 'muted' }, t('styles6.making')));
    try {
      const r = await studioApi.theme({ text });
      if (disposed) return;
      madeBox.replaceChildren(themeCard(r.theme, true));
    } catch {
      if (!disposed) madeBox.replaceChildren(h('p', { class: 'muted' }, t('styles6.failed')));
    } finally {
      go.disabled = false;
    }
  };

  root.append(h('div', { class: 'w-page th-page' },
    h('div', { class: 'w-head' },
      h('div', { class: 'w-head-text' },
        h('h1', { class: 'w-h1' }, t('styles6.title')),
        h('p', { class: 'w-sub' }, t('styles6.sub')))),
    h('section', { class: 'th-describe' }, h('h2', { class: 'w-h4' }, t('styles6.describe')), form, madeBox),
    h('section', null, h('h2', { class: 'w-h4' }, t('styles6.presets')), grid)));

  void loadThemes().then((themes) => {
    if (disposed) return;
    grid.replaceChildren(...themes.map((th) => themeCard(th)));
  });
  return () => {
    disposed = true;
  };
}
