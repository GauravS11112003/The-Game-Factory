/**
 * #/review/:game — the review queue (v3 lane 5). New levels from helpers wait here. Each card: thumbnail, who made it,
 * the bot's verdict and difficulty band (from the level's design report), votes and comments, and for the owner and
 * maintainers: Play it, Accept (a celebration), Ask for changes (with a note), Decline. Everyone else can play, vote
 * and cheer, so the whole community helps review.
 */
import { api } from '../api.ts';
import { card, h, icon, prefersReducedMotion, toast } from '../dom.ts';
import { ensurePlayer } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { levelThumb } from '../thumbs.ts';
import { collab, type Decision, type Submission, type SubStatus } from '../collab/api.ts';
import { loadTeam } from '../collab/roles.ts';
import { errText, note, playerChip, timeAgo, verdictEl } from '../collab/ui.ts';

const enc = encodeURIComponent;
const FILTERS: SubStatus[] = ['pending', 'accepted', 'changes', 'declined'];

export interface ReviewListHandle {
  el: HTMLElement;
  dispose(): void;
}

/** The queue for one game. `canReview` shows Accept / Ask for changes / Decline. */
export function reviewList(gameId: string, o: { canReview: boolean; onCount?: (pending: number) => void; filters?: boolean }): ReviewListHandle {
  let disposed = false;
  let status: SubStatus = 'pending';
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const listEl = h('div', { class: 'collab-sub-list' }, note(t('ui.loading')));
  const el = h('div', { class: 'collab-review' }, o.filters === false ? '' : tabs, listEl);

  const renderTabs = (): void => {
    tabs.replaceChildren(...FILTERS.map((f) => h('button', {
      type: 'button', role: 'tab', class: `tab${f === status ? ' on' : ''}`,
      onclick: () => {
        status = f;
        void load();
      },
    }, t(`collab.review.filter_${f}`))));
  };

  const load = async (): Promise<void> => {
    renderTabs();
    listEl.replaceChildren(note(t('ui.loading')));
    try {
      const subs = await collab.submissions(gameId, status);
      if (disposed) return;
      const shown = subs.filter((s) => s.status === status);
      if (status === 'pending') o.onCount?.(shown.length);
      listEl.replaceChildren(...(shown.length ? shown.map(subCard) : [note(t(status === 'pending' ? 'collab.review.empty' : 'collab.review.empty_other'))]));
    } catch (e) {
      if (!disposed) listEl.replaceChildren(note(errText(e), 'warn'));
    }
  };

  function subCard(s: Submission): HTMLElement {
    const verdict = h('div', null, s.level ? verdictEl(s.level) : note(t('ui.loading'), 'small muted'));
    if (!s.level && s.level_id) {
      api.level(s.level_id, s.level_version ?? undefined).then((r) => !disposed && verdict.replaceChildren(verdictEl(r.level)),
        () => !disposed && verdict.replaceChildren(verdictEl(null)));
    }
    const playHref = `#/play/${enc(s.level_id)}${s.level_version ? `?v=${s.level_version}` : ''}`;

    // votes
    let votes = s.votes;
    let voted = s.voted;
    const voteBtn = h('button', { type: 'button', class: `pill small${voted ? ' on' : ''}`, title: t('collab.review.vote_help'), 'aria-pressed': String(voted) });
    const syncVote = (): void => {
      voteBtn.replaceChildren(h('span', { class: 'emo' }, '👍'), ` ${votes}`);
    };
    syncVote();
    voteBtn.onclick = async () => {
      try {
        await ensurePlayer();
        voteBtn.disabled = true;
        votes = await collab.vote(s.id, voted ? 0 : 1);
        voted = !voted;
        voteBtn.classList.toggle('on', voted);
        voteBtn.setAttribute('aria-pressed', String(voted));
        voteBtn.disabled = false;
        syncVote();
      } catch (e) {
        voteBtn.disabled = false;
        if (!(e instanceof Error && e.message === 'collab.who.cancelled')) toast(errText(e));
      }
    };

    // comments
    const comments = h('ul', { class: 'collab-comments' }, ...s.comments.map(commentEl));
    const commentIn = h('input', { type: 'text', class: 'text', maxLength: 200, placeholder: t('collab.review.comment_placeholder') });
    const sendComment = async (): Promise<void> => {
      const text = commentIn.value.trim();
      if (!text) return;
      try {
        await ensurePlayer();
        const c = await collab.comment(s.id, text);
        comments.append(commentEl(c.text ? c : { ...c, text }));
        commentIn.value = '';
      } catch (e) {
        if (!(e instanceof Error && e.message === 'collab.who.cancelled')) toast(errText(e));
      }
    };
    commentIn.onkeydown = (e) => {
      if (e.key === 'Enter') void sendComment();
    };

    // review actions
    const noteBox = h('div', { class: 'collab-note-box hidden' });
    const actions = h('div', { class: 'row wrap collab-review-actions' });
    const stampHost = h('div', { class: 'collab-stamp-host' });
    const cardEl = card(`collab-sub status-${s.status}`,
      stampHost,
      h('div', { class: 'collab-sub-body' },
        h('a', { class: 'collab-sub-thumb', href: playHref, title: t('collab.review.play') }, levelThumb(s.card)),
        h('div', { class: 'collab-sub-meta' },
          h('h3', null, kidText(s.title || t('ui.untitled'))),
          h('div', { class: 'row wrap small' }, playerChip(s.player), s.created_at ? h('span', { class: 'muted' }, timeAgo(s.created_at)) : '',
            s.quest_id ? h('span', { class: 'badge' }, '🗺️ ', s.quest_title ? kidText(s.quest_title) : t('collab.review.for_quest')) : '',
            s.jam_id ? h('span', { class: 'badge' }, '🎪 ', t('collab.review.for_jam')) : ''),
          verdict,
          s.note ? h('p', { class: 'collab-review-note small' }, icon('pencil'), ' ', t(`collab.review.note_${s.status === 'declined' ? 'declined' : 'changes'}`), ' ', h('q', null, kidText(s.note))) : '',
          h('div', { class: 'row wrap' },
            h('a', { class: 'pill small play', href: playHref }, icon('play'), t('collab.review.play')),
            voteBtn,
            h('span', { class: 'small muted' }, `💬 ${Math.max(s.comments_count, s.comments.length)}`)),
          comments,
          h('div', { class: 'row collab-comment-row' }, commentIn, h('button', { type: 'button', class: 'pill small', onclick: () => void sendComment() }, t('collab.review.send'))),
          actions,
          noteBox)));

    const decide = async (decision: Decision, text: string, btns: HTMLButtonElement[]): Promise<void> => {
      btns.forEach((b) => (b.disabled = true));
      try {
        await collab.review(s.id, decision, text);
        if (disposed) return;
        const who = kidText(s.player?.name || t('ui.someone'));
        if (decision === 'accept') {
          celebrate(stampHost, cardEl);
          toast(t('collab.review.accepted_toast', { name: who }), { ms: 6000 });
        } else toast(t(decision === 'changes' ? 'collab.review.changes_toast' : 'collab.review.declined_toast', { name: who }));
        cardEl.classList.remove(`status-${s.status}`);
        cardEl.classList.add(`status-${decision === 'accept' ? 'accepted' : decision === 'changes' ? 'changes' : 'declined'}`);
        actions.replaceChildren(h('span', { class: 'small' }, t(`collab.review.done_${decision}`)));
        noteBox.classList.add('hidden');
        if (status === 'pending') {
          window.setTimeout(() => {
            cardEl.classList.add('collab-leaving');
            window.setTimeout(() => {
              cardEl.remove();
              const left = listEl.querySelectorAll('.collab-sub').length;
              o.onCount?.(left);
              if (!left) listEl.replaceChildren(note(t('collab.review.empty')));
            }, 400);
          }, decision === 'accept' ? 2200 : 900);
        }
      } catch (e) {
        btns.forEach((b) => (b.disabled = false));
        toast(errText(e));
      }
    };

    if (o.canReview && (s.status === 'pending' || s.status === 'changes')) {
      const accept = h('button', { type: 'button', class: 'pill primary' }, icon('check'), t('collab.review.accept'));
      const changes = h('button', { type: 'button', class: 'pill' }, icon('pencil'), t('collab.review.changes'));
      const decline = h('button', { type: 'button', class: 'pill' }, icon('close'), t('collab.review.decline'));
      const all = [accept, changes, decline];
      accept.onclick = () => void decide('accept', '', all);
      const askNote = (decision: 'changes' | 'decline'): void => {
        const ta = h('textarea', { rows: 2, maxLength: 400, placeholder: t(decision === 'changes' ? 'collab.review.changes_placeholder' : 'collab.review.decline_placeholder') });
        const send = h('button', { type: 'button', class: 'pill small primary' }, t(decision === 'changes' ? 'collab.review.send_changes' : 'collab.review.send_decline'));
        send.onclick = () => {
          const text = ta.value.trim();
          if (decision === 'changes' && !text) {
            ta.focus();
            toast(t('collab.review.changes_need_note'));
            return;
          }
          void decide(decision, text, [...all, send]);
        };
        noteBox.replaceChildren(ta, h('div', { class: 'row end' },
          h('button', { type: 'button', class: 'pill small', onclick: () => noteBox.classList.add('hidden') }, t('ui.cancel')), send));
        noteBox.classList.remove('hidden');
        ta.focus();
      };
      changes.onclick = () => askNote('changes');
      decline.onclick = () => askNote('decline');
      actions.append(...all);
    } else if (s.status !== 'pending') {
      actions.append(h('span', { class: `collab-status st-${s.status}` }, t(`collab.submission.${s.status}`)));
    }
    return cardEl;
  }

  void load();
  return {
    el,
    dispose: () => {
      disposed = true;
    },
  };
}

function commentEl(c: { player: Submission['player']; text: string; created_at: string | null }): HTMLElement {
  return h('li', null, playerChip(c.player, { size: 20 }), h('span', null, ' ', kidText(c.text)),
    c.created_at ? h('span', { class: 'small muted' }, ` · ${timeAgo(c.created_at)}`) : '');
}

/** A red "ACCEPTED" stamp slaps onto the card, with a little confetti. */
function celebrate(host: HTMLElement, cardEl: HTMLElement): void {
  host.replaceChildren(h('div', { class: 'collab-stamp' }, t('collab.review.stamp')));
  if (prefersReducedMotion()) return;
  const bits = ['🎉', '⭐', '✨', '🎈', '🌟', '🎊'];
  const burst = h('div', { class: 'collab-confetti', 'aria-hidden': 'true' },
    ...Array.from({ length: 18 }, (_, i) => h('span', {
      style: `left:${5 + ((i * 53) % 90)}%;animation-delay:${(i % 6) * 60}ms;--dx:${((i * 37) % 120) - 60}px`,
    }, bits[i % bits.length])));
  cardEl.append(burst);
  window.setTimeout(() => burst.remove(), 2400);
}

export function reviewScreen(root: HTMLElement, gameId: string): () => void {
  let disposed = false;
  let list: ReviewListHandle | null = null;
  const body = h('div', { class: 'collab-screen review-screen' }, card(null, note(t('ui.loading'))));
  root.append(body);
  void (async () => {
    const [game, team] = await Promise.all([api.game(gameId).catch(() => null), loadTeam(gameId)]);
    if (disposed) return;
    const can = team.keeper;
    const count = h('span', { class: 'collab-count hidden' });
    list = reviewList(gameId, {
      canReview: can,
      onCount: (n) => {
        count.textContent = String(n);
        count.classList.toggle('hidden', n === 0);
      },
    });
    body.replaceChildren(
      card('collab-head',
        h('div', { class: 'row between wrap' },
          h('div', null,
            h('h1', { class: 'marker-underline' }, t('collab.review.title'), ' ', count),
            h('p', { class: 'muted' }, game ? h('a', { href: `#/game/${enc(gameId)}` }, kidText(game.title || t('ui.untitled'))) : '', game ? ' · ' : '',
              t(can ? 'collab.review.help_owner' : 'collab.review.help_everyone'))),
          h('a', { class: 'pill', href: `#/game/${enc(gameId)}` }, icon('home'), t('ui.game')))),
      list.el);
  })();
  return () => {
    disposed = true;
    list?.dispose();
  };
}
