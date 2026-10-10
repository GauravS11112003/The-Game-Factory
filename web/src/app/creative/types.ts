/**
 * Shapes of the creative API and the level `skin` (docs/v3/CONTRACTS_V3.md, "Creative API" and "Skin on levels").
 * Lane 1 owns the server side and the spec change; these are the client's tolerant mirrors of that contract.
 */
import type { RectCells } from '../../core/types.gen.ts';

export type ArtProvider = 'firefly' | 'claude-svg' | 'none';

export interface CreativeStatus {
  provider: ArtProvider;
  budget_left_usd: number | null;
}

export type JobStatus = 'queued' | 'working' | 'done' | 'failed';

export interface Credit {
  by?: string | null;
  tool?: string | null;
  prompt?: string | null;
}

export interface Job {
  job_id: string;
  doc_id: string;
  status: JobStatus;
  label: string | null;
  prompt: string | null;
  url: string | null;
  variants: { url: string }[];
  stroke_ids: string[];
  bbox_cells: RectCells | null;
  provider: string | null;
  error_key: string | null;
  credit: Credit | null;
  /** 'object' (a sprite) or 'backdrop'. */
  kind: 'object' | 'backdrop';
  /** The game style the art was made with, if any. */
  style_id: string | null;
  /** The picked variant (index into `variants`), if any. */
  chosen: number | null;
}

export type SkinMode = 'life' | 'ink';

export interface SkinObject {
  stroke_ids: string[];
  object_id: string | null;
  url: string;
  label: string;
  credit: Credit;
  mode: SkinMode;
}

export interface SkinBackdrop {
  url: string;
  credit: Credit;
}

export interface Skin {
  provider: 'firefly' | 'claude-svg';
  style_id?: string | null;
  backdrop: SkinBackdrop | null;
  objects: SkinObject[];
}

/** `POST /api/v2/levels` may now answer with a pending submission (publishing into someone else's game). */
export interface Submission {
  id: string;
  status: string;
  game_id: string;
  game_title?: string | null;
}

export function isWorking(j: Job | null | undefined): boolean {
  return !!j && (j.status === 'queued' || j.status === 'working');
}

/** Normalize a job body from the server (missing arrays and nulls tolerated). */
export function normJob(x: unknown): Job | null {
  const j = x as Partial<Job> | null;
  if (!j || typeof j !== 'object' || typeof j.job_id !== 'string') return null;
  const status: JobStatus = j.status === 'queued' || j.status === 'working' || j.status === 'done' || j.status === 'failed' ? j.status : 'queued';
  return {
    job_id: j.job_id,
    doc_id: typeof j.doc_id === 'string' ? j.doc_id : '',
    status,
    label: typeof j.label === 'string' ? j.label : null,
    prompt: typeof j.prompt === 'string' ? j.prompt : null,
    url: typeof j.url === 'string' && j.url ? j.url : null,
    variants: Array.isArray(j.variants) ? j.variants.filter((v) => v && typeof v.url === 'string') : [],
    stroke_ids: Array.isArray(j.stroke_ids) ? j.stroke_ids.filter((s) => typeof s === 'string') : [],
    bbox_cells: Array.isArray(j.bbox_cells) && j.bbox_cells.length === 4 ? (j.bbox_cells as RectCells) : null,
    provider: typeof j.provider === 'string' ? j.provider : null,
    error_key: typeof j.error_key === 'string' ? j.error_key : null,
    credit: j.credit && typeof j.credit === 'object' ? j.credit : null,
    kind: j.kind === 'backdrop' ? 'backdrop' : 'object',
    style_id: typeof j.style_id === 'string' && j.style_id ? j.style_id : null,
    chosen: typeof j.chosen === 'number' ? j.chosen : null,
  };
}
