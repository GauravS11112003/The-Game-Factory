/**
 * Canonical JSON (PLAN_V2 §2.5): sorted keys, no whitespace, numbers rounded half-up to 4 decimals and
 * printed without trailing zeros (2.0 → "2"), object members whose value is null or undefined omitted.
 * Must stay byte-identical to vision/app/spec/level.py canonical_json().
 */

export function canonicalNumber(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`canonical JSON cannot encode ${x}`);
  // floor(v + 0.5) rather than Math.round so Python (math.floor) gives the identical integer.
  let n = Math.floor(x * 10000 + 0.5);
  if (n === 0) return '0';
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  const whole = Math.floor(n / 10000);
  const frac = n - whole * 10000;
  if (frac === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${String(frac).padStart(4, '0').replace(/0+$/, '')}`;
}

export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return canonicalNumber(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => canonicalJson(x)).join(',') + ']';
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== null && obj[k] !== undefined)
      .sort(); // UTF-16 code-unit order; keys are ASCII in every contract
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  throw new Error(`canonical JSON cannot encode ${typeof v}`);
}
