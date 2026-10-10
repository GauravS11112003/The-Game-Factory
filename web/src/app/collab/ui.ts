/**
 * Shared collaboration bits (lane 5): avatars (the kid's drawn face, or a coloured initial), player chips, time-ago,
 * badges, role chips, bot verdicts, and the kid-sentence + deep link for every activity / notification item.
 */
import type { LevelV2 } from '../../core/types.gen.ts';
import { ApiError } from '../api.ts';
import { h, icon } from '../dom.ts';
import { currentPlayer, type Player } from '../identity.ts';
import { fmtClock, hasMessage, kidText, t } from '../messages.ts';
import { drops } from '../readout.ts';
import type { FeedItem, QuestKind, Role } from './api.ts';

const enc = encodeURIComponent;

/** Kid sentence for any error (ApiError keys, identity Error keys). */
export function errText(e: unknown, fallback = 'error.network'): string {
  if (e instanceof ApiError) return t(e.messageKey, e.args);
  if (e instanceof Error && hasMessage(e.message)) return t(e.message);
  return t(fallback);
}

const AV_COLORS = ['#ffe36e', '#f6b8b0', '#b9d7f5', '#c6e6c0', '#d9cff7', '#f8d2a8'];

function hash(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(x);
}

/** A round avatar: the drawn face when there is one, else the first letter on a pastel. */
export function avatar(p: Pick<Player, 'name' | 'avatar_url'> & { id?: string } | null, size = 32): HTMLElement {
  const name = p?.name || t('ui.someone');
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.5)}px` };
  if (p?.avatar_url) {
    const img = h('img', { class: 'collab-av', src: p.avatar_url, alt: '', style, loading: 'lazy', decoding: 'async' });
    img.onerror = () => img.replaceWith(initialAvatar(name, p.id ?? name, size));
    return img;
  }
  return initialAvatar(name, p?.id ?? name, size);
}

function initialAvatar(name: string, seed: string, size: number): HTMLElement {
  return h('span', {
    class: 'collab-av initial', 'aria-hidden': 'true',
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.52)}px`, background: AV_COLORS[hash(seed) % AV_COLORS.length] },
  }, (name.trim()[0] ?? '?').toUpperCase());
}

/** Avatar + name, linking to the profile when the player has a real id. */
export function playerChip(p: Player | null, o: { size?: number; fallbackName?: string; cls?: string } = {}): HTMLElement {
  const name = kidText(p?.name || o.fallbackName || t('ui.someone'));
  const shown = p ?? { id: o.fallbackName ?? '', name, avatar_url: null };
  const me = currentPlayer();
  const label = me && p && me.id === p.id ? t('collab.you_name', { name }) : name;
  const kids = [avatar(shown, o.size ?? 26), h('span', { class: 'collab-who-name' }, label)];
  const cls = `collab-chip${o.cls ? ` ${o.cls}` : ''}`;
  return p && p.id && !p.id.startsWith('name:') ? h('a', { class: cls, href: `#/profile/${enc(p.id)}` }, ...kids) : h('span', { class: cls }, ...kids);
}

/** A row of overlapping avatars (up to `max`, then "+n"). */
export function avatarStack(ps: Player[], max = 6, size = 28): HTMLElement {
  const shown = ps.slice(0, max);
  return h('span', { class: 'collab-stack', title: ps.map((p) => p.name).join(', ') },
    ...shown.map((p) => avatar(p, size)),
    ps.length > max ? h('span', { class: 'collab-av more', style: { width: `${size}px`, height: `${size}px` } }, `+${ps.length - max}`) : '');
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return t('collab.time.now');
  if (s < 3600) return t('collab.time.min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('collab.time.hour', { n: Math.floor(s / 3600) });
  if (s < 86400 * 30) return t('collab.time.day', { n: Math.floor(s / 86400) });
  return new Date(ts).toLocaleDateString();
}

export function dateText(iso: string | null): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

export function roleChip(r: Role | null): HTMLElement | '' {
  if (!r) return '';
  const s = t(`collab.role.${r}`);
  return h('span', { class: `collab-role role-${r}` }, s.charAt(0).toUpperCase() + s.slice(1));
}

// ---- badges --------------------------------------------------------------------------------------------------------

export const BADGES: { id: string; emoji: string }[] = [
  { id: 'first_level', emoji: '✏️' },
  { id: 'first_accept', emoji: '🎉' },
  { id: 'creature_maker', emoji: '🐾' },
  { id: 'quest_hero', emoji: '🦸' },
  { id: 'featured', emoji: '⭐' },
  { id: 'jam_entrant', emoji: '🎪' },
  { id: 'helper', emoji: '🤝' },
];

export function badgeEmoji(id: string): string {
  return BADGES.find((b) => b.id === id)?.emoji ?? '🏅';
}

export function badgeName(id: string): string {
  return hasMessage(`collab.badge.${id}`) ? t(`collab.badge.${id}`) : kidText(id);
}

/** A badge: earned ones say what you did (`_help`), the ones still to earn say how (`_how`). */
export function badgeEl(id: string, earned: boolean): HTMLElement {
  const key = earned ? `collab.badge.${id}_help` : `collab.badge.${id}_how`;
  const line = hasMessage(key) ? t(key) : '';
  return h('div', { class: `collab-badge${earned ? ' earned' : ''}`, title: line },
    h('span', { class: 'collab-badge-emo', 'aria-hidden': 'true' }, badgeEmoji(id)),
    h('span', { class: 'collab-badge-name' }, badgeName(id)),
    line ? h('span', { class: 'small muted' }, line) : '');
}

export const QUEST_EMOJI: Record<QuestKind, string> = { level: '🗺️', creature: '🐾', art: '🎨', fix: '🔧' };

// ---- the bot's verdict on a level (from its design report and meta) --------------------------------------------------

export function verdictEl(level: LevelV2 | null): HTMLElement {
  if (!level) return h('span', { class: 'small muted' }, t('collab.review.no_report'));
  const d = level.design;
  const bits: (HTMLElement | string)[] = [];
  if (d) {
    bits.push(d.solvable
      ? h('span', { class: 'collab-verdict ok' }, icon('bot'), ' ', d.fastest_ms ? t('collab.review.bot_cleared', { time: fmtClock(d.fastest_ms) }) : t('collab.review.bot_ok'))
      : h('span', { class: 'collab-verdict bad' }, icon('bot'), ' ', t('collab.review.bot_stuck')));
    if (d.band) {
      const n = drops(d.score ?? 0);
      bits.push(h('span', { class: `band-badge band-${d.band}` }, t(`band.${d.band}`), ' ', ...Array.from({ length: n }, () => icon('drop', 'ico drop full'))));
    }
  } else bits.push(h('span', { class: 'small muted' }, t('collab.review.no_report')));
  if (level.meta?.safety === 'unchecked') bits.push(h('span', { class: 'badge' }, t('badge.not_checked')));
  if (level.world?.screens > 1) bits.push(h('span', { class: 'small muted' }, t('home.screens', { n: level.world.screens })));
  return h('div', { class: 'row wrap collab-verdict-row' }, ...bits);
}

// ---- activity / notification sentences and links --------------------------------------------------------------------

type Kind = 'submission_new' | 'accepted' | 'changes' | 'declined' | 'played_100' | 'played' | 'beaten' | 'quest_done' | 'quest_claimed'
  | 'quest_new' | 'joined' | 'comment' | 'vote' | 'badge' | 'jam_new' | 'level_published' | 'generic';

export function feedKind(raw: string): Kind {
  const k = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (k.includes('accept')) return 'accepted';
  if (k.includes('change')) return 'changes';
  if (k.includes('decline') || k.includes('reject')) return 'declined';
  if (k.includes('submission') || k.includes('submit')) return 'submission_new';
  if (k.includes('play') && k.includes('100')) return 'played_100';
  if (k.includes('play')) return 'played';
  if (k.includes('beat') || k.includes('clear')) return 'beaten';
  if (k.includes('quest') && (k.includes('fill') || k.includes('done') || k.includes('complete'))) return 'quest_done';
  if (k.includes('quest') && k.includes('claim')) return 'quest_claimed';
  if (k.includes('quest')) return 'quest_new';
  if (k.includes('join') || k.includes('member')) return 'joined';
  if (k.includes('comment')) return 'comment';
  if (k.includes('vote')) return 'vote';
  if (k.includes('badge')) return 'badge';
  if (k.includes('jam')) return 'jam_new';
  if (k.includes('level') || k.includes('publish') || k.includes('remix') || k === 'updated') return 'level_published';
  return 'generic';
}

export function feedText(it: FeedItem): string {
  if (it.key) return t(it.key, it.args);
  const kind = feedKind(it.kind);
  const args = {
    who: it.player?.name || t('ui.someone'),
    game: it.game_title || t('collab.sent.the_game'),
    title: it.level_title || t('ui.untitled'),
    quest: it.quest_title || t('collab.feed.a_quest'),
    badge: it.badge ? badgeName(it.badge) : '',
    n: it.count ?? 10,
  };
  if (kind === 'generic' && it.text) return kidText(it.text);
  return t(`collab.feed.${kind}`, args);
}

export function feedEmoji(it: FeedItem): string {
  const kind = feedKind(it.kind);
  const m: Record<Kind, string> = {
    submission_new: '📬', accepted: '🎉', changes: '✏️', declined: '🙈', played_100: '🔥', played: '▶️', beaten: '🏁', quest_done: '🏆',
    quest_claimed: '🙋', quest_new: '🗺️', joined: '👋', comment: '💬', vote: '👍', badge: it.badge ? badgeEmoji(it.badge) : '🏅', jam_new: '🎪',
    level_published: '✨', generic: '🔔',
  };
  return m[kind];
}

export function feedLink(it: FeedItem): string {
  if (it.link && it.link.startsWith('#/')) return it.link;
  const g = it.game_id ? enc(it.game_id) : null;
  switch (feedKind(it.kind)) {
    case 'submission_new':
    case 'comment':
    case 'vote':
      return g ? `#/review/${g}` : '#/me';
    case 'changes':
    case 'declined':
      return '#/me';
    case 'badge':
      return it.player && !it.player.id.startsWith('name:') ? `#/profile/${enc(it.player.id)}` : '#/me';
    case 'accepted':
    case 'played':
    case 'played_100':
    case 'beaten':
    case 'level_published':
      return it.level_id ? `#/play/${enc(it.level_id)}` : g ? `#/game/${g}` : '#/me';
    case 'quest_new':
    case 'quest_claimed':
    case 'quest_done':
      return g ? `#/quests/${g}` : '#/activity';
    case 'jam_new':
      return '#/jams';
    default:
      return g ? `#/game/${g}` : '#/activity';
  }
}

/** One feed line: emoji, avatar, sentence, time. */
export function feedRow(it: FeedItem, o: { onOpen?: (it: FeedItem) => void } = {}): HTMLElement {
  const a = h('a', { class: `collab-feed-row${it.read ? '' : ' unread'}`, href: feedLink(it) },
    h('span', { class: 'collab-feed-emo', 'aria-hidden': 'true' }, feedEmoji(it)),
    it.player ? avatar(it.player, 28) : '',
    h('span', { class: 'collab-feed-text' }, feedText(it), it.created_at ? h('span', { class: 'small muted' }, ` · ${timeAgo(it.created_at)}`) : ''));
  if (o.onOpen) a.addEventListener('click', () => o.onOpen?.(it));
  return a;
}

/** A small "loading…" / message paragraph. */
export function note(text: string, cls = 'muted'): HTMLElement {
  return h('p', { class: cls }, text);
}
