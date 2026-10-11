import { card, h, toast } from '../dom.ts';
import { store } from '../store.ts';
import { roomDocument } from '../rooms/bridge.ts';
import { roomRequest, roomSession, type Room } from '../rooms/api.ts';

export function roomScreen(root: HTMLElement, id: string, query: URLSearchParams): () => void {
  let disposed = false;
  let session = roomSession(id);
  const invite = query.get('invite') ?? session?.invite ?? '';
  let room: Room | null = null;
  let socket: WebSocket | null = null;
  let reconnect = 0;
  let loaded = false;
  let authenticated = false;
  let startedRound = 0;
  let lastWorld = -1;
  let wasReady = false;
  let restoreHost = true;
  let gameFault = false;
  let frame: HTMLIFrameElement | null = null;
  const nonce = crypto.randomUUID();
  const held = new Set<string>();
  const pressedAt = new Map<string, number>();
  const releases = new Map<string, number>();
  const keys: Record<string, string> = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down', ' ': 'jump', j: 'attack', k: 'special', l: 'block', Enter: 'confirm' };
  const title = h('h1', null, 'Play with a friend');
  const status = h('p', { role: 'status', 'aria-live': 'polite' }, 'Opening your game…');
  const seats = h('div', { class: 'room-seats' });
  const error = h('p', { role: 'alert', class: 'room-error' });
  const ready = h('button', { class: 'pill primary', type: 'button', disabled: true }, 'Ready');
  const rematch = h('button', { class: 'pill', type: 'button', hidden: true }, 'Play again');
  const share = h('button', { class: 'pill', type: 'button' }, 'Invite a friend');
  const imessage = h('a', { class: 'pill', hidden: true }, 'Start in iMessage');
  const messagingNote = h('p', { class: 'small muted' });
  const joinPanel = h('div');
  const game = h('div', { class: 'room-game' });
  const touch = h('div', { class: 'room-controls', 'aria-label': 'Your game controls' });
  root.append(h('div', { class: 'room-screen' }, card(null, title, status, seats,
    h('div', { class: 'row wrap' }, ready, rematch, share, imessage), joinPanel, error, messagingNote), game, touch));
  const send = (data: Record<string, unknown>): void => {
    if (authenticated && socket?.readyState === WebSocket.OPEN && room) socket.send(JSON.stringify({ ...data, round: room.round }));
  };
  const command = (data: Record<string, unknown>): void => { frame?.contentWindow?.postMessage({ channel: 'draw-play-room', nonce, ...data }, '*'); };
  const input = (): void => { if (room?.phase === 'playing') send({ type: 'input', actions: [...held] }); };
  function hold(action: string, down: boolean): void {
    window.clearTimeout(releases.get(action));
    if (down) { pressedAt.set(action, performance.now()); held.add(action); input(); }
    else {
      // Brief taps must survive the relay's snapshot cadence, including touch and keyboard presses.
      releases.set(action, window.setTimeout(() => { held.delete(action); releases.delete(action); input(); },
        Math.max(0, 200 - (performance.now() - (pressedAt.get(action) ?? 0)))));
    }
  }
  const release = (): void => { for (const timer of releases.values()) window.clearTimeout(timer); releases.clear(); held.clear(); input(); };
  function report(e: unknown): void { if (!disposed) error.textContent = e instanceof Error ? e.message : 'Could not connect. Try again.'; }
  function sync(): void {
    if (!room) return;
    title.textContent = room.title;
    seats.replaceChildren(...[0, 1].map(seat => { const p = room!.players.find(x => x.seat === seat); return h('span', null, p ? `${p.name}${session?.seat === seat ? ' (you)' : ''} · ${p.ready ? 'Ready' : p.connected ? 'Joined' : 'Away'}` : 'Waiting for your friend'); }));
    ready.hidden = !session || !['waiting', 'paused'].includes(room.phase);
    ready.disabled = !loaded || !authenticated || gameFault;
    ready.textContent = wasReady ? 'Ready ✓' : 'Ready';
    rematch.hidden = room.phase !== 'finished' || !session;
    rematch.disabled = !authenticated || !!room.players.find(p => p.seat === session?.seat)?.rematch;
    rematch.textContent = rematch.disabled ? 'Waiting for your friend…' : 'Play again';
    if (gameFault) status.textContent = 'This game needs a multiplayer repair.';
    else if (!authenticated && session) status.textContent = 'Reconnecting… Your game is paused.';
    else if (room.phase === 'waiting') status.textContent = loaded ? 'Both players tap Ready to begin.' : 'Loading the game…';
    else if (room.phase === 'countdown') status.textContent = 'Get ready…';
    else if (room.phase === 'playing') status.textContent = `You are Player ${(session?.seat ?? 0) + 1}. ${room.spec.mode === 'cooperative' ? 'Work together!' : 'Good luck!'}`;
    else if (room.phase === 'paused') status.textContent = 'Paused while your friend reconnects.';
    else if (room.phase === 'finished') status.textContent = `${room.result?.text ?? 'Round complete'} · ${room.result?.scores.join(' – ') ?? ''}`;
    else status.textContent = 'This invitation expired. Create a new game.';
    for (const button of touch.querySelectorAll<HTMLButtonElement>('button')) button.disabled = room.phase !== 'playing' || !authenticated || gameFault;
    if (loaded && session) {
      if (startedRound !== room.round) {
        startedRound = room.round; lastWorld = -1; restoreHost = false;
        command({ type: 'start', round: room.round, seed: room.seed, seat: session.seat, world: room.world });
      }
      const world = session.seat === 1 && room.world_seq !== lastWorld || session.seat === 0 && restoreHost ? room.world : undefined;
      if (world) { lastWorld = room.world_seq ?? 0; restoreHost = false; }
      command({ type: 'state', round: room.round, paused: room.phase !== 'playing' || !authenticated || gameFault, inputs: room.inputs, ...(world ? { world } : {}) });
    }
  }
  function receive(event: MessageEvent): void {
    const m = event.data;
    if (!frame || event.source !== frame.contentWindow || m?.channel !== 'draw-play-room' || m.nonce !== nonce) return;
    if (m.type === 'ready') { loaded = true; sync(); }
    else if (m.type === 'error') {
      gameFault = true; release(); command({ type: 'pause' });
      error.textContent = String(m.message).slice(0, 200); sync(); socket?.close();
    } else if (session?.seat === 0 && m.round === room?.round && room?.phase === 'playing' && !gameFault) {
      if (m.type === 'world' && m.world && typeof m.world === 'object' && !Array.isArray(m.world) && JSON.stringify(m.world).length <= 48000) send({ type: 'world', world: m.world });
      else if (m.type === 'finish') send({ type: 'finish', result: m.result });
    }
  }
  window.addEventListener('message', receive);
  async function mount(): Promise<void> {
    if (!session || disposed) return;
    const response = await fetch(`/api/v2/play-rooms/${id}/game`, { headers: { Authorization: `Bearer ${session.token}` } });
    if (!response.ok) throw new Error('This game could not be loaded. Reopen your invitation.');
    const html = await response.text();
    if (disposed) return;
    frame = h('iframe', { class: 'imagined-game', sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', title: room?.title ?? 'Two-player game', srcdoc: roomDocument(html, nonce) });
    game.replaceChildren(frame);
    touch.replaceChildren(...(room?.spec.actions ?? []).map(action => {
      const button = h('button', { class: 'pill', type: 'button', disabled: true, 'aria-label': action.label }, action.label);
      button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); hold(action.id, true); });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => { hold(action.id, false); });
      return button;
    }));
    connect();
  }
  function connect(): void {
    if (disposed || !session || gameFault) return;
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v2/play-rooms/${id}/socket`);
    socket.onopen = () => socket?.send(JSON.stringify({ type: 'auth', token: session!.token }));
    socket.onmessage = event => {
      const m = JSON.parse(event.data);
      if (m.type === 'authenticated') { authenticated = true; restoreHost = true; return; }
      if (m.type === 'state') {
        const next = m.room as Room;
        if (room && next.round !== room.round) { wasReady = false; held.clear(); }
        room = next; sync();
        if (wasReady && loaded && !room.players.find(p => p.seat === session?.seat)?.ready) send({ type: 'ready' });
      }
    };
    socket.onclose = () => {
      authenticated = false; held.clear(); command({ type: 'pause' }); sync();
      if (!disposed && !gameFault && room?.phase !== 'expired') reconnect = window.setTimeout(connect, 1500);
    };
  }
  ready.onclick = () => { wasReady = true; send({ type: 'ready' }); sync(); };
  rematch.onclick = () => { send({ type: 'rematch' }); rematch.disabled = true; };
  share.onclick = async () => {
    const url = new URL(`/api/v2/play-rooms/${id}/card?invite=${encodeURIComponent(invite)}`, location.origin).href;
    if (navigator.share) { try { await navigator.share({ title: room?.title, text: 'Play my new game with me!', url }); return; } catch (e) { if (e instanceof DOMException && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(url); toast('Invitation copied. Send it to your friend.'); }
    catch { window.prompt('Send this invitation to your friend', url); }
  };
  const keydown = (e: KeyboardEvent): void => {
    const action = e.key === ' ' && !room?.spec.actions.some(a => a.id === 'jump') ? 'attack' : keys[e.key];
    if (!action || /INPUT|TEXTAREA/.test((e.target as HTMLElement)?.tagName) || !room?.spec.actions.some(a => a.id === action) || room.phase !== 'playing') return;
    e.preventDefault(); if (!held.has(action)) { hold(action, true); }
  };
  const keyup = (e: KeyboardEvent): void => { const action = e.key === ' ' && !room?.spec.actions.some(a => a.id === 'jump') ? 'attack' : keys[e.key]; if (action && held.has(action)) { e.preventDefault(); hold(action, false); } };
  window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', release);
  const heartbeat = window.setInterval(() => { send({ type: 'ping' }); command({ type: 'hello' }); }, 1000);
  void (async () => {
    try {
      room = await roomRequest<Room>('GET', `/${id}`, undefined, session?.token, invite);
      if (disposed) return;
      sync();
      const config = await fetch('/api/v2/matches/config').then(r => r.json());
      if (disposed) return;
      if (config.imessage_number) {
        imessage.hidden = false;
        imessage.href = `sms:${config.imessage_number}&body=${encodeURIComponent(`play ${room.draft_id}`)}`;
        messagingNote.textContent = 'For play inside Messages, start a fresh card with the bot and forward it to your friend. Install Spectrum’s Messages app once.';
      } else messagingNote.textContent = 'This invitation opens in a browser. Activate your Spectrum bot for play inside Messages.';
      if (session) await mount();
      else {
        const name = h('input', { class: 'text', maxLength: 16, required: true, placeholder: 'Your name', value: (store.author() || '').slice(0, 16), 'aria-label': 'Your name' });
        const join = h('button', { class: 'pill primary', type: 'submit' }, 'Join game');
        const form = h('form', { class: 'row wrap' }, name, join); joinPanel.replaceChildren(form);
        form.onsubmit = async e => {
          e.preventDefault(); if (!name.value.trim()) return;
          join.disabled = true;
          const claimKey = `dp.room-claim.${id}`;
          let claim = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
          try { claim = localStorage.getItem(claimKey) ?? claim; localStorage.setItem(claimKey, claim); } catch { /* Memory claim remains valid for this attempt. */ }
          try {
            const joined = await roomRequest<{ match: Room; token: string; seat: number }>('POST', `/${id}/join`, { invite, name: name.value.trim(), claim });
            if (disposed) return;
            session = { token: joined.token, seat: joined.seat, invite }; roomSession(id, session); room = joined.match;
            joinPanel.replaceChildren(); sync(); await mount();
          } catch (e) { report(e); join.disabled = false; }
        };
      }
    } catch (e) { report(e); }
  })();
  return () => { disposed = true; release(); command({ type: 'pause' }); window.clearInterval(heartbeat); window.clearTimeout(reconnect); socket?.close(); window.removeEventListener('message', receive); window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', release); };
}
