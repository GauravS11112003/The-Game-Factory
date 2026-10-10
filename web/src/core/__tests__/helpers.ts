/// <reference types="node" />
/** Paths and fixture loaders shared by the core tests. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = join(CORE_DIR, '..', '..');
export const REPO = join(WEB_DIR, '..');
export const SPEC_DIR = join(REPO, 'shared', 'spec');
export const LEVELS_DIR = join(SPEC_DIR, 'conformance', 'levels');

export function readJson<T = unknown>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

export function listJson(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

export function coreSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) out.push(relative(CORE_DIR, p).split('\\').join('/'));
    }
  };
  walk(CORE_DIR);
  return out.sort();
}
