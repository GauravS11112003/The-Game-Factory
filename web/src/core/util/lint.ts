/**
 * Core source lint (PLAN_V2 §11.3b, §5.2). Pure: callers (cli.ts selftest, vitest) read the files.
 * The `import type` rule is enforced by tsc (verbatimModuleSyntax) and by Node itself at import time;
 * this lint covers what tsc does not: suffixes, dependencies, DOM/Phaser, JSON, and determinism bans.
 */

export interface LintIssue {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/** Files that run only in Node (they may import node:* modules). Paths are relative to web/src/core. */
export const NODE_ONLY = [/^cli\.ts$/, /^worker\/main\.ts$/, /^worker\/pool\.ts$/, /^worker\/stub\.ts$/, /^__tests__\//];
/** Directories whose step code must be deterministic (§5.2). */
export const DETERMINISTIC_DIRS = ['sim/', 'bot/', 'replay/'];

const FROM_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /^\s*import\s+['"]([^'"]+)['"]/;
const DYN_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const DOM_RE = /\b(document|window|HTMLElement|HTMLCanvasElement|requestAnimationFrame|localStorage|navigator)\s*[.([]/;
const BANNED_DETERMINISM: [RegExp, string][] = [
  [/\bMath\.(sin|cos|tan|atan2|exp|pow|random)\b/, 'Math trig/exp/pow/random'],
  [/\bDate\b/, 'Date'],
  [/\bperformance\b/, 'performance'],
];

function stripComments(src: string): string[] {
  // Line-preserving comment removal; good enough for lint (strings containing comment markers are rare here).
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock.split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'));
}

export function lintSource(rel: string, src: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const nodeOnly = NODE_ONLY.some((r) => r.test(rel));
  const isTest = rel.startsWith('__tests__/');
  const deterministic = DETERMINISTIC_DIRS.some((d) => rel.startsWith(d));
  const lines = stripComments(src);
  lines.forEach((line, i) => {
    const add = (rule: string): void => {
      issues.push({ file: rel, line: i + 1, rule, text: line.trim() });
    };
    const specs: string[] = [];
    for (const f of line.matchAll(FROM_RE)) specs.push(f[1]);
    const side = SIDE_EFFECT_RE.exec(line);
    if (side) specs.push(side[1]);
    for (const d of line.matchAll(DYN_IMPORT_RE)) specs.push(d[1]);
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        if (spec.endsWith('.json')) add('no-json-import');
        else if (!spec.endsWith('.ts')) add('ts-suffix');
      } else if (spec.startsWith('node:')) {
        if (!nodeOnly) add('node-only');
      } else if (spec === 'phaser') {
        add('no-phaser');
      } else if (!(isTest && (spec === 'vitest' || spec === 'typescript'))) {
        add('no-npm-deps');
      }
    }
    if (!isTest && DOM_RE.test(line)) add('no-dom');
    if (deterministic) for (const [r, what] of BANNED_DETERMINISM) if (r.test(line)) add(`determinism:${what}`);
  });
  return issues;
}
