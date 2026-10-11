/**
 * Typed wrappers for every creative endpoint (docs/v3/CONTRACTS_V3.md "Creative API"), prefix /api/v2/creative,
 * plus PUT /api/v2/drafts/{id}/skin. Every call carries the player header from identity.ts (lane 5). Errors become
 * the app's ApiError with a messages.json key, like the rest of the v2 client.
 */
import type { Behavior, InkStroke, RectCells } from '../../core/types.gen.ts';
import { ApiError } from '../api.ts';
import { authHeaders } from '../identity.ts';
import { hasMessage } from '../messages.ts';
import { normJob, type ArtProvider, type CreativeStatus, type Job, type Skin } from './types.ts';

const V2 = '/api/v2';
const BASE = `${V2}/creative`;

function defaultKey(status: number): string {
  if (status === 0) return 'error.network';
  if (status === 404) return 'error.not_found';
  if (status === 429) return 'error.rate_limited';
  if (status === 501) return 'error.not_implemented';
  if (status === 503) return 'error.worker_down';
  if (status === 400 || status === 422) return 'error.bad_request';
  return 'creative.failed';
}

function headers(json: boolean): Record<string, string> {
  let auth: Record<string, string> = {};
  try {
    auth = authHeaders();
  } catch {
    auth = {};
  }
  return json ? { ...auth, 'content-type': 'application/json' } : auth;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    const init: RequestInit = { method };
    if (body instanceof FormData) {
      init.body = body;
      init.headers = headers(false);
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = headers(true);
    } else init.headers = headers(false);
    r = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'error.network');
  }
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    const msg = (j && typeof j === 'object' && 'detail' in j && j.detail && typeof j.detail === 'object' ? j.detail : j) as
      { message_key?: string; args?: Record<string, unknown> } | null;
    const key = msg?.message_key && hasMessage(msg.message_key) ? msg.message_key : defaultKey(r.status);
    throw new ApiError(r.status, key, msg?.args ?? {}, j);
  }
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function mustJob(x: unknown): Job {
  const j = normJob(x);
  if (!j) throw new ApiError(500, 'creative.failed');
  return j;
}

export interface NewJob {
  crop: Blob;
  doc_id: string;
  stroke_ids: string[];
  bbox_cells: RectCells;
  game_id?: string | null;
  hint?: string | null;
}

export type LibraryKind = 'creature' | 'platform' | 'hazard' | 'pickup' | 'prop' | 'player';

export interface PinBody {
  game_id: string;
  name: string;
  strokes?: InkStroke[];
  kind?: LibraryKind;
  behavior?: Behavior | null;
}

export interface BackdropBody {
  doc_id: string;
  game_id?: string | null;
  theme?: string | null;
  screens: number;
}

export const creativeApi = {
  async status(): Promise<CreativeStatus> {
    const s = await call<Partial<CreativeStatus>>('GET', `${BASE}/status`);
    const p = s?.provider;
    const provider: ArtProvider = p === 'firefly' || p === 'claude-svg' ? p : 'none';
    return { provider, budget_left_usd: typeof s?.budget_left_usd === 'number' ? s.budget_left_usd : null };
  },

  /** 202 {job_id}; an identical fingerprint (crop hash + game style) returns the cached job (and the job itself). */
  async createJob(j: NewJob): Promise<{ job_id: string; job: Job | null }> {
    const f = new FormData();
    f.append('crop', j.crop, 'crop.png');
    f.append('doc_id', j.doc_id);
    f.append('stroke_ids', JSON.stringify(j.stroke_ids));
    f.append('bbox_cells', JSON.stringify(j.bbox_cells));
    if (j.game_id) f.append('game_id', j.game_id);
    if (j.hint) f.append('hint', j.hint);
    f.append('provider', 'claude-svg');
    const r = await call<{ job_id: string; job?: unknown }>('POST', `${BASE}/jobs`, f);
    return { job_id: r.job_id, job: normJob(r.job) };
  },

  async jobs(docId: string): Promise<Job[]> {
    const r = await call<{ jobs?: unknown[] }>('GET', `${BASE}/jobs?doc_id=${encodeURIComponent(docId)}`);
    return (r?.jobs ?? []).map(normJob).filter((j): j is Job => !!j);
  },

  async job(jobId: string): Promise<Job> {
    return mustJob(await call('GET', `${BASE}/jobs/${encodeURIComponent(jobId)}`));
  },

  /** 202 {job_id}: three variations arrive in Job.variants. */
  reroll(jobId: string): Promise<{ job_id: string }> {
    return call('POST', `${BASE}/jobs/${encodeURIComponent(jobId)}/reroll`, {});
  },

  async choose(jobId: string, variant: number): Promise<Job> {
    return mustJob(await call('POST', `${BASE}/jobs/${encodeURIComponent(jobId)}/choose`, { variant }));
  },

  /** Save to the game's creature library with this art (the kid's own strokes keep the ink; kind/behavior optional). */
  pin(jobId: string, body: PinBody): Promise<{ type_id: string; version?: number; name?: string }> {
    return call('POST', `${BASE}/jobs/${encodeURIComponent(jobId)}/pin`, body);
  },

  /** 202 {job_id}: a wide parallax backdrop for the level. */
  backdrop(body: BackdropBody): Promise<{ job_id: string }> {
    return call('POST', `${BASE}/backdrop`, { ...body, provider: 'claude-svg' });
  },

  /** The game's style reference, from words or from a picture (image_url is null without Firefly). */
  style(body: { game_id: string; description: string } | { game_id: string; image: Blob; description?: string }): Promise<{ style_id: string; image_url: string | null }> {
    if ('image' in body) {
      const f = new FormData();
      f.append('game_id', body.game_id);
      f.append('image', body.image, 'style.png');
      if (body.description) f.append('description', body.description);
      return call('POST', `${BASE}/style`, f);
    }
    return call('POST', `${BASE}/style`, body);
  },

  /** The game's current style (record and its text). */
  getStyle(gameId: string): Promise<{ style: Record<string, unknown> | null; text: string }> {
    return call('GET', `${BASE}/style?game_id=${encodeURIComponent(gameId)}`);
  },

  /** Stored in the draft state `skin` (null clears it); publishing copies it into the level. */
  putSkin(draftId: string, skin: Skin | null): Promise<{ ok: boolean }> {
    return call('PUT', `${V2}/drafts/${encodeURIComponent(draftId)}/skin`, skin);
  },
};
