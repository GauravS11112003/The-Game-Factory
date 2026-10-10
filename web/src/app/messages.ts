/** Kid-facing text (PLAN_V2 §7.10): every sentence comes from shared/spec/messages.json; raw codes never reach the DOM. */
import table from '../../../shared/spec/messages.json';
import type { MessageRef } from '../core/types.gen.ts';

const MESSAGES: Record<string, string> = (table as { messages: Record<string, string> }).messages;

export function hasMessage(key: string): boolean {
  return key in MESSAGES;
}

/** Render a message; unknown keys render as a neutral ellipsis (and warn) instead of leaking the key. */
export function t(key: string, args: Record<string, unknown> = {}): string {
  const tpl = MESSAGES[key];
  if (tpl === undefined) {
    console.warn(`messages.json has no key ${key}`);
    return '…';
  }
  return tpl.replace(/\{([a-z_]+)\}/g, (_, name: string) => (args[name] === undefined || args[name] === null ? '' : String(args[name])));
}

export function tRef(ref: MessageRef): string {
  return t(ref.key, ref.args ?? {});
}
