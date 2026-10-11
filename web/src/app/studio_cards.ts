/**
 * Studio games on the dashboard, My games and the sidebar (docs/v6/CONTRACTS_V6.md §9): the card list from
 * GET /studio/games and the card element. Never throws: no server (or no lane A yet) means an empty list.
 */
import { h, icon } from './dom.ts';
import { authHeaders } from './identity.ts';
import { kidText, t } from './messages.ts';
import { timeAgo } from './collab/ui.ts';
import type { StudioGameCard } from '../core/types.gen.ts';

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

function thumb(c: StudioGameCard): HTMLElement {
  const box = h('div', { class: 'ws-thumb ws-thumb-empty' }, icon('pencil'));
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
