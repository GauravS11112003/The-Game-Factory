/**
 * #/play/:id[?vs=<run id>&v=<version>] — the play screen (§7.9, §8.4).
 * - mountGame in play mode, the one results card, personal bests, verified runs (the replay is the proof).
 * - Boards: the top 10 verified Any% and Collector runs, your own best, the creator's best; runs on an older version
 *   are labelled. The leader's and the challenger's runs can be raced as ghosts.
 * - Ghosts: up to 3 at once (your PB, the leader, the challenger), each a pencil copy of the level's character stepped
 *   from its replay.
 * - "Beat my level": after a clear, "Challenge a friend" shares `#/play/<id>?vs=<run id>`. The friend sees "Maya
 *   cleared this in 0:41.20 with 2 deaths. Beat it!", races her ghost (on the version she ran), and the result reads
 *   "You beat Maya by 1.32 s!" or "0.40 s to go!" with a one-tap rematch.
 * - Attempts, deaths and clears are counted for the measured clear rate.
 */
import type { InkDoc, LevelResponse, LevelV2, Replay, RunResult, Stamp } from '../../core/types.gen.ts';
import { RUNS } from '../../core/params.ts';
import { shareCardFile, type GhostOption, type WinPayload } from '../../engine/index.ts';
import { api, ApiError, type RunRow } from '../api.ts';
import { coreClient } from '../core_client.ts';
import { card, h, icon, saveBlob, toast } from '../dom.ts';
import { inkFromLevel } from '../ink.ts';
import { fmtTime, kidText, t } from '../messages.ts';
import { pill } from '../readout.ts';
import { showResults, type ResultsHandle, type WinInfo } from '../results.ts';
import { navigate } from '../router.ts';
import { Stage } from '../stage.ts';
import { store, type GhostPrefs } from '../store.ts';
import { creditsAfterWin } from './credits.ts'; // v3 lane 5: "See who made this" after a game's last level

type Ghost = GhostOption;
type Board = 'any' | 'collector';

export function playScreen(root: HTMLElement, id: string, query: URLSearchParams): () => void {
  let disposed = false;
  let stage: Stage | null = null;
  let attempts = 1;
  let deaths = 0;
  let clears = 0;
  let sent = false;
  let cleanupKey: (() => void) | null = null;
  const wrap = h('div', { class: 'play-screen' }, card(null, h('p', { class: 'muted' }, t('ui.loading'))));
  root.append(wrap);

  const sendAttempts = (): void => {
    if (sent || !stage) return;
    sent = true;
    api.attempts(id, { attempts, deaths, clears }).catch(() => undefined);
  };

  void (async () => {
    const vsId = query.get('vs');
    const vs = vsId ? await api.run(vsId).catch(() => null) : null;
    if (disposed) return;
    if (vsId && !vs) toast(t('vs.not_found'));
    // race the challenger on the version they ran, so their ghost stays in step with the level
    const wantV = query.get('v') ? Number(query.get('v')) : vs?.run.level_version ?? undefined;
    let res: LevelResponse;
    try {
      res = await api.level(id, wantV).catch((e) => (wantV ? api.level(id) : Promise.reject(e)));
    } catch (e) {
      wrap.replaceChildren(card(null, h('p', null, t(e instanceof ApiError ? e.messageKey : 'error.not_found'))));
      return;
    }
    if (disposed) return;
    const level = res.level;
    const ink = inkFromLevel(level);
    const character = level.ink?.character?.strokes ?? undefined;
    const bigTotal = level.compiled.entities.filter((e) => e.type === 'big_coin').length;
    const [anyBoard, collectorRuns] = await Promise.all([
      api.board(id, 'any', RUNS.board_size).catch(() => ({ runs: [] as RunRow[], creator: null })),
      bigTotal ? api.runs(id, 'collector', RUNS.board_size).catch(() => [] as RunRow[]) : Promise.resolve([] as RunRow[]),
    ]);
    if (disposed) return;
    const anyRuns = anyBoard.runs;
    const creatorRun = anyBoard.creator ?? anyRuns.filter((r) => r.player === level.author).sort((a, b) => a.time_ms - b.time_ms)[0] ?? null;
    const leader = anyRuns[0] ?? null;
    // The challenger's numbers come from re-simulating their replay, not from the run row (§8.4: the replay is the proof).
    let vsTime = vs?.run.time_ms ?? 0;
    let vsDeaths = vs?.run.deaths ?? 0;
    let next: string | null = null;
    if (level.game_id) {
      api.game(level.game_id).then((g) => {
        const i = g.levels.findIndex((l) => l.id === level.id);
        next = i >= 0 && i + 1 < g.levels.length ? g.levels[i + 1].id : null;
      }).catch(() => undefined);
    }

    // ---- ghosts (≤ 3: your PB, the leader, the challenger) ----------------------------------------------------
    let prefs: GhostPrefs = store.ghostPrefs();
    let leaderReplay: Replay | null = null;
    let leaderSprite: string | null = null;
    const loadLeader = async (): Promise<void> => {
      if (!leader || leaderReplay) return;
      const r = await api.run(leader.run_id).catch(() => null);
      leaderReplay = r?.replay ?? null;
      leaderSprite = r?.sprite_url ?? null;
    };
    const ghostRow = h('div', { class: 'chips ghost-row' });
    const ghosts = (): Ghost[] => {
      const out: Ghost[] = [];
      const pb = store.pb(level.id, level.version)?.replay ?? null;
      if (prefs.vs && vs?.replay) out.push({ replay: vs.replay, strokes: character, sprite_url: vs.sprite_url, label: vs.run.player, kind: 'challenger' });
      if (prefs.leader && leaderReplay && leader && leader.run_id !== vs?.run.run_id) out.push({ replay: leaderReplay, strokes: character, sprite_url: leaderSprite, label: leader.player, kind: 'leader' });
      if (prefs.pb && pb) out.push({ replay: pb, strokes: character, label: t('play.you'), kind: 'pb' });
      return out.filter((g) => g.replay.level_hash === level.meta.level_hash || !g.replay.level_hash).slice(0, RUNS.max_ghosts);
    };
    const applyGhosts = (): void => {
      store.setGhostPrefs(prefs);
      closeResults();
      stage?.setMode('play', { ghosts: ghosts() });
      renderGhostRow();
    };
    const renderGhostRow = (): void => {
      const pb = store.pb(level.id, level.version)?.replay;
      const chip = (key: keyof GhostPrefs, label: string, enabled: boolean): HTMLElement => h('button', {
        type: 'button', class: `chip${prefs[key] && enabled ? ' on' : ''}`, disabled: !enabled,
        onclick: async () => {
          prefs = { ...prefs, [key]: !prefs[key] };
          if (key === 'leader' && prefs.leader && !leaderReplay && leader) {
            await loadLeader();
            if (!leaderReplay) toast(t('vs.not_found'));
          }
          applyGhosts();
        },
      }, icon('ghost'), label);
      ghostRow.replaceChildren(h('span', { class: 'small muted' }, t('play.ghosts')),
        chip('pb', t('play.ghost_pb'), !!pb),
        leader ? chip('leader', t('play.ghost_leader', { name: leader.player }), true) : '',
        vs ? chip('vs', t('play.ghost_vs', { name: vs.run.player }), !!vs.replay) : '');
    };

    stage = new Stage('stage play-stage');
    if (prefs.leader && leader) await loadLeader();
    if (disposed) return;
    stage.setMode('play', { ghosts: ghosts() });
    stage.show({ level, ink });
    renderGhostRow();

    const muteBtn = h('button', { type: 'button', class: 'tool', title: t('ui.mute') });
    const syncMute = (): void => {
      const m = store.flag('muted');
      muteBtn.replaceChildren(h('span', { class: 'emo' }, m ? '🔇' : '🔊'), h('span', { class: 'lbl' }, t(m ? 'ui.unmute' : 'ui.mute')));
    };
    muteBtn.onclick = () => {
      store.setFlag('muted', !store.flag('muted'));
      syncMute();
      stage?.setMode('play', { ghosts: ghosts() });
    };
    syncMute();
    const remixMenu = h('details', { class: 'menu' },
      h('summary', { class: 'tool' }, icon('remix'), h('span', { class: 'lbl' }, t('results.remix'))),
      h('div', { class: 'menu-items card paper' },
        h('a', { class: 'pill small', href: `#/draw?remix=${encodeURIComponent(level.id)}` }, icon('marker'), t('remix.on_screen')),
        h('a', { class: 'pill small', href: `#/scan?remix=${encodeURIComponent(level.id)}${level.game_id ? `&game=${encodeURIComponent(level.game_id)}` : ''}` }, icon('rules'), t('remix.on_paper')),
        level.world.screens < 6 ? h('a', { class: 'pill small', href: `#/scan?extend=${encodeURIComponent(level.id)}${level.game_id ? `&game=${encodeURIComponent(level.game_id)}` : ''}` }, icon('plus'), t('remix.extend')) : ''));
    const stats = res.stats;
    const vsText = h('span', null, vs ? t('vs.challenge', { name: vs.run.player, time: fmtTime(vsTime), deaths: vsDeaths }) : '');
    const vsBanner = vs ? h('p', { class: 'vs-banner' }, icon('ghost'), ' ', vsText,
      vs.run.level_version !== null && vs.run.level_version !== level.version ? h('span', { class: 'small muted' }, ` ${t('run.older_version')}`) : '') : '';
    if (vs?.replay) {
      coreClient().verify({ level, replay: vs.replay }).then((v) => {
        if (disposed || !v.finished) return;
        vsTime = v.time_ms;
        vsDeaths = v.deaths;
        vsText.textContent = t('vs.challenge', { name: vs.run.player, time: fmtTime(vsTime), deaths: vsDeaths });
      }).catch(() => undefined);
    }
    const head = h('div', { class: 'play-head card paper' },
      h('div', { class: 'row wrap between' },
        h('div', null,
          h('h2', { class: 'marker-underline' }, kidText(level.title || t('ui.untitled'))),
          h('p', { class: 'muted' }, t('play.by', { author: level.author || t('ui.someone') }),
            level.meta.safety === 'unchecked' ? h('span', { class: 'badge' }, t('badge.not_checked')) : '',
            res.children.length ? h('span', { class: 'badge' }, t('play.remixes', { n: res.children.length })) : '')),
        h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'tool', title: 'R', onclick: () => { attempts++; stage?.restart('start'); closeResults(); } }, icon('retry'), h('span', { class: 'lbl' }, t('results.retry'))),
          muteBtn,
          remixMenu,
          h('button', { type: 'button', class: 'tool', onclick: () => navigate(`#/tree/${encodeURIComponent(level.id)}`) }, icon('tree'), h('span', { class: 'lbl' }, t('ui.tree'))),
          h('button', {
            type: 'button', class: 'tool', title: t('export.level_help'),
            onclick: () => api.pdf(`${api.exportUrl('level', level.id)}?version=${level.version}`).then((b) => saveBlob(b, `${level.id}-v${level.version}.zip`),
              (e) => toast(t(e instanceof ApiError ? e.messageKey : 'error.network'))),
          }, icon('share'), h('span', { class: 'lbl' }, t('export.level'))),
          level.game_id ? h('button', { type: 'button', class: 'tool', onclick: () => navigate(`#/game/${encodeURIComponent(level.game_id!)}`) }, icon('home'), h('span', { class: 'lbl' }, t('ui.game'))) : '',
          level.source.kind === 'migrated' && level.rules.physics_profile === 'v1-classic' ? upgradeButton(level) : '')),
      h('div', { class: 'row wrap' },
        level.design ? pill({ ...emptyReport(), C: level.design.C, band: level.design.band, score: level.design.score, fastest_ms: level.design.fastest_ms, par_ms: level.design.par_ms, segments: level.design.segments.map((s, i) => ({ id: `seg${i}`, from: s.from, to: s.to, E: s.E, A: 1, T_ms: s.T_ms, F_s: s.F_s, actions: s.actions })) }) : '',
        h('span', { class: 'small muted' }, t('play.stats', { plays: stats.plays, rate: stats.clear_rate === null ? '–' : `${Math.round(stats.clear_rate * 100)}%` })),
        stats.best ? h('span', { class: 'small muted' }, t('play.best', { time: fmtTime(stats.best) })) : ''),
      vsBanner,
      ghostRow);
    const boardEl = boardCard({ any: anyRuns.slice(0, RUNS.board_size), collector: collectorRuns }, level, creatorRun, bigTotal > 0);
    wrap.replaceChildren(head, stage.el, boardEl);

    let results: ResultsHandle | null = null;
    const closeResults = (): void => {
      results?.close();
      results = null;
    };
    let lastReplay: Replay | null = null;
    let runId: string | null = null;
    let saving: Promise<RunResult | null> | null = null;

    let lastWin: (WinInfo & { stamps?: Stamp[] }) | null = null;
    const challenge = async (): Promise<void> => {
      if (!runId && saving) await saving.catch(() => null);
      if (!runId) {
        const best = store.bestRun(level.id);
        if (best && best.version === level.version) runId = best.run_id;
      }
      if (!runId) {
        toast(t('vs.need_name'));
        results?.focusName();
        return;
      }
      await shareChallenge(level, runId, ink, lastWin ? { player: store.author() || null, ...lastWin } : null);
    };

    stage.on('die', () => {
      deaths++;
      attempts++;
    });
    stage.on('win', (p: WinInfo & Partial<Pick<WinPayload, 'replay' | 'rewound' | 'ghosts'>>) => {
      clears++;
      if (!store.cleared(level.id)) {
        store.setCleared(level.id); // unlocks bonus levels that wait for this one (§9: L5 after L4)
        if (level.game_id) {
          api.game(level.game_id).then((g) => {
            for (const l of g.levels) if (l.unlock_after === level.id) toast(t('game.unlocked', { title: kidText(l.title || t('ui.untitled')) }));
          }, () => undefined);
        }
      }
      lastWin = { frames: p.frames, time_ms: p.time_ms, deaths: p.deaths, coins: p.coins, big_coins_banked: p.big_coins_banked };
      const replay = p.replay ?? stage?.replay() ?? null;
      lastReplay = replay;
      const pb = store.pb(level.id, level.version);
      const counts = !(p.rewound && p.rewound > 0); // a rewound run is a practice run: it never goes on a board
      if (counts && (!pb || p.time_ms < pb.time_ms)) store.setPb(level.id, level.version, { time_ms: p.time_ms, replay });
      sendAttempts();
      sent = false;
      attempts = 1;
      deaths = 0;
      clears = 0;
      closeResults();
      runId = null;
      saving = null;
      results = showResults(wrap, {
        level, win: p, prevPbMs: pb?.time_ms ?? null,
        creator: creatorRun ? { name: creatorRun.player, time_ms: creatorRun.time_ms } : null,
        // the race ghost's own clock when the engine raced it, else the re-simulated replay
        vs: vs ? { name: vs.run.player, time_ms: p.ghosts?.find((g) => g.kind === 'challenger' && g.finished && g.time_ms !== null)?.time_ms ?? vsTime } : null,
        hasNext: !!next, practice: !counts,
        onRetry: () => { closeResults(); stage?.restart('start'); },
        onNext: () => next && navigate(`#/play/${encodeURIComponent(next)}`),
        onGhost: () => {
          const g = lastReplay ?? store.pb(level.id, level.version)?.replay ?? null;
          if (!g) {
            toast(t('play.no_ghost'));
            return;
          }
          prefs = { ...prefs, pb: true };
          if (lastReplay && (!pb || p.time_ms >= pb.time_ms)) {
            // watch this very run, even when it was not a best
            closeResults();
            store.setGhostPrefs(prefs);
            const mine: Ghost = { replay: lastReplay, strokes: character, label: t('play.you'), kind: 'you' };
            stage?.setMode('play', { ghosts: [mine, ...ghosts().filter((x) => x.kind !== 'pb')].slice(0, RUNS.max_ghosts) });
            renderGhostRow();
          } else applyGhosts();
        },
        onChallenge: () => void challenge(),
        onRemix: () => navigate(`#/draw?remix=${encodeURIComponent(level.id)}`),
        onSaveRun: (name: string): Promise<RunResult | null> => {
          if (!replay || !counts) return Promise.resolve(null);
          const claimed = { time_ms: p.time_ms, deaths: p.deaths, coins: p.coins, big_coins: p.big_coins_banked };
          // re-simulate in the browser first: a run that can't check out is told at once (the server stays the judge)
          saving = coreClient().verify({ level, replay, claimed }).then((v) => v, () => null).then((v) => {
            if (v && !v.accepted) throw new ApiError(422, 'run.rejected', { why: v.reason });
            return api.submitRun(level.id, { player: name, replay, claimed, vs_run_id: vs?.run.run_id ?? null });
          }).then((rr) => {
            runId = rr.run_id;
            const best = store.bestRun(level.id);
            if (!best || best.version !== level.version || p.time_ms < best.time_ms) store.setBestRun(level.id, { run_id: rr.run_id, time_ms: p.time_ms, version: level.version });
            return rr;
          }, (e) => {
            if (e instanceof ApiError && e.status === 422) toast(t('run.rejected'));
            else if (e instanceof ApiError) toast(t(e.messageKey));
            return null;
          });
          return saving;
        },
      });
      creditsAfterWin(level, results.el);
    });

    const onKey = (e: KeyboardEvent): void => {
      if ((e.key === 'r' || e.key === 'R') && results && !(e.target instanceof HTMLInputElement)) {
        closeResults();
        stage?.restart('start');
      }
    };
    window.addEventListener('keydown', onKey);
    cleanupKey = () => window.removeEventListener('keydown', onKey);
  })();

  const onHide = (): void => {
    if (document.visibilityState === 'hidden') sendAttempts();
  };
  document.addEventListener('visibilitychange', onHide);

  return () => {
    disposed = true;
    sendAttempts();
    cleanupKey?.();
    document.removeEventListener('visibilitychange', onHide);
    stage?.destroy();
  };
}

/** "Challenge a friend": the Web Share API (with the run's share card when files can be shared), or a copied link. */
export async function shareChallenge(level: LevelV2, runId: string, ink: InkDoc | null = null, run: (WinInfo & { player?: string | null }) | null = null): Promise<void> {
  const url = `${location.origin}${location.pathname}#/play/${encodeURIComponent(level.id)}?vs=${encodeURIComponent(runId)}`;
  try {
    if (navigator.share) {
      let file: File | null = null;
      if (run) {
        try {
          file = await shareCardFile(level, ink, { run: { player: run.player ?? null, time_ms: run.time_ms, deaths: run.deaths, coins: run.coins, big_coins: run.big_coins_banked }, title: level.title, author: level.author });
        } catch {
          file = null;
        }
      }
      const data: ShareData = { url, title: level.title, text: t('play.share_text') };
      if (file && navigator.canShare?.({ files: [file] })) data.files = [file];
      await navigator.share(data);
    } else {
      await navigator.clipboard.writeText(url);
      toast(t('ui.link_copied'));
    }
  } catch {
    /* cancelled */
  }
}

function boardCard(rows: Record<Board, RunRow[]>, level: LevelV2, creator: RunRow | null, hasCollector: boolean): HTMLElement {
  let tab: Board = 'any';
  const me = store.author().toLowerCase();
  const list = h('div', { class: 'board-body' });
  const tabs = h('div', { class: 'tabs' });
  const pb = store.pb(level.id, level.version);
  const render = (): void => {
    tabs.replaceChildren(...(['any', 'collector'] as Board[]).filter((b) => b === 'any' || hasCollector).map((b) => h('button', {
      type: 'button', class: `tab${tab === b ? ' on' : ''}`, onclick: () => { tab = b; render(); },
    }, t(`board.${b}`))));
    const rs = rows[tab];
    list.replaceChildren(rs.length ? h('ol', { class: 'board-list' }, ...rs.map((r) => h('li', { class: me && r.player.toLowerCase() === me ? 'mine' : '' },
      h('span', { class: 'who' }, kidText(r.player)), ' ', h('span', { class: 'time' }, fmtTime(r.time_ms)),
      h('span', { class: 'small muted' }, ` · ${t('board.deaths', { n: r.deaths })}`),
      r.player === level.author ? h('span', { class: 'badge' }, t('play.creator')) : '',
      r.older || (r.level_version !== null && r.level_version !== level.version) ? h('span', { class: 'muted small' }, ` ${t('run.older_version')}`) : '',
      r.run_id ? h('a', { class: 'small race', href: `#/play/${encodeURIComponent(level.id)}?vs=${encodeURIComponent(r.run_id)}` }, ` ${t('play.race')}`) : '')))
      : h('p', { class: 'muted small' }, t(tab === 'any' ? 'play.board_empty' : 'board.collector_empty')));
  };
  render();
  return card('board', h('h3', null, t('play.board')), tabs, list,
    h('div', { class: 'row wrap small board-foot' },
      pb ? h('span', null, icon('star'), ' ', t('board.your_best', { time: fmtTime(pb.time_ms) })) : '',
      creator ? h('span', null, icon('pencil'), ' ', t('board.creator_best', { name: kidText(creator.player), time: fmtTime(creator.time_ms) })) : ''));
}

function emptyReport() {
  return {
    solvable: true, route: [], segments: [], C: 0, F: 0, score: 0, band: 'trivial' as const, C_skilled: 0, fastest_ms: 0, par_ms: 0,
    casual_clear_s: 0, flags: [], reachable: [], setpiece_order: [], slots: {}, engaged_enemies: 0, actions_per_screen: 0, trace: [],
    level_hash: '', core_version: '',
  };
}

/** §2.6 "Upgrade to v2" on a migrated v1 level: momentum physics, walkers with gravity; saved as a new version. */
function upgradeButton(level: LevelV2): HTMLElement {
  const b = h('button', { type: 'button', class: 'tool', title: t('upgrade.help') }, icon('next'), h('span', { class: 'lbl' }, t('upgrade.button')));
  b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await api.upgradeLevel(level.id);
      toast(t('upgrade.done', { v: r.version }));
      navigate(`#/play/${encodeURIComponent(level.id)}?v=${r.version}`);
    } catch (e) {
      toast(t(e instanceof ApiError ? e.messageKey : 'error.network'));
      b.disabled = false;
    }
  };
  return b;
}
