/**
 * Catalog params → plain values (docs/v6/CONTRACTS_V6.md §1): unknown params are ignored, missing or mistyped ones take
 * the catalog default, numbers are clamped to min/max, ints rounded, choices must be one of the options. Pure.
 */
import type { CatalogEntry, ParamSpec } from '../model/catalog.ts';

export type Params = Record<string, unknown>;

function fallback(p: ParamSpec): unknown {
  if (p.default !== undefined) return p.default;
  switch (p.type) {
    case 'number':
    case 'int':
      return p.min !== undefined && p.min > 0 ? p.min : 0;
    case 'bool':
      return false;
    case 'vec':
      return [0, 0];
    case 'choice':
      return p.options?.[0] ?? '';
    default:
      return '';
  }
}

function clamp(n: number, p: ParamSpec): number {
  let v = n;
  if (p.min !== undefined) v = Math.max(p.min, v);
  if (p.max !== undefined) v = Math.min(p.max, v);
  return v;
}

/** One param value checked against its spec. */
export function coerceParam(p: ParamSpec, v: unknown): unknown {
  switch (p.type) {
    case 'number':
    case 'int': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) {
        const d = fallback(p);
        return typeof d === 'number' ? d : 0;
      }
      return clamp(p.type === 'int' ? Math.round(n) : n, p);
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1) return true;
      if (v === 'false' || v === 0) return false;
      return fallback(p);
    case 'choice':
      return typeof v === 'string' && (p.options ?? []).includes(v) ? v : fallback(p);
    case 'vec': {
      if (Array.isArray(v) && v.length >= 2) {
        const x = Number(v[0]);
        const y = Number(v[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
      }
      const d = fallback(p);
      return Array.isArray(d) ? [Number(d[0]) || 0, Number(d[1]) || 0] : [0, 0];
    }
    case 'counter':
    case 'tag':
      return typeof v === 'string' ? v.trim().toLowerCase() : typeof v === 'number' ? String(v) : fallback(p);
    default:
      // string, key, target, object, template
      return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : fallback(p);
  }
}

/** All params of a catalog entry, resolved: every spec'd param present, nothing else. */
export function resolveParams(entry: CatalogEntry | undefined, raw: unknown): Params {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Params) : {};
  const out: Params = {};
  for (const p of entry?.params ?? []) out[p.name] = p.name in src ? coerceParam(p, src[p.name]) : coerceParam(p, undefined);
  return out;
}

/** Typed readers for resolved params. */
export const num = (p: Params, k: string, d = 0): number => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d);
export const str = (p: Params, k: string, d = ''): string => (typeof p[k] === 'string' ? (p[k] as string) : d);
export const bool = (p: Params, k: string, d = false): boolean => (typeof p[k] === 'boolean' ? (p[k] as boolean) : d);
export const vec = (p: Params, k: string): [number, number] => {
  const v = p[k];
  return Array.isArray(v) && v.length >= 2 ? [Number(v[0]) || 0, Number(v[1]) || 0] : [0, 0];
};
