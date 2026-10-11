/**
 * #/g/:id — play a Studio game full screen (docs/v6/CONTRACTS_V6.md §6): title, restart, fullscreen, copy the share
 * link, and Remix (a copy owned by the player, opened in the Studio). Works offline from a local draft.
 */
import '../../studio/studio.css';
import type { GameDoc } from '../../core/types.gen.ts';
import { h, toast } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { store } from '../store.ts';
import { BLANK_DOC, isOffline, loadDraft, localGameFrom, saveDraft, studioApi } from '../studio_api.ts';
import { sicon } from '../../studio/editor/icons.ts';
import { mountRuntime, type RuntimeHandle } from '../../studio/runtime/index.ts';

async function fetchDoc(id: string): Promise<GameDoc | null> {
  try {
    return id.startsWith('tpl_') ? await studioApi.template(id) : await studioApi.game(id);
  } catch {
    const d = loadDraft(id);
    if (d) return d.doc;
    if (id === BLANK_DOC.id) return BLANK_DOC;
    return null;
  }
}

export function studioPlayScreen(root: HTMLElement, gameId: string, _query: URLSearchParams): () => void {
  let disposed = false;
  let runtime: RuntimeHandle | null = null;
  const stage = h('div', { class: 'stp-stage' });
  const titleEl = h('div', { class: 'stp-title' }, t('studio.opening'));
  const bar = h('header', { class: 'stp-bar' });
  const page = h('div', { class: 'stp-root' }, bar, stage);
  root.append(page);
  document.body.classList.add('st-on');
  const prevTitle = document.title;

  const btn = (ico: string, label: string, onclick: () => void, cls = ''): HTMLButtonElement =>
    h('button', { type: 'button', class: `stp-btn${cls ? ` ${cls}` : ''}`, title: label, 'aria-label': label, onclick }, sicon(ico), h('span', { class: 'st-hide-sm' }, label));

  void fetchDoc(gameId).then((doc) => {
    if (disposed) return;
    if (!doc) {
      stage.replaceChildren(h('div', { class: 'st-missing' }, h('h2', null, t('studio.missing')), h('p', null, t('studio.missing_sub')), h('a', { class: 'st-btn primary', href: '#/' }, t('studio.top.home'))));
      bar.replaceChildren(h('a', { class: 'stp-btn', href: '#/' }, sicon('back')));
      return;
    }
    titleEl.replaceChildren(h('span', { class: 'stp-name' }, kidText(doc.title ?? '')), ...(doc.author ? [h('span', { class: 'stp-by' }, t('studio.play.by', { name: doc.author }))] : []));
    document.title = `${doc.title ?? 'draw.play'} · draw.play`;
    const start = (): void => {
      try { runtime?.stop(); } catch { /* already gone */ }
      stage.replaceChildren();
      try {
        runtime = mountRuntime(stage, doc, { muted: store.flag('muted') });
      } catch (e) {
        console.error('runtime failed', e);
        stage.append(h('p', { class: 'st-empty-note' }, t('studio.play.failed')));
      }
    };
    const share = async (): Promise<void> => {
      const url = `${location.origin}${location.pathname}#/g/${encodeURIComponent(gameId)}`;
      try { await navigator.clipboard.writeText(url); toast(t('studio.share.copied')); } catch { toast(url, { ms: 8000 }); }
    };
    const remix = async (): Promise<void> => {
      try {
        const copy = await studioApi.remix(gameId);
        navigate(`#/studio/${encodeURIComponent(copy.id)}`);
      } catch (e) {
        if (!isOffline(e)) { toast(t('studio.play.remix_failed')); return; }
        const local = localGameFrom(doc, t('studio.play.remix_title', { title: doc.title ?? '' }));
        saveDraft(local, false);
        navigate(`#/studio/${encodeURIComponent(local.id)}`);
      }
    };
    const full = (): void => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else void page.requestFullscreen?.().catch(() => undefined);
    };
    bar.replaceChildren(
      h('a', { class: 'stp-btn', href: '#/', title: t('studio.top.home'), 'aria-label': t('studio.top.home') }, sicon('back')),
      titleEl, h('span', { class: 'st-grow' }),
      btn('restart', t('studio.play.restart'), () => { if (runtime) runtime.restart(); else start(); }),
      btn('expand', t('studio.play.fullscreen'), full),
      btn('share', t('studio.share.copy'), () => void share()),
      btn('remix', t('studio.play.remix'), () => void remix(), 'primary'));
    start();
  });

  return () => {
    disposed = true;
    try { runtime?.stop(); } catch { /* already gone */ }
    document.body.classList.remove('st-on');
    document.title = prevTitle;
  };
}
