/**
 * Key schemes (catalog `keys`, docs/v6/CONTRACTS_V6.md §3): which physical keys (KeyboardEvent.code) a logical key means
 * for an object. 1-player worlds: every player object uses `single`. 2-player worlds: player-1 objects use `player1`
 * (WASD + F/G), player-2 objects use `player2` (arrows + L/K). Rule keys left…action2 follow the rule owner's scheme;
 * w/a/s/d/f/g/shift/enter/space are raw keys. Pure.
 */
import { CATALOG } from '../model/catalog.ts';

export type SchemeName = 'single' | 'player1' | 'player2';

/** Logical keys that follow a scheme. */
export const LOGICAL_KEYS = ['left', 'right', 'up', 'down', 'jump', 'action', 'action2'] as const;

const RAW: Record<string, string[]> = {
  w: ['KeyW'], a: ['KeyA'], s: ['KeyS'], d: ['KeyD'], f: ['KeyF'], g: ['KeyG'],
  shift: ['ShiftLeft', 'ShiftRight'], enter: ['Enter', 'NumpadEnter'], space: ['Space'],
};

const FALLBACK: Record<SchemeName, Record<string, string[]>> = {
  single: { left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'],
    jump: ['ArrowUp', 'KeyW', 'Space'], action: ['KeyE', 'Enter'], action2: ['KeyQ', 'ShiftLeft'], space: ['Space'] },
  player1: { left: ['KeyA'], right: ['KeyD'], up: ['KeyW'], down: ['KeyS'], jump: ['KeyW'], action: ['KeyF'], action2: ['KeyG'], space: ['Space'] },
  player2: { left: ['ArrowLeft'], right: ['ArrowRight'], up: ['ArrowUp'], down: ['ArrowDown'], jump: ['ArrowUp'], action: ['KeyL', 'Enter'],
    action2: ['KeyK'], space: ['ShiftRight'] },
};

export function scheme(name: SchemeName): Record<string, string[]> {
  return CATALOG.keys?.schemes?.[name] ?? FALLBACK[name];
}

/** The scheme an object with `player` uses in a world with `players` players. */
export function schemeName(player: number, players: number): SchemeName {
  if (players === 2 && player === 1) return 'player1';
  if (players === 2 && player === 2) return 'player2';
  return 'single';
}

/** Codes for a key used by a behaviour (the whole scheme applies, `space` included). */
export function behaviorCodes(key: string, s: SchemeName): string[] {
  const sc = scheme(s);
  return sc[key] ?? RAW[key] ?? [];
}

/** Codes for a key named in a rule (`any` → [] and handled by the caller). Raw keys stay raw. */
export function ruleCodes(key: string, s: SchemeName): string[] {
  if ((LOGICAL_KEYS as readonly string[]).includes(key)) return scheme(s)[key] ?? [];
  return RAW[key] ?? [];
}

/** Does this keyboard code mean `key` in a rule owned by scheme `s`? */
export function ruleKeyMatches(key: string, code: string, s: SchemeName): boolean {
  if (key === 'any') return true;
  return ruleCodes(key, s).includes(code);
}

/** Every code any scheme uses (so the runtime can preventDefault on them, e.g. arrows and space scrolling the page). */
export function allGameCodes(): Set<string> {
  const out = new Set<string>();
  for (const n of ['single', 'player1', 'player2'] as SchemeName[]) for (const v of Object.values(scheme(n))) v.forEach((c) => out.add(c));
  for (const v of Object.values(RAW)) v.forEach((c) => out.add(c));
  return out;
}
