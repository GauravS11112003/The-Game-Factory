import { card, h, toast } from '../dom.ts';
import { store } from '../store.ts';
import { roomDocument } from '../rooms/bridge.ts';
import { localOnlyAddress, messagesLink, roomRequest, roomSession, type PublishedRoom, type Room, type SharingConfig } from '../rooms/api.ts';
import './room.css';

export function roomScreen(root: HTMLElement, id: string, query: URLSearchParams): () => void {
  let disposed = false;
  let session = roomSession(id);
  let invite = query.get('invite') ?? session?.invite ?? '';
  const messages = query.get('surface') === 'messages';
  let enlarged = false;
  let safariPrepared = false;
  let transferring = false;
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
  let sessionEnded = false;
  let sharingConfig: SharingConfig = { imessage_number: null };
  let published: PublishedRoom | null = null;
  let publishing: Promise<PublishedRoom> | null = null;
  let frame: HTMLIFrameElement | null = null;
  const nonce = crypto.randomUUID();
  const held = new Set<string>();
  const pressedAt = new Map<string, number>();
  const releases = new Map<string, number>();
  const keys: Record<string, string> = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down', ' ': 'jump', j: 'attack', k: 'special', l: 'block', Enter: 'confirm' };
  const title = h('h1', { class: 'room-title' }, 'Play with a friend');
  const status = h('p', { role: 'status', 'aria-live': 'polite' }, 'Opening your game…');
  const seats = h('div', { class: 'room-seats' });
  const error = h('p', { role: 'alert', class: 'room-error' });
  const ready = h('button', { class: 'pill primary', type: 'button', disabled: true }, 'Ready');
  const rematch = h('button', { class: 'pill', type: 'button', hidden: true }, 'Play again');
  const share = h('button', { class: 'pill', type: 'button' }, 'Invite a friend');
  const imessage = h('a', { class: 'pill', hidden: true }, 'Start in iMessage');
  const online = h('a', { class: 'pill primary', hidden: true }, 'Open online game');
  const enlarge = h('button', { class: 'pill', type: 'button', 'aria-pressed': 'false' }, 'Enlarge');
  const safari = h('a', { class: 'pill', target: '_blank', rel: 'noopener noreferrer' }, 'Open in Safari');
  const messagingNote = h('p', { class: 'small muted' });
  const joinPanel = h('div');
  const game = h('div', { class: 'room-game' });
  const touch = h('div', { class: 'room-controls', 'aria-label': 'Your game controls' });
  const stage = h('div', { class: 'room-stage' }, game, touch);
  const lobby = card(null, title, status, seats,
    h('div', { class: 'row wrap room-actions' }, ready, rematch, share, enlarge, safari, imessage, online), joinPanel, error, messagingNote);
  lobby.classList.add('room-lobby');
  const screen = h('div', { class: `room-screen${messages ? ' room-messages' : ''}` }, lobby, stage);
  root.append(screen);
  if (messages) document.body.dataset.roomSurface = 'messages';
  safari.href = new URL(`/#/room/${id}?invite=${encodeURIComponent(invite)}`, location.origin).href;
  const fitStage = (): void => {
    const aspect = Number(screen.style.getPropertyValue('--room-aspect')) || 16 / 9;
    game.style.maxWidth = enlarged ? `${Math.max(1, stage.clientHeight - touch.offsetHeight - 8) * aspect}px` : '';
  };
  const resize = new ResizeObserver(fitStage);
  resize.observe(stage); resize.observe(touch);
  function playerClaim(): string {
    const key = `dp.room-claim.${id}`;
    let claim = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    try { claim = localStorage.getItem(key) ?? claim; localStorage.setItem(key, claim); } catch { /* Keep the in-memory claim. */ }
    return claim;
  }
  function setEnlarged(value: boolean): void {
    enlarged = value; screen.classList.toggle('room-enlarged', value);
    document.body.classList.toggle('room-is-enlarged', value);
    enlarge.textContent = value ? 'Minimize' : 'Enlarge';
    enlarge.setAttribute('aria-pressed', String(value));
    fitStage();
  }
  enlarge.onclick = async () => {
    release();
    if (enlarged) {
      if (document.fullscreenElement === screen) await document.exitFullscreen().catch(() => {});
      setEnlarged(false);
    } else {
      setEnlarged(true);
      // WKWebView may reject browser fullscreen. The fixed layout still fills its available area.
      if (screen.requestFullscreen) await screen.requestFullscreen().catch(() => {});
    }
  };
  const fullscreenChange = (): void => { if (!document.fullscreenElement) setEnlarged(false); };
  document.addEventListener('fullscreenchange', fullscreenChange);
  safari.onclick = async event => {
    if (!session || safariPrepared) return;
    event.preventDefault();
    if (transferring) return;
    transferring = true; safari.textContent = 'Preparing Safari…';
    try {
      const result = await roomRequest<{ handoff: string }>('POST', `/${id}/handoff`, undefined, session.token);
      safari.href = new URL(`/#/room/${id}?handoff=${encodeURIComponent(result.handoff)}`, location.origin).href;
      safariPrepared = true; safari.textContent = 'Continue in Safari';
      toast('Tap Continue in Safari to keep your player seat.');
      window.setTimeout(() => { if (!disposed) { safariPrepared = false; safari.textContent = 'Open in Safari'; } }, 110000);
    } catch (e) { safari.textContent = 'Open in Safari'; report(e); }
    finally { transferring = false; }
  };
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
    ready.hidden = !!published || !session || !['waiting', 'paused'].includes(room.phase);
    ready.disabled = !loaded || !authenticated || gameFault || sessionEnded;
    ready.textContent = wasReady ? 'Ready ✓' : 'Ready';
    rematch.hidden = room.phase !== 'finished' || !session;
    rematch.disabled = !authenticated || !!room.players.find(p => p.seat === session?.seat)?.rematch;
    rematch.textContent = rematch.disabled ? 'Waiting for your friend…' : 'Play again';
    if (published) status.textContent = 'Your game is online. Both players open the online invitation to play together.';
    else if (sessionEnded) status.textContent = safariPrepared ? 'Your player has moved to Safari. Continue there.' : 'This player session ended. Reopen your game in the other window.';
    else if (gameFault) status.textContent = 'This game needs a multiplayer repair.';
    else if (!authenticated && session) status.textContent = 'Reconnecting… Your game is paused.';
    else if (room.phase === 'waiting') status.textContent = !session ? 'Join to play with your friend.' : loaded ? 'Both players tap Ready to begin.' : 'Loading the game…';
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
    if (m.type === 'ready') {
      loaded = true;
      if (typeof m.aspect === 'number' && Number.isFinite(m.aspect) && m.aspect >= 0.25 && m.aspect <= 4) {
        screen.style.setProperty('--room-aspect', String(m.aspect));
        fitStage();
      }
      sync();
    }
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
    if (disposed || !session || gameFault || sessionEnded) return;
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
    socket.onclose = event => {
      if (event.code === 1008) sessionEnded = true;
      authenticated = false; held.clear(); command({ type: 'pause' }); sync();
      if (!disposed && !gameFault && !sessionEnded && room?.phase !== 'expired') reconnect = window.setTimeout(connect, 1500);
    };
  }
  ready.onclick = () => { wasReady = true; send({ type: 'ready' }); sync(); };
  rematch.onclick = () => { send({ type: 'rematch' }); rematch.disabled = true; };
  async function putOnline(): Promise<PublishedRoom> {
    if (published) return published;
    if (!session || session.seat !== 0) throw new Error('The host needs to put this local game online first.');
    if (!sharingConfig.local_publishing) throw new Error('This game is only on your Mac. Connect online sharing or create it on the live draw.play site.');
    publishing ??= roomRequest<PublishedRoom>('POST', `/${id}/publish`, undefined, session.token).then(result => {
      published = result;
      online.href = result.invite_url; online.hidden = false;
      messagingNote.textContent = 'Open online game on this device too. Both players must use the online invitation. For Messages, send the prepared text and share the returned Spectrum card.';
      if (result.imessage_number) { imessage.hidden = false; imessage.href = messagesLink(result.imessage_number, result.match.draft_id); imessage.textContent = 'Open Messages'; }
      sync();
      return result;
    }).catch(e => { publishing = null; throw e; });
    return publishing;
  }
  imessage.onclick = async event => {
    if (!sharingConfig.local_publishing || published) return;
    event.preventDefault(); imessage.textContent = 'Putting game online…';
    try { await putOnline(); toast('Your game is online. Tap Open Messages to send it.'); }
    catch (e) { imessage.textContent = 'Start in iMessage'; report(e); }
  };
  share.onclick = async () => {
    share.disabled = true;
    try {
      const url = sharingConfig.local_publishing || localOnlyAddress(location.href)
        ? (await putOnline()).card_url
        : new URL(`/api/v2/play-rooms/${id}/card?invite=${encodeURIComponent(invite)}`, location.origin).href;
      if (navigator.share) { try { await navigator.share({ title: room?.title, text: 'Play my new game with me!', url }); return; } catch (e) { if (e instanceof DOMException && e.name === 'AbortError') return; } }
      try { await navigator.clipboard.writeText(url); toast(published ? 'Online invitation copied. Send it to your friend, then open the online game here too.' : 'Invitation copied. Send it to your friend.'); }
      catch { window.prompt('Send this online invitation to your friend', url); }
    } catch (e) { report(e); }
    finally { share.disabled = false; }
  };
  const keydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && enlarged) { setEnlarged(false); return; }
    const action = e.key === ' ' && !room?.spec.actions.some(a => a.id === 'jump') ? 'attack' : keys[e.key];
    if (!action || /INPUT|TEXTAREA/.test((e.target as HTMLElement)?.tagName) || !room?.spec.actions.some(a => a.id === action) || room.phase !== 'playing') return;
    e.preventDefault(); if (!held.has(action)) { hold(action, true); }
  };
  const keyup = (e: KeyboardEvent): void => { const action = e.key === ' ' && !room?.spec.actions.some(a => a.id === 'jump') ? 'attack' : keys[e.key]; if (action && held.has(action)) { e.preventDefault(); hold(action, false); } };
  window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', release);
  const heartbeat = window.setInterval(() => { send({ type: 'ping' }); command({ type: 'hello' }); }, 1000);
  void (async () => {
    try {
      const handoff = query.get('handoff');
      if (handoff) {
        // Transfer codes live only in the fragment and are removed before any request.
        history.replaceState(null, '', `/#/room/${id}`);
        const resumed = await roomRequest<{ match: Room; token: string; seat: number; invite: string }>('POST', `/${id}/resume`, { handoff, claim: playerClaim() });
        if (disposed) return;
        invite = resumed.invite;
        session = { token: resumed.token, seat: resumed.seat, invite }; roomSession(id, session);
        safari.href = new URL(`/#/room/${id}?invite=${encodeURIComponent(resumed.invite)}`, location.origin).href;
      }
      room = await roomRequest<Room>('GET', `/${id}`, undefined, session?.token, invite);
      if (disposed) return;
      sync();
      const config: SharingConfig = await fetch('/api/v2/matches/config').then(r => r.json());
      if (disposed) return;
      sharingConfig = config;
      if (!messages && config.imessage_number && (!localOnlyAddress(location.href) || config.local_publishing)) {
        imessage.hidden = false;
        imessage.href = config.local_publishing ? '#' : messagesLink(config.imessage_number, room.draft_id);
        messagingNote.textContent = config.local_publishing ? 'Your game is on this Mac. Invite a friend or Start in iMessage will put it online first.' : 'For play inside Messages, start a fresh card with the bot and share it with your friend. Install Spectrum’s Messages app once.';
      } else if (messages) messagingNote.textContent = 'Share this card with your friend. Enlarge fills the available Messages area.';
      else messagingNote.textContent = localOnlyAddress(location.href) ? 'This game is only on your Mac. Connect online sharing before inviting a friend on another phone.' : 'This invitation opens in a browser. Activate your Spectrum bot for play inside Messages.';
      if (session) await mount();
      else {
        const name = h('input', { class: 'text', maxLength: 16, required: true, placeholder: 'Your name', value: (store.author() || '').slice(0, 16), 'aria-label': 'Your name' });
        const join = h('button', { class: 'pill primary', type: 'submit' }, 'Join game');
        const form = h('form', { class: 'row wrap' }, name, join); joinPanel.replaceChildren(form);
        form.onsubmit = async e => {
          e.preventDefault(); if (!name.value.trim()) return;
          join.disabled = true;
          const claim = playerClaim();
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
  return () => { disposed = true; resize.disconnect(); release(); setEnlarged(false); delete document.body.dataset.roomSurface; document.removeEventListener('fullscreenchange', fullscreenChange); command({ type: 'pause' }); window.clearInterval(heartbeat); window.clearTimeout(reconnect); socket?.close(); window.removeEventListener('message', receive); window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', release); };
}
