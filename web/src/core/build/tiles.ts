/** Tile rows: one char per cell, run-length encoded as `<count><char>`, count omitted when 1 (§2.4). */
export const TILE_LEGEND = '.#=/\\abcd~X';
const ROW_RE = /^(?:[0-9]*[.#=/\\abcd~X])+$/;
const RUN_RE = /([0-9]*)([.#=/\\abcd~X])/g;

export function decodeRow(row: string): string {
  if (!ROW_RE.test(row)) throw new Error(`bad tile row ${JSON.stringify(row)}`);
  let out = '';
  for (const m of row.matchAll(RUN_RE)) out += m[2].repeat(m[1] ? Number(m[1]) : 1);
  return out;
}

export function encodeRow(cells: string): string {
  let out = '';
  let i = 0;
  while (i < cells.length) {
    let j = i;
    while (j < cells.length && cells[j] === cells[i]) j++;
    const n = j - i;
    out += (n > 1 ? String(n) : '') + cells[i];
    i = j;
  }
  return out;
}
