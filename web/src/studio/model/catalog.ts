/**
 * The Studio catalog (docs/v6/CONTRACTS_V6.md §3): behaviours, rule events, rule actions, keys, archetypes and world
 * presets, from shared/spec/studio_catalog.json. The runtime implements every entry; the inspector renders params.
 */
import raw from '../../../../shared/spec/studio_catalog.json';

export type ParamType = 'number' | 'int' | 'bool' | 'string' | 'choice' | 'key' | 'target' | 'object' | 'template' | 'tag' | 'counter' | 'vec';

export interface ParamSpec {
  name: string;
  type: ParamType;
  default?: unknown;
  min?: number;
  max?: number;
  options?: string[];
  label?: string;
}

export interface CatalogEntry {
  type: string;
  label: string;
  group?: string;
  help?: string;
  params: ParamSpec[];
}

export interface Archetype {
  kind: string;
  label: string;
  physics: Record<string, unknown>;
  behaviors: { type: string; params?: Record<string, unknown> }[];
  counters?: Record<string, number>;
  tags?: string[];
  player?: 0 | 1 | 2;
  template?: boolean;
  camera?: boolean;
  wheels?: boolean;
}

export interface WorldPreset {
  kind: string;
  gravity: [number, number];
  camera: { mode: 'fixed' | 'follow' | 'auto_scroll'; axis?: 'x' | 'y' | 'xy'; speed?: number };
  edges: 'none' | 'walls' | 'wrap' | 'floor';
  width: number;
  height: number;
  players?: 1 | 2;
}

export interface Catalog {
  version: number;
  keys: { names: string[]; schemes: Record<'single' | 'player1' | 'player2', Record<string, string[]>> };
  behaviors: CatalogEntry[];
  events: CatalogEntry[];
  actions: CatalogEntry[];
  archetypes: Archetype[];
  worlds: WorldPreset[];
}

export const CATALOG = raw as unknown as Catalog;

const by = (list: CatalogEntry[]): Map<string, CatalogEntry> => new Map(list.map((e) => [e.type, e]));
export const BEHAVIORS = by(CATALOG.behaviors);
export const EVENTS = by(CATALOG.events);
export const ACTIONS = by(CATALOG.actions);

/** A params object with every catalog default filled in under the given values. */
export function withDefaults(entry: CatalogEntry | undefined, params: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of entry?.params ?? []) if (p.default !== undefined) out[p.name] = p.default;
  return { ...out, ...params };
}
