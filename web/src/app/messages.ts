/** Kid-facing text (PLAN_V2 §7.10): every sentence comes from shared/spec/messages.json; raw codes never reach the DOM. */
import table from '../../../shared/spec/messages.json';
// v4 lanes keep their sentences in their own files (docs/v4/CONTRACTS_V4.md §8), merged over messages.json.
import v4Shell from '../../../shared/spec/messages-v4/shell.json';
import v4Core from '../../../shared/spec/messages-v4/core.json';
import v4Engine from '../../../shared/spec/messages-v4/engine.json';
import v4Api from '../../../shared/spec/messages-v4/api.json';
import v4Ui from '../../../shared/spec/messages-v4/ui.json';
import type { MessageRef, Role } from '../core/types.gen.ts';

type Table = { messages?: Record<string, string> };
const MESSAGES: Record<string, string> = Object.assign({},
  ...[table, v4Shell, v4Core, v4Engine, v4Api, v4Ui].map((x) => (x as Table).messages ?? {}));

export function hasMessage(key: string): boolean {
  return key in MESSAGES;
}

/** Placeholder values are shown as words: numbers are rounded, snake_case values become spaced words. */
function argText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
  return kidText(String(v));
}

/** Render a message; unknown keys render as a neutral ellipsis (and warn) instead of leaking the key. */
export function t(key: string, args: Record<string, unknown> = {}): string {
  const tpl = MESSAGES[key];
  if (tpl === undefined) {
    console.warn(`messages.json has no key ${key}`);
    return '…';
  }
  return tpl.replace(/\{([A-Za-z_]+)\}/g, (_, name: string) => argText(args[name]));
}

/** Like t(), but returns null for a missing key (so callers can fall back). */
export function tMaybe(key: string | null | undefined, args: Record<string, unknown> = {}): string | null {
  return key && hasMessage(key) ? t(key, args) : null;
}

export function tRef(ref: MessageRef): string {
  return t(ref.key, ref.args ?? {});
}

/** Free text from the model or a kid (reasons, notes, titles): never shows a raw snake_case code. */
export function kidText(s: string): string {
  return s.replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, (m) => m.replace(/_/g, ' '));
}

export function roleName(role: Role): string {
  return t(`role.${role}`);
}

/** Capitalized short role label for chips ("a ledge" → "Ledge"). */
export function roleChip(role: Role): string {
  const s = roleName(role).replace(/^(a|an|the)\s+/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Speedrun clock m:ss.cc (§5.9). */
export function fmtTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Short clock m:ss for bot and par times. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Signed seconds delta, e.g. "−1.32 s" / "+0.40 s". */
export function fmtDelta(ms: number): string {
  const s = Math.abs(ms) / 1000;
  return `${ms < 0 ? '−' : '+'}${s.toFixed(2)} s`;
}

export function fmtSeconds(ms: number): string {
  return `${(Math.abs(ms) / 1000).toFixed(2)} s`;
}
