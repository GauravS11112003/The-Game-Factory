/**
 * HTTP API v2 client (PLAN_V2 §11.3e). The web app only talks to Vite :5173, which proxies /api and /uploads.
 * Errors become ApiError with a message key (409/422/501/503 bodies carry `{message_key, args}`, possibly wrapped in
 * FastAPI's `{detail: …}`), so the UI always shows a sentence from messages.json and never a raw code.
 */
import type {
  AffectedLevel, AttemptsBody, Behavior, BuildAccepted, BuildEvent, ChallengeBand, CreatureSpecJson, Dial, EditOp, GameRules,
  Health, InkStroke, LevelResponse, LevelV2, LibraryType, PackCreate, PublishBody, Replay, RunResult, RunSubmit, Telemetry,
  Tier, TierSetSummary,
} from '../core/types.gen.ts';
import { hasMessage } from './messages.ts';
import { authHeaders } from './identity.ts';
import { afterPublish, withContribution } from './collab/contribute.ts';

const BASE = '/api/v2';

export class ApiError extends Error {
  readonly status: number;
  readonly messageKey: string;
  readonly args: Record<string, unknown>;
  /** The whole error body (e.g. `affected` on a 409 rules.blocked). */
  readonly body: unknown;
  constructor(status: number, messageKey: string, args: Record<string, unknown> = {}, body: unknown = null) {
    super(`HTTP ${status} ${messageKey}`);
    this.name = 'ApiError';
    this.status = status;
    this.messageKey = messageKey;
    this.args = args;
    this.body = body;
  }
}

function defaultKey(status: number): string {
  if (status === 0) return 'error.network';
  if (status === 404) return 'error.not_found';
  if (status === 429) return 'error.rate_limited';
  if (status === 501) return 'error.not_implemented';
  if (status === 503) return 'error.worker_down';
  if (status === 400 || status === 422) return 'error.bad_request';
  return 'error.build_failed';
}

async function request<T>(method: string, path: string, body?: unknown, o: { raw?: boolean; keepalive?: boolean } = {}): Promise<T> {
  let r: Response;
  try {
    const init: RequestInit = { method, keepalive: o.keepalive };
    if (body instanceof FormData || body instanceof Blob) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
    init.headers = { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) }; // v3 identity (lane 5): X-DP-Player
    r = await fetch(`${BASE}${path}`, init);
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
  if (o.raw || r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---- tolerant shapes for the feed, games and the remix tree (lane D owns the exact bodies) ------------------------

export interface LevelCard {
  id: string;
  version: number;
  title: string;
  author: string;
  band: string | null;
  score: number | null;
  clear_rate: number | null;
  best_ms: number | null;
  screens: number;
  order_index: number;
  parent_id: string | null;
  game_id: string | null;
  thumbnail_url: string | null;
  safety: string | null;
  verified: boolean | null;
  level: LevelV2 | null; // when the feed embeds the level JSON
  /** §9: a level to clear first (Starter World's bonus L5 unlocks after L4), or null. */
  unlock_after: string | null;
  bonus: boolean;
}

export interface GameCard {
  id: string;
  title: string;
  author: string;
  created_at: string | null;
  levels: LevelCard[];
  /** Remixes of this game's levels (listed apart from the playable sequence). */
  remixes: LevelCard[];
  rules: GameRules | null;
}

export interface ChangedObject {
  id: string;
  kind: 'added' | 'changed' | 'removed';
  role: string | null;
  bbox: [number, number, number, number];
}

export interface TreeNode {
  id: string;
  version: number;
  versions: number[];
  title: string;
  author: string;
  changed: number | null;
  changed_bboxes: [number, number, number, number][];
  changed_objects: ChangedObject[];
  thumbnail_url: string | null;
  current: boolean;
  screens: number;
  band: string | null;
  created_at: string | null;
  children: TreeNode[];
}

/** A printed paper pack (§6.4): k sheets with QR `dal2|p|<pack_id>|n/k`. */
export interface PackInfo {
  pack_id: string;
  pdf_url: string;
  kind: PackCreate['kind'];
  k: number;
  game_id: string | null;
  parent_id: string | null;
  /** Sheet indexes (1-based) the server has already seen, when it reports them. */
  scanned: number[];
}

export interface InterpretOut {
  spec: CreatureSpecJson;
  behavior: Behavior;
  source: 'model' | 'keywords';
}

export interface RunRow {
  run_id: string;
  player: string;
  time_ms: number;
  deaths: number;
  coins: number;
  big_coins: number;
  level_version: number | null;
  board: string | null;
  /** On an older version of the level. */
  older: boolean;
}

/** A Library Sheet box read by the server (lane C's OMR + the handwriting read of the name line). */
export interface LibraryDraft {
  box: number;
  name: string;
  name_source: 'default' | 'model' | 'kid';
  letter: string | null;
  archetype: string | null; // null: it stays still
  speed: 'slow' | 'normal' | 'fast';
  spiky: boolean;
  behavior: Behavior;
  collision: LibraryType['collision'];
  art: LibraryType['art'];
  symbol: LibraryType['symbol'];
  asks: { key: string; args?: Record<string, unknown> }[];
  warnings: { key: string; args?: Record<string, unknown> }[];
}

export interface RulesSheetRead {
  patch: Record<string, unknown>;
  asks: { key: string; args?: Record<string, unknown> }[];
  warnings: { key: string; args?: Record<string, unknown> }[];
  story: string | null;
  title_suggestion: string | null;
  game_id: string | null;
}

type Any = any;

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v === undefined || v === null ? d : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function toLevelCard(x: Any): LevelCard {
  const lv: LevelV2 | null = x?.format === 'dal-level' ? x : x?.level?.format === 'dal-level' ? x.level : x?.json_v2?.format === 'dal-level' ? x.json_v2 : null;
  const design = lv?.design;
  return {
    id: str(x?.id ?? lv?.id),
    version: num(x?.version ?? lv?.version) ?? 1,
    title: str(x?.title ?? lv?.title),
    author: str(x?.author ?? lv?.author),
    band: str(x?.band ?? design?.band, '') || null,
    score: num(x?.score ?? design?.score),
    clear_rate: num(x?.clear_rate ?? x?.stats?.clear_rate),
    best_ms: num(x?.best_ms ?? x?.fastest_ms ?? x?.best ?? x?.stats?.best),
    screens: num(x?.screens ?? lv?.world?.screens) ?? 1,
    order_index: num(x?.order_index ?? lv?.order_index) ?? 0,
    parent_id: (x?.parent_id ?? lv?.parent_id ?? null) as string | null,
    game_id: (x?.game_id ?? lv?.game_id ?? null) as string | null,
    thumbnail_url: (x?.thumbnail_url ?? x?.thumb_url ?? null) as string | null,
    safety: (x?.safety ?? lv?.meta?.safety ?? null) as string | null,
    verified: typeof x?.verified === 'boolean' ? x.verified : null,
    level: lv,
    unlock_after: (typeof x?.unlock_after === 'string' ? x.unlock_after : typeof (lv as Any)?.x_unlock_after === 'string' ? (lv as Any).x_unlock_after : null) as string | null,
    bonus: !!(x?.bonus ?? (lv as Any)?.x_bonus),
  };
}

export function toGameCard(x: Any): GameCard {
  const levels = (Array.isArray(x?.levels) ? x.levels : []).map(toLevelCard);
  levels.sort((a: LevelCard, b: LevelCard) => a.order_index - b.order_index);
  return {
    id: str(x?.id ?? x?.game_id), title: str(x?.title), author: str(x?.author), created_at: (x?.created_at ?? null) as string | null, levels,
    remixes: (Array.isArray(x?.remixes) ? x.remixes : []).map(toLevelCard), rules: toRules(x?.rules ?? x?.rules_json),
  };
}

function isBox(b: unknown): b is [number, number, number, number] {
  return Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v));
}

function toTree(x: Any): TreeNode {
  const lv = x?.level?.format === 'dal-level' ? x.level : null;
  const changed = Array.isArray(x?.changed) ? x.changed : Array.isArray(x?.changed_objects) ? x.changed_objects : null;
  const objs: ChangedObject[] = (changed ?? [])
    .filter((c: Any) => c && typeof c === 'object' && isBox(c.bbox))
    .map((c: Any) => ({
      id: str(c.id ?? c.object_id), kind: c.kind === 'changed' || c.kind === 'removed' ? c.kind : 'added',
      role: typeof c.role === 'string' ? c.role : null, bbox: c.bbox as [number, number, number, number],
    }));
  // the server may also send the raw {added, changed, removed} id lists without boxes: count them
  const rawCounts = x?.changed && typeof x.changed === 'object' && !Array.isArray(x.changed)
    ? ['added', 'changed', 'removed'].reduce((n, k) => n + (Array.isArray(x.changed[k]) ? x.changed[k].length : 0), 0)
    : null;
  const versions = (Array.isArray(x?.versions) ? x.versions : []).map((v: Any) => num(typeof v === 'object' ? v?.version : v)).filter((v: number | null): v is number => v !== null);
  return {
    id: str(x?.id ?? x?.level_id ?? lv?.id),
    version: num(x?.version ?? lv?.version) ?? 1,
    versions,
    title: str(x?.title ?? lv?.title),
    author: str(x?.author ?? lv?.author),
    changed: changed ? changed.length : rawCounts ?? num(x?.changed_count),
    changed_bboxes: objs.map((o) => o.bbox),
    changed_objects: objs,
    thumbnail_url: (x?.thumbnail_url ?? null) as string | null,
    current: x?.current === true,
    screens: num(x?.screens ?? lv?.world?.screens) ?? 1,
    band: (typeof x?.band === 'string' ? x.band : null) as string | null,
    created_at: (x?.created_at ?? null) as string | null,
    children: (Array.isArray(x?.children) ? x.children : []).filter((c: unknown) => c && typeof c === 'object').map(toTree),
  };
}

function toPack(x: Any, fallback: Partial<PackInfo> = {}): PackInfo {
  const sheets = Array.isArray(x?.sheets) ? x.sheets : Array.isArray(x?.sheets_json) ? x.sheets_json : [];
  const scanned = sheets
    .map((s: Any) => (typeof s === 'number' ? s : s && (s.scanned || s.seen || s.status === 'scanned' || s.photo_url) ? num(s.index ?? s.n) : null))
    .filter((n: number | null): n is number => n !== null && n >= 1 && n <= 6);
  const kind = (['new', 'game', 'remix', 'extend'] as const).find((k) => k === x?.kind) ?? fallback.kind ?? 'new';
  return {
    pack_id: str(x?.pack_id ?? x?.id ?? fallback.pack_id),
    pdf_url: str(x?.pdf_url ?? fallback.pdf_url),
    kind,
    k: Math.max(1, Math.min(6, num(x?.k) ?? fallback.k ?? 1)),
    game_id: (x?.game_id ?? fallback.game_id ?? null) as string | null,
    parent_id: (x?.parent_id ?? fallback.parent_id ?? null) as string | null,
    scanned: [...new Set<number>(scanned)].sort((a, b) => a - b),
  };
}

function toRules(x: Any): GameRules | null {
  const r = x && typeof x === 'object' && 'version' in x ? x : x?.rules;
  return r && typeof r === 'object' && typeof r.version === 'number' ? (r as GameRules) : null;
}

function toRun(x: Any): RunRow {
  return {
    run_id: str(x?.run_id ?? x?.id), player: str(x?.player, '?'), time_ms: num(x?.time_ms ?? (num(x?.frames) ?? 0) * (1000 / 60)) ?? 0,
    deaths: num(x?.deaths) ?? 0, coins: num(x?.coins) ?? 0, big_coins: num(x?.big_coins) ?? 0,
    level_version: num(x?.level_version), board: (x?.board ?? null) as string | null, older: x?.older === true,
  };
}

const refs = (v: unknown): { key: string; args?: Record<string, unknown> }[] =>
  (Array.isArray(v) ? v : []).filter((m: Any) => m && typeof m.key === 'string').map((m: Any) => ({ key: m.key, args: m.args ?? {} }));

function toDraft(x: Any): LibraryDraft {
  return {
    box: num(x?.box) ?? 0, name: str(x?.name), name_source: x?.name_source === 'model' || x?.name_source === 'kid' ? x.name_source : 'default',
    letter: typeof x?.letter === 'string' ? x.letter : null, archetype: typeof x?.archetype === 'string' ? x.archetype : null,
    speed: x?.speed === 'slow' || x?.speed === 'fast' ? x.speed : 'normal', spiky: x?.spiky === true,
    behavior: (x?.behavior ?? { kind: 'static' }) as Behavior, collision: x?.collision === 'solid' || x?.collision === 'one_way' ? x.collision : 'none',
    art: (x?.art ?? { strokes: [], size_cells: [1, 1] }) as LibraryType['art'], symbol: (x?.symbol ?? null) as LibraryType['symbol'],
    asks: refs(x?.asks), warnings: refs(x?.warnings),
  };
}

export type Sort = 'new' | 'hot' | 'hard' | 'cleared';

export const api = {
  health: (): Promise<Health> => request<Health>('GET', '/health'),

  // ---- builds and drafts (§3.11) ----
  createBuild: (body: FormData): Promise<BuildAccepted> => request<BuildAccepted>('POST', '/builds', body),
  draft: (id: string, since?: number): Promise<{ state: 'running' | 'done' | 'failed'; events: BuildEvent[] }> =>
    request('GET', `/drafts/${encodeURIComponent(id)}${since === undefined ? '' : `?since=${since}`}`),
  putEdits: (id: string, statuses: Record<string, 'applied' | 'undone'>, kidEdits: EditOp[]): Promise<{ tiers?: TierSetSummary; rejected?: string[] } & Record<string, unknown>> =>
    request('PUT', `/drafts/${encodeURIComponent(id)}/edits`, { statuses, kid_edits: kidEdits }),
  answer: (id: string, askId: string, choice: string): Promise<{ tiers?: TierSetSummary }> =>
    request('POST', `/drafts/${encodeURIComponent(id)}/answers`, { ask_id: askId, choice }),
  dial: (id: string, tier: Tier): Promise<{ tier: Tier }> => request('POST', `/drafts/${encodeURIComponent(id)}/dial`, { tier }),
  redesign: (id: string): Promise<{ build_id: string; draft_id?: string | null }> => request('POST', `/drafts/${encodeURIComponent(id)}/redesign`, {}),
  critic: (id: string, telemetry: Telemetry): Promise<{ build_id: string; draft_id?: string | null }> =>
    request('POST', `/drafts/${encodeURIComponent(id)}/critic`, { telemetry }),

  // ---- levels ----
  publish: async (body: PublishBody): Promise<{ level: LevelV2 }> => afterPublish(await request<{ level: LevelV2 }>('POST', '/levels', await withContribution(body))), // v3 lane 5: quest_id / jam_id, submissions
  level: (id: string, version?: number): Promise<LevelResponse> =>
    request('GET', `/levels/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`),
  async tree(id: string): Promise<TreeNode> {
    const r = await request<Any>('GET', `/levels/${encodeURIComponent(id)}/tree`);
    return toTree(r?.tree ?? r?.root ?? r);
  },
  /** §2.6 "Upgrade to v2": a migrated v1-classic level re-run under v2-standard, saved as a new version. */
  upgradeLevel: (id: string): Promise<{ level: LevelV2; version: number; repairs: unknown[] }> =>
    request('POST', `/levels/${encodeURIComponent(id)}/upgrade`, {}),
  submitRun: (id: string, body: RunSubmit): Promise<RunResult> => request('POST', `/levels/${encodeURIComponent(id)}/runs`, body),
  async runs(id: string, board: 'any' | 'collector' = 'any', limit = 10): Promise<RunRow[]> {
    return (await api.board(id, board, limit)).runs;
  },
  /** A board: its runs (each player's best, current version first) and the creator's best run. */
  async board(id: string, board: 'any' | 'collector' = 'any', limit = 10): Promise<{ runs: RunRow[]; creator: RunRow | null }> {
    const r = await request<Any>('GET', `/levels/${encodeURIComponent(id)}/runs?board=${board}&limit=${limit}`);
    const runs = (Array.isArray(r) ? r : Array.isArray(r?.runs) ? r.runs : []).map(toRun);
    return { runs, creator: r?.creator && typeof r.creator === 'object' ? toRun(r.creator) : null };
  },
  async run(runId: string): Promise<{ run: RunRow; replay: Replay; sprite_url: string | null }> {
    const r = await request<Any>('GET', `/runs/${encodeURIComponent(runId)}`);
    return { run: toRun(r?.run ?? r), replay: r?.replay as Replay, sprite_url: (r?.sprite_url ?? null) as string | null };
  },
  attempts: (id: string, body: AttemptsBody): Promise<void> =>
    request('POST', `/levels/${encodeURIComponent(id)}/attempts`, body, { raw: true, keepalive: true }),
  thumbnail: (id: string, png: Blob): Promise<void> => request('PUT', `/levels/${encodeURIComponent(id)}/thumbnail`, png, { raw: true }),

  // ---- games ----
  async games(sort: Sort): Promise<{ games: GameCard[]; levels: LevelCard[] }> {
    const r = await request<Any>('GET', `/games?sort=${sort}`);
    const games = (Array.isArray(r) ? r : Array.isArray(r?.games) ? r.games : []).map(toGameCard);
    const levels = (Array.isArray(r?.levels) ? r.levels : Array.isArray(r?.items) ? r.items : []).map(toLevelCard);
    return { games, levels };
  },
  async createGame(title: string, author: string): Promise<GameCard> {
    const r = await request<Any>('POST', '/games', { title, author });
    return toGameCard(r?.game ?? r);
  },
  async game(id: string): Promise<GameCard> {
    const r = await request<Any>('GET', `/games/${encodeURIComponent(id)}`);
    const g = toGameCard(r?.game ?? r);
    if (!g.levels.length && Array.isArray(r?.levels)) g.levels = r.levels.map(toLevelCard).sort((a: LevelCard, b: LevelCard) => a.order_index - b.order_index);
    if (!g.remixes.length && Array.isArray(r?.remixes)) g.remixes = r.remixes.map(toLevelCard);
    return g;
  },
  async library(gameId: string): Promise<LibraryType[]> {
    const r = await request<Any>('GET', `/games/${encodeURIComponent(gameId)}/library`);
    return Array.isArray(r) ? r : Array.isArray(r?.types) ? r.types : [];
  },
  addLibrary: (gameId: string, type: LibraryType): Promise<LibraryType> => request('POST', `/games/${encodeURIComponent(gameId)}/library`, type),
  /**
   * A new immutable version of an existing type (§8.1 "Editing a type creates version n + 1"). The dedicated route
   * is tried first; while it is not live, posting the same id to the game's library makes the next version too.
   */
  async newLibraryVersion(gameId: string, type: LibraryType): Promise<LibraryType> {
    try {
      return await request<LibraryType>('POST', `/library/${encodeURIComponent(type.id)}/versions`, type);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 501 || e.status === 404 || e.status === 405)) {
        return request<LibraryType>('POST', `/games/${encodeURIComponent(gameId)}/library`, type);
      }
      throw e;
    }
  },
  libraryType: (typeId: string, version?: number): Promise<LibraryType> =>
    request('GET', `/library/${encodeURIComponent(typeId)}${version ? `?v=${version}` : ''}`),
  /** Rebuild and re-verify every level that pins an older version, publishing the ones that still work. */
  async updateLevels(typeId: string, version: number): Promise<{ updated: { level_id: string; version: number }[]; broken: { level_id: string; reason_key: string }[] }> {
    const r = await request<Any>('POST', `/library/${encodeURIComponent(typeId)}/update-levels?v=${version}`, {});
    return {
      updated: (Array.isArray(r?.updated) ? r.updated : []).map((u: Any) => ({ level_id: str(u?.level_id), version: num(u?.version) ?? 1 })),
      broken: (Array.isArray(r?.broken) ? r.broken : []).map((b: Any) => ({ level_id: str(b?.level_id), reason_key: str(b?.reason_key, 'library.update_breaks') })),
    };
  },
  /** Read a photographed Library Sheet (`dal2|lib|<game>`): one draft per filled box. */
  async scanLibrarySheet(photo: Blob, gameId: string | null): Promise<LibraryDraft[]> {
    const form = new FormData();
    form.append('photo', photo, 'library.jpg');
    if (gameId) form.append('game_id', gameId);
    const r = await request<Any>('POST', '/scan/library-sheet', form);
    return (Array.isArray(r?.drafts) ? r.drafts : []).map(toDraft);
  },
  async interpret(name: string, text: string, ink: InkStroke[]): Promise<InterpretOut> {
    const r = await request<Any>('POST', '/library/interpret', { name, text, ink });
    return { spec: r?.spec as CreatureSpecJson, behavior: r?.behavior as Behavior, source: r?.source === 'model' ? 'model' : 'keywords' };
  },

  // ---- game rules (§8.2) ----
  async rules(gameId: string): Promise<GameRules | null> {
    return toRules(await request<Any>('GET', `/games/${encodeURIComponent(gameId)}/rules`));
  },
  /**
   * Save the game's rules (version + 1). `apply: 'all'` also rebuilds every level of the game under them (the server
   * dry-runs first and answers 409 rules.blocked when one would break); `repair` lets the designer make Faithful
   * repairs on those and saves each as a new version.
   */
  async putRules(gameId: string, rules: GameRules, o: { apply?: 'none' | 'all'; repair?: boolean } = {}): Promise<{ rules: GameRules | null; applied: number; failed: number }> {
    const q = o.apply === 'all' ? `?apply=all${o.repair ? '&repair=1' : ''}` : '';
    const r = await request<Any>('PUT', `/games/${encodeURIComponent(gameId)}/rules${q}`, rules);
    return { rules: toRules(r), applied: Array.isArray(r?.applied) ? r.applied.length : 0, failed: Array.isArray(r?.failed) ? r.failed.length : 0 };
  },
  /** Read a photographed Rules Sheet (`dal2|rules|<game>`): the ticked boxes as a rules patch, plus questions. */
  async scanRulesSheet(photo: Blob): Promise<RulesSheetRead> {
    const form = new FormData();
    form.append('photo', photo, 'rules.jpg');
    const r = await request<Any>('POST', '/scan/rules-sheet', form);
    return {
      patch: r?.patch && typeof r.patch === 'object' ? r.patch : {}, asks: refs(r?.asks), warnings: refs(r?.x_warnings ?? r?.warnings),
      story: typeof r?.story === 'string' ? r.story : null, title_suggestion: typeof r?.title_suggestion === 'string' ? r.title_suggestion : null,
      game_id: typeof r?.game_id === 'string' ? r.game_id : null,
    };
  },
  async rulesCheck(gameId: string, rules: GameRules): Promise<AffectedLevel[]> {
    const r = await request<Any>('POST', `/games/${encodeURIComponent(gameId)}/rules/check`, rules);
    return (Array.isArray(r?.affected) ? r.affected : []).filter((a: Any) => a && typeof a.level_id === 'string')
      .map((a: Any) => ({
        level_id: a.level_id, reason_key: str(a.reason_key, 'rules.becomes_unsolvable'),
        repairable: typeof a.repairable === 'boolean' ? a.repairable : null, repairs: Array.isArray(a.repairs) ? a.repairs : [],
        level_hash: typeof a.level_hash === 'string' ? a.level_hash : null,
      }));
  },

  // ---- prompt-to-level (§8.3) ----
  async promptLevel(body: { prompt: string; game_id: string | null; screens: number; dial: Dial; band: ChallengeBand | null }): Promise<BuildAccepted> {
    const r = await request<Any>('POST', '/prompt-levels', body);
    return { build_id: str(r?.build_id), draft_id: str(r?.draft_id), events_url: str(r?.events_url, r?.build_id ? `/api/v2/builds/${r.build_id}/events` : '') };
  },

  // ---- paper packs (§6.4) ----
  async createPack(body: PackCreate): Promise<PackInfo> {
    const r = await request<Any>('POST', '/packs', body);
    return toPack(r, { kind: body.kind, k: body.k, game_id: body.game_id ?? null, parent_id: body.parent_id ?? null });
  },
  async pack(id: string): Promise<PackInfo> {
    return toPack(await request<Any>('GET', `/packs/${encodeURIComponent(id)}`), { pack_id: id });
  },
  // ---- export / import (§8.5) ----
  exportUrl: (what: 'level' | 'game', id: string): string => `${BASE}/${what === 'level' ? 'levels' : 'games'}/${encodeURIComponent(id)}/export`,
  async importZip(file: Blob): Promise<{ game_id: string | null; levels: string[]; types: number }> {
    const form = new FormData();
    form.append('file', file, 'level.zip');
    const r = await request<Any>('POST', '/import', form);
    const levels = (Array.isArray(r?.levels) ? r.levels : []).map((l: Any) => (typeof l === 'string' ? l : str(l?.id ?? l?.level_id))).filter(Boolean);
    return { game_id: typeof r?.game_id === 'string' ? r.game_id : null, levels, types: Array.isArray(r?.types) ? r.types.length : num(r?.types) ?? 0 };
  },

  /** Fetch a PDF (template or pack) so a 501/404 shows a sentence instead of a raw JSON page. */
  async pdf(url: string): Promise<Blob> {
    let r: Response;
    try {
      r = await fetch(url);
    } catch {
      throw new ApiError(0, 'error.network');
    }
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { message_key?: string; args?: Record<string, unknown>; detail?: { message_key?: string } } | null;
      const key = j?.message_key ?? j?.detail?.message_key;
      throw new ApiError(r.status, key && hasMessage(key) ? key : defaultKey(r.status), j?.args ?? {});
    }
    return r.blob();
  },
};
