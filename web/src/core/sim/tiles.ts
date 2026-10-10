/**
 * The tile layer of the sim (§2.4): decode RLE rows into a typed grid and answer the geometric questions the
 * collision code needs (solid cells, floor surfaces, slope heights, ceilings, lava). All coordinates here are world
 * px (16 per cell), y down. Outside the world: columns < 0 or ≥ w are solid walls (any row); rows < 0 or ≥ h are empty.
 *
 * Floor height inside a slope cell, px below the cell top at the left → right edge:
 *   '/' 16→0, '\' 0→16, 'a' 16→8, 'b' 8→0, 'c' 0→8, 'd' 8→16. Below the floor line a slope cell is solid.
 */

export const CELL = 16;

export const T_EMPTY = 0;
export const T_SOLID = 1;
export const T_ONEWAY = 2;
export const T_SL_R = 3; // '/'
export const T_SL_L = 4; // '\'
export const T_A = 5;
export const T_B = 6;
export const T_C = 7;
export const T_D = 8;
export const T_LAVA = 9;
export const T_X = 10;

const CHAR_CODE: Record<string, number> = {
  '.': T_EMPTY, '#': T_SOLID, '=': T_ONEWAY, '/': T_SL_R, '\\': T_SL_L, a: T_A, b: T_B, c: T_C, d: T_D, '~': T_LAVA, X: T_X,
};

export function isSlope(code: number): boolean {
  return code >= T_SL_R && code <= T_D;
}

/** Floor y (px from the cell top) of a slope code at local x ∈ [0, 16]. */
export function slopeLocal(code: number, xl: number): number {
  const u = xl < 0 ? 0 : xl > CELL ? CELL : xl;
  switch (code) {
    case T_SL_R: return CELL - u;
    case T_SL_L: return u;
    case T_A: return CELL - u / 2;
    case T_B: return CELL / 2 - u / 2;
    case T_C: return u / 2;
    case T_D: return CELL / 2 + u / 2;
    default: return 0;
  }
}

/** Uphill direction of a slope (+1: rises to the right, −1: rises to the left). */
export function slopeRise(code: number): number {
  return code === T_SL_R || code === T_A || code === T_B ? 1 : code === T_SL_L || code === T_C || code === T_D ? -1 : 0;
}

/** px of rise per px of x for a slope code (1 or 0.5). */
export function slopeGrade(code: number): number {
  return code === T_SL_R || code === T_SL_L ? 1 : isSlope(code) ? 0.5 : 0;
}

function decodeRowLoose(row: string, w: number): Uint8Array {
  const out = new Uint8Array(w);
  let i = 0;
  let n = 0;
  let hasN = false;
  for (let k = 0; k < row.length && i < w; k++) {
    const ch = row[k];
    if (ch >= '0' && ch <= '9') {
      n = n * 10 + (ch.charCodeAt(0) - 48);
      hasN = true;
      continue;
    }
    const code = CHAR_CODE[ch] ?? T_EMPTY;
    const count = hasN ? n : 1;
    for (let j = 0; j < count && i < w; j++) out[i++] = code;
    n = 0;
    hasN = false;
  }
  return out;
}

/** A floor piece: the walkable surface of one cell (exposed solid top, one-way top or slope line). */
export interface FloorPiece {
  cx: number;
  cy: number;
  code: number;
  yl: number; // px at the left edge
  yr: number; // px at the right edge
  comp: number; // surface component id
}

export class TileGrid {
  readonly w: number;
  readonly h: number;
  readonly c: Uint8Array;
  /** Floor pieces per column, top to bottom. */
  readonly pieces: FloorPiece[][];
  /** Surface components: [minCol, maxCol, pieceCount, oneWayCount]. */
  readonly comps: { id: number; c0: number; c1: number; n: number; oneway: number; flat: number }[];

  constructor(rows: string[], w: number, h: number) {
    this.w = w;
    this.h = h;
    this.c = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const r = decodeRowLoose(rows[y] ?? '', w);
      this.c.set(r, y * w);
    }
    this.pieces = [];
    this.comps = [];
    this.buildPieces();
  }

  at(cx: number, cy: number): number {
    if (cx < 0 || cx >= this.w) return T_SOLID;
    if (cy < 0 || cy >= this.h) return T_EMPTY;
    return this.c[cy * this.w + cx];
  }

  /** Solid for horizontal blocking: '#' only (slopes are walked, one-way is passed). */
  blocksSide(cx: number, cy: number): boolean {
    return this.at(cx, cy) === T_SOLID;
  }

  /** Solid for ceilings: '#' and slope cells (their underside is solid). */
  blocksHead(cx: number, cy: number): boolean {
    const t = this.at(cx, cy);
    return t === T_SOLID || isSlope(t);
  }

  /** Any part of the cell is solid (for crush tests and line of sight). */
  solidish(cx: number, cy: number): boolean {
    const t = this.at(cx, cy);
    return t === T_SOLID || isSlope(t);
  }

  slopeY(code: number, cx: number, cy: number, x: number): number {
    return cy * CELL + slopeLocal(code, x - cx * CELL);
  }

  /**
   * The surface y of a floor-bearing cell at x, or NaN when the cell bears no floor (covered solids included).
   * One-way tops count only when they are at or below `oneWayMin` (feet were at or above them; +Infinity disables).
   */
  surfaceOf(cx: number, cy: number, x: number, oneWayMin: number): number {
    const t = this.at(cx, cy);
    if (t === T_SOLID) {
      if (cx < 0 || cx >= this.w) return NaN;
      const above = this.at(cx, cy - 1);
      if (above === T_SOLID || isSlope(above)) return NaN;
      return cy * CELL;
    }
    if (t === T_ONEWAY) return cy * CELL >= oneWayMin - 1e-6 ? cy * CELL : NaN;
    if (isSlope(t)) return this.slopeY(t, cx, cy, x);
    return NaN;
  }

  /**
   * Topmost floor surface in column cx with y ∈ [yMin, yMax]. `x` is where slopes are evaluated.
   * `oneWayMin`: see surfaceOf. `flatOnly` skips slopes. Returns +Infinity when none. `outCode[0]` receives the code.
   */
  floorInColumn(cx: number, x: number, yMin: number, yMax: number, oneWayMin: number, flatOnly: boolean, outCode?: number[]): number {
    if (cx < 0 || cx >= this.w) return Infinity;
    let r0 = Math.floor(yMin / CELL) - 1;
    let r1 = Math.floor(yMax / CELL);
    if (r0 < 0) r0 = 0;
    if (r1 > this.h - 1) r1 = this.h - 1;
    for (let r = r0; r <= r1; r++) {
      const t = this.c[r * this.w + cx];
      if (t === T_EMPTY || t === T_LAVA || t === T_X) continue;
      if (flatOnly && isSlope(t)) continue;
      const s = this.surfaceOf(cx, r, x, oneWayMin);
      if (s !== s) continue; // NaN
      if (s >= yMin - 1e-9 && s <= yMax + 1e-9) {
        if (outCode) outCode[0] = t;
        return s;
      }
    }
    return Infinity;
  }

  /** True when the cell is lava; lavaTop returns the hitbox top (4 px below the drawn top for the top lava cell). */
  lavaTop(cx: number, cy: number): number {
    if (this.at(cx, cy) !== T_LAVA) return NaN;
    return this.at(cx, cy - 1) === T_LAVA ? cy * CELL : cy * CELL + 4;
  }

  /** Floor piece under (x, feet) within 1 px, searching the column of x. */
  pieceAt(x: number, feet: number): FloorPiece | null {
    const cx = Math.floor(x / CELL);
    if (cx < 0 || cx >= this.w) return null;
    for (const p of this.pieces[cx]) {
      const y = isSlope(p.code) ? this.slopeY(p.code, p.cx, p.cy, x) : p.cy * CELL;
      if (Math.abs(y - feet) <= 1.01) return p;
    }
    return null;
  }

  private buildPieces(): void {
    const w = this.w;
    const h = this.h;
    for (let cx = 0; cx < w; cx++) {
      const col: FloorPiece[] = [];
      for (let cy = 0; cy < h; cy++) {
        const t = this.c[cy * w + cx];
        if (t === T_EMPTY || t === T_LAVA || t === T_X) continue;
        let yl: number;
        let yr: number;
        if (t === T_SOLID) {
          const above = this.at(cx, cy - 1);
          if (above === T_SOLID || isSlope(above)) continue;
          yl = yr = cy * CELL;
        } else if (t === T_ONEWAY) {
          yl = yr = cy * CELL;
        } else {
          yl = cy * CELL + slopeLocal(t, 0);
          yr = cy * CELL + slopeLocal(t, CELL);
        }
        col.push({ cx, cy, code: t, yl, yr, comp: -1 });
      }
      this.pieces.push(col);
    }
    // Union-find over horizontally connected pieces (|Δy| ≤ 4 px at the shared edge, no wall in between).
    const all: FloorPiece[] = [];
    for (const col of this.pieces) for (const p of col) all.push(p);
    const parent = new Int32Array(all.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const idx = new Map<FloorPiece, number>();
    all.forEach((p, i) => idx.set(p, i));
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (let cx = 0; cx + 1 < w; cx++) {
      for (const a of this.pieces[cx]) {
        for (const b of this.pieces[cx + 1]) {
          if (Math.abs(a.yr - b.yl) > 4.01) continue;
          if (a.code === T_ONEWAY && b.code !== T_ONEWAY && b.code !== T_SOLID) continue;
          // The body (28 px) must fit above the joint: no side-blocking cell right above either piece.
          const yj = Math.min(a.yr, b.yl);
          const rHead = Math.floor((yj - 1) / CELL);
          if (this.blocksSide(cx + 1, rHead) && !isSlope(b.code)) continue;
          if (this.blocksSide(cx, rHead) && !isSlope(a.code)) continue;
          const ra = find(idx.get(a) as number);
          const rb = find(idx.get(b) as number);
          if (ra !== rb) parent[ra] = rb;
        }
      }
    }
    const compOf = new Map<number, number>();
    for (let i = 0; i < all.length; i++) {
      const root = find(i);
      let c = compOf.get(root);
      if (c === undefined) {
        c = this.comps.length;
        compOf.set(root, c);
        this.comps.push({ id: c, c0: all[i].cx, c1: all[i].cx, n: 0, oneway: 0, flat: 0 });
      }
      const comp = this.comps[c];
      all[i].comp = c;
      comp.c0 = Math.min(comp.c0, all[i].cx);
      comp.c1 = Math.max(comp.c1, all[i].cx);
      comp.n++;
      if (all[i].code === T_ONEWAY) comp.oneway++;
      if (!isSlope(all[i].code)) comp.flat++;
    }
  }
}
