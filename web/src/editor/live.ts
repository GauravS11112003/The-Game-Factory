/**
 * Live drawing (docs/v3/CONTRACTS_V3.md "Live drawing", lane 6): binds an editor to a room on
 * WebSocket /api/v2/live/<room> (protocol in vision/app/routers/v2/live.py).
 *
 * - Local changes are found by diffing the doc's strokes against a shadow copy after every doc change (strokes keep
 *   their object identity until they change), so the editor needs no op plumbing: adds and changes go out as
 *   `stroke_add` (upsert by id), deletions as `stroke_remove`, screens and title as `meta`.
 * - Remote ops are written straight into the doc and announced with an undo-free change, so they never echo back
 *   and never land on the local undo stack: undo only undoes your own strokes.
 * - Ops wait in an outbox until the server acks them. A remote op on a stroke with a pending local op is not shown
 *   (the local op comes later in the room's order and wins), so every copy converges on the server's order.
 * - Reconnects back off (0.5 s … 10 s) and resync: the room's state plus the pending outbox, re-sent (ops are
 *   idempotent upserts and removes).
 * - Remote cursors, name tags, avatars and in-progress strokes are painted as an overlay on the editor canvas.
 * - While live, new stroke ids come from a random per-session block (`s<base+n>`), so two people never mint the
 *   same id.
 */
import type { CellXY, InkColor, InkStroke } from '../core/types.gen.ts';
import type { EditorDoc, EditorDocData, Patch } from './doc.ts';
import type { EditorHandle } from './index.ts';
import { q } from './geom.ts';
import { INK, paintStroke } from './paint.ts';
import type { View } from './view.ts';

export interface LivePlayer {
  id: string;
  name: string;
  avatar_url: string | null;
}

export interface LivePen {
  k: string | number;
  color: InkColor;
  pts: [number, number, number][];
}

export interface LivePeer {
  conn: string;
  key: string;
  player: LivePlayer;
  color: string;
  cursor: CellXY | null;
  pen: LivePen | null;
  /** Last cursor activity (performance.now()). */
  at: number;
  /** Where the cursor is painted (eases toward `cursor`). */
  shown: CellXY | null;
}

export interface LivePencil {
  mode: boolean;
  holder: string | null;
}

export type LiveStatus = 'connecting' | 'live' | 'offline' | 'closed';

export interface LiveEvents {
  status?(s: LiveStatus, attempt: number): void;
  presence?(peers: LivePeer[], first: boolean): void;
  pencil?(p: LivePencil, prev: LivePencil): void;
  chat?(m: { peer: LivePeer | null; text: string; mine: boolean }): void;
  /** The server refused one of our ops (it was rolled back locally). */
  reject?(code: string): void;
  error?(code: string): void;
  synced?(first: boolean): void;
  meta?(m: { title?: string; screens?: number }): void;
  /** A drawing tool was pressed while someone else holds the pencil. */
  blocked?(): void;
}

export interface LiveOptions {
  room: string;
  /** host: the room is this doc (its strokes seed the room); guest: the doc becomes the room's drawing. */
  role: 'host' | 'guest';
  /** The X-DP-Player value (`<id>.<token>`), or '' (a guest by name). */
  token: string;
  name: string;
  events: LiveEvents;
}

export interface LiveSession {
  readonly room: string;
  readonly role: 'host' | 'guest';
  status(): LiveStatus;
  me(): LivePeer | null;
  /** Everyone in the room (one entry per connection, yourself included). */
  peers(): LivePeer[];
  pencil(): LivePencil;
  canDraw(): boolean;
  sendChat(text: string): void;
  setPencilMode(on: boolean): void;
  passPencil(toKey: string): void;
  takePencil(): void;
  /** Where a peer's cursor is on screen (CSS px in the canvas), for reaction bubbles. */
  cursorPx(conn: string): [number, number] | null;
  close(): void;
}

type OpBody =
  | { type: 'stroke_add'; strokes: InkStroke[] }
  | { type: 'stroke_remove'; ids: string[] }
  | { type: 'meta'; screens?: number; title?: string };
type Op = OpBody & { n: number };

interface WirePeer {
  conn: string;
  key: string;
  player: LivePlayer;
  color: string;
  cursor: [number, number] | null;
}

interface WirePen {
  k: string | number;
  color: InkColor;
  from: number;
  pts: number[][];
}

type Wire =
  | { type: 'hello'; conn: string; key: string; player: LivePlayer; color: string; pencil: LivePencil; limits?: { max_points?: number; max_batch?: number } }
  | { type: 'sync'; strokes: InkStroke[]; screens: number | null; title: string | null; seq: number; fresh: boolean }
  | { type: 'presence'; players: WirePeer[]; pencil: LivePencil }
  | { type: 'stroke_add'; strokes?: InkStroke[]; stroke?: InkStroke; by: string }
  | { type: 'stroke_remove'; ids?: string[]; id?: string; by: string }
  | { type: 'meta'; screens?: number; title?: string; by: string }
  | { type: 'ack'; n: number | null }
  | { type: 'reject'; n: number | null; code: string }
  | { type: 'cursor'; conn: string; x: number | null; y: number | null; pen?: WirePen }
  | { type: 'chat'; conn: string; key: string; player: LivePlayer; color: string; text: string }
  | { type: 'pencil'; mode: boolean; holder: string | null }
  | { type: 'pong' }
  | { type: 'error'; code: string };

const ROOM_RE = /^[A-Za-z0-9_-]{3,64}$/;
const CURSOR_MS = 50; // ≤ 20 cursor frames a second
const PEN_CHUNK = 300; // points per cursor frame (server cap 400)
const FRAME_BYTES = 1_500_000; // a seed batch is split into frames of about this size
const PING_MS = 15_000;
const DEAD_MS = 45_000;
const IDLE_FADE_MS = 8_000;

// ---- the doc id (= the room id) ----------------------------------------------------------------------------------------

type WithId = EditorDocData & { id?: unknown; doc_id?: unknown; docId?: unknown };

/** The editor doc's id (the live room id), when it has one. */
export function docIdOf(d: EditorDocData): string | null {
  const x = d as WithId;
  for (const v of [x.id, x.doc_id, x.docId]) if (typeof v === 'string' && ROOM_RE.test(v)) return v;
  return null;
}

/** The doc's id, minted (and saved with the doc's next snapshot) when it has none yet. */
export function ensureDocId(doc: EditorDoc): string {
  const have = docIdOf(doc.data);
  if (have) return have;
  const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  (doc.data as WithId).id = id;
  doc.setMeta({});
  return id;
}

/** A per-tab id, so a guest keeps their colour when the socket reconnects. */
function tabId(): string {
  try {
    let v = sessionStorage.getItem('dp.live.cid');
    if (!v) {
      v = Math.random().toString(36).slice(2, 12);
      sessionStorage.setItem('dp.live.cid', v);
    }
    return v;
  } catch {
    return Math.random().toString(36).slice(2, 12);
  }
}

// ---- stroke helpers -----------------------------------------------------------------------------------------------------

function sameStroke(a: InkStroke | undefined, b: InkStroke | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id || a.color !== b.color || a.kind !== b.kind || !!a.closed !== !!b.closed || a.sheet !== b.sheet || a.origin !== b.origin) return false;
  if ((a.stamp ?? null) !== (b.stamp ?? null) || (a.label ?? null) !== (b.label ?? null) || (a.t ?? null) !== (b.t ?? null)) return false;
  if (a.pts.length !== b.pts.length || a.w.length !== b.w.length) return false;
  for (let i = 0; i < a.pts.length; i++) {
    if (Math.abs(a.pts[i][0] - b.pts[i][0]) > 1e-4 || Math.abs(a.pts[i][1] - b.pts[i][1]) > 1e-4) return false;
  }
  for (let i = 0; i < a.w.length; i++) if (Math.abs(a.w[i] - b.w[i]) > 1e-4) return false;
  return JSON.stringify(a.rule ?? null) === JSON.stringify(b.rule ?? null) && JSON.stringify(a.lib ?? null) === JSON.stringify(b.lib ?? null);
}

function isStroke(x: unknown): x is InkStroke {
  const s = x as InkStroke | null;
  return !!s && typeof s.id === 'string' && Array.isArray(s.pts) && s.pts.length > 0 && Array.isArray(s.w) && typeof s.color === 'string';
}

function byT(strokes: InkStroke[]): InkStroke[] {
  return strokes.slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

function opIds(op: Op): string[] {
  return op.type === 'stroke_add' ? op.strokes.map((s) => s.id) : op.type === 'stroke_remove' ? op.ids : [];
}

/** Split strokes into frames of at most `maxBatch` strokes and about FRAME_BYTES of JSON. */
function chunks(strokes: InkStroke[], maxBatch: number): InkStroke[][] {
  const out: InkStroke[][] = [];
  let cur: InkStroke[] = [];
  let bytes = 0;
  for (const s of strokes) {
    const b = s.pts.length * 24 + 200;
    if (cur.length && (cur.length >= maxBatch || bytes + b > FRAME_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(s);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---- the binding --------------------------------------------------------------------------------------------------------

export function bindLive(editor: EditorHandle, o: LiveOptions): LiveSession {
  const doc = editor.doc;
  const ev = o.events;
  const cid = tabId();

  let ws: WebSocket | null = null;
  let status: LiveStatus = 'connecting';
  let closed = false;
  let attempt = 0;
  let retryTimer = 0;
  let pingTimer = 0;
  let lastMsgAt = performance.now();
  let synced = false; // the current socket has delivered its sync
  let firstSync = true;
  let firstPresence = true;
  let maxPoints = 5000;
  let maxBatch = 2000;

  // server state as known (acked ops + remote ops), the doc as last diffed, and our ops not acked yet
  let confirmed = new Map<string, InkStroke>();
  let confirmedScreens: number | null = null;
  let confirmedTitle: string | null = null;
  let shadow = new Map<string, InkStroke>(doc.data.strokes.map((s) => [s.id, s]));
  let shadowScreens = doc.data.screens;
  let shadowTitle = doc.data.title;
  let outbox: Op[] = [];
  let nextN = 1;
  let applying = false;
  let titleTimer = 0;

  let meConn: string | null = null;
  let meKey: string | null = null;
  let myColor = '#6a5acd';
  let myPlayer: LivePlayer = { id: '', name: o.name, avatar_url: null };
  const peers = new Map<string, LivePeer>();
  let pencil: LivePencil = { mode: false, holder: null };

  // ---- ids: a random block per session so two people never mint the same stroke id ----
  const origNewId = doc.newId;
  let idBase = 0;
  let idN = 0;
  const freshBase = (): number => (1 + Math.floor(Math.random() * 89_999)) * 10_000;
  idBase = freshBase();
  doc.newId = (prefix: 's' | 'c' = 's'): string => {
    for (;;) {
      idN++;
      if (idN > 9_999) {
        idBase = freshBase();
        idN = 1;
      }
      const id = `${prefix}${idBase + idN}`;
      if (!doc.data.strokes.some((s) => s.id === id) && !doc.data.character.some((s) => s.id === id)) return id;
    }
  };

  // ---- pass the pencil: only the holder may change the shared drawing ----
  const origApply = doc.apply;
  const origUndo = doc.undo;
  const origRedo = doc.redo;
  const blocked = (): void => ev.blocked?.();
  doc.apply = (p: Patch): void => {
    if (!canDraw() && (p.removed.length || p.added.length || p.screens)) {
      blocked();
      return;
    }
    origApply.call(doc, p);
  };
  doc.undo = (): void => {
    if (!canDraw()) return blocked();
    origUndo.call(doc);
  };
  doc.redo = (): void => {
    if (!canDraw()) return blocked();
    origRedo.call(doc);
  };

  function holderPresent(): boolean {
    return !!pencil.holder && [...peers.values()].some((p) => p.key === pencil.holder);
  }

  function canDraw(): boolean {
    return !pencil.mode || !pencil.holder || pencil.holder === meKey || !holderPresent();
  }

  function syncReadOnly(): void {
    editor.setReadOnly(canDraw() ? null : blocked);
  }

  // ---- sending ----
  function send(obj: Record<string, unknown>): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function sendOp(op: Op): void {
    if (synced) send(op as unknown as Record<string, unknown>);
  }

  function queue(op: OpBody): void {
    const full: Op = { ...op, n: nextN++ };
    outbox.push(full);
    sendOp(full);
  }

  function queueAdds(strokes: InkStroke[]): void {
    for (const c of chunks(strokes, maxBatch)) queue({ type: 'stroke_add', strokes: c });
  }

  function queueRemoves(ids: string[]): void {
    for (let i = 0; i < ids.length; i += maxBatch) queue({ type: 'stroke_remove', ids: ids.slice(i, i + maxBatch) });
  }

  // ---- local changes → ops ----
  function diffLocal(): void {
    const cur = doc.data.strokes;
    const added: InkStroke[] = [];
    const seen = new Set<string>();
    for (const s of cur) {
      seen.add(s.id);
      const was = shadow.get(s.id);
      if (was !== s && !sameStroke(was, s)) added.push(s);
    }
    const removed: string[] = [];
    for (const id of shadow.keys()) if (!seen.has(id)) removed.push(id);
    shadow = new Map(cur.map((s) => [s.id, s]));
    const tooLong = added.filter((s) => s.pts.length > maxPoints);
    if (tooLong.length) ev.reject?.('too_many_points');
    if (removed.length) queueRemoves(removed);
    const ok = added.filter((s) => s.pts.length <= maxPoints);
    if (ok.length) queueAdds(ok);
    if (doc.data.screens !== shadowScreens) {
      shadowScreens = doc.data.screens;
      queue({ type: 'meta', screens: shadowScreens });
    }
    if ((doc.data.title ?? '') !== (shadowTitle ?? '')) {
      window.clearTimeout(titleTimer);
      titleTimer = window.setTimeout(() => {
        titleTimer = 0;
        if ((doc.data.title ?? '') === (shadowTitle ?? '')) return;
        shadowTitle = doc.data.title ?? '';
        queue({ type: 'meta', title: shadowTitle.slice(0, 60) });
      }, 500);
    }
  }

  const offDoc = doc.on(() => {
    if (!applying && !closed) diffLocal();
  });

  // ---- remote changes → the doc, without an undo step ----
  /** Write into the doc and announce it as an undo-free edit (bumps rev, reruns the hints, saves the drawing). */
  function applyRemote(fn: (byId: Map<string, InkStroke>) => void): void {
    const byId = new Map(doc.data.strokes.map((s) => [s.id, s]));
    fn(byId);
    applying = true;
    try {
      doc.data.strokes = byT([...byId.values()]);
      shadow = new Map(doc.data.strokes.map((s) => [s.id, s]));
      shadowScreens = doc.data.screens;
      doc.setMeta({ library: doc.data.library }); // setMeta: no undo step; a library "change" counts as an ink change
    } finally {
      applying = false;
    }
  }

  /** A title from the room: saved with the drawing, shown in the title box, never echoed back. */
  function setTitleRemote(title: string): void {
    shadowTitle = title;
    if (doc.data.title !== title) doc.setMeta({ title });
    ev.meta?.({ title });
  }

  function pendingIds(): Set<string> {
    const out = new Set<string>();
    for (const op of outbox) for (const id of opIds(op)) out.add(id);
    return out;
  }

  function pendingMeta(field: 'screens' | 'title'): boolean {
    if (field === 'title' && titleTimer) return true;
    return outbox.some((op) => op.type === 'meta' && op[field] !== undefined);
  }

  function applyOp(map: Map<string, InkStroke>, op: Op): void {
    if (op.type === 'stroke_add') for (const s of op.strokes) map.set(s.id, s);
    else if (op.type === 'stroke_remove') for (const id of op.ids) map.delete(id);
  }

  function clearPen(conn: string): void {
    const p = peers.get(conn);
    if (p?.pen) {
      p.pen = null;
      editor.requestDraw();
    }
  }

  function onRemoteAdd(strokes: InkStroke[], by: string): void {
    for (const s of strokes) confirmed.set(s.id, s);
    clearPen(by);
    const pend = pendingIds();
    const show = strokes.filter((s) => !pend.has(s.id));
    if (show.length) applyRemote((byId) => { for (const s of show) byId.set(s.id, s); });
  }

  function onRemoteRemove(ids: string[]): void {
    for (const id of ids) confirmed.delete(id);
    const pend = pendingIds();
    const drop = ids.filter((id) => !pend.has(id) && shadow.has(id));
    if (drop.length) applyRemote((byId) => { for (const id of drop) byId.delete(id); });
  }

  function onRemoteMeta(m: { screens?: number; title?: string }): void {
    let screensChanged = false;
    if (typeof m.screens === 'number') {
      confirmedScreens = m.screens;
      if (!pendingMeta('screens') && m.screens !== doc.data.screens) {
        doc.data.screens = m.screens;
        screensChanged = true;
      }
    }
    if (typeof m.title === 'string') {
      confirmedTitle = m.title;
      if (!pendingMeta('title') && m.title !== doc.data.title) setTitleRemote(m.title);
    }
    if (screensChanged) {
      applyRemote(() => undefined);
      ev.meta?.({ screens: doc.data.screens });
    }
  }

  function onAck(n: number | null): void {
    const i = outbox.findIndex((op) => op.n === n);
    if (i < 0) return;
    const [op] = outbox.splice(i, 1);
    applyOp(confirmed, op);
    if (op.type === 'meta') {
      if (op.screens !== undefined) confirmedScreens = op.screens;
      if (op.title !== undefined) confirmedTitle = op.title;
    }
  }

  function onReject(n: number | null, code: string): void {
    const i = outbox.findIndex((op) => op.n === n);
    if (i >= 0) {
      const [op] = outbox.splice(i, 1);
      const pend = pendingIds();
      const ids = opIds(op).filter((id) => !pend.has(id));
      if (ids.length) {
        applyRemote((byId) => {
          for (const id of ids) {
            const s = confirmed.get(id);
            if (s) byId.set(id, s);
            else byId.delete(id);
          }
        });
      }
      if (op.type === 'meta' && op.screens !== undefined && confirmedScreens !== null && !pendingMeta('screens')) {
        doc.data.screens = confirmedScreens;
        applyRemote(() => undefined);
      }
    }
    ev.reject?.(code);
  }

  function onSync(m: Extract<Wire, { type: 'sync' }>): void {
    const strokes = (Array.isArray(m.strokes) ? m.strokes : []).filter(isStroke);
    confirmed = new Map(strokes.map((s) => [s.id, s]));
    confirmedScreens = typeof m.screens === 'number' ? m.screens : null;
    confirmedTitle = typeof m.title === 'string' ? m.title : null;
    const first = firstSync;
    firstSync = false;
    if (first && o.role === 'guest') {
      // the guest's doc becomes the room's drawing (a fresh undo stack: nothing of theirs is in it yet)
      outbox = [];
      applying = true;
      try {
        const data = doc.snapshot() as WithId;
        data.id = o.room;
        doc.load({
          ...data, strokes: byT(strokes), screens: confirmedScreens ?? data.screens, title: confirmedTitle ?? data.title,
        } as EditorDocData);
        (doc.data as WithId).id = o.room;
      } finally {
        applying = false;
      }
      shadow = new Map(doc.data.strokes.map((s) => [s.id, s]));
      shadowScreens = doc.data.screens;
      shadowTitle = doc.data.title;
      if (confirmedTitle !== null) ev.meta?.({ title: confirmedTitle });
    } else if (first) {
      // the host: the room keeps what it has, and this drawing's strokes it doesn't have yet are added to it
      outbox = [];
      const local = doc.data.strokes;
      const push = local.filter((s) => !sameStroke(confirmed.get(s.id), s) && s.pts.length <= maxPoints);
      const localIds = new Set(local.map((s) => s.id));
      const missing = strokes.filter((s) => !localIds.has(s.id));
      if (missing.length) applyRemote((byId) => { for (const s of missing) byId.set(s.id, s); });
      if (push.length) queueAdds(push);
      if (confirmedScreens === null || doc.data.screens > confirmedScreens) {
        queue({ type: 'meta', screens: doc.data.screens, ...(confirmedTitle === null && doc.data.title ? { title: doc.data.title.slice(0, 60) } : {}) });
      } else if (confirmedScreens > doc.data.screens) {
        doc.data.screens = confirmedScreens;
        applyRemote(() => undefined);
      }
      shadowScreens = doc.data.screens;
      if (confirmedTitle !== null && confirmedTitle !== doc.data.title) setTitleRemote(confirmedTitle);
    } else {
      // reconnect: the room as it is now, with our pending ops on top (they are re-sent below)
      const next = new Map(confirmed);
      for (const op of outbox) applyOp(next, op);
      let screens = confirmedScreens ?? doc.data.screens;
      for (const op of outbox) if (op.type === 'meta' && op.screens !== undefined) screens = op.screens;
      doc.data.screens = screens;
      applyRemote((byId) => {
        byId.clear();
        for (const [id, s] of next) byId.set(id, s);
      });
      if (confirmedTitle !== null && !pendingMeta('title') && confirmedTitle !== doc.data.title) setTitleRemote(confirmedTitle);
    }
    synced = true;
    for (const op of outbox) sendOp(op);
    setStatus('live');
    ev.synced?.(first);
  }

  // ---- presence, cursors, chat, pencil ----
  function peerFrom(w: WirePeer, old: LivePeer | undefined): LivePeer {
    const cursor: CellXY | null = Array.isArray(w.cursor) ? [w.cursor[0], w.cursor[1]] : null;
    return {
      conn: w.conn, key: w.key, player: w.player, color: w.color, cursor,
      pen: old?.pen ?? null, at: old?.at ?? performance.now(), shown: old?.shown ?? cursor,
    };
  }

  function onPresence(players: WirePeer[], p: LivePencil): void {
    const next = new Map<string, LivePeer>();
    for (const w of players) if (w && typeof w.conn === 'string') next.set(w.conn, peerFrom(w, peers.get(w.conn)));
    peers.clear();
    for (const [k, v] of next) peers.set(k, v);
    const first = firstPresence;
    firstPresence = false;
    ev.presence?.([...peers.values()], first);
    onPencil(p);
    editor.requestDraw();
  }

  function onPencil(p: LivePencil | undefined): void {
    if (!p) return;
    const prev = pencil;
    pencil = { mode: !!p.mode, holder: typeof p.holder === 'string' ? p.holder : null };
    syncReadOnly();
    if (prev.mode !== pencil.mode || prev.holder !== pencil.holder) ev.pencil?.(pencil, prev);
  }

  function onCursor(m: Extract<Wire, { type: 'cursor' }>): void {
    const p = peers.get(m.conn);
    if (!p) return;
    p.cursor = typeof m.x === 'number' && typeof m.y === 'number' ? [m.x, m.y] : null;
    if (p.cursor && !p.shown) p.shown = [p.cursor[0], p.cursor[1]];
    p.at = performance.now();
    const pen = m.pen;
    if (pen && Array.isArray(pen.pts) && INK[pen.color]) {
      if (!p.pen || p.pen.k !== pen.k) p.pen = { k: pen.k, color: pen.color, pts: [] };
      const from = Math.max(0, Math.floor(pen.from || 0));
      if (from < p.pen.pts.length) p.pen.pts.length = from;
      for (const pt of pen.pts) if (Array.isArray(pt) && pt.length >= 2) p.pen.pts.push([pt[0], pt[1], pt[2] ?? 0.75]);
    } else p.pen = null;
    editor.requestDraw();
  }

  // ---- the socket ----
  function setStatus(s: LiveStatus): void {
    if (status === s) return;
    status = s;
    ev.status?.(s, attempt);
  }

  function url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams({ cid, name: o.name.slice(0, 24) });
    if (o.token) qs.set('player', o.token);
    return `${proto}//${location.host}/api/v2/live/${encodeURIComponent(o.room)}?${qs.toString()}`;
  }

  function connect(): void {
    if (closed) return;
    window.clearTimeout(retryTimer);
    synced = false;
    firstPresence = true;
    setStatus(attempt ? 'offline' : 'connecting');
    let sock: WebSocket;
    try {
      sock = new WebSocket(url());
    } catch {
      scheduleRetry();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      lastMsgAt = performance.now();
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      lastMsgAt = performance.now();
      let m: Wire;
      try {
        m = JSON.parse(String(e.data)) as Wire;
      } catch {
        return;
      }
      if (!m || typeof m.type !== 'string') return;
      handle(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      synced = false;
      for (const p of peers.values()) p.pen = null;
      editor.requestDraw();
      if (!closed) scheduleRetry();
    };
    sock.onerror = () => undefined; // onclose follows
  }

  function scheduleRetry(): void {
    attempt++;
    setStatus('offline');
    const base = Math.min(10_000, 500 * 2 ** Math.min(5, attempt - 1));
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connect, base * (0.75 + Math.random() * 0.5));
  }

  function handle(m: Wire): void {
    switch (m.type) {
      case 'hello':
        meConn = m.conn;
        meKey = m.key;
        myColor = m.color;
        myPlayer = m.player;
        if (m.limits?.max_points) maxPoints = m.limits.max_points;
        if (m.limits?.max_batch) maxBatch = m.limits.max_batch;
        attempt = 0;
        onPencil(m.pencil);
        return;
      case 'sync':
        onSync(m);
        return;
      case 'presence':
        onPresence(Array.isArray(m.players) ? m.players : [], m.pencil);
        return;
      case 'stroke_add': {
        const list = (Array.isArray(m.strokes) ? m.strokes : m.stroke ? [m.stroke] : []).filter(isStroke);
        if (list.length) onRemoteAdd(list, m.by);
        return;
      }
      case 'stroke_remove': {
        const ids = (Array.isArray(m.ids) ? m.ids : m.id ? [m.id] : []).filter((x): x is string => typeof x === 'string');
        if (ids.length) onRemoteRemove(ids);
        return;
      }
      case 'meta':
        onRemoteMeta(m);
        return;
      case 'ack':
        onAck(m.n);
        return;
      case 'reject':
        onReject(m.n, m.code);
        return;
      case 'cursor':
        onCursor(m);
        return;
      case 'chat':
        ev.chat?.({ peer: peers.get(m.conn) ?? { conn: m.conn, key: m.key, player: m.player, color: m.color, cursor: null, pen: null, at: 0, shown: null }, text: m.text, mine: false });
        return;
      case 'pencil':
        onPencil(m);
        return;
      case 'error':
        ev.error?.(m.code);
        return;
      default:
        return;
    }
  }

  // ---- our cursor and the stroke being drawn ----
  const canvas = editor.canvas;
  let cursorCell: CellXY | null = null;
  let lastCell: CellXY | null = null; // where our reactions bubble up from after the pointer left the canvas
  let cursorTimer = 0;
  let lastCursorAt = 0;
  let penArr: readonly unknown[] | null = null;
  let penK = 0;
  let penSent = 0;

  function flushCursor(): void {
    cursorTimer = 0;
    if (!synced) return;
    lastCursorAt = performance.now();
    const msg: Record<string, unknown> = { type: 'cursor', x: cursorCell ? q(cursorCell[0]) : null, y: cursorCell ? q(cursorCell[1]) : null };
    const ls = editor.liveStroke();
    if (ls && ls.pts.length) {
      if (ls.pts !== penArr) {
        penArr = ls.pts;
        penK++;
        penSent = 0;
      }
      if (penSent > ls.pts.length) penSent = 0;
      const from = penSent;
      const part = ls.pts.slice(from, from + PEN_CHUNK).map((p) => [q(p.x), q(p.y), Math.round(p.w * 100) / 100]);
      penSent = from + part.length;
      msg.pen = { k: penK, color: ls.color, from, pts: part };
      if (penSent < ls.pts.length) scheduleCursor(); // the rest next frame
    } else penArr = null;
    send(msg);
  }

  function scheduleCursor(now = false): void {
    if (now) {
      window.clearTimeout(cursorTimer);
      flushCursor();
      return;
    }
    if (cursorTimer) return;
    cursorTimer = window.setTimeout(flushCursor, Math.max(0, CURSOR_MS - (performance.now() - lastCursorAt)));
  }

  const onMove = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    const [x, y] = editor.view.toCells(e.clientX - r.left, e.clientY - r.top);
    cursorCell = [x, y];
    lastCell = cursorCell;
    scheduleCursor();
  };
  const onLeave = (): void => {
    if (editor.liveStroke()) return;
    cursorCell = null;
    scheduleCursor();
  };
  const onUp = (): void => {
    // after the editor's own pointerup (which already sent the finished stroke): clear our in-progress ink
    window.setTimeout(() => scheduleCursor(true), 0);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  // ---- the overlay: remote cursors, name tags, avatars, strokes in progress ----
  const avatars = new Map<string, HTMLImageElement>();
  function avatarImg(src: string | null): HTMLImageElement | null {
    if (!src) return null;
    let img = avatars.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => editor.requestDraw();
      img.src = src;
      avatars.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  let lastFrame = performance.now();
  editor.setOverlay((ctx: CanvasRenderingContext2D, view: View, now: number): boolean => {
    const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    let anim = false;
    const S = view.scale;
    for (const p of peers.values()) {
      if (p.conn === meConn) continue;
      if (p.pen && p.pen.pts.length) {
        const pts = p.pen.pts;
        const s: InkStroke = {
          id: `live:${p.conn}`, color: p.pen.color, kind: pts.length === 1 ? 'dot' : 'line', pts: pts.map((x) => [x[0], x[1]] as CellXY),
          w: pts.map((x) => x[2]), closed: false, sheet: 0, origin: 'kid',
        };
        paintStroke(ctx, s, { scale: S, ox: view.x, oy: view.y, alpha: 0.85 });
      }
      if (!p.cursor) continue;
      if (!p.shown) p.shown = [p.cursor[0], p.cursor[1]];
      const k = 1 - Math.exp(-dt * 18);
      p.shown = [p.shown[0] + (p.cursor[0] - p.shown[0]) * k, p.shown[1] + (p.cursor[1] - p.shown[1]) * k];
      if (Math.hypot(p.cursor[0] - p.shown[0], p.cursor[1] - p.shown[1]) * S > 0.5) anim = true;
      const [x, y] = view.toPx(p.shown[0], p.shown[1]);
      if (x < -40 || y < -40 || x > view.w + 40 || y > view.h + 40) continue;
      const idle = now - p.at > IDLE_FADE_MS;
      drawCursor(ctx, x, y, p, idle ? 0.4 : 1, avatarImg(p.player.avatar_url), pencil.mode && pencil.holder === p.key);
    }
    return anim;
  });

  // ---- keepalive ----
  pingTimer = window.setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (performance.now() - lastMsgAt > DEAD_MS) {
      ws.close();
      return;
    }
    send({ type: 'ping' });
  }, PING_MS);
  const onOnline = (): void => {
    if (!closed && !ws) {
      attempt = Math.max(0, attempt - 1);
      connect();
    }
  };
  window.addEventListener('online', onOnline);

  connect();

  function close(): void {
    if (closed) return;
    closed = true;
    window.clearTimeout(retryTimer);
    window.clearTimeout(cursorTimer);
    window.clearTimeout(titleTimer);
    window.clearInterval(pingTimer);
    window.removeEventListener('online', onOnline);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    offDoc();
    doc.newId = origNewId;
    doc.apply = origApply;
    doc.undo = origUndo;
    doc.redo = origRedo;
    editor.setOverlay(null);
    editor.setReadOnly(null);
    const sock = ws;
    ws = null;
    if (sock) {
      sock.onclose = null;
      try {
        sock.close(1000);
      } catch {
        /* already closed */
      }
    }
    peers.clear();
    setStatus('closed');
  }

  return {
    room: o.room,
    role: o.role,
    status: () => status,
    me: () => (meConn ? peers.get(meConn) ?? { conn: meConn, key: meKey ?? '', player: myPlayer, color: myColor, cursor: null, pen: null, at: 0, shown: null } : null),
    peers: () => [...peers.values()],
    pencil: () => pencil,
    canDraw,
    sendChat(text: string) {
      const t = text.trim().slice(0, 40);
      if (!t) return;
      send({ type: 'chat', text: t });
      ev.chat?.({ peer: meConn ? peers.get(meConn) ?? null : null, text: t, mine: true });
    },
    setPencilMode(on: boolean) {
      send({ type: 'pencil', mode: on });
    },
    passPencil(toKey: string) {
      send({ type: 'pencil', to: toKey });
    },
    takePencil() {
      send({ type: 'pencil', take: true });
    },
    cursorPx(conn: string) {
      if (conn === meConn) {
        const at = cursorCell ?? lastCell;
        return at ? editor.view.toPx(at[0], at[1]) : null;
      }
      const p = peers.get(conn);
      const at = p?.shown ?? p?.cursor;
      return at ? editor.view.toPx(at[0], at[1]) : null;
    },
    close,
  };
}

// ---- painting a remote cursor -------------------------------------------------------------------------------------------

const TAG_FONT = '600 12px "Patrick Hand", "Comic Sans MS", "Chalkboard SE", system-ui, sans-serif';

function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, p: LivePeer, alpha: number, img: HTMLImageElement | null, holder: boolean): void {
  ctx.save();
  ctx.globalAlpha *= alpha;
  // the pointer: a marker-tip arrow in the player's colour
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 3.5, y + 15);
  ctx.lineTo(x + 7, y + 9.5);
  ctx.lineTo(x + 13.5, y + 9);
  ctx.closePath();
  ctx.fillStyle = p.color;
  ctx.strokeStyle = '#fffdf6';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
  // the name tag, with the avatar when there is one
  const name = `${holder ? '✏️ ' : ''}${p.player.name || '…'}`;
  ctx.font = TAG_FONT;
  const tw = ctx.measureText(name).width;
  const av = 18;
  const pad = 6;
  const w = tw + pad * 2 + (img ? av + 4 : 0);
  const h = 22;
  const tx = x + 12;
  const ty = y + 16;
  ctx.beginPath();
  const r = 11;
  ctx.moveTo(tx + r, ty);
  ctx.arcTo(tx + w, ty, tx + w, ty + h, r);
  ctx.arcTo(tx + w, ty + h, tx, ty + h, r);
  ctx.arcTo(tx, ty + h, tx, ty, r);
  ctx.arcTo(tx, ty, tx + w, ty, r);
  ctx.closePath();
  ctx.fillStyle = p.color;
  ctx.fill();
  let textX = tx + pad;
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(tx + 2 + av / 2, ty + h / 2, av / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#fffdf6';
    ctx.fill();
    ctx.clip();
    ctx.drawImage(img, tx + 2, ty + h / 2 - av / 2, av, av);
    ctx.restore();
    textX = tx + 2 + av + 4;
  }
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, textX, ty + h / 2 + 1);
  ctx.restore();
}
