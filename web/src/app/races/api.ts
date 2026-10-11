import type { LevelV2, Replay } from '../../core/types.gen.ts';
import { ApiError } from '../api.ts';

export interface Racer {
  seat: number;
  name: string;
  connected: boolean;
  ready: boolean;
  rematch: boolean;
  forfeit: boolean;
  progress: { frame: number; x: number; y: number; deaths: number } | null;
  result: { elapsed_ms: number; time_ms: number; deaths: number; coins: number; verified: boolean } | null;
}

export interface Race {
  id: string;
  level_id: string;
  level_version: number;
  title: string;
  phase: 'waiting' | 'countdown' | 'playing' | 'finished' | 'expired';
  round: number;
  start_at: number | null;
  server_time: number;
  expires_at: number;
  winner: number | null;
  players: Racer[];
}

export interface RaceCreated {
  match: Race;
  token: string | null;
  invite: string;
  invite_url: string;
  card_url: string;
}

async function request<T>(method: string, path: string, body?: unknown, token?: string, invite?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v2/matches${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(invite ? { 'X-Race-Invite': invite } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(0, 'error.network');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.detail?.message_key ?? data.message_key ?? 'error.network');
  return data as T;
}

export const raceApi = {
  create: (level: LevelV2, name: string) => request<RaceCreated>('POST', '', { level_id: level.id, version: level.version, name }),
  snapshot: (id: string, token?: string, invite?: string) => request<Race>('GET', `/${id}`, undefined, token, invite),
  join: (id: string, invite: string, name: string, claim: string) => request<{ match: Race; token: string; seat: number }>('POST', `/${id}/join`, { invite, name, claim }),
  level: (id: string, token: string) => request<{ level: LevelV2 }>('GET', `/${id}/level`, undefined, token),
  ready: (id: string, token: string, round: number) => request<Race>('POST', `/${id}/ready`, { round }, token),
  rematch: (id: string, token: string, round: number) => request<Race>('POST', `/${id}/rematch`, { round }, token),
  finish: (id: string, token: string, round: number, replay: Replay) => request<Race>('POST', `/${id}/finish`, { round, replay }, token),
  config: () => request<{ imessage_number: string | null }>('GET', '/config'),
};

export interface RaceSession { token: string; seat: number; invite: string }
const sessions = new Map<string, RaceSession>();
const claims = new Map<string, string>();

export function raceSession(id: string, session?: RaceSession): RaceSession | null {
  if (session) sessions.set(id, session);
  try {
    if (session) localStorage.setItem(`dp.race.${id}`, JSON.stringify(session));
    const value = JSON.parse(localStorage.getItem(`dp.race.${id}`) ?? 'null') as RaceSession | null;
    return value?.token && typeof value.seat === 'number' ? value : sessions.get(id) ?? null;
  } catch { return sessions.get(id) ?? null; }
}

export function joinClaim(id: string): string {
  const key = `dp.race.claim.${id}`;
  const value = claims.get(id) ?? crypto.randomUUID();
  claims.set(id, value);
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    localStorage.setItem(key, value);
  } catch { /* A join still works when storage is unavailable. */ }
  return value;
}

export function savedRaceReplay(id: string, round: number, replay?: Replay): Replay | null {
  try {
    const key = `dp.race.replay.${id}`;
    if (replay) sessionStorage.setItem(key, JSON.stringify({ round, replay }));
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return saved?.round === round ? saved.replay as Replay : null;
  } catch { return null; }
}
