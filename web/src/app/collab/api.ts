/**
 * Collaboration API client (v3 contract, lane 4 backend). Prefix /api/v2/collab; every call sends authHeaders().
 * Shapes are read tolerantly (lists may come bare or wrapped, players embedded or flattened) so the screens keep
 * working while the backend settles. Errors are ApiError with a message key, like the main api.ts.
 */
import type { LevelV2 } from '../../core/types.gen.ts';
import { ApiError, toLevelCard, type LevelCard } from '../api.ts';
import { authHeaders, forgetPlayer, type Player } from '../identity.ts';
import { hasMessage } from '../messages.ts';

const BASE = '/api/v2/collab';

export type Role = 'owner' | 'maintainer' | 'contributor';
export type OpenFor = 'everyone' | 'invite';
export type SubStatus = 'pending' | 'accepted' | 'changes' | 'declined';
export type QuestKind = 'level' | 'creature' | 'art' | 'fix';
export type Decision = 'accept' | 'changes' | 'decline';

/** What the acting profile may do in a game (bible / members / submissions / quests carry it). */
export interface Viewer {
  role: Role | null;
  keeper: boolean;
  can_manage_members: boolean;
  can_take_part: boolean;
  claimable: boolean;
}

export interface Bible {
  viewer: Viewer | null;
  game_id: string;
  pitch: string;
  mechanics_text: string;
  style_id: string | null;
  style_prompt: string | null;
  style_image_url: string | null;
  starter_type_ids: string[];
  open_for: OpenFor;
  owner_id: string | null;
}

export interface BiblePut {
  pitch: string;
  mechanics_text: string;
  style_id?: string | null;
  style_prompt?: string | null;
  starter_type_ids: string[];
  open_for: OpenFor;
}

export interface Member {
  player: Player;
  role: Role;
}

export interface Comment {
  id: string;
  player: Player | null;
  text: string;
  created_at: string | null;
}

export interface Submission {
  id: string;
  status: SubStatus;
  game_id: string | null;
  game_title: string;
  level_id: string;
  level_version: number | null;
  title: string;
  level: LevelV2 | null;
  card: LevelCard;
  player: Player | null;
  votes: number;
  voted: boolean;
  comments: Comment[];
  comments_count: number;
  note: string | null;
  quest_id: string | null;
  quest_title: string | null;
  jam_id: string | null;
  created_at: string | null;
}

export interface Quest {
  id: string;
  game_id: string | null;
  title: string;
  description: string;
  kind: QuestKind;
  reward_badge: string | null;
  status: 'open' | 'claimed' | 'done';
  claimers: Player[];
  created_by: Player | null;
  level_id: string | null;
  created_at: string | null;
}

export interface CreditItem {
  id: string | null;
  title: string;
  tool: string | null;
  url: string | null;
}

export interface Contributor {
  player: Player;
  role: Role | null;
  levels: CreditItem[];
  creatures: CreditItem[];
  art: CreditItem[];
  quests: CreditItem[];
  counts: { levels: number; creatures: number; art: number; quests: number; reviews: number };
}

export interface FeedItem {
  id: string;
  kind: string;
  key: string | null;
  args: Record<string, unknown>;
  text: string | null;
  player: Player | null;
  game_id: string | null;
  game_title: string | null;
  level_id: string | null;
  level_title: string | null;
  submission_id: string | null;
  quest_id: string | null;
  quest_title: string | null;
  jam_id: string | null;
  badge: string | null;
  count: number | null;
  link: string | null;
  created_at: string | null;
  read: boolean;
}

export interface Jam {
  id: string;
  title: string;
  theme: string;
  starts_at: string | null;
  ends_at: string | null;
  game_id: string | null;
  game_title: string | null;
  status: 'soon' | 'live' | 'over' | null;
  entries: Submission[];
  entry_count: number;
  created_by: Player | null;
}

export interface ProfileLevel extends LevelCard {
  plays: number | null;
}

export interface PlayerGame {
  game_id: string;
  title: string;
  role: Role;
}

export interface PlayerPage {
  player: Player;
  games: PlayerGame[];
  badges: string[];
  stats: Record<string, number>;
  levels: ProfileLevel[];
  submissions: Submission[];
}

type Any = any;

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v === undefined || v === null ? d : String(v));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const list = (r: Any, ...keys: string[]): Any[] => {
  if (Array.isArray(r)) return r;
  for (const k of keys) if (Array.isArray(r?.[k])) return r[k];
  return [];
};

async function creq<T>(method: string, path: string, body?: unknown, base = BASE): Promise<T> {
  let r: Response;
  try {
    const headers: Record<string, string> = { ...authHeaders() };
    const init: RequestInit = { method, headers };
    if (body instanceof FormData || body instanceof Blob) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    r = await fetch(`${base}${path}`, init);
  } catch {
    throw new ApiError(0, 'error.network');
  }
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as Any;
    const m = j && typeof j === 'object' && j.detail && typeof j.detail === 'object' ? j.detail : j;
    // a saved token the server no longer knows: forget it, so the next action asks "Who are you?" again
    if (r.status === 401 && Object.keys(authHeaders()).length) forgetPlayer();
    // FastAPI answers a route that does not exist yet with {"detail": "Not Found"}: that part isn't ready
    const missingRoute = r.status === 404 && j?.detail === 'Not Found';
    const key = typeof m?.message_key === 'string' && hasMessage(m.message_key) ? m.message_key
      : r.status === 401 ? 'collab.need_profile'
        : r.status === 403 ? 'collab.not_allowed'
          : missingRoute || r.status === 501 ? 'collab.not_ready'
            : r.status === 404 ? 'error.not_found'
              : r.status === 409 ? 'collab.already'
                : r.status === 429 ? 'error.rate_limited'
                  : r.status === 400 || r.status === 422 ? 'error.bad_request' : 'error.network';
    throw new ApiError(r.status, key, (m?.args ?? {}) as Record<string, unknown>, j);
  }
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---- tolerant readers ---------------------------------------------------------------------------------------------

export function toPlayer(x: Any): Player | null {
  if (!x) return null;
  if (typeof x === 'string') return { id: x, name: x, avatar_url: null };
  const p = x.player && typeof x.player === 'object' ? x.player : x;
  const id = strOrNull(p.id ?? p.player_id);
  const name = str(p.name ?? p.player_name ?? p.display_name);
  if (!id && !name) return null;
  const avatar = p.avatar_url ?? p.avatar ?? null;
  return { id: id ?? `name:${name}`, name, avatar_url: typeof avatar === 'string' && avatar ? avatar : null };
}

function role(v: unknown): Role {
  return v === 'owner' || v === 'maintainer' ? v : 'contributor';
}

export function toViewer(v: Any): Viewer | null {
  if (!v || typeof v !== 'object') return null;
  return {
    role: v.role === 'owner' || v.role === 'maintainer' || v.role === 'contributor' ? v.role : null,
    keeper: v.keeper === true || v.role === 'owner' || v.role === 'maintainer',
    can_manage_members: v.can_manage_members === true,
    can_take_part: v.can_take_part !== false && v.can_participate !== false,
    claimable: v.claimable === true,
  };
}

function toBible(x: Any, gameId: string): Bible {
  const b = x?.bible && typeof x.bible === 'object' ? x.bible : x ?? {};
  const ids = Array.isArray(b.starter_type_ids) ? b.starter_type_ids : Array.isArray(b.starters) ? b.starters : [];
  return {
    viewer: toViewer(x?.viewer ?? b.viewer),
    game_id: str(b.game_id, gameId),
    pitch: str(b.pitch),
    mechanics_text: str(b.mechanics_text ?? b.mechanics),
    style_id: strOrNull(b.style_id),
    style_prompt: strOrNull(b.style_prompt),
    style_image_url: strOrNull(b.style_image_url ?? b.style_url ?? b.image_url ?? b.style?.image_url),
    starter_type_ids: ids.map((v: Any) => (typeof v === 'string' ? v : str(v?.id))).filter(Boolean),
    open_for: b.open_for === 'invite' ? 'invite' : 'everyone',
    owner_id: strOrNull(b.owner_id ?? b.owner?.id ?? x?.owner_id),
  };
}

function toMember(x: Any): Member | null {
  const p = toPlayer(x?.player ?? x);
  return p ? { player: p, role: role(x?.role) } : null;
}

function toComment(x: Any, i: number): Comment {
  return { id: str(x?.id, `c${i}`), player: toPlayer(x?.player ?? x?.author), text: str(x?.text ?? x?.body), created_at: strOrNull(x?.created_at) };
}

function subStatus(v: unknown): SubStatus {
  if (v === 'accepted' || v === 'accept') return 'accepted';
  if (v === 'changes' || v === 'changes_requested' || v === 'needs_changes') return 'changes';
  if (v === 'declined' || v === 'decline' || v === 'rejected') return 'declined';
  return 'pending';
}

export function toSubmission(x: Any): Submission {
  const lv: LevelV2 | null = x?.level?.format === 'dal-level' ? x.level : x?.level_json?.format === 'dal-level' ? x.level_json : null;
  const levelId = str(x?.level_id ?? lv?.id ?? (typeof x?.level === 'string' ? x.level : ''));
  const version = num(x?.level_version ?? x?.version ?? lv?.version);
  const card = toLevelCard({ ...(x?.level && typeof x.level === 'object' ? x.level : {}), ...(lv ? { level: lv } : {}), id: levelId, version: version ?? undefined, title: x?.title ?? lv?.title, author: x?.player?.name ?? x?.author ?? lv?.author, thumbnail_url: x?.thumbnail_url ?? x?.level?.thumbnail_url ?? null, game_id: x?.game_id ?? null });
  const votes = num(x?.votes) ?? (Array.isArray(x?.votes) ? x.votes.length : null) ?? 0;
  return {
    id: str(x?.id ?? x?.submission_id),
    status: subStatus(x?.status),
    game_id: strOrNull(x?.game_id ?? x?.game?.id),
    game_title: str(x?.game_title ?? x?.game?.title),
    level_id: levelId,
    level_version: version,
    title: str(x?.title ?? lv?.title ?? x?.level?.title),
    level: lv,
    card,
    player: toPlayer(x?.player ?? x?.contributor ?? x?.author_player ?? (x?.player_id ? { id: x.player_id, name: x?.player_name ?? x?.author } : null)),
    votes,
    voted: x?.voted === true || x?.my_vote === 1,
    comments: list(x?.comments).map(toComment),
    comments_count: num(x?.comments_count) ?? list(x?.comments).length,
    note: strOrNull(x?.note ?? x?.review_note ?? x?.review?.note),
    quest_id: strOrNull(x?.quest_id),
    quest_title: strOrNull(x?.quest_title),
    jam_id: strOrNull(x?.jam_id),
    created_at: strOrNull(x?.created_at),
  };
}

function questKind(v: unknown): QuestKind {
  return v === 'creature' || v === 'art' || v === 'fix' ? v : 'level';
}

export function toQuest(x: Any): Quest {
  const claim = x?.claimers ?? x?.claimed_by ?? x?.claims ?? null;
  const claimers = (Array.isArray(claim) ? claim : claim ? [claim] : []).map((c: Any) => toPlayer(c?.player ?? c)).filter((p: Player | null): p is Player => !!p);
  const st = x?.status === 'done' || x?.status === 'filled' || x?.status === 'closed' ? 'done' : x?.status === 'claimed' || claimers.length ? 'claimed' : 'open';
  return {
    id: str(x?.id ?? x?.quest_id),
    game_id: strOrNull(x?.game_id),
    title: str(x?.title),
    description: str(x?.description),
    kind: questKind(x?.kind),
    reward_badge: strOrNull(x?.reward_badge),
    status: st,
    claimers,
    created_by: toPlayer(x?.created_by ?? x?.author),
    level_id: strOrNull(x?.level_id),
    created_at: strOrNull(x?.created_at),
  };
}

function creditItems(v: Any): { items: CreditItem[]; n: number } {
  if (typeof v === 'number') return { items: [], n: v };
  const arr = Array.isArray(v) ? v : [];
  const items = arr.map((x: Any) => (typeof x === 'string'
    ? { id: x, title: '', tool: null, url: null }
    : {
      id: strOrNull(x?.id ?? x?.level_id ?? x?.type_id), title: str(x?.title ?? x?.name ?? x?.label),
      tool: strOrNull(x?.tool ?? x?.credit?.tool), url: strOrNull(x?.url ?? x?.image_url),
    }));
  return { items, n: items.length };
}

function toContributor(x: Any): Contributor | null {
  const p = toPlayer(x?.player ?? x);
  if (!p) return null;
  const l = creditItems(x?.levels);
  const c = creditItems(x?.creatures);
  const a = creditItems(x?.art);
  const q = creditItems(x?.quests);
  const rv = creditItems(x?.reviews);
  return {
    player: p, role: x?.role ? role(x.role) : null, levels: l.items, creatures: c.items, art: a.items, quests: q.items,
    counts: { levels: l.n, creatures: c.n, art: a.n, quests: q.n, reviews: rv.n },
  };
}

export function toFeedItem(x: Any, i = 0): FeedItem {
  const args = x?.args && typeof x.args === 'object' ? x.args : {};
  const key = strOrNull(x?.message_key ?? x?.key);
  return {
    id: str(x?.id, `f${i}`),
    kind: str(x?.kind ?? x?.type ?? x?.event),
    key: key && hasMessage(key) ? key : null,
    args,
    text: strOrNull(x?.text ?? x?.message),
    player: toPlayer(x?.player ?? x?.actor ?? x?.by),
    game_id: strOrNull(x?.game_id ?? x?.game?.id ?? args.game_id),
    game_title: strOrNull(x?.game_title ?? x?.game?.title ?? args.game),
    level_id: strOrNull(x?.level_id ?? x?.level?.id ?? args.level_id),
    level_title: strOrNull(x?.level_title ?? x?.title ?? x?.level?.title ?? args.title),
    submission_id: strOrNull(x?.submission_id ?? args.submission_id),
    quest_id: strOrNull(x?.quest_id ?? args.quest_id),
    quest_title: strOrNull(x?.quest_title ?? x?.quest?.title ?? args.quest),
    jam_id: strOrNull(x?.jam_id ?? args.jam_id),
    badge: strOrNull(x?.badge ?? x?.badge_id ?? args.badge),
    count: num(x?.count ?? x?.plays ?? args.n),
    link: strOrNull(x?.link ?? x?.url ?? x?.href),
    created_at: strOrNull(x?.created_at ?? x?.at ?? x?.ts),
    read: x?.read === true || !!x?.read_at,
  };
}

function toJam(x: Any): Jam {
  const entries = list(x?.entries, 'submissions').filter((e: Any) => e && typeof e === 'object').map(toSubmission);
  return {
    id: str(x?.id ?? x?.jam_id),
    title: str(x?.title),
    theme: str(x?.theme),
    starts_at: strOrNull(x?.starts_at),
    ends_at: strOrNull(x?.ends_at),
    game_id: strOrNull(x?.game_id),
    game_title: strOrNull(x?.game_title ?? x?.game?.title),
    status: x?.status === 'upcoming' || x?.status === 'soon' ? 'soon' : x?.status === 'ended' || x?.status === 'over' ? 'over' : x?.status === 'live' ? 'live' : null,
    entries,
    entry_count: num(x?.entry_count ?? x?.entries_count) ?? (typeof x?.entries === 'number' ? x.entries : entries.length),
    created_by: toPlayer(x?.created_by ?? x?.host),
  };
}

function toStats(x: Any): Record<string, number> {
  const out: Record<string, number> = {};
  if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) {
    const n = num(v);
    if (n !== null) out[k] = n;
  }
  return out;
}

function toBadges(x: Any): string[] {
  return list(x, 'badges').map((b: Any) => (typeof b === 'string' ? b : str(b?.id ?? b?.badge ?? b?.badge_id))).filter(Boolean);
}

function toPlayerPage(r: Any): PlayerPage {
  const p = toPlayer(r?.player ?? r) ?? { id: '', name: '', avatar_url: null };
  const levels = list(r?.levels).map((x: Any) => ({ ...toLevelCard(x), plays: num(x?.plays ?? x?.stats?.plays ?? x?.play_count) }));
  const games = list(r?.games).map((g: Any) => ({ game_id: str(g?.game_id ?? g?.id), title: str(g?.title), role: role(g?.role) })).filter((g: PlayerGame) => g.game_id);
  return { player: p, games, badges: toBadges(r?.badges), stats: toStats(r?.stats), levels, submissions: list(r?.submissions).map(toSubmission) };
}

const enc = encodeURIComponent;

export const collab = {
  // ---- players ----
  me: async (): Promise<PlayerPage> => toPlayerPage(await creq<Any>('GET', '/players/me')),
  player: async (id: string): Promise<PlayerPage> => toPlayerPage(await creq<Any>('GET', `/players/${enc(id)}`)),

  // ---- the game's bible and members ----
  bible: async (gameId: string): Promise<Bible> => toBible(await creq<Any>('GET', `/games/${enc(gameId)}/bible`), gameId),
  putBible: async (gameId: string, b: BiblePut): Promise<Bible> => toBible(await creq<Any>('PUT', `/games/${enc(gameId)}/bible`, b), gameId),
  members: async (gameId: string): Promise<Member[]> =>
    list(await creq<Any>('GET', `/games/${enc(gameId)}/members`), 'members', 'items').map(toMember).filter((m: Member | null): m is Member => !!m),
  addMember: async (gameId: string, playerId: string, r: 'maintainer' | 'contributor'): Promise<Member[]> =>
    list(await creq<Any>('POST', `/games/${enc(gameId)}/members`, { player_id: playerId, role: r }), 'members', 'items').map(toMember).filter((m: Member | null): m is Member => !!m),
  removeMember: async (gameId: string, playerId: string): Promise<void> => {
    await creq<Any>('DELETE', `/games/${enc(gameId)}/members/${enc(playerId)}`);
  },
  join: async (gameId: string): Promise<Member | null> => toMember(await creq<Any>('POST', `/games/${enc(gameId)}/join`, {})),

  // ---- submissions and review ----
  submissions: async (gameId: string, status?: SubStatus): Promise<Submission[]> =>
    list(await creq<Any>('GET', `/games/${enc(gameId)}/submissions${status ? `?status=${status}` : ''}`), 'submissions', 'items').map(toSubmission),
  review: async (subId: string, decision: Decision, note: string): Promise<Submission> =>
    toSubmission(await creq<Any>('POST', `/submissions/${enc(subId)}/review`, { decision, note })),
  comment: async (subId: string, text: string): Promise<Comment> => toComment(await creq<Any>('POST', `/submissions/${enc(subId)}/comments`, { text }), 0),
  /** 1 = thumbs up, 0 = take it back. */
  vote: async (subId: string, value: 1 | 0 = 1): Promise<number> => {
    const r = await creq<Any>('POST', `/submissions/${enc(subId)}/vote`, { value });
    return num(r?.votes) ?? num(r) ?? 0;
  },

  // ---- quests ----
  quests: async (gameId: string): Promise<Quest[]> => list(await creq<Any>('GET', `/games/${enc(gameId)}/quests`), 'quests', 'items').map(toQuest),
  postQuest: async (gameId: string, q: { title: string; description: string; kind: QuestKind; reward_badge?: string | null }): Promise<Quest[]> => {
    const r = await creq<Any>('POST', `/games/${enc(gameId)}/quests`, q);
    return Array.isArray(r) || Array.isArray(r?.quests) ? list(r, 'quests').map(toQuest) : r ? [toQuest(r)] : [];
  },
  claimQuest: async (questId: string): Promise<Quest> => toQuest(await creq<Any>('POST', `/quests/${enc(questId)}/claim`, {})),
  /** Keepers close a quest by hand (creature / art quests). */
  questDone: async (questId: string): Promise<Quest> => toQuest(await creq<Any>('POST', `/quests/${enc(questId)}/done`, {})),

  // ---- credits, activity, notifications ----
  /** Everyone who made the game (with a profile), and `authors`: level authors who never made a profile. */
  async credits(gameId: string): Promise<{ contributors: Contributor[]; authors: string[] }> {
    const r = await creq<Any>('GET', `/games/${enc(gameId)}/credits`);
    return {
      contributors: list(r, 'contributors', 'credits').map(toContributor).filter((c: Contributor | null): c is Contributor => !!c),
      authors: list(r?.authors).filter((a: unknown): a is string => typeof a === 'string' && !!a),
    };
  },
  activity: async (gameId?: string | null): Promise<FeedItem[]> =>
    list(await creq<Any>('GET', `/activity${gameId ? `?game_id=${enc(gameId)}` : ''}`), 'items', 'activity', 'feed').map(toFeedItem),
  async notifications(): Promise<{ items: FeedItem[]; unread: number }> {
    const r = await creq<Any>('GET', '/notifications');
    const items = list(r, 'items', 'notifications').map(toFeedItem);
    return { items, unread: num(r?.unread) ?? items.filter((i) => !i.read).length };
  },
  /** Mark some (ids) or all (no ids) notifications read. */
  markRead: async (ids?: string[]): Promise<void> => {
    await creq<Any>('POST', '/notifications/read', ids && ids.length ? { ids } : {});
  },

  // ---- jams ----
  jams: async (): Promise<Jam[]> => list(await creq<Any>('GET', '/jams'), 'jams', 'items').map(toJam),
  createJam: async (j: { title: string; theme: string; starts_at: string; ends_at: string; game_id?: string | null }): Promise<Jam[]> => {
    const r = await creq<Any>('POST', '/jams', j);
    return Array.isArray(r) || Array.isArray(r?.jams) ? list(r, 'jams').map(toJam) : r ? [toJam(r)] : [];
  },

  // ---- the game's style picture (lane 1, creative API) ----
  async styleFromText(gameId: string, description: string): Promise<{ style_id: string; image_url: string | null }> {
    const r = await creq<Any>('POST', '/style', { game_id: gameId, description }, '/api/v2/creative');
    return { style_id: str(r?.style_id), image_url: strOrNull(r?.image_url) };
  },
  async styleFromImage(gameId: string, image: Blob): Promise<{ style_id: string; image_url: string | null }> {
    const form = new FormData();
    form.append('image', image, 'style.png');
    form.append('game_id', gameId);
    const r = await creq<Any>('POST', '/style', form, '/api/v2/creative');
    return { style_id: str(r?.style_id), image_url: strOrNull(r?.image_url) };
  },
};
