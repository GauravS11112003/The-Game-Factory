/**
 * Studio games on the dashboard, My games and the sidebar (docs/v6/CONTRACTS_V6.md §9): the card list from
 * GET /studio/games and the card element. Never throws: no server (or no lane A yet) means an empty list.
 */
import { h, icon } from './dom.ts';
import { authHeaders } from './identity.ts';
import { kidText, t } from './messages.ts';
import { timeAgo } from './collab/ui.ts';
import type { GameDoc, StudioGameCard } from '../core/types.gen.ts';
import { thumbnailCanvas } from '../studio/editor/snapshot.ts';
import { normalizeDoc } from '../studio/model/types.ts';

const BASE = '/api/v2/studio';

export const isStudioId = (id: string): boolean => id.startsWith('sg_');
export const studioHref = (id: string): string => `#/studio/${encodeURIComponent(id)}`;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}${path}`, { headers: authHeaders() });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function studioGames(which: 'mine' | 'published'): Promise<StudioGameCard[]> {
  const r = await getJson<{ games: StudioGameCard[] }>(`/games?${which}=1`);
  return r?.games ?? [];
}

export async function studioTemplates(): Promise<StudioGameCard[]> {
  const r = await getJson<{ templates: StudioGameCard[] }>('/templates');
  return r?.templates ?? [];
}

export async function studioTitle(id: string): Promise<string | null> {
  const r = await getJson<{ title?: string }>(`/games/${encodeURIComponent(id)}`);
  return r?.title ?? null;
}

const tplThumbs = new Map<string, Promise<HTMLCanvasElement | null>>();

/** A template's picture, drawn in the browser from its own strokes and theme (templates ship no PNGs). */
export function templateThumb(id: string): Promise<HTMLCanvasElement | null> {
  let p = tplThumbs.get(id);
  if (!p) {
    p = getJson<GameDoc>(`/templates/${encodeURIComponent(id)}`).then((doc) => {
      if (!doc) return null;
      try {
        return thumbnailCanvas(normalizeDoc(doc));
      } catch {
        return null;
      }
    });
    tplThumbs.set(id, p);
  }
  return p.then((c) => {
    if (!c) return null;
    const copy = document.createElement('canvas'); // one card per canvas element
    copy.width = c.width;
    copy.height = c.height;
    copy.getContext('2d')?.drawImage(c, 0, 0);
    return copy;
  });
}

function thumb(c: StudioGameCard): HTMLElement {
  const box = h('div', { class: 'ws-thumb ws-thumb-empty' }, icon('pencil'));
  if (c.id.startsWith('tpl_') && !c.thumbnail_url) {
    void templateThumb(c.id).then((cv) => {
      if (!cv) return;
      box.classList.remove('ws-thumb-empty');
      box.replaceChildren(cv);
    });
    return box;
  }
  const url = c.thumbnail_url ?? `${BASE}/games/${encodeURIComponent(c.id)}/thumbnail.png`;
  const img = h('img', { alt: '', loading: 'lazy', src: url });
  img.onload = () => {
    box.classList.remove('ws-thumb-empty');
    box.replaceChildren(img);
  };
  return box;
}

/** A Studio game card; `href` defaults to the Studio (templates pass `#/new?template=…`). */
export function studioCardEl(c: StudioGameCard, href = studioHref(c.id)): HTMLElement {
  const meta = [c.kind ? kidText(c.kind) : t('ws.studio_any_game'), c.theme_name].filter(Boolean).join(' · ');
  return h('a', { class: 'ws-game', href },
    thumb(c),
    h('div', { class: 'ws-game-body' },
      h('div', { class: 'ws-game-head' },
        h('span', { class: 'ws-game-title' }, kidText(c.title || t('ui.untitled'))),
        c.published ? h('span', { class: 'ws-chip beat' }, t('ws.studio_published')) : h('span', { class: 'ws-chip draft' }, t('ws.studio_draft'))),
      h('span', { class: 'ws-game-meta' }, meta),
      h('span', { class: 'ws-game-foot' }, c.updated_at ? t('ws.edited', { when: timeAgo(c.updated_at) }) : '')));
}
