/**
 * The contribution path (lane 5): what the kid is drawing for (a game, a quest, a jam), carried from "I'll do it!" or
 * "Join the jam" through the editor to publish. api.publish() calls withContribution() to add `quest_id` / `jam_id`
 * to the publish body (and asks "Who are you?" when a level for a game has no player yet), and afterPublish() to
 * cheer a submission ("Sent to the team!") and remember it on this device for the profile page.
 * Imports only identity/dom/messages/store (api.ts imports this module).
 */
import type { PublishBody } from '../../core/types.gen.ts';
import { card, h, icon } from '../dom.ts';
import { currentPlayer, ensurePlayer } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { store } from '../store.ts';

export interface Contribution {
  game_id: string | null;
  quest_id: string | null;
  quest_title: string | null;
  jam_id: string | null;
  jam_title: string | null;
  at: number;
}

export interface LocalSubmission {
  id: string;
  game_id: string | null;
  game_title: string;
  level_id: string;
  title: string;
  created_at: string;
}

const CTX = 'dp.v3.contrib';
const SUBS = 'dp.v3.subs';
/** A quest or jam stays attached to the next publish for this long. */
const FRESH_MS = 6 * 3600_000;

function get<T>(k: string): T | null {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function put(k: string, v: unknown): void {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage off */
  }
}

export function contribution(): Contribution | null {
  const c = get<Contribution>(CTX);
  return c && Date.now() - (c.at ?? 0) < FRESH_MS ? c : null;
}

export function setContribution(c: Partial<Omit<Contribution, 'at'>>): void {
  const prev = contribution();
  const same = prev && (prev.game_id ?? null) === (c.game_id ?? prev.game_id ?? null);
  put(CTX, {
    game_id: c.game_id ?? (same ? prev?.game_id : null) ?? null,
    quest_id: c.quest_id !== undefined ? c.quest_id : same ? prev?.quest_id ?? null : null,
    quest_title: c.quest_title !== undefined ? c.quest_title : same ? prev?.quest_title ?? null : null,
    jam_id: c.jam_id !== undefined ? c.jam_id : same ? prev?.jam_id ?? null : null,
    jam_title: c.jam_title !== undefined ? c.jam_title : same ? prev?.jam_title ?? null : null,
    at: Date.now(),
  } satisfies Contribution);
}

export function clearContribution(): void {
  put(CTX, null);
}

/** main.ts: `#/draw?game=…&quest=…` or `&jam=…` (also scan / prompt / library) remembers what this drawing is for. */
export function captureContribution(query: URLSearchParams): Contribution | null {
  const quest = query.get('quest');
  const jam = query.get('jam');
  if (!quest && !jam) return null;
  const game = query.get('game');
  const prev = contribution();
  setContribution({
    game_id: game ?? prev?.game_id ?? null,
    quest_id: quest ?? (prev?.game_id === game ? prev?.quest_id ?? null : null),
    quest_title: quest && prev?.quest_id === quest ? prev.quest_title : quest ? null : prev?.quest_title ?? null,
    jam_id: jam ?? (prev?.game_id === game ? prev?.jam_id ?? null : null),
    jam_title: jam && prev?.jam_id === jam ? prev.jam_title : jam ? null : prev?.jam_title ?? null,
  });
  return contribution();
}

/** The game a draft was drawn for (the editor keeps its document per draft). */
function draftGame(draftId: string): string | null | undefined {
  const d = store.draftDoc(draftId);
  return d ? d.gameId ?? null : undefined;
}

/**
 * The publish body plus `quest_id` / `jam_id` when this draft is the quest's or jam's level. A level for a game asks
 * "Who are you?" first so it is credited (closing the sheet still publishes, as before).
 */
export async function withContribution(body: PublishBody): Promise<PublishBody & { quest_id?: string; jam_id?: string }> {
  const game = draftGame(body.draft_id);
  if (game && !currentPlayer()) await ensurePlayer().catch(() => null);
  const c = contribution();
  if (!c) return body;
  // the draft's game must match; a draft we know nothing about (paper, prompt) only takes a very fresh context
  const matches = game === undefined ? Date.now() - c.at < 2 * 3600_000 : !c.game_id || c.game_id === game;
  if (!matches) return body;
  const extra: { quest_id?: string; jam_id?: string } = {};
  if (c.quest_id) extra.quest_id = c.quest_id;
  if (c.jam_id) extra.jam_id = c.jam_id;
  return { ...body, ...extra };
}

type Any = any;

/** After POST /levels: clear a used quest/jam, remember a submission and say it went to the game's team. */
export function afterPublish<T>(res: T): T {
  const r = res as Any;
  const c = contribution();
  if (c && (c.quest_id || c.jam_id)) clearContribution();
  const sub = r?.submission;
  if (sub && typeof sub === 'object' && sub.id) {
    const level = r?.level ?? {};
    const mine: LocalSubmission = {
      id: String(sub.id), game_id: sub.game_id ?? level.game_id ?? null, game_title: String(sub.game_title ?? ''),
      level_id: String(level.id ?? sub.level_id ?? ''), title: String(level.title ?? sub.title ?? ''), created_at: new Date().toISOString(),
    };
    put(SUBS, [mine, ...mySubmissions().filter((s) => s.id !== mine.id)].slice(0, 60));
    window.setTimeout(() => showSent(mine), 60);
  }
  return res;
}

export function mySubmissions(): LocalSubmission[] {
  const v = get<LocalSubmission[]>(SUBS);
  return Array.isArray(v) ? v.filter((s) => s && typeof s.id === 'string') : [];
}

function showSent(s: LocalSubmission): void {
  const close = (): void => back.remove();
  const back = h('div', { class: 'modal-back collab-top' }, card('narrow celebrate collab-sent',
    h('div', { class: 'collab-big-emoji', 'aria-hidden': 'true' }, '📬'),
    h('h2', { class: 'marker-underline' }, t('collab.sent.title')),
    h('p', null, t('collab.sent.body', { game: kidText(s.game_title || t('collab.sent.the_game')) })),
    h('p', { class: 'small muted' }, t('collab.sent.bell')),
    h('div', { class: 'row wrap end' },
      s.game_id ? h('button', { type: 'button', class: 'pill', onclick: () => { close(); navigate(`#/game/${encodeURIComponent(s.game_id!)}`); } }, icon('home'), t('collab.sent.see_game')) : '',
      h('button', { type: 'button', class: 'pill primary', onclick: close }, t('ui.ok')))));
  document.body.append(back);
}
