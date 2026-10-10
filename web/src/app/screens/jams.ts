/**
 * #/jams — level jams (v3 lane 5): a theme and dates ("Spooky week: Oct 24 – Oct 31"), optionally for one game.
 * "Make an entry" (while it's live) remembers the jam and opens the editor with `jam=<id>` (and the jam's game). The
 * server enters every level published during a live jam that fits it; the publish body also carries `jam_id`.
 * Anyone can start a jam; a jam for one game needs one of its keepers.
 */
import { api } from '../api.ts';
import { card, h, icon, toast } from '../dom.ts';
import { ensurePlayer } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { levelCardEl } from './home.ts';
import { collab, type Jam } from '../collab/api.ts';
import { setContribution } from '../collab/contribute.ts';
import { avatarStack, dateText, errText, note, playerChip } from '../collab/ui.ts';

const enc = encodeURIComponent;
const DAY = 86400_000;

type Phase = 'soon' | 'live' | 'over';

function phase(j: Jam, now = Date.now()): Phase {
  if (j.status) return j.status;
  const s = j.starts_at ? Date.parse(j.starts_at) : NaN;
  const e = j.ends_at ? Date.parse(j.ends_at) : NaN;
  if (Number.isFinite(s) && now < s) return 'soon';
  // an end date means "through that whole day"
  if (Number.isFinite(e) && now > e + (j.ends_at && j.ends_at.length <= 10 ? DAY : 0)) return 'over';
  return 'live';
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Remember the jam (and its game) for the publish, then go draw. */
async function enter(j: Jam): Promise<void> {
  await ensurePlayer();
  setContribution({ game_id: j.game_id, jam_id: j.id, jam_title: j.title, quest_id: null, quest_title: null });
  navigate(`#/draw?new=1&jam=${enc(j.id)}${j.game_id ? `&game=${enc(j.game_id)}` : ''}`);
}

export function jamsScreen(root: HTMLElement, query: URLSearchParams): () => void {
  let disposed = false;
  let games: { id: string; title: string }[] = [];
  const listEl = h('div', { class: 'collab-jams' }, card(null, note(t('ui.loading'))));
  const formHost = h('div', null);
  const focus = query.get('jam');

  const load = async (): Promise<void> => {
    try {
      const jams = await collab.jams();
      if (disposed) return;
      const order: Record<Phase, number> = { live: 0, soon: 1, over: 2 };
      jams.sort((a, b) => order[phase(a)] - order[phase(b)] || (a.starts_at ?? '').localeCompare(b.starts_at ?? ''));
      listEl.replaceChildren(...(jams.length ? jams.map(jamCard) : [card(null, note(t('collab.jams.empty')))]));
      if (focus) listEl.querySelector(`[data-jam="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'start' });
    } catch (e) {
      if (!disposed) listEl.replaceChildren(card(null, note(errText(e), 'warn')));
    }
  };

  function jamCard(j: Jam): HTMLElement {
    const ph = phase(j);
    const go = h('button', { type: 'button', class: 'pill primary big' }, icon('marker'), t('collab.jams.enter'));
    go.onclick = () => void enter(j).catch((e) => {
      if (!(e instanceof Error && e.message === 'collab.who.cancelled')) toast(errText(e));
    });
    const people = j.entries.map((s) => s.player).filter((p): p is NonNullable<typeof p> => !!p);
    return card(`collab-jam phase-${ph}`,
      h('div', { class: 'row between wrap' },
        h('div', null,
          h('span', { class: `collab-phase ph-${ph}` }, t(`collab.jams.phase_${ph}`)),
          h('h2', null, '🎪 ', kidText(j.title || t('collab.jams.untitled'))),
          j.theme ? h('p', { class: 'collab-jam-theme' }, t('collab.jams.theme', { theme: kidText(j.theme) })) : '',
          h('p', { class: 'small muted' },
            j.starts_at || j.ends_at ? t('collab.jams.dates', { from: dateText(j.starts_at), to: dateText(j.ends_at) }) : '',
            j.game_id ? h('span', null, ' · ', h('a', { href: `#/game/${enc(j.game_id)}` }, kidText(j.game_title || games.find((g) => g.id === j.game_id)?.title || t('collab.sent.the_game')))) : '',
            j.created_by ? h('span', { class: 'row', style: 'display:inline-flex' }, ' · ', t('collab.jams.host'), ' ', playerChip(j.created_by, { size: 18 })) : '')),
        ph === 'live' ? go : ''),
      h('div', { class: 'row wrap small' }, people.length ? avatarStack(people, 8, 26) : '', t('collab.jams.entries', { n: j.entry_count })),
      j.entries.length ? h('div', { class: 'level-strip' }, ...j.entries.map((s) => levelCardEl(s.card))) : '');
  }

  function createForm(): HTMLElement {
    const title = h('input', { type: 'text', class: 'text', maxLength: 50, placeholder: t('collab.jams.title_placeholder') });
    const theme = h('input', { type: 'text', class: 'text', maxLength: 80, placeholder: t('collab.jams.theme_placeholder') });
    const today = new Date();
    const from = h('input', { type: 'date', class: 'text', value: isoDay(today) });
    const to = h('input', { type: 'date', class: 'text', value: isoDay(new Date(today.getTime() + 7 * DAY)) });
    const game = h('select', { class: 'text' }, h('option', { value: '' }, t('collab.jams.any_game')),
      ...games.map((g) => h('option', { value: g.id }, kidText(g.title || t('ui.untitled')))));
    const make = h('button', { type: 'submit', class: 'pill primary' }, '🎪 ', t('collab.jams.create'));
    const f = h('form', { class: 'collab-jam-form' },
      h('details', null,
        h('summary', { class: 'pill' }, icon('plus'), t('collab.jams.new')),
        h('div', { class: 'collab-form-body' },
          h('label', { class: 'field' }, h('span', null, t('collab.jams.name')), title),
          h('label', { class: 'field' }, h('span', null, t('collab.jams.theme_label')), theme),
          h('div', { class: 'row wrap' },
            h('label', { class: 'field' }, h('span', null, t('collab.jams.starts')), from),
            h('label', { class: 'field' }, h('span', null, t('collab.jams.ends')), to)),
          h('label', { class: 'field' }, h('span', null, t('collab.jams.for_game')), game),
          h('div', { class: 'row end' }, make))));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const tt = title.value.trim();
      const th = theme.value.trim();
      if (!tt || !th) {
        (tt ? theme : title).focus();
        toast(t('collab.jams.need_both'));
        return;
      }
      if (to.value && from.value && to.value < from.value) {
        toast(t('collab.bad_dates'));
        return;
      }
      make.disabled = true;
      try {
        await ensurePlayer();
        await collab.createJam({ title: tt, theme: th, starts_at: from.value, ends_at: to.value, game_id: game.value || null });
        toast(t('collab.jams.created'));
        title.value = '';
        theme.value = '';
        f.querySelector('details')?.removeAttribute('open');
        void load();
      } catch (err) {
        if (!(err instanceof Error && err.message === 'collab.who.cancelled')) toast(errText(err));
      } finally {
        make.disabled = false;
      }
    };
    return f;
  }

  root.append(h('div', { class: 'collab-screen jams-screen' },
    card('collab-head',
      h('h1', { class: 'marker-underline' }, '🎪 ', t('collab.jams.title')),
      h('p', { class: 'muted' }, t('collab.jams.help')),
      formHost),
    listEl));
  formHost.append(createForm());
  // a jam for one game needs one of its keepers: offer the games I keep (all games when the server can't say)
  collab.me().then((me) => me.games.filter((g) => g.role === 'owner' || g.role === 'maintainer').map((g) => ({ id: g.game_id, title: g.title })))
    .catch(() => api.games('new').then((r) => r.games.map((g) => ({ id: g.id, title: g.title }))))
    .then((gs) => {
      if (disposed) return;
      games = gs;
      formHost.replaceChildren(createForm());
    }, () => undefined);
  void load();
  return () => {
    disposed = true;
  };
}
