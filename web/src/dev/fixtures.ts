/**
 * Starter World fixtures for dev pages (no backend needed). Vite's
 * import.meta.glob pulls shared/fixtures/levels/*.json in at build time;
 * server.fs.allow in vite.config.ts lets the dev server read them.
 */
import type { Level } from '../types';

const modules = import.meta.glob<Level>('../../../shared/fixtures/levels/*.json', { eager: true, import: 'default' });

export interface Fixture {
  /** file name without extension, e.g. starter_1_first_steps */
  name: string;
  level: Level;
}

export const FIXTURES: Fixture[] = Object.entries(modules)
  .map(([path, level]) => ({ name: path.split('/').pop()?.replace(/\.json$/, '') ?? path, level }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Look a fixture up by file name or level id; undefined when there is none. */
export function getFixture(nameOrId: string): Level | undefined {
  return FIXTURES.find((f) => f.name === nameOrId || f.level.id === nameOrId)?.level;
}
