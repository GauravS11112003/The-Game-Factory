import { store } from '../store.ts';
import { navigate } from '../router.ts';
import { toast } from '../dom.ts';

export interface Room {
  id: string; draft_id: string; title: string; round: number; seed: number;
  phase: 'waiting' | 'countdown' | 'playing' | 'paused' | 'finished' | 'expired';
  start_at: number | null; server_time: number; winner: number | null;
  result: { winner: number | null; scores: number[]; text: string } | null;
  spec: { version: 1; mode: 'versus' | 'cooperative'; actions: { id: string; label: string }[] };
  players: { seat: number; name: string; ready: boolean; connected: boolean; rematch: boolean }[];
  world?: Record<string, unknown> | null; world_seq?: number; inputs?: string[][];
}
export interface RoomSession { token: string; seat: number; invite: string }
export interface SharingConfig { imessage_number: string | null; public_url?: string | null; local_publishing?: boolean }
export interface PublishedRoom { match: Room; invite: string; invite_url: string; card_url: string; imessage_number: string | null }
export function localOnlyAddress(url: string): boolean {
  const { hostname, protocol } = new URL(url);
  return protocol === 'http:' || ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
export function messagesLink(number: string, draftId: string): string {
  return `sms:${number}&body=${encodeURIComponent(`play ${draftId}`)}`;
}
const memory = new Map<string, RoomSession>();
export function roomSession(id: string, value?: RoomSession): RoomSession | null {
  if (value) memory.set(id, value);
  try {
    if (value) localStorage.setItem(`dp.room.${id}`, JSON.stringify(value));
    return JSON.parse(localStorage.getItem(`dp.room.${id}`) ?? 'null') as RoomSession | null ?? memory.get(id) ?? null;
  } catch { return memory.get(id) ?? null; }
}
export async function roomRequest<T>(method: string, path: string, body?: unknown, token?: string, invite?: string): Promise<T> {
  const response = await fetch(`/api/v2/play-rooms${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(invite ? { 'X-Race-Invite': invite } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path.endsWith('/publish') ? 45000 : 15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail?.message ?? 'Could not connect. Try again.');
  return data as T;
}
export async function startGeneratedRoom(draftId: string, button?: HTMLButtonElement): Promise<void> {
  if (button) button.disabled = true;
  try {
    const created = await roomRequest<{ match: Room; token: string; invite: string }>('POST', '', { draft_id: draftId, name: (store.author() || 'Player 1').slice(0, 16) });
    roomSession(created.match.id, { token: created.token, seat: 0, invite: created.invite });
    document.querySelectorAll('.modal-back').forEach(el => el.remove());
    navigate(`#/room/${created.match.id}?invite=${encodeURIComponent(created.invite)}`);
  } catch (error) { toast(error instanceof Error ? error.message : 'Could not invite your friend.'); }
  finally { if (button) button.disabled = false; }
}
