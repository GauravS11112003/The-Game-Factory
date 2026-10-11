/** The same two-seat lobby works in a browser and Photon's Messages launcher. */
import type { LevelV2, Replay } from '../../core/types.gen.ts';
import type { ReadyPayload, WinPayload } from '../../engine/types.ts';
import { ApiError } from '../api.ts';
import { card, h, icon } from '../dom.ts';
import { inkFromLevel } from '../ink.ts';
import { fmtTime, kidText, t } from '../messages.ts';
import { Stage } from '../stage.ts';
import { store } from '../store.ts';
import { joinClaim, raceApi, raceSession, savedRaceReplay, type Race } from '../races/api.ts';
import { shareRace } from '../races/share.ts';
import '../races/race.css';

export function raceScreen(root: HTMLElement, id: string, query: URLSearchParams): () => void {
  let disposed = false;
  let session = raceSession(id);
  const invite = query.get('invite') ?? session?.invite ?? '';
  let match: Race | null = null;
  let stage: Stage | null = null;
  let level: LevelV2 | null = null;
  let socket: WebSocket | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let retryFinish: ReturnType<typeof setTimeout> | undefined;
  let mountedRound = 0;
  let engineReady = false;
  let started = false;
  let connected = false;
  let stopped = false;
  let sendingFinish = false;
  let pendingReplay: Replay | null = null;
  let receivedAt = performance.now();
  let backoff = 500;
  let number: string | null = null;

  const status = h('p', { class: 'race-status', role: 'status', 'aria-live': 'polite' }, t('ui.loading'));
  const title = h('h2', { class: 'marker-underline' }, t('race.title'));
  const seats = h('div', { class: 'race-seats' });
  const controls = h('div', { class: 'row wrap race-actions' });
  const joinPanel = h('div');
  const game = h('div', { class: 'race-game' });
  const cover = h('div', { class: 'race-cover' }, t('race.waiting'));
  const errorLine = h('p', { class: 'race-error', role: 'alert' });
  const explanation = h('p', { class: 'small muted' }, t('race.clock_help'));
  const wrap = h('div', { class: 'race-screen' }, card(null, title, status, seats, controls, joinPanel, errorLine), game, explanation);
  root.append(wrap);

  const report = (error: unknown): void => {
    if (!disposed) errorLine.textContent = t(error instanceof ApiError ? error.messageKey : 'error.network');
  };
  const serverNow = (): number => (match?.server_time ?? Date.now() / 1000) + (performance.now() - receivedAt) / 1000;
  const send = (message: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const submitFinish = async (): Promise<void> => {
    if (disposed || sendingFinish || !pendingReplay || !session || !match || match.phase !== 'playing') return;
    const round = match.round;
    const replay = pendingReplay;
    sendingFinish = true;
    try {
      const result = await raceApi.finish(id, session.token, round, replay);
      if (disposed || match.round !== round) return;
      pendingReplay = null;
      errorLine.textContent = '';
      update(result);
    } catch (error) {
      report(error);
      if (!(error instanceof ApiError) || error.status === 0 || error.status === 503) {
        retryFinish = setTimeout(() => { void submitFinish(); }, 3000);
      }
    } finally { sendingFinish = false; }
  };

  const mount = (): void => {
    if (!level || !match || !session) return;
    stage?.destroy();
    mountedRound = match.round;
    engineReady = false;
    started = false;
    pendingReplay = null;
    if (retryFinish) clearTimeout(retryFinish);
    const resume = savedRaceReplay(id, mountedRound) ?? undefined;
    stage = new Stage('stage play-stage race-stage', { resume });
    const thisStage = stage;
    stage.on('ready', (payload: ReadyPayload) => {
      if (disposed || stage !== thisStage) return;
      engineReady = payload.sim === 'core';
      if (!engineReady) errorLine.textContent = t('race.engine_unavailable');
      render();
    });
    stage.on('race_progress', (progress: unknown) => {
      if (!match || stage !== thisStage || match.round !== mountedRound) return;
      send({ type: 'progress', round: mountedRound, progress });
      const frame = (progress as { frame: number }).frame;
      if (frame % 60 === 0) {
        const replay = stage?.replay();
        if (replay) savedRaceReplay(id, mountedRound, replay);
      }
    });
    stage.on('win', (payload: WinPayload) => {
      if (stage !== thisStage || !match || match.round !== mountedRound) return;
      pendingReplay = payload.replay;
      savedRaceReplay(id, mountedRound, payload.replay);
      void submitFinish();
    });
    stage.on('race_lost', () => send({ type: 'forfeit', round: mountedRound }));
    stage.setMode('play');
    stage.show({ level, ink: inkFromLevel(level) });
    game.replaceChildren(stage.el, cover);
  };

  const button = (label: string, action: () => Promise<unknown>): HTMLButtonElement => h('button', {
    type: 'button', class: 'pill primary', onclick: async (event: Event) => {
      const target = event.currentTarget as HTMLButtonElement;
      target.disabled = true;
      errorLine.textContent = '';
      try { await action(); } catch (error) { report(error); }
      finally { if (!disposed) target.disabled = false; }
    },
  }, label);

  const render = (): void => {
    if (!match || disposed) return;
    const me = match.players.find(player => player.seat === session?.seat);
    title.textContent = kidText(match.title);
    let message = t('race.waiting');
    if (match.phase === 'waiting') message = match.players.length < 2 ? t('race.invite_friend') : t('race.ready_help');
    if (match.phase === 'countdown') message = t('race.countdown', { n: Math.max(1, Math.ceil((match.start_at ?? 0) - serverNow())) });
    if (match.phase === 'playing') message = me?.result ? t('race.finished_waiting') : me?.forfeit ? t('race.left_waiting') : t('race.go');
    if (match.phase === 'finished') {
      const winner = match.players.find(player => player.seat === match!.winner);
      message = winner ? winner.seat === session?.seat ? t('race.you_win') : t('race.winner', { name: winner.name })
        : match.players.every(player => player.result) ? t('race.tie') : t('race.no_finish');
    }
    if (match.phase === 'expired') message = t('race.expired');
    if (session && !connected && !stopped) message = t('race.reconnecting');
    if (stopped) message = t('race.other_tab');
    status.textContent = message;
    cover.textContent = message;
    const running = match.phase === 'playing' && connected && !me?.result && !me?.forfeit;
    cover.hidden = running;
    if (engineReady && running && serverNow() >= (match.start_at ?? Infinity) && !document.hidden) {
      stage?.resume();
      started = true;
    } else if (started || match.phase !== 'playing') stage?.pause();
    seats.replaceChildren(...[1, 2].map(seat => {
      const player = match!.players.find(p => p.seat === seat);
      const label = player ? `${player.name}${seat === session?.seat ? ` (${t('race.you')})` : ''}` : t('race.open_seat');
      const state = player?.result ? t('race.verified_time', { time: fmtTime(player.result.elapsed_ms) })
        : player?.forfeit ? t('race.left') : player?.ready ? t('race.ready') : player?.connected ? t('race.joined') : t('race.offline');
      const progress = h('progress', { max: 1, value: player?.result ? 1 : Math.max(0, Math.min(1, (player?.progress?.x ?? 0) / (level?.world.w ?? 48))), 'aria-label': label });
      return h('div', { class: `race-seat race-seat-${seat}` }, h('strong', null, label), h('span', { class: 'small muted' }, state), progress);
    }));
    controls.replaceChildren();
    if (session && me && match.phase === 'waiting') {
      const ready = button(me.ready ? t('race.wait_friend') : t('race.im_ready'), async () => {
        update(await raceApi.ready(id, session!.token, match!.round));
      });
      ready.disabled = me.ready || !engineReady || !connected;
      controls.append(ready);
    }
    if (session && match.phase === 'finished') {
      const rematch = button(me?.rematch ? t('race.wait_rematch') : t('race.rematch'), async () => {
        update(await raceApi.rematch(id, session!.token, match!.round));
      });
      rematch.disabled = !!me?.rematch;
      controls.append(rematch);
    }
    if (invite && match.phase === 'waiting') {
      controls.append(button(t('race.share'), () => shareRace(id, invite)));
      if (number && match.players.length < 2) {
        // Messages has its own browser storage. Start with two open seats there,
        // rather than leaving the host's private ticket stranded in Safari.
        const command = `race ${match.level_id} v${match.level_version}`;
        controls.append(h('a', { class: 'pill', href: `sms:${number}?&body=${encodeURIComponent(command)}` }, icon('share'), t('race.send_imessage')));
      }
    }
    if (session && match.phase === 'playing' && !me?.result && !me?.forfeit) {
      controls.append(button(t('race.leave'), async () => { send({ type: 'forfeit', round: match!.round }); }));
    }
    controls.append(h('a', { class: 'pill', href: `#/play/${match.level_id}?v=${match.level_version}` }, t('race.solo')));
  };

  function update(next: Race): void {
    if (disposed) return;
    match = next;
    receivedAt = performance.now();
    if (level && session && mountedRound !== next.round) mount();
    render();
  }

  const connect = (): void => {
    if (disposed || !session || stopped) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/api/v2/matches/${encodeURIComponent(id)}/socket`);
    socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'authenticate', token: session!.token }));
    ws.onmessage = event => {
      if (disposed || socket !== ws) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'error') {
          errorLine.textContent = t(data.message_key);
          stopped = true;
          return;
        }
        if (data.type === 'state') {
          connected = true;
          backoff = 500;
          update(data.match as Race);
        }
      } catch { report(new Error('Invalid match response')); }
    };
    ws.onclose = () => {
      if (disposed || socket !== ws) return;
      connected = false;
      const replay = stage?.replay();
      if (replay && match) savedRaceReplay(id, match.round, replay);
      stage?.pause();
      render();
      if (!stopped) {
        reconnect = setTimeout(connect, backoff);
        backoff = Math.min(5000, backoff * 2);
      }
    };
  };

  const loadPlayer = async (): Promise<void> => {
    if (!session) return;
    const response = await raceApi.level(id, session.token);
    if (disposed) return;
    level = response.level;
    joinPanel.replaceChildren();
    mount();
    connect();
  };

  const joinForm = (): void => {
    const name = h('input', { class: 'text', maxLength: 16, value: store.author(), placeholder: t('race.name'), required: true, 'aria-label': t('race.name') });
    const submit = h('button', { type: 'submit', class: 'pill primary' }, t('race.join'));
    const form = h('form', { class: 'row wrap', onsubmit: async (event: Event) => {
      event.preventDefault();
      const chosen = name.value.trim();
      if (!chosen) { name.focus(); return; }
      submit.disabled = true;
      try {
        const joined = await raceApi.join(id, invite, chosen, joinClaim(id));
        if (disposed) return;
        session = { token: joined.token, seat: joined.seat, invite };
        raceSession(id, session);
        update(joined.match);
        await loadPlayer();
      } catch (error) { report(error); submit.disabled = false; }
    } }, name, submit);
    joinPanel.replaceChildren(form);
  };

  void raceApi.config().then(config => {
    if (disposed) return;
    number = config.imessage_number && /^\+?[0-9]{7,15}$/.test(config.imessage_number) ? config.imessage_number : null;
    render();
  }).catch(() => undefined);
  void (async () => {
    try {
      const initial = await raceApi.snapshot(id, session?.token, invite);
      update(initial);
      if (disposed) return;
      if (session) await loadPlayer();
      else if (initial.phase === 'waiting' && invite) joinForm();
    } catch (error) { report(error); }
  })();
  const heartbeat = setInterval(() => { if (connected) send({ type: 'ping' }); }, 5000);
  const countdown = setInterval(() => { if (match?.phase === 'countdown') render(); }, 250);
  const onVisibility = (): void => {
    if (document.hidden) {
      stage?.pause();
      const replay = stage?.replay();
      if (replay && match) savedRaceReplay(id, match.round, replay);
    } else {
      if (connected) send({ type: 'ping' });
      render();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    disposed = true;
    clearInterval(heartbeat);
    clearInterval(countdown);
    if (reconnect) clearTimeout(reconnect);
    if (retryFinish) clearTimeout(retryFinish);
    document.removeEventListener('visibilitychange', onVisibility);
    const replay = stage?.replay();
    if (replay && match) savedRaceReplay(id, match.round, replay);
    socket?.close();
    stage?.destroy();
    wrap.remove();
  };
}
