/**
 * Typed fetch wrappers for the API in PLAN.md section 9. Owned by lane D.
 *
 * apiBase is '' in dev (Vite proxies /api and /uploads to :8000). Set
 * VITE_API_BASE=http://<laptop-lan-ip>:8000 when the built app is served from
 * somewhere else. It doubles as the assetBase passed to mountGame.
 */
import type { Level } from './types';

export const apiBase: string = import.meta.env.VITE_API_BASE ?? '';

export interface Health {
  ok: boolean;
  llm: 'fake' | 'live';
}

export interface GameInfo {
  id: string;
  title: string;
  author: string;
  created_at: string;
}

export interface FeedGame extends GameInfo {
  level_count: number;
  authors: string[];
  likes: number;
  /** The first level of the game; its backdrop is the card image. */
  cover: Level | null;
}

export interface LevelSummary {
  id: string;
  game_id: string | null;
  parent_id: string | null;
  order_index: number;
  title: string;
  author: string;
  likes: number;
  solvable: boolean | null;
  created_at: string;
  backdrop_url: string | null;
}

export interface GameDetail {
  game: GameInfo;
  levels: (LevelSummary & { level: Level })[];
}

export interface LevelRef {
  id: string;
  title: string;
  author: string;
}

export interface LevelDetail {
  level: Level;
  author: string;
  likes: number;
  solvable: boolean | null;
  game: GameInfo | null;
  parent: LevelRef | null;
  children: LevelRef[];
  next_level_id: string | null;
}

export interface TreeNode {
  id: string;
  title: string;
  author: string;
  created_at: string;
  likes: number;
  game_id: string | null;
  parent_id: string | null;
  level: Level;
  children: TreeNode[];
}

export interface Safety {
  ok: boolean;
  reason: string | null;
}

export interface ScanResponse {
  draft_id: string;
  level: Level;
  parent_hint: string | null;
  game_hint: string | null;
  warnings: string[];
  safety: Safety;
  debug?: Record<string, string>;
}

export interface PublishBody {
  draft_id: string;
  author: string;
  title?: string;
  solvable: boolean | null;
  game_id?: string | null;
  parent_id?: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, init);
  } catch {
    throw new ApiError('Can’t reach the server. Is scripts/dev.sh running?', 0);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
      else if (Array.isArray(body.detail)) detail = body.detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d)).join('; ');
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function getHealth(): Promise<Health> {
  return request<Health>('/api/health');
}

export async function getGames(): Promise<FeedGame[]> {
  return (await request<{ games: FeedGame[] }>('/api/games')).games;
}

export function getGame(id: string): Promise<GameDetail> {
  return request<GameDetail>(`/api/games/${encodeURIComponent(id)}`);
}

export function addLevelToGame(gameId: string, levelId: string): Promise<{ level: Level; order_index: number }> {
  return postJson(`/api/games/${encodeURIComponent(gameId)}/levels`, { level_id: levelId });
}

export function getLevel(id: string): Promise<LevelDetail> {
  return request<LevelDetail>(`/api/levels/${encodeURIComponent(id)}`);
}

export function getTree(id: string): Promise<TreeNode> {
  return request<TreeNode>(`/api/levels/${encodeURIComponent(id)}/tree`);
}

export async function likeLevel(id: string): Promise<number> {
  return (await request<{ likes: number }>(`/api/levels/${encodeURIComponent(id)}/like`, { method: 'POST' })).likes;
}

export function scanImage(form: FormData): Promise<ScanResponse> {
  return request<ScanResponse>('/api/scan', { method: 'POST', body: form });
}

export function getDraft(draftId: string): Promise<ScanResponse> {
  return request<ScanResponse>(`/api/drafts/${encodeURIComponent(draftId)}`);
}

export async function publishLevel(body: PublishBody): Promise<Level> {
  return (await postJson<{ level: Level }>('/api/levels', body)).level;
}

export async function listFixtures(): Promise<string[]> {
  return (await request<{ fixtures: string[] }>('/api/fixtures')).fixtures;
}

export function getFixture(name: string): Promise<Level> {
  return request<Level>(`/api/fixtures/${encodeURIComponent(name)}`);
}

export function blankSheetUrl(gameId?: string | null): string {
  return `${apiBase}/api/templates/blank.pdf${gameId ? `?game_id=${encodeURIComponent(gameId)}` : ''}`;
}

export function remixSheetUrl(levelId: string): string {
  return `${apiBase}/api/templates/remix/${encodeURIComponent(levelId)}.pdf`;
}

/** Absolute URL for a relative /uploads/... path; null stays null. */
export function assetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^(https?:|data:|blob:)/.test(url) ? url : `${apiBase}${url}`;
}
