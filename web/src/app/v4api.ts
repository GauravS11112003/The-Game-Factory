/**
 * v4 client (docs/v4/CONTRACTS_V4.md §6): public blocks, written rules, the workspace dashboard and connectors.
 * Shapes come from the generated contracts; errors are the app's ApiError with a messages key, like api.ts.
 */
import { apiRequest } from './api.ts';
import type {
  BlockCard, BlockCreate, BlockDescribeBody, BlockDescribeResult, BlockKind, BlockList, Dashboard, LogicParseBody,
  LogicParseResult, MinecraftBody, MinecraftResult, UseBlockBody, UseBlockResult,
} from '../core/types.gen.ts';

export type BlockSort = 'new' | 'popular';

export interface BlockQuery {
  q?: string;
  kind?: BlockKind | null;
  sort?: BlockSort;
  author_id?: string | null;
  limit?: number;
  offset?: number;
}

function qs(o: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

export const v4 = {
  blocks: (q: BlockQuery = {}): Promise<BlockList> =>
    apiRequest<BlockList>('GET', `/blocks${qs({ q: q.q, kind: q.kind, sort: q.sort, author_id: q.author_id, limit: q.limit, offset: q.offset })}`),
  block: (id: string, version?: number): Promise<BlockCard> => apiRequest<BlockCard>('GET', `/blocks/${enc(id)}${qs({ v: version })}`),
  createBlock: (body: BlockCreate): Promise<BlockCard> => apiRequest<BlockCard>('POST', '/blocks', body),
  newBlockVersion: (id: string, body: BlockCreate): Promise<BlockCard> => apiRequest<BlockCard>('POST', `/blocks/${enc(id)}/versions`, body),
  describeBlock: (body: BlockDescribeBody): Promise<BlockDescribeResult> => apiRequest<BlockDescribeResult>('POST', '/blocks/describe', body),
  useBlock: (gameId: string, body: UseBlockBody): Promise<UseBlockResult> => apiRequest<UseBlockResult>('POST', `/games/${enc(gameId)}/blocks`, body),

  parseLogic: (body: LogicParseBody): Promise<LogicParseResult> => apiRequest<LogicParseResult>('POST', '/logic/parse', body),

  dashboard: (): Promise<Dashboard> => apiRequest<Dashboard>('GET', '/dashboard'),

  /** Download URLs (open with api.pdf-style navigation or a plain link). */
  tiledUrl: (gameId: string): string => `/api/v2/games/${enc(gameId)}/export/tiled`,
  minecraftUrl: (gameId: string): string => `/api/v2/games/${enc(gameId)}/export/minecraft`,
  minecraftLive: (gameId: string, body: MinecraftBody): Promise<MinecraftResult> =>
    apiRequest<MinecraftResult>('POST', `/games/${enc(gameId)}/export/minecraft/live`, body),
};
