// Runs the real v1 solver (web/src/solver/solve.ts) over a JSON array of minimal levels.
// Usage (from web/): npx vite-node ../docs/v2/diagnosis/model/solve_cli.ts -- in.json out.json
import { readFileSync, writeFileSync } from 'node:fs';
import { solve } from '../../../../web/src/solver/solve';

const args = process.argv.slice(2).filter((a) => a !== '--');
const [inPath, outPath] = args;
const levels = JSON.parse(readFileSync(inPath, 'utf8')) as any[];
const out = levels.map((lv) => {
  const t0 = performance.now();
  const r = solve(lv);
  return { name: lv.name, solvable: r.solvable, reason: r.reason ?? null, reachable: r.reachable, ms: +(performance.now() - t0).toFixed(1) };
});
writeFileSync(outPath, JSON.stringify(out));
