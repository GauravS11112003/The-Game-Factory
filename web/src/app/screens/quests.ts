/**
 * #/quests/:game — the quest board (v3 lane 5). Maintainers post quests ("Draw an ice level", "Make a bat creature");
 * anyone taps "I'll do it!": we claim it, remember the quest, and open the editor for that game with `quest=<id>`.
 * The publish body then carries `quest_id` (collab/contribute.ts) so the submission links the quest.
 */
import { api, ApiError } from '../api.ts';
import { card, h, icon, toast } from '../dom.ts';
import { currentPlayer, ensurePlayer } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { collab, type Quest, type QuestKind } from '../collab/api.ts';
import { setContribution } from '../collab/contribute.ts';
import { loadTeam } from '../collab/roles.ts';
import { avatarStack, badgeEmoji, badgeName, errText, note, playerChip, QUEST_EMOJI } from '../collab/ui.ts';

const enc = encodeURIComponent;
const KINDS: QuestKind[] = ['level', 'creature', 'art', 'fix'];
const REWARDS: (string | null)[] = [null, 'quest_hero', 'featured'];

/** Where "I'll do it!" takes you for a quest. */
export function questHref(q: Quest, gameId: string): string {
  const g = enc(gameId);
  const qs = `quest=${enc(q.id)}`;
  if (q.kind === 'creature') return `#/game/${g}/library?${qs}`;
  return `#/draw?new=1&game=${g}&${qs}`;
}

/** Claim (when needed), remember the quest for the publish, then go draw. False when the quest can't be taken. */
export async function takeQuest(q: Quest, gameId: string): Promise<boolean> {
  const me = await ensurePlayer();
  if (!q.claimers.some((p) => p.id === me.id)) {
    try {
      await collab.claimQuest(q.id);
      toast(t('collab.quests.claimed', { quest: kidText(q.title) }));
    } catch (e) {
      // someone else has it, it's done, or the game is invite only: say so and stay here
      if (e instanceof ApiError && e.messageKey !== 'collab.not_ready') {
        toast(errText(e));
        return false;
      }
    }
  }
  setContribution({ game_id: gameId, quest_id: q.id, quest_title: q.title, jam_id: null, jam_title: null });
  navigate(questHref(q, gameId));
  return true;
}

export interface QuestBoardHandle {
  el: HTMLElement;
  dispose(): void;
}

export function questBoard(gameId: string, o: { canPost: boolean; onCount?: (open: number) => void }): QuestBoardHandle {
  let disposed = false;
  const listEl = h('div', { class: 'collab-quest-grid' }, note(t('ui.loading')));
  const form = o.canPost ? postForm() : '';
  const el = h('div', { class: 'collab-quests' }, form, listEl);

  const load = async (): Promise<void> => {
    try {
      const qs = await collab.quests(gameId);
      if (disposed) return;
      const order = { open: 0, claimed: 1, done: 2 } as const;
      qs.sort((a, b) => order[a.status] - order[b.status]);
      o.onCount?.(qs.filter((q) => q.status !== 'done').length);
      listEl.replaceChildren(...(qs.length ? qs.map(questCard) : [note(t(o.canPost ? 'collab.quests.empty_owner' : 'collab.quests.empty'))]));
    } catch (e) {
      if (!disposed) listEl.replaceChildren(note(errText(e), 'warn'));
    }
  };

  function questCard(q: Quest): HTMLElement {
    const me = currentPlayer();
    const mine = !!me && q.claimers.some((p) => p.id === me.id);
    const go = h('button', { type: 'button', class: `pill ${mine ? '' : 'primary'} big` }, mine ? icon('marker') : h('span', { class: 'emo' }, '🙋'),
      t(mine ? 'collab.quests.keep_going' : 'collab.quests.ill_do_it'));
    go.onclick = async () => {
      go.disabled = true;
      try {
        if (!(await takeQuest(q, gameId))) void load();
      } catch (e) {
        if (!(e instanceof Error && e.message === 'collab.who.cancelled')) toast(errText(e));
      } finally {
        go.disabled = false;
      }
    };
    return h('div', { class: `collab-quest kind-${q.kind} st-${q.status}` },
      h('div', { class: 'collab-quest-emo', 'aria-hidden': 'true' }, QUEST_EMOJI[q.kind]),
      h('div', { class: 'collab-quest-body' },
        h('div', { class: 'row wrap' },
          h('span', { class: 'collab-kind' }, t(`collab.quest.kind.${q.kind}`)),
          h('span', { class: `collab-status st-${q.status}` }, t(`collab.quests.status_${q.status}`))),
        h('h3', null, kidText(q.title || t('collab.feed.a_quest'))),
        q.description ? h('p', null, kidText(q.description)) : '',
        q.reward_badge ? h('p', { class: 'small collab-reward' }, t('collab.quests.reward', { badge: `${badgeEmoji(q.reward_badge)} ${badgeName(q.reward_badge)}` })) : '',
        h('div', { class: 'row wrap small' },
          q.claimers.length ? h('span', { class: 'row' }, avatarStack(q.claimers, 5, 24), t('collab.quests.on_it', { n: q.claimers.length })) : '',
          q.created_by ? h('span', { class: 'muted row' }, t('collab.quests.posted_by'), ' ', playerChip(q.created_by, { size: 18 })) : ''),
        q.status === 'done' ? '' : h('div', { class: 'row wrap' }, go, o.canPost && q.status === 'claimed' ? doneBtn(q) : '')));
  }

  /** Keepers close a quest by hand (creature and art quests have no level to link). */
  function doneBtn(q: Quest): HTMLElement {
    const b = h('button', { type: 'button', class: 'pill small' }, icon('check'), t('collab.quests.mark_done'));
    b.onclick = async () => {
      b.disabled = true;
      try {
        await collab.questDone(q.id);
        toast(t('collab.quests.done_toast', { quest: kidText(q.title) }));
        void load();
      } catch (e) {
        b.disabled = false;
        toast(errText(e));
      }
    };
    return b;
  }

  function postForm(): HTMLElement {
    let kind: QuestKind = 'level';
    let reward: string | null = null;
    const title = h('input', { type: 'text', class: 'text', maxLength: 60, placeholder: t('collab.quests.title_placeholder') });
    const desc = h('textarea', { rows: 2, maxLength: 400, placeholder: t('collab.quests.desc_placeholder') });
    const kinds = h('div', { class: 'chips' });
    const rewards = h('div', { class: 'chips' });
    const render = (): void => {
      kinds.replaceChildren(...KINDS.map((k) => h('button', { type: 'button', class: `chip big${k === kind ? ' on' : ''}`, onclick: () => { kind = k; render(); } },
        QUEST_EMOJI[k], ' ', t(`collab.quest.kind.${k}`))));
      rewards.replaceChildren(...REWARDS.map((r) => h('button', { type: 'button', class: `chip${r === reward ? ' on' : ''}`, onclick: () => { reward = r; render(); } },
        r ? `${badgeEmoji(r)} ${badgeName(r)}` : t('collab.quests.no_reward'))));
    };
    render();
    const post = h('button', { type: 'submit', class: 'pill primary' }, icon('plus'), t('collab.quests.post'));
    const f = h('form', { class: 'collab-quest-form' },
      h('details', null,
        h('summary', { class: 'pill' }, icon('plus'), t('collab.quests.new')),
        h('div', { class: 'collab-form-body' },
          h('label', { class: 'field' }, h('span', null, t('collab.quests.what')), title),
          h('label', { class: 'field' }, h('span', null, t('collab.quests.details')), desc),
          h('div', { class: 'field' }, h('span', null, t('collab.quests.kind')), kinds),
          h('div', { class: 'field' }, h('span', null, t('collab.quests.reward_pick')), rewards),
          h('div', { class: 'row end' }, post))));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const tt = title.value.trim();
      if (!tt) {
        title.focus();
        return;
      }
      post.disabled = true;
      try {
        await collab.postQuest(gameId, { title: tt, description: desc.value.trim(), kind, reward_badge: reward });
        toast(t('collab.quests.posted'));
        title.value = '';
        desc.value = '';
        f.querySelector('details')?.removeAttribute('open');
        void load();
      } catch (err) {
        toast(errText(err));
      } finally {
        post.disabled = false;
      }
    };
    return f;
  }

  void load();
  return {
    el,
    dispose: () => {
      disposed = true;
    },
  };
}

export function questsScreen(root: HTMLElement, gameId: string): () => void {
  let disposed = false;
  let board: QuestBoardHandle | null = null;
  const body = h('div', { class: 'collab-screen quests-screen' }, card(null, note(t('ui.loading'))));
  root.append(body);
  void (async () => {
    const [game, team] = await Promise.all([api.game(gameId).catch(() => null), loadTeam(gameId)]);
    if (disposed) return;
    board = questBoard(gameId, { canPost: team.keeper || team.claimable });
    body.replaceChildren(
      card('collab-head',
        h('div', { class: 'row between wrap' },
          h('div', null,
            h('h1', { class: 'marker-underline' }, '🗺️ ', t('collab.quests.title')),
            h('p', { class: 'muted' }, game ? h('a', { href: `#/game/${enc(gameId)}` }, kidText(game.title || t('ui.untitled'))) : '', game ? ' · ' : '',
              t('collab.quests.help'))),
          h('a', { class: 'pill', href: `#/game/${enc(gameId)}` }, icon('home'), t('ui.game')))),
      board.el);
  })();
  return () => {
    disposed = true;
    board?.dispose();
  };
}
