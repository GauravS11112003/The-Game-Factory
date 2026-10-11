/**
 * #/new — New game (docs/v6/CONTRACTS_V6.md §6): "What are you making?" (sent to the copilot as the first message once
 * the Studio opens), a template gallery (GET /studio/templates) and "Blank canvas". Creating = POST /studio/games →
 * #/studio/<id>; offline, the game is made on this device and synced later.
 * Query: ?text=<words> prefills the box, ?template=<id> or ?blank=1 create right away, ?tab=templates focuses the gallery.
 */
import '../../studio/studio.css';
import { templateThumb } from '../studio_cards.ts';
import type { GameDoc, StudioGameCard } from '../../core/types.gen.ts';
import { h, toast } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import type { Shell } from '../shell.ts';
import { BLANK_CARD, BLANK_DOC, isOffline, loadTemplates, localGameFrom, localGames, saveDraft, studioApi } from '../studio_api.ts';
import { sicon } from '../../studio/editor/icons.ts';

const KIND_EMOJI: [RegExp, string][] = [
  [/hill|rac|car|drive/, '🚙'], [/fight/, '🥊'], [/space|shoot/, '🚀'], [/platform/, '🍄'], [/puzzle|angry|launch/, '🧩'], [/catch/, '🧺'],
  [/flap/, '🐦'], [/top|collect|zelda/, '🗝️'], [/run/, '🏃'],
];

const emojiFor = (card: StudioGameCard): string => {
  if (card.id === BLANK_CARD.id) return '✏️';
  const s = `${card.kind} ${card.title}`.toLowerCase();
  return KIND_EMOJI.find(([re]) => re.test(s))?.[1] ?? '🎮';
};

const IDEAS = ['studio.new.idea_racer', 'studio.new.idea_fighter', 'studio.new.idea_space', 'studio.new.idea_platformer', 'studio.new.idea_puzzle', 'studio.new.idea_catch'];

function titleFrom(text: string): string | undefined {
  const s = text.trim().replace(/^(a|an|the|make|making|i'?m making|i want)\s+/i, '').replace(/[.!?]+$/, '');
  if (!s || s.length > 40) return undefined;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function newGameScreen(root: HTMLElement, query: URLSearchParams, shell: Shell): () => void {
  let disposed = false;
  let busy = false;

  const input = h('textarea', { class: 'stn-input', rows: 2, maxLength: 2000, placeholder: t('studio.new.placeholder'), 'aria-label': t('studio.new.question') });
  input.value = query.get('text') ?? '';
  const go = h('button', { type: 'submit', class: 'stn-go' }, sicon('sparkle'), h('span', null, t('studio.new.start')));
  const form = h('form', { class: 'stn-ask' }, input, go);
  const status = h('p', { class: 'stn-status', role: 'status' });
  const gallery = h('div', { class: 'stn-gallery', id: 'stn-templates' });
  const localBox = h('div', { class: 'stn-local' });

  async function create(template: string | null, say: string): Promise<void> {
    if (busy) return;
    busy = true;
    go.disabled = true;
    status.textContent = t('studio.new.creating');
    const title = say ? titleFrom(say) : undefined;
    const sayQ = say ? `?say=${encodeURIComponent(say.slice(0, 2000))}` : '';
    try {
      const doc = await studioApi.createGame({ ...(template && template !== BLANK_CARD.id ? { template } : {}), ...(title ? { title } : {}) });
      if (disposed) return;
      shell.noteGame(doc.id, doc.title ?? null);
      navigate(`#/studio/${encodeURIComponent(doc.id)}${sayQ}`);
    } catch (e) {
      if (!isOffline(e)) {
        toast(t('studio.new.failed'));
        status.textContent = '';
        return;
      }
      // offline: make it on this device (the Studio syncs it when the server is back)
      let tpl: GameDoc | null = null;
      if (template && template !== BLANK_CARD.id) tpl = await studioApi.template(template).catch(() => null);
      const local = localGameFrom(tpl ?? BLANK_DOC, title);
      saveDraft(local, false);
      if (disposed) return;
      navigate(`#/studio/${encodeURIComponent(local.id)}${sayQ}`);
    } finally {
      busy = false;
      go.disabled = false;
    }
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    void create(null, text);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  };

  const ideas = h('div', { class: 'stn-ideas' }, ...IDEAS.map((k) => h('button', { type: 'button', class: 'st-suggest', onclick: () => { input.value = t(k); input.focus(); } }, t(k))));

  const renderGallery = (cards: StudioGameCard[], offline: boolean): void => {
    const list = [BLANK_CARD, ...cards.filter((c) => c.id !== BLANK_CARD.id)];
    gallery.replaceChildren(...list.map((c) => {
      const thumb = c.thumbnail_url ? h('img', { src: c.thumbnail_url, alt: '', loading: 'lazy' }) : h('span', { class: 'stn-emoji', 'aria-hidden': 'true' }, emojiFor(c));
      if (!c.thumbnail_url && c.id.startsWith('tpl_') && c.id !== 'tpl_blank') void templateThumb(c.id).then((cv) => { if (cv) { cv.classList.add('stn-thumb-cv'); thumb.replaceWith(cv); } });
      return h('button', { type: 'button', class: `stn-card${c.id === BLANK_CARD.id ? ' blank' : ''}`, onclick: () => void create(c.id, input.value.trim()) },
        h('span', { class: 'stn-thumb' }, thumb),
        h('span', { class: 'stn-card-body' }, h('span', { class: 'stn-card-title' }, c.id === BLANK_CARD.id ? t('studio.new.blank') : kidText(c.title)),
          h('span', { class: 'stn-card-sub' }, c.id === BLANK_CARD.id ? t('studio.new.blank_sub') : t('studio.new.card_sub', { theme: c.theme_name, n: c.objects }))));
    }), ...(offline ? [h('p', { class: 'stn-note' }, t('studio.new.templates_offline'))] : []));
  };
  renderGallery([], false);
  void loadTemplates().then((r) => { if (!disposed) renderGallery(r.templates, r.offline); });

  const locals = localGames();
  if (locals.length) {
    localBox.replaceChildren(h('h2', { class: 'stn-h2' }, t('studio.new.on_device')),
      h('div', { class: 'stn-local-list' }, ...locals.slice(0, 6).map((g) => h('a', { class: 'stn-local-row', href: `#/studio/${encodeURIComponent(g.id)}` }, sicon('cloudoff'), h('span', null, g.title || t('ui.untitled'))))));
  }

  root.append(h('div', { class: 'stn-page' },
    h('section', { class: 'stn-hero' },
      h('h1', { class: 'stn-h1' }, t('studio.new.question')),
      h('p', { class: 'stn-sub' }, t('studio.new.sub')),
      form, ideas, status),
    h('section', { class: 'stn-sec' }, h('div', { class: 'stn-sec-head' }, h('h2', { class: 'stn-h2' }, t('studio.new.templates')), h('span', { class: 'stn-sec-sub' }, t('studio.new.templates_sub'))), gallery),
    localBox));

  if (query.get('template')) void create(query.get('template'), input.value.trim());
  else if (query.get('blank') === '1') void create(BLANK_CARD.id, input.value.trim());
  else if (query.get('tab') === 'templates') window.setTimeout(() => gallery.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  else input.focus();

  return () => {
    disposed = true;
  };
}
