/**
 * Kid-facing text drawn into canvases (share cards, theme swatches, ghost tags): every sentence comes from
 * shared/spec/messages.json (PLAN_V2 §7.10), with an English fallback while a key is still being added
 * (docs/v2/requests/E-2.md lists the keys lane E asks for). Raw codes never reach the screen.
 */
import table from '../../../shared/spec/messages.json';
import v4Shell from '../../../shared/spec/messages-v4/shell.json';
import v4Core from '../../../shared/spec/messages-v4/core.json';
import v4Engine from '../../../shared/spec/messages-v4/engine.json';
import v4Api from '../../../shared/spec/messages-v4/api.json';
import v4Ui from '../../../shared/spec/messages-v4/ui.json';

type Table = { messages?: Record<string, string> };
const MESSAGES: Record<string, string> = Object.assign({},
  ...[table, v4Shell, v4Core, v4Engine, v4Api, v4Ui].map((x) => (x as Table).messages ?? {}));

function arg(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
  return String(v).replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, (m) => m.replace(/_/g, ' '));
}

/** messages.json[key] with {placeholders} filled, else the fallback template (same placeholder syntax). */
export function msg(key: string, args: Record<string, unknown> = {}, fallback = ''): string {
  const tpl = MESSAGES[key] ?? fallback;
  return tpl.replace(/\{([A-Za-z_]+)\}/g, (_, name: string) => arg(args[name]));
}

/** m:ss.cc, the one clock format (§5.9). */
export function fmtClock(ms: number): string {
  const cs = Math.floor(Math.max(0, ms) / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
