/**
 * Live drawing on the draw screen (docs/v3/CONTRACTS_V3.md "Live drawing", lane 6).
 *
 * "Draw together" → the "Who are you?" sheet if needed → this drawing becomes a room (room id = the editor doc id) →
 * the share sheet: the link `#/draw?live=<room>&game=<id>`, Copy, a QR code (rendered by the server) and who is here.
 * Opening the link joins the room and loads the shared drawing (kept in its own saved slot, so the guest's own
 * drawing is never overwritten). A presence bar shows everyone's avatar in their colour, the connection, "Pass the
 * pencil" (only the holder can draw; the holder taps a friend to pass it) and emoji reactions that bubble up from
 * the sender's cursor.
 */
import type { EditorDocData, EditorHandle } from '../../editor/index.ts';
import { emptyDoc, isDoc } from '../../editor/index.ts';
import { bindLive, docIdOf, ensureDocId, type LivePeer, type LiveSession, type LiveStatus } from '../../editor/live.ts';
import { card, h, icon, toast } from '../dom.ts';
import { authHeaders, currentPlayer, ensurePlayer } from '../identity.ts';
import { store } from '../store.ts';
import { injectLiveStyles } from './style.ts';
import { lt } from './text.ts';

const ROOM_RE = /^[A-Za-z0-9_-]{3,64}$/;
const REACTIONS = ['👍', '😂', '😮', '❤️', '🎉', '👏'];

/** The room named by the draw screen's query (`live=<room>`), or null. */
export function liveRoom(query: URLSearchParams): string | null {
  const r = query.get('live');
  return r && ROOM_RE.test(r) ? r : null;
}

export interface LiveDoc {
  doc: EditorDocData;
  /** The store slot the drawing is saved in while it is open. */
  slot: string;
  role: 'host' | 'guest';
}

/** The drawing a room opens: your own drawing when the room is it (the host), else the shared copy in its own slot. */
export function liveDoc(room: string, gameId: string | null): LiveDoc {
  const cur = store.editorDoc();
  if (cur && isDoc(cur) && docIdOf(cur) === room) return { doc: cur, slot: 'current', role: 'host' };
  const slot = `live.${room}`;
  const saved = store.editorDoc(slot);
  let doc: EditorDocData = saved && isDoc(saved) ? saved : emptyDoc({ gameId });
  if (gameId && !doc.gameId) doc = { ...doc, gameId };
  (doc as EditorDocData & { id?: string }).id = room;
  return { doc, slot, role: 'guest' };
}

export interface MountLiveOptions {
  /** The draw screen's head row: the "Draw together" button goes there and the presence bar right after it. */
  head: HTMLElement;
  editor: EditorHandle;
  /** From liveDoc() when the screen was opened with `live=<room>`. */
  join?: { room: string; role: 'host' | 'guest' } | null;
}

export function mountLive(o: MountLiveOptions): () => void {
  injectLiveStyles();
  const editor = o.editor;
  let session: LiveSession | null = null;
  let disposed = false;
  let lastStatus: LiveStatus = 'connecting';
  let known = new Map<string, string>(); // player key → name, to say who joined and left
  let blockedToastAt = 0;
  let share: HTMLElement | null = null;

  const startBtn = h('button', { type: 'button', class: 'pill small accent', title: lt('draw_together_help') }, icon('share'), lt('draw_together'));
  startBtn.onclick = () => void start();
  o.head.append(startBtn);

  const bar = h('div', { class: 'live-bar hidden', role: 'region', 'aria-label': lt('draw_together') });
  o.head.after(bar);

  // ---- starting, joining, leaving ----
  async function start(): Promise<void> {
    if (session) return openShare();
    try {
      await ensurePlayer();
    } catch {
      /* the sheet was closed (or profiles are not reachable): draw together as a guest by name */
    }
    if (disposed || session) return;
    connect(ensureDocId(editor.doc), 'host');
    openShare();
  }

  async function joinLink(room: string, role: 'host' | 'guest'): Promise<void> {
    if (!currentPlayer() && role === 'guest') {
      try {
        await ensurePlayer();
      } catch {
        /* join as a guest by name */
      }
    }
    if (disposed || session) return;
    connect(room, role);
  }

  function connect(room: string, role: 'host' | 'guest'): void {
    const token = authHeaders()['X-DP-Player'] ?? '';
    const name = currentPlayer()?.name || store.author() || lt('guest');
    known = new Map();
    lastStatus = 'connecting';
    session = bindLive(editor, {
      room, role, token, name,
      events: {
        status: onStatus,
        presence: onPresence,
        pencil: (p, prev) => {
          const me = session?.me();
          if (p.mode !== prev.mode) toast(lt(p.mode ? 'pass_on' : 'pass_off'));
          else if (p.mode && me && p.holder === me.key && prev.holder !== me.key) toast(lt('your_turn'));
          renderBar();
          renderShare();
        },
        chat: ({ peer, text, mine }) => bubble(text, peer, mine),
        reject: (code) => toast(lt(code === 'too_many_points' ? 'too_long' : code === 'room_full' ? 'room_full' : code === 'not_your_turn' ? 'not_your_turn' : 'refused')),
        error: (code) => {
          if (code === 'not_your_turn') toast(lt('not_your_turn'));
          else if (code === 'slow_down' || code === 'too_fast') toast(lt('slow_down'));
        },
        synced: (first) => {
          if (first && role === 'guest') toast(lt('joined_room'));
        },
        meta: (m) => {
          const titleIn = o.head.querySelector<HTMLInputElement>('.title-in');
          if (m.title !== undefined && titleIn && document.activeElement !== titleIn) titleIn.value = m.title;
        },
        blocked: () => {
          const now = performance.now();
          if (now - blockedToastAt < 1500) return;
          blockedToastAt = now;
          const holder = holderPeer();
          toast(holder ? lt('their_turn', { name: holder.player.name || lt('someone') }) : lt('not_your_turn'));
          if (holder) bar.querySelector(`[data-key="${CSS.escape(holder.key)}"]`)?.classList.add('wiggle');
          window.setTimeout(() => bar.querySelectorAll('.wiggle').forEach((n) => n.classList.remove('wiggle')), 600);
        },
      },
    });
    setHash(room);
    startBtn.classList.add('hidden');
    bar.classList.remove('hidden');
    renderBar();
  }

  function leave(): void {
    const s = session;
    if (!s) return;
    session = null;
    s.close();
    share?.remove();
    share = null;
    bar.classList.add('hidden');
    bar.replaceChildren();
    startBtn.classList.remove('hidden');
    setHash(null);
    if (s.role === 'guest') toast(lt('left_room'));
  }

  /** Keep the room in the address (a reload rejoins it) without re-rendering the screen. */
  function setHash(room: string | null): void {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs = ''] = raw.split('?');
    if (path !== 'draw') return;
    const params = new URLSearchParams(qs);
    if (room) {
      params.set('live', room);
      const g = editor.doc.data.gameId;
      if (g) params.set('game', g);
      for (const k of ['new', 'from', 'remix', 'stamp']) params.delete(k);
    } else params.delete('live');
    const next = `#/draw${params.toString() ? `?${params.toString()}` : ''}`;
    if (next !== location.hash) history.replaceState(history.state, '', next);
  }

  // ---- events ----
  function onStatus(s: LiveStatus): void {
    if (s === 'offline' && lastStatus === 'live') toast(lt('lost'));
    if (s === 'live' && lastStatus === 'offline') toast(lt('back'));
    lastStatus = s;
    renderBar();
  }

  function onPresence(peers: LivePeer[], first: boolean): void {
    const me = session?.me();
    const next = new Map<string, string>();
    for (const p of peers) if (!me || p.key !== me.key) next.set(p.key, p.player.name || lt('someone'));
    if (!first) {
      for (const [k, name] of next) if (!known.has(k)) toast(lt('joined', { name }));
      for (const [k, name] of known) if (!next.has(k)) toast(lt('left', { name }));
    }
    known = next;
    renderBar();
    renderShare();
  }

  // ---- the presence bar ----
  function people(): LivePeer[] {
    const seen = new Set<string>();
    const out: LivePeer[] = [];
    const me = session?.me() ?? null;
    if (me) {
      seen.add(me.key);
      out.push(me);
    }
    for (const p of session?.peers() ?? []) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      out.push(p);
    }
    return out;
  }

  function holderPeer(): LivePeer | null {
    const p = session?.pencil();
    if (!p?.mode || !p.holder) return null;
    return people().find((x) => x.key === p.holder) ?? null;
  }

  function iHoldPencil(): boolean {
    const s = session;
    const me = s?.me();
    if (!s || !me) return false;
    const p = s.pencil();
    return p.mode && (p.holder === me.key || !holderPeer());
  }

  function avatar(p: LivePeer, mine: boolean, holder: boolean): HTMLElement {
    const canPass = !mine && iHoldPencil();
    const name = p.player.name || lt('someone');
    const b = h('button', {
      type: 'button', class: `live-av${mine ? ' me' : ''}${canPass ? ' can-pass' : ''}`, data: { key: p.key },
      title: mine ? `${name} (${lt('you')})` : canPass ? `${name}: ${lt('pass_mode')}` : name,
      style: { borderColor: p.color, background: p.color },
    }, p.player.avatar_url ? h('img', { src: p.player.avatar_url, alt: '' }) : (name.trim()[0] ?? '?').toUpperCase(),
    holder ? h('span', { class: 'live-badge', 'aria-hidden': 'true' }, '✏️') : null);
    b.onclick = () => {
      const s = session;
      if (!s || mine) return;
      const pen = s.pencil();
      if (!pen.mode) return;
      if (!iHoldPencil()) {
        const hp = holderPeer();
        toast(lt('only_holder', { name: hp?.player.name || lt('someone') }));
        return;
      }
      s.passPencil(p.key);
      toast(lt('passed_to', { name }));
    };
    return b;
  }

  function renderBar(): void {
    const s = session;
    if (!s) return;
    const st = s.status();
    const pen = s.pencil();
    const me = s.me();
    const holder = holderPeer();
    const dot = h('span', { class: `live-dot ${st}` });
    const label = st === 'live' ? lt('live') : st === 'offline' ? lt('offline') : lt('connecting');
    const avs = h('div', { class: 'live-avs' }, ...people().map((p) => avatar(p, !!me && p.key === me.key, pen.mode && (holder ? holder.key === p.key : false))));
    const passBtn = h('button', {
      type: 'button', class: `pill small${pen.mode ? ' on' : ''}`, title: lt('pass_help'), 'aria-pressed': pen.mode ? 'true' : 'false',
      onclick: () => {
        if (pen.mode && !iHoldPencil()) {
          toast(lt('only_holder', { name: holder?.player.name || lt('someone') }));
          return;
        }
        s.setPencilMode(!pen.mode);
      },
    }, '✏️ ', lt('pass_mode'));
    const takeBtn = pen.mode && !holder
      ? h('button', { type: 'button', class: 'pill small accent', onclick: () => s.takePencil() }, lt('take'))
      : null;
    const reacts = h('div', { class: 'live-reacts', role: 'group', 'aria-label': lt('react') },
      ...REACTIONS.map((e) => h('button', { type: 'button', title: lt('react'), onclick: () => s.sendChat(e) }, e)));
    bar.replaceChildren(
      h('span', { class: 'live-status', role: 'status' }, dot, label),
      avs, passBtn, ...(takeBtn ? [takeBtn] : []), reacts, h('span', { class: 'live-grow' }),
      h('button', { type: 'button', class: 'pill small', onclick: () => openShare() }, icon('share'), lt('invite')),
      h('button', { type: 'button', class: 'pill small', onclick: () => leave() }, icon('close'), lt('leave')));
  }

  // ---- reactions ----
  function bubble(text: string, peer: LivePeer | null, mine: boolean): void {
    const host = editor.canvas.parentElement;
    const s = session;
    if (!host || !s) return;
    const at = peer ? s.cursorPx(peer.conn) : null;
    const w = host.clientWidth;
    const hgt = host.clientHeight;
    const x = at ? Math.max(20, Math.min(w - 20, at[0])) : w * (0.3 + Math.random() * 0.4);
    const y = at ? Math.max(40, Math.min(hgt - 6, at[1])) : hgt - 24;
    const color = peer?.color ?? '#6a5acd';
    const tag = !mine && peer ? h('small', { style: { background: color } }, peer.player.name || lt('someone')) : null;
    const b = h('div', { class: 'live-bubble', style: { left: `${x}px`, top: `${y}px` } }, text, tag);
    host.append(b);
    window.setTimeout(() => b.remove(), 2300);
  }

  // ---- the share sheet ----
  let lanHost: string | null = null;
  let lanAsked = false;

  function shareLink(room: string): string {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    const origin = local && lanHost ? `${location.protocol}//${lanHost}${location.port ? `:${location.port}` : ''}` : location.origin;
    const g = editor.doc.data.gameId;
    return `${origin}${location.pathname}#/draw?live=${encodeURIComponent(room)}${g ? `&game=${encodeURIComponent(g)}` : ''}`;
  }

  function askLan(room: string): void {
    if (lanAsked) return;
    lanAsked = true;
    fetch(`/api/v2/live/${encodeURIComponent(room)}/info`).then((r) => (r.ok ? r.json() : null)).then((j: { lan_hosts?: unknown } | null) => {
      const hosts = Array.isArray(j?.lan_hosts) ? j.lan_hosts.filter((x): x is string => typeof x === 'string') : [];
      if (hosts.length) {
        lanHost = hosts[0];
        renderShare(true);
      }
    }).catch(() => undefined);
  }

  function openShare(): void {
    if (!session) return;
    share?.remove();
    share = h('div', { class: 'modal-back', role: 'dialog', 'aria-label': lt('share_title') });
    share.addEventListener('pointerdown', (e) => {
      if (e.target === share) closeShare();
    });
    document.body.append(share);
    renderShare(true);
    askLan(session.room);
  }

  function closeShare(): void {
    share?.remove();
    share = null;
  }

  function renderShare(full = false): void {
    const s = session;
    if (!share || !s) return;
    if (!full) {
      // presence and pencil changes only touch the "who's here" row
      const row = share.querySelector('.live-share-who');
      if (row) row.replaceChildren(...whoRow());
      const pass = share.querySelector<HTMLInputElement>('.live-pass input');
      if (pass) pass.checked = s.pencil().mode;
      return;
    }
    const link = shareLink(s.room);
    const input = h('input', { type: 'text', readOnly: true, value: link, 'aria-label': lt('share_title') });
    input.onfocus = () => input.select();
    const copy = h('button', { type: 'button', class: 'pill small primary' }, lt('copy'));
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(link);
        toast(lt('copied'));
      } catch {
        input.focus();
        input.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch {
          ok = false;
        }
        toast(lt(ok ? 'copied' : 'copy_failed'));
      }
    };
    const qr = h('img', { class: 'live-qr', alt: '', src: `/api/v2/live/${encodeURIComponent(s.room)}/qr.svg?url=${encodeURIComponent(link)}` });
    const qrCap = h('p', { class: 'muted small live-qr-cap' }, lt('scan'));
    qr.onerror = () => {
      qr.remove();
      qrCap.remove();
    };
    const pass = h('input', { type: 'checkbox', checked: s.pencil().mode });
    pass.onchange = () => {
      if (s.pencil().mode && !iHoldPencil()) {
        pass.checked = true;
        toast(lt('only_holder', { name: holderPeer()?.player.name || lt('someone') }));
        return;
      }
      s.setPencilMode(pass.checked);
    };
    share.replaceChildren(card('narrow live-share',
      h('h2', { class: 'marker-underline' }, lt('share_title')),
      h('p', { class: 'muted' }, lt('share_help')),
      h('div', { class: 'live-link' }, input, copy),
      qr, qrCap,
      h('h4', null, lt('here')),
      h('div', { class: 'live-avs live-share-who' }, ...whoRow()),
      h('label', { class: 'live-pass' }, pass, h('span', null, h('strong', null, lt('pass_mode')), h('br'), h('span', { class: 'muted small' }, lt('pass_help')))),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { type: 'button', class: 'pill', onclick: () => closeShare() }, lt('share_done')))));
  }

  function whoRow(): HTMLElement[] {
    const me = session?.me();
    const holder = holderPeer();
    return people().map((p) => avatar(p, !!me && p.key === me.key, !!holder && holder.key === p.key));
  }

  // ---- go ----
  if (o.join) void joinLink(o.join.room, o.join.role);

  return () => {
    disposed = true;
    const s = session;
    session = null;
    s?.close();
    share?.remove();
    bar.remove();
    startBtn.remove();
  };
}
