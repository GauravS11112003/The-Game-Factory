/**
 * The one results card after a win (§7.9, v1 fix 1): exactly one `[data-role=results]` element. The time is large with
 * its delta to your PB; the four stamps (Clear, Collector, Speedy, Flawless) slap on one after another with a thunk;
 * deaths, coins and big coins; the creator's time or the "beat my level" result. Buttons: Retry (R), Next level,
 * Watch ghost, Challenge a friend, Remix.
 */
import type { LevelV2, RunResult, Stamp } from '../core/types.gen.ts';
import { createMixer } from '../audio/index.ts';
import { h, icon, prefersReducedMotion } from './dom.ts';
import { fmtDelta, fmtSeconds, fmtTime, t } from './messages.ts';
import { store } from './store.ts';

export interface WinInfo {
  frames: number;
  time_ms: number;
  deaths: number;
  coins: number;
  big_coins_banked: number;
}

export interface ResultsOptions {
  level: LevelV2;
  win: WinInfo;
  prevPbMs: number | null;
  creator: { name: string; time_ms: number } | null;
  vs: { name: string; time_ms: number } | null;
  hasNext: boolean;
  /** A run that used "restart from checkpoint" rewinding: it counts for you, not for boards. */
  practice?: boolean;
  onRetry(): void;
  onNext(): void;
  onGhost(): void;
  onChallenge(): void;
  onRemix(): void;
  /** Called with the player's name when the card needs one to save the run. */
  onSaveRun(name: string): Promise<RunResult | null>;
}

export const STAMP_ORDER: readonly Stamp[] = ['clear', 'collector', 'speedy', 'flawless'];

export function localStamps(level: LevelV2, w: WinInfo): Stamp[] {
  const bigTotal = level.compiled.entities.filter((e) => e.type === 'big_coin').length;
  const par = level.design?.par_ms ?? null;
  const out: Stamp[] = ['clear'];
  if (bigTotal > 0 && w.big_coins_banked >= bigTotal) out.push('collector');
  if (par && w.time_ms <= par) out.push('speedy');
  if (w.deaths === 0) out.push('flawless');
  return out;
}

export interface ResultsHandle {
  el: HTMLElement;
  close(): void;
  /** Ask for the player's name (to save the run before a challenge link). */
  focusName(): void;
}

export function showResults(host: HTMLElement, o: ResultsOptions): ResultsHandle {
  host.querySelectorAll('[data-role=results]').forEach((n) => n.remove());
  const w = o.win;
  const stampsRow = h('div', { class: 'stamps' });
  const pbLine = h('div', { class: 'pb small' });
  const vsLine = h('div', { class: 'vs' });
  const runLine = h('div', { class: 'small muted' });
  const nameRow = h('div', { class: 'row' });
  const el = h('div', { class: 'results card paper', data: { role: 'results' }, role: 'dialog', 'aria-label': t('results.title') },
    h('div', { class: 'big-time' }, icon('clock'), ' ', fmtTime(w.time_ms)),
    pbLine,
    stampsRow,
    h('div', { class: 'tally row' },
      h('span', null, icon('skull'), ` ${t('results.deaths')}: ${w.deaths}`),
      h('span', null, icon('coin'), ` ${t('results.coins')}: ${w.coins}`),
      h('span', null, icon('star'), ` ${t('results.big_coins')}: ${w.big_coins_banked}`)),
    vsLine,
    runLine,
    nameRow,
    h('div', { class: 'row wrap end' },
      h('button', { type: 'button', class: 'pill', onclick: () => o.onRetry(), title: 'R' }, icon('retry'), t(o.vs ? 'vs.rematch' : 'results.retry')),
      o.hasNext ? h('button', { type: 'button', class: 'pill primary', onclick: () => o.onNext() }, icon('next'), t('results.next')) : '',
      h('button', { type: 'button', class: 'pill', onclick: () => o.onGhost() }, icon('ghost'), t('results.watch_ghost')),
      h('button', { type: 'button', class: 'pill', onclick: () => o.onChallenge() }, icon('share'), t('results.challenge')),
      h('button', { type: 'button', class: 'pill', onclick: () => o.onRemix() }, icon('remix'), t('results.remix'))));

  // the time large, with its delta to your PB
  if (o.prevPbMs === null) pbLine.textContent = t('run.pb');
  else if (w.time_ms < o.prevPbMs) pbLine.textContent = t('results.pb_by', { by: fmtSeconds(o.prevPbMs - w.time_ms) });
  else pbLine.textContent = t('results.vs_pb', { best: fmtTime(o.prevPbMs), delta: fmtDelta(w.time_ms - o.prevPbMs) });
  pbLine.classList.toggle('ok', o.prevPbMs === null || w.time_ms < o.prevPbMs);

  // the challenger's result, else the creator's time (with a badge when you beat it)
  const creatorLine = h('div', { class: 'small creator-line' });
  if (o.vs) {
    const d = w.time_ms - o.vs.time_ms;
    vsLine.textContent = d < 0 ? t('vs.beat', { name: o.vs.name, by: fmtSeconds(d) }) : t('vs.to_go', { by: fmtSeconds(d) });
    vsLine.classList.add(d < 0 ? 'ok' : 'warn');
  }
  if (o.creator && (!o.vs || o.vs.name !== o.creator.name)) {
    const beat = w.time_ms < o.creator.time_ms;
    creatorLine.append(t('results.creator_time', { name: o.creator.name, time: fmtTime(o.creator.time_ms) }),
      beat ? h('span', { class: 'badge beat' }, t('badge.beat_creator')) : '');
  }
  vsLine.after(creatorLine);
  if (o.practice) runLine.textContent = t('results.practice');

  // The card slides in (whoosh), the stamps slap on one after another (thunk), then the new best or the beaten rival.
  const reduce = prefersReducedMotion();
  // the app's mute for this mixer only: setMuted() would write the engine's persisted setting (E-2)
  const mixer = createMixer({ muted: store.flag('muted') });
  const timers: number[] = [];
  const later = (ms: number, fn: () => void): void => {
    timers.push(window.setTimeout(fn, ms));
  };
  mixer.play('whoosh', { gain: 0.5 });
  const earned = new Set(localStamps(o.level, w));
  const stampEls = STAMP_ORDER.map((s) => h('div', { class: `stamp-badge${earned.has(s) ? ' earned' : ''}`, data: { stamp: s } }, t(`stamp.${s}`)));
  stampsRow.append(...stampEls);
  let slapAt = 350;
  stampEls.forEach((s) => {
    if (!s.classList.contains('earned')) return;
    if (reduce) s.classList.add('in');
    else {
      later(slapAt, () => {
        s.classList.add('in');
        mixer.play('stamp', { gain: 0.7 });
      });
      slapAt += 320;
    }
  });
  const newPb = o.prevPbMs === null || w.time_ms < o.prevPbMs;
  const beatVs = !!o.vs && w.time_ms < o.vs.time_ms;
  if (beatVs) later(slapAt + 120, () => mixer.play('beat', { gain: 0.7 }));
  else if (newPb && o.prevPbMs !== null) later(slapAt + 120, () => mixer.play('pb', { gain: 0.7 }));

  const applyServer = (r: RunResult | null): void => {
    if (!r) return;
    runLine.textContent = r.verified ? t('run.verified') + (r.rank ? ` ${t('results.rank', { n: r.rank })}` : '') : t('run.rejected');
    const server = new Set(r.stamps);
    stampEls.forEach((s) => {
      const on = server.has(s.dataset.stamp as Stamp);
      s.classList.toggle('earned', on);
      s.classList.toggle('in', on);
    });
    if (r.vs) vsLine.textContent = r.vs.beat ? t('vs.beat', { name: o.vs?.name ?? '', by: fmtSeconds(r.vs.by_ms) }) : t('vs.to_go', { by: fmtSeconds(r.vs.by_ms) });
  };

  const name = store.author();
  if (o.practice) {
    /* rewound runs stay off the boards */
  } else if (name) void o.onSaveRun(name).then(applyServer).catch(() => undefined);
  else {
    const input = h('input', { type: 'text', class: 'text', maxLength: 16, placeholder: t('ui.your_name') });
    const save = h('button', {
      type: 'button', class: 'pill small',
      onclick: async () => {
        const n = input.value.trim().slice(0, 16);
        if (!n) return;
        store.setAuthor(n);
        nameRow.replaceChildren();
        applyServer(await o.onSaveRun(n).catch(() => null));
      },
    }, t('results.save_time'));
    nameRow.append(input, save);
  }

  host.append(el);
  return {
    el,
    close: () => {
      for (const id of timers) window.clearTimeout(id);
      el.remove();
      window.setTimeout(() => mixer.dispose(), 400);
    },
    focusName: () => {
      const input = nameRow.querySelector('input');
      if (input) {
        input.focus();
        input.classList.add('attention');
      }
    },
  };
}
