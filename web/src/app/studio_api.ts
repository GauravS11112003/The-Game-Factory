/**
 * Studio client (docs/v6/CONTRACTS_V6.md §5.1): games, thumbnails, templates, themes, the copilot, recognize and
 * theme-from-words. Errors are `{error: {key, args}}` (lane A) or FastAPI's `{detail}`; they become StudioApiError,
 * and `offline` says the server could not be reached at all (no network, proxy error, endpoint not deployed yet), so
 * screens can keep working locally instead of showing an error. Local drafts live in localStorage (try/catch).
 */
import blankTemplate from '../../../shared/studio/templates/blank.json';
import type {
  GameDoc, RecognizeBody, RecognizeResult, StudioChatBody, StudioChatResult, StudioGameCard, StudioTheme, ThemeBody, ThemeResult,
} from '../core/types.gen.ts';
import { authHeaders } from './identity.ts';
import { hasMessage } from './messages.ts';

const BASE = '/api/v2/studio';
const enc = encodeURIComponent;

export class StudioApiError extends Error {
  readonly status: number;
  readonly key: string;
  readonly args: Record<string, unknown>;
  /** The server could not be reached, or does not have the Studio yet: work locally. */
  readonly offline: boolean;
  constructor(status: number, key: string, args: Record<string, unknown> = {}, offline = false) {
    super(`studio ${status} ${key}`);
    this.name = 'StudioApiError';
    this.status = status;
    this.key = key;
    this.args = args;
    this.offline = offline;
  }
}

export const isOffline = (e: unknown): boolean => e instanceof StudioApiError && e.offline;

async function req<T>(method: string, path: string, body?: unknown, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), o.timeoutMs ?? 20000);
  o.signal?.addEventListener('abort', () => ctl.abort());
  let r: Response;
  try {
    const headers: Record<string, string> = { ...authHeaders() };
    let payload: BodyInit | undefined;
    if (body instanceof Blob) {
      payload = body;
      headers['content-type'] = body.type || 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    r = await fetch(`${BASE}${path}`, { method, headers, body: payload, signal: ctl.signal });
  } catch {
    throw new StudioApiError(0, 'studio.offline', {}, true);
  } finally {
    window.clearTimeout(timer);
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    let j: Record<string, unknown> | null = null;
    try { j = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { j = null; }
    const err = (j?.error ?? (j?.detail && typeof j.detail === 'object' ? (j.detail as Record<string, unknown>).error ?? j.detail : null)) as
      { key?: string; message_key?: string; args?: Record<string, unknown> } | null;
    const key = err?.key ?? err?.message_key;
    // No Studio error body: a proxy error, a server without the v6 routes, or a crash. Treat as "can't reach it".
    const offline = !key && (r.status === 404 || r.status === 405 || r.status >= 500);
    throw new StudioApiError(r.status, key && hasMessage(key) ? key : offline ? 'studio.offline' : 'studio.error', err?.args ?? {}, offline);
  }
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const studioApi = {
  createGame: (body: { template?: string; title?: string; doc?: GameDoc }): Promise<GameDoc> => req<GameDoc>('POST', '/games', body),
  game: (id: string): Promise<GameDoc> => req<GameDoc>('GET', `/games/${enc(id)}`),
  saveGame: (doc: GameDoc): Promise<GameDoc> => req<GameDoc>('PUT', `/games/${enc(doc.id)}`, doc),
  games: (which: 'mine' | 'published'): Promise<{ games: StudioGameCard[] }> => req('GET', `/games?${which}=1`),
  publish: (id: string, published: boolean): Promise<StudioGameCard> => req<StudioGameCard>('POST', `/games/${enc(id)}/publish`, { published }),
  putThumbnail: (id: string, png: Blob): Promise<void> => req<void>('PUT', `/games/${enc(id)}/thumbnail`, png),
  thumbnailUrl: (id: string): string => `${BASE}/games/${enc(id)}/thumbnail.png`,
  remix: (id: string): Promise<GameDoc> => req<GameDoc>('POST', `/games/${enc(id)}/remix`),
  templates: (): Promise<{ templates: StudioGameCard[] }> => req('GET', '/templates', undefined, { timeoutMs: 8000 }),
  template: (id: string): Promise<GameDoc> => req<GameDoc>('GET', `/templates/${enc(id)}`),
  themes: (): Promise<{ themes: StudioTheme[] }> => req('GET', '/themes', undefined, { timeoutMs: 8000 }),
  chat: (body: StudioChatBody, signal?: AbortSignal): Promise<StudioChatResult> => req<StudioChatResult>('POST', '/chat', body, { timeoutMs: 60000, signal }),
  recognize: (body: RecognizeBody): Promise<RecognizeResult> => req<RecognizeResult>('POST', '/recognize', body, { timeoutMs: 20000 }),
  theme: (body: ThemeBody): Promise<ThemeResult> => req<ThemeResult>('POST', '/theme', body, { timeoutMs: 15000 }),
};

// ---- fallbacks: blank template, the one built-in theme ---------------------------------------------------------------

export const BLANK_DOC = blankTemplate as unknown as GameDoc;

let themesP: Promise<StudioTheme[]> | null = null;
/** Theme presets from the server (shared/studio/themes.json); offline: the blank template's Sketchbook. */
export function loadThemes(): Promise<StudioTheme[]> {
  themesP ??= studioApi.themes().then((r) => (Array.isArray(r?.themes) && r.themes.length ? r.themes : [BLANK_DOC.theme!]), () => {
    themesP = null; // try again next time
    return [BLANK_DOC.theme!];
  });
  return themesP;
}

export const BLANK_CARD: StudioGameCard = {
  id: 'tpl_blank', title: 'Blank canvas', author: 'draw.play', kind: '', theme_name: 'Sketchbook', scenes: 1, objects: 0, published: true, updated_at: null,
};

/** Template cards; offline: blank only. */
export async function loadTemplates(): Promise<{ templates: StudioGameCard[]; offline: boolean }> {
  try {
    const r = await studioApi.templates();
    return { templates: Array.isArray(r?.templates) && r.templates.length ? r.templates : [BLANK_CARD], offline: false };
  } catch {
    return { templates: [BLANK_CARD], offline: true };
  }
}

// ---- local drafts ------------------------------------------------------------------------------------------------

const DRAFT = 'dp.studio.draft.';
const LOCAL_INDEX = 'dp.studio.local';

export const isLocalId = (id: string): boolean => id.startsWith('local-');

export function newLocalId(): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return `local-${[...a].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface Draft { doc: GameDoc; savedAt: number; synced: boolean }

export function saveDraft(doc: GameDoc, synced: boolean): boolean {
  try {
    localStorage.setItem(DRAFT + doc.id, JSON.stringify({ doc, savedAt: Date.now(), synced } satisfies Draft));
    if (isLocalId(doc.id)) {
      const list = localGames().filter((g) => g.id !== doc.id);
      localStorage.setItem(LOCAL_INDEX, JSON.stringify([{ id: doc.id, title: doc.title ?? '' }, ...list].slice(0, 30)));
    }
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(id: string): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT + id);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return d && d.doc && typeof d.savedAt === 'number' ? d : null;
  } catch {
    return null;
  }
}

export function dropDraft(id: string): void {
  try {
    localStorage.removeItem(DRAFT + id);
    if (isLocalId(id)) localStorage.setItem(LOCAL_INDEX, JSON.stringify(localGames().filter((g) => g.id !== id)));
  } catch {
    /* storage off */
  }
}

/** Games made on this device while the server was away (newest first). */
export function localGames(): { id: string; title: string }[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_INDEX) ?? '[]') as { id: string; title: string }[];
    return Array.isArray(v) ? v.filter((g) => g && typeof g.id === 'string') : [];
  } catch {
    return [];
  }
}

/** A brand-new doc made on this device (from a template doc, or blank). */
export function localGameFrom(template: GameDoc | null, title?: string): GameDoc {
  const src = JSON.parse(JSON.stringify(template ?? BLANK_DOC)) as GameDoc;
  const now = new Date().toISOString();
  return { ...src, id: newLocalId(), title: title?.trim() || (template && template.id !== 'tpl_blank' ? src.title : 'Untitled game') || 'Untitled game', created_at: now, updated_at: now };
}
