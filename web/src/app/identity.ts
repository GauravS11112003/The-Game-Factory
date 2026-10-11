/**
 * Identity (v3 contract, lane 5). No passwords: a profile is `{id, name, avatar_url}` plus a secret device token kept
 * in localStorage. Every request that acts as someone carries `X-DP-Player: <player_id>.<token>` (authHeaders()).
 * ensurePlayer() opens the friendly "Who are you?" sheet (a name and a drawn face) the first time it is needed and
 * creates the profile with POST /api/v2/collab/players. The same secret code can be typed on another device
 * ("I already have a player code") to be the same player there. editPlayer() reopens the sheet to change the name or
 * redraw the face (PUT /api/v2/collab/players/me).
 */
import { card, h, toast } from './dom.ts';
import { hasMessage, t } from './messages.ts';
import { store } from './store.ts';

export interface Player {
  id: string;
  name: string;
  avatar_url: string | null;
}

interface Saved {
  player: Player;
  token: string;
}

const KEY = 'dp.v3.player';
const BASE = '/api/v2/collab';

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Saved> | null;
    if (!v || !v.player || typeof v.player.id !== 'string' || typeof v.token !== 'string') return null;
    return { player: { id: v.player.id, name: String(v.player.name ?? ''), avatar_url: v.player.avatar_url ?? null }, token: v.token };
  } catch {
    return null;
  }
}

function save(v: Saved | null): void {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage off: the profile lives for this tab only */
  }
}

let saved: Saved | null = load();
if (saved?.player.name) store.setAuthor(saved.player.name);
const listeners = new Set<(p: Player | null) => void>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn(saved?.player ?? null);
    } catch (e) {
      console.warn('player listener failed', e);
    }
  }
}

/** The player on this device, or null before the "Who are you?" sheet was filled in. */
export function currentPlayer(): Player | null {
  return saved?.player ?? null;
}

/** `{ 'X-DP-Player': '<id>.<token>' }`, or `{}` when there is no profile yet. */
export function authHeaders(): Record<string, string> {
  return saved ? { 'X-DP-Player': `${saved.player.id}.${saved.token}` } : {};
}

/** Listen for sign-in, profile refreshes and "forget me". Returns an unsubscribe function. */
export function onPlayerChange(fn: (p: Player | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Merge fresh fields from the server (name, avatar) into the saved profile. */
export function updatePlayer(p: Partial<Player>): void {
  if (!saved) return;
  const next: Player = {
    id: saved.player.id,
    name: typeof p.name === 'string' && p.name ? p.name : saved.player.name,
    avatar_url: p.avatar_url !== undefined ? p.avatar_url ?? saved.player.avatar_url : saved.player.avatar_url,
  };
  if (next.name === saved.player.name && next.avatar_url === saved.player.avatar_url) return;
  saved = { ...saved, player: next };
  save(saved);
  store.setAuthor(next.name);
  emit();
}

/** Forget the profile on this device (the secret code brings it back). */
export function forgetPlayer(): void {
  saved = null;
  save(null);
  emit();
}

/** The secret player code (`<id>.<token>`): the same player on another device. */
export function secretCode(): string | null {
  return saved ? `${saved.player.id}.${saved.token}` : null;
}

type Any = any;

function toPlayer(x: Any): Player | null {
  const p = x?.player && typeof x.player === 'object' ? x.player : x;
  const id = p?.id ?? p?.player_id;
  if (typeof id !== 'string' || !id) return null;
  const avatar = p?.avatar_url ?? p?.avatar ?? null;
  return { id, name: typeof p?.name === 'string' ? p.name : '', avatar_url: typeof avatar === 'string' && avatar ? avatar : null };
}

async function readError(r: Response): Promise<string> {
  const j = (await r.json().catch(() => null)) as Any;
  const m = j?.detail && typeof j.detail === 'object' ? j.detail : j;
  const key = typeof m?.message_key === 'string' ? m.message_key : null;
  if (key && hasMessage(key)) return key;
  if (r.status === 429) return 'error.rate_limited';
  if (r.status === 404 || r.status === 501) return 'collab.not_ready';
  return 'collab.who.failed';
}

/** Check the saved profile against the server (on app start): a token the server no longer knows is forgotten. */
export async function refreshPlayer(): Promise<void> {
  if (!saved) return;
  const checking = saved;
  try {
    const r = await fetch(`${BASE}/players/me`, { headers: authHeaders() });
    // A response for an older login must not sign out or overwrite the current one.
    if (saved !== checking) return;
    if (r.status === 401 || r.status === 403) {
      forgetPlayer();
      return;
    }
    if (!r.ok) return;
    const p = toPlayer(await r.json());
    if (saved !== checking) return;
    if (p && p.id === saved.player.id) updatePlayer({ name: p.name, avatar_url: p.avatar_url ?? saved.player.avatar_url });
  } catch {
    /* offline: keep the profile */
  }
}

/** Use a secret code from another device. Resolves with the player when the server knows it. */
export async function useSecretCode(code: string): Promise<Player> {
  const clean = code.trim();
  const dot = clean.indexOf('.');
  if (dot <= 0 || dot === clean.length - 1) throw new Error('collab.who.bad_code');
  const id = clean.slice(0, dot);
  const token = clean.slice(dot + 1);
  let r: Response;
  try {
    r = await fetch(`${BASE}/players/me`, { headers: { 'X-DP-Player': `${id}.${token}` } });
  } catch {
    throw new Error('error.network');
  }
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 || r.status === 404 ? 'collab.who.bad_code' : await readError(r));
  const p = toPlayer(await r.json().catch(() => null)) ?? { id, name: '', avatar_url: null };
  saved = { player: { ...p, id }, token };
  save(saved);
  if (p.name) store.setAuthor(p.name);
  emit();
  return saved.player;
}

async function createPlayer(name: string, avatarPng: string | null): Promise<Player> {
  let r: Response;
  try {
    r = await fetch(`${BASE}/players`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(avatarPng ? { name, avatar_png: avatarPng } : { name }),
    });
  } catch {
    throw new Error('error.network');
  }
  if (!r.ok) throw new Error(await readError(r));
  const j = (await r.json().catch(() => null)) as Any;
  const p = toPlayer(j);
  const token = typeof j?.token === 'string' ? j.token : null;
  if (!p || !token) throw new Error('collab.who.failed');
  // the server stores the face; until it hands back a url, show the drawing we just made
  saved = { player: { ...p, name: p.name || name, avatar_url: p.avatar_url ?? avatarPng }, token };
  save(saved);
  store.setAuthor(saved.player.name);
  emit();
  return saved.player;
}

let pending: Promise<Player> | null = null;

/** The player, after the "Who are you?" sheet when there is none yet. Rejects when the kid closes the sheet. */
export function ensurePlayer(): Promise<Player> {
  const p = currentPlayer();
  if (p) return Promise.resolve(p);
  pending ??= openWhoSheet(null).finally(() => {
    pending = null;
  });
  return pending;
}

/** Change my name or redraw my face. Resolves with the updated player, or null when the sheet is closed. */
export function editPlayer(): Promise<Player | null> {
  const p = currentPlayer();
  if (!p) return ensurePlayer().then((x) => x, () => null);
  return openWhoSheet(p).then((x) => x, () => null);
}

async function savePlayer(name: string, avatarPng: string | null): Promise<Player> {
  if (!saved) throw new Error('collab.need_profile');
  let r: Response;
  try {
    r = await fetch(`${BASE}/players/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(avatarPng ? { name, avatar_png: avatarPng } : { name }),
    });
  } catch {
    throw new Error('error.network');
  }
  if (!r.ok) throw new Error(await readError(r));
  const p = toPlayer(await r.json().catch(() => null));
  updatePlayer({ name: p?.name || name, avatar_url: p?.avatar_url ?? avatarPng ?? undefined });
  store.setAuthor(saved.player.name);
  return saved.player;
}

// ---- the "Who are you?" sheet ------------------------------------------------------------------------------------

const FACE_COLORS = ['#1f1b18', '#e0453a', '#2c7be5', '#3e9e4f', '#6a5acd', '#d9822b'];
const FACE_PX = 192;

function faceCanvas(): { el: HTMLElement; png: () => string | null; clear: () => void } {
  const c = h('canvas', { class: 'collab-face-pad', width: FACE_PX, height: FACE_PX, 'aria-label': t('collab.who.face') });
  const ctx = c.getContext('2d');
  let color = FACE_COLORS[0];
  let drawn = false;
  let last: [number, number] | null = null;
  const paper = (): void => {
    if (!ctx) return;
    ctx.fillStyle = '#fffdf6';
    ctx.fillRect(0, 0, FACE_PX, FACE_PX);
  };
  paper();
  const at = (e: PointerEvent): [number, number] => {
    const b = c.getBoundingClientRect();
    return [((e.clientX - b.left) / Math.max(1, b.width)) * FACE_PX, ((e.clientY - b.top) / Math.max(1, b.height)) * FACE_PX];
  };
  const line = (a: [number, number], b: [number, number]): void => {
    if (!ctx) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0] + 0.01, b[1]);
    ctx.stroke();
  };
  c.onpointerdown = (e) => {
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    last = at(e);
    line(last, last);
    drawn = true;
  };
  c.onpointermove = (e) => {
    if (!last) return;
    const p = at(e);
    line(last, p);
    last = p;
  };
  c.onpointerup = c.onpointercancel = () => {
    last = null;
  };
  const swatches = h('div', { class: 'row wrap collab-face-colors' }, ...FACE_COLORS.map((col, i) => {
    const b = h('button', { type: 'button', class: `swatch small${i === 0 ? ' on' : ''}`, style: { background: col }, title: t('collab.who.color') });
    b.onclick = () => {
      color = col;
      swatches.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s === b));
    };
    return b;
  }));
  const clear = (): void => {
    paper();
    drawn = false;
  };
  const el = h('div', { class: 'collab-face' }, c,
    h('div', { class: 'collab-face-side' }, swatches,
      h('button', { type: 'button', class: 'pill small', onclick: clear }, t('collab.who.start_over'))));
  return { el, png: () => (drawn ? c.toDataURL('image/png') : null), clear };
}

function openWhoSheet(edit: Player | null): Promise<Player> {
  return new Promise<Player>((resolve, reject) => {
    const nameIn = h('input', { type: 'text', class: 'text collab-name-in', maxLength: 16, placeholder: t('ui.your_name'), value: edit?.name ?? store.author() });
    const face = faceCanvas();
    const err = h('p', { class: 'small warn collab-who-err' });
    const codeIn = h('input', { type: 'text', class: 'text', placeholder: t('collab.who.code_placeholder'), autocomplete: 'off' });
    const codeBox = h('div', { class: 'row wrap hidden collab-code-box' }, codeIn,
      h('button', { type: 'button', class: 'pill small', onclick: () => void useCode() }, t('collab.who.use_code')));
    const okBtn = h('button', { type: 'button', class: 'pill primary big' }, t(edit ? 'collab.who.save' : 'collab.who.thats_me'));
    let settled = false;
    const finish = (p: Player | null): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('hashchange', onNav);
      document.removeEventListener('keydown', onKey);
      back.remove();
      if (p) {
        toast(t(edit ? 'collab.who.saved' : 'collab.who.hello', { name: p.name }));
        resolve(p);
      } else reject(new Error('collab.who.cancelled'));
    };
    const onNav = (): void => finish(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(null);
    };
    const go = async (): Promise<void> => {
      const name = nameIn.value.trim().slice(0, 16);
      if (!name) {
        err.textContent = t('collab.who.need_name');
        nameIn.focus();
        return;
      }
      okBtn.disabled = true;
      err.textContent = '';
      try {
        finish(edit ? await savePlayer(name, face.png()) : await createPlayer(name, face.png()));
      } catch (e) {
        const key = e instanceof Error && hasMessage(e.message) ? e.message : 'collab.who.failed';
        err.textContent = t(key);
        okBtn.disabled = false;
      }
    };
    async function useCode(): Promise<void> {
      err.textContent = '';
      try {
        finish(await useSecretCode(codeIn.value));
      } catch (e) {
        err.textContent = t(e instanceof Error && hasMessage(e.message) ? e.message : 'collab.who.bad_code');
      }
    }
    okBtn.onclick = () => void go();
    nameIn.onkeydown = (e) => {
      if (e.key === 'Enter') void go();
    };
    const back = h('div', { class: 'modal-back collab-top' }, card('narrow collab-who',
      h('h2', { class: 'marker-underline' }, t(edit ? 'collab.who.edit_title' : 'collab.who.title')),
      h('p', { class: 'muted' }, t(edit ? 'collab.who.edit_help' : 'collab.who.help')),
      h('label', { class: 'field' }, h('span', null, t('collab.who.name')), nameIn),
      h('div', { class: 'field' }, h('span', null, t('collab.who.face')), face.el),
      err,
      h('div', { class: 'row between wrap' },
        edit ? h('span') : h('button', { type: 'button', class: 'link small', onclick: () => { codeBox.classList.toggle('hidden'); codeIn.focus(); } }, t('collab.who.have_code')),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'pill', onclick: () => finish(null) }, t('collab.who.not_now')),
          okBtn)),
      codeBox));
    back.addEventListener('pointerdown', (e) => {
      if (e.target === back) finish(null);
    });
    window.addEventListener('hashchange', onNav);
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    nameIn.focus();
  });
}
