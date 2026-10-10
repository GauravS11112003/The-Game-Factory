/** HTTP API v2 client (PLAN_V2 §11.3e). The web app only talks to Vite :5173, which proxies /api. */
import type { BuildAccepted, BuildEvent, Health } from '../core/types.gen.ts';

const BASE = '/api/v2';

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, body: await r.json().catch(() => null) });
  return (await r.json()) as T;
}

export const api = {
  health: (): Promise<Health> => fetch(`${BASE}/health`).then((r) => json<Health>(r)),
  createBuild(body: FormData): Promise<BuildAccepted> {
    return fetch(`${BASE}/builds`, { method: 'POST', body }).then((r) => json<BuildAccepted>(r));
  },
  draft(id: string, since?: number): Promise<{ state: 'running' | 'done' | 'failed'; events: BuildEvent[] }> {
    const q = since === undefined ? '' : `?since=${since}`;
    return fetch(`${BASE}/drafts/${id}${q}`).then((r) => json(r));
  },
};
