/**
 * A small JSON Schema (2020-12) validator for the subset Pydantic emits in shared/spec/*.schema.json:
 * $ref (local), type, enum, const, properties, required, additionalProperties, patternProperties, items,
 * prefixItems, min/maxItems, min/maxLength, pattern, minimum/maximum (+exclusive), anyOf, oneOf, allOf.
 * Unknown keywords (title, description, default, discriminator, format, $comment) are ignored.
 */

type Schema = Record<string, unknown> | boolean;

export interface SchemaError {
  path: string;
  message: string;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => deepEqual(ao[k], bo[k]));
}

const patternCache = new Map<string, RegExp>();
function re(p: string): RegExp {
  let r = patternCache.get(p);
  if (!r) {
    r = new RegExp(p, 'u');
    patternCache.set(p, r);
  }
  return r;
}

export class SchemaValidator {
  private readonly root: Record<string, unknown>;

  constructor(root: Record<string, unknown>) {
    this.root = root;
  }

  validate(value: unknown, maxErrors = 20): SchemaError[] {
    const errors: SchemaError[] = [];
    this.check(this.root, value, '', errors, maxErrors);
    return errors;
  }

  private resolve(ref: string): Schema {
    if (!ref.startsWith('#/')) throw new Error(`only local $ref is supported: ${ref}`);
    let node: unknown = this.root;
    for (const part of ref.slice(2).split('/')) {
      node = (node as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (node === undefined) throw new Error(`unresolved $ref ${ref}`);
    }
    return node as Schema;
  }

  private matches(schema: Schema, v: unknown): boolean {
    const errs: SchemaError[] = [];
    this.check(schema, v, '', errs, 1);
    return errs.length === 0;
  }

  private check(schema: Schema, v: unknown, path: string, errors: SchemaError[], max: number): void {
    if (errors.length >= max) return;
    if (schema === true) return;
    if (schema === false) {
      errors.push({ path, message: 'not allowed' });
      return;
    }
    const s = schema;
    const fail = (message: string): void => {
      errors.push({ path: path || '/', message });
    };

    if (typeof s.$ref === 'string') {
      this.check(this.resolve(s.$ref), v, path, errors, max);
      if (errors.length >= max) return;
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => typeMatches(v, t))) return fail(`expected ${types.join('|')}, got ${typeOf(v)}`);
    }
    if (s.const !== undefined && !deepEqual(v, s.const)) return fail(`expected const ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v))) {
      return fail(`expected one of ${JSON.stringify(s.enum)}, got ${JSON.stringify(v)}`);
    }
    if (Array.isArray(s.allOf)) for (const sub of s.allOf as Schema[]) this.check(sub, v, path, errors, max);
    if (Array.isArray(s.anyOf) && !(s.anyOf as Schema[]).some((sub) => this.matches(sub, v))) {
      return fail('matches no anyOf branch');
    }
    if (Array.isArray(s.oneOf)) {
      const n = (s.oneOf as Schema[]).filter((sub) => this.matches(sub, v)).length;
      if (n !== 1) {
        // Report the branch selected by a const discriminator, if any, for a readable message.
        const branch = this.discriminated(s, v);
        if (n === 0 && branch) return this.check(branch, v, path, errors, max);
        return fail(n === 0 ? 'matches no oneOf branch' : `matches ${n} oneOf branches`);
      }
    }

    const t = typeOf(v);
    if (t === 'string') {
      const str = v as string;
      if (typeof s.minLength === 'number' && [...str].length < s.minLength) fail(`shorter than ${s.minLength}`);
      if (typeof s.maxLength === 'number' && [...str].length > s.maxLength) fail(`longer than ${s.maxLength}`);
      if (typeof s.pattern === 'string' && !re(s.pattern).test(str)) fail(`does not match ${s.pattern}`);
    } else if (t === 'number' || t === 'integer') {
      const n = v as number;
      if (typeof s.minimum === 'number' && n < s.minimum) fail(`below minimum ${s.minimum}`);
      if (typeof s.maximum === 'number' && n > s.maximum) fail(`above maximum ${s.maximum}`);
      if (typeof s.exclusiveMinimum === 'number' && n <= s.exclusiveMinimum) fail(`not above ${s.exclusiveMinimum}`);
      if (typeof s.exclusiveMaximum === 'number' && n >= s.exclusiveMaximum) fail(`not below ${s.exclusiveMaximum}`);
    } else if (t === 'array') {
      const arr = v as unknown[];
      if (typeof s.minItems === 'number' && arr.length < s.minItems) fail(`fewer than ${s.minItems} items`);
      if (typeof s.maxItems === 'number' && arr.length > s.maxItems) fail(`more than ${s.maxItems} items`);
      const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
      prefix.forEach((sub, i) => {
        if (i < arr.length) this.check(sub, arr[i], `${path}/${i}`, errors, max);
      });
      if (s.items !== undefined && !Array.isArray(s.items)) {
        for (let i = prefix.length; i < arr.length; i++) this.check(s.items as Schema, arr[i], `${path}/${i}`, errors, max);
      }
    } else if (t === 'object') {
      const obj = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      if (Array.isArray(s.required)) {
        for (const k of s.required as string[]) if (!(k in obj)) fail(`missing required property "${k}"`);
      }
      const patterns = (s.patternProperties ?? {}) as Record<string, Schema>;
      for (const [k, val] of Object.entries(obj)) {
        if (k in props) {
          this.check(props[k], val, `${path}/${k}`, errors, max);
          continue;
        }
        const pats = Object.keys(patterns).filter((p) => re(p).test(k));
        if (pats.length) {
          for (const p of pats) this.check(patterns[p], val, `${path}/${k}`, errors, max);
          continue;
        }
        if (s.additionalProperties === false) fail(`unknown property "${k}"`);
        else if (typeof s.additionalProperties === 'object') {
          this.check(s.additionalProperties as Schema, val, `${path}/${k}`, errors, max);
        }
      }
    }
  }

  private discriminated(s: Record<string, unknown>, v: unknown): Schema | null {
    const d = s.discriminator as { propertyName?: string; mapping?: Record<string, string> } | undefined;
    if (!d?.propertyName || !d.mapping || typeof v !== 'object' || v === null) return null;
    const tag = (v as Record<string, unknown>)[d.propertyName];
    const ref = typeof tag === 'string' ? d.mapping[tag] : undefined;
    return ref ? this.resolve(ref) : null;
  }
}
