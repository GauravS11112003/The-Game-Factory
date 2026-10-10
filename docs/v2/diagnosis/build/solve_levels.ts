/**
 * Run v1's own browser solver (web/src/solver/solve.ts) over level JSON files.
 * Usage (from web/): npx vite-node ../docs/v2/diagnosis/build/solve_levels.ts -- <level-or-response.json> ...
 * Prints one JSON line per file: {file, solvable, reason, reachable}.
 */
import { readFileSync } from 'node:fs';
import { solve } from '../../../../web/src/solver/solve';

const files = process.argv.slice(2).filter((a) => a !== '--');
for (const f of files) {
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  const level = doc.level ?? doc;
  const r = solve(level);
  console.log(JSON.stringify({ file: f, solvable: r.solvable, reason: r.reason ?? null, reachable: r.reachable.length, cells: r.reachable }));
}
