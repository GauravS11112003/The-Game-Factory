/**
 * Texture plumbing for the engine (PLAN_V2 §6.6, §7.4): ArtDoc layers rasterized into 1024 × 432 logical-px chunk
 * textures at render scale r (LINEAR filtering), only chunks within the camera ± 1 resident, held in an LRU of 4;
 * sprite baking for entities and the player.
 */
import Phaser from 'phaser';
import type { ArtDoc, ArtPath } from '../core/art/types.ts';
import type { RectCells } from '../core/types.gen.ts';
import { PERF } from '../core/params.ts';
import { bakePaths, rasterizeChunk } from '../render/canvas_ink.ts';

export const CELL = 16;
export const VIEW_W_PX = 768;
export const VIEW_H_PX = 432;

export class TexBank {
  private scene: Phaser.Scene;
  private n = 0;
  private keys = new Set<string>();
  private readonly prefix: string;
  constructor(scene: Phaser.Scene, prefix: string) {
    this.scene = scene;
    this.prefix = prefix;
  }
  add(name: string, canvas: HTMLCanvasElement): string {
    const key = `${this.prefix}${name}#${this.n++}`;
    this.scene.textures.addCanvas(key, canvas);
    this.keys.add(key);
    return key;
  }
  /** A writable canvas texture (re-drawn in place, e.g. a waving flag). */
  canvas(name: string, w: number, h: number): Phaser.Textures.CanvasTexture | null {
    const key = `${this.prefix}${name}#${this.n++}`;
    const t = this.scene.textures.createCanvas(key, Math.max(2, Math.ceil(w)), Math.max(2, Math.ceil(h)));
    if (t) this.keys.add(key);
    return t;
  }
  remove(key: string): void {
    if (!this.keys.has(key)) return;
    this.keys.delete(key);
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
  }
  clear(): void {
    for (const k of [...this.keys]) this.remove(k);
  }
}

/** A baked sprite: texture key plus the normalized origin of a local point (anchor or pivot). */
export interface Baked {
  key: string;
  ox: number;
  oy: number;
  px: number; // canvas px per logical px
  w: number; // logical px
  h: number;
}

export function boxOf(paths: readonly ArtPath[]): RectCells {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of paths) {
    const pad = (p.w && p.w.length ? Math.max(...p.w) : 3) / 2 / CELL;
    for (let i = 0; i + 1 < p.pts.length; i += 2) {
      x0 = Math.min(x0, p.pts[i] - pad);
      y0 = Math.min(y0, p.pts[i + 1] - pad);
      x1 = Math.max(x1, p.pts[i] + pad);
      y1 = Math.max(y1, p.pts[i + 1] + pad);
    }
  }
  if (x0 === Infinity) return [-0.25, -0.25, 0.25, 0.25];
  return [x0, y0, x1, y1];
}

/** Bake local paths into a texture; (ox, oy) is where the local point `at` (cells) sits, normalized. */
export function bake(bank: TexBank, doc: ArtDoc, name: string, paths: readonly ArtPath[], px: number, at: [number, number] = [0, 0], box?: RectCells): Baked {
  const b = box ?? boxOf(paths);
  const pad = 2;
  const { canvas } = bakePaths(doc, paths, b, px, pad);
  const w = (b[2] - b[0]) * CELL + pad * 2;
  const h = (b[3] - b[1]) * CELL + pad * 2;
  return {
    key: bank.add(name, canvas), px, w, h,
    ox: ((at[0] - b[0]) * CELL + pad) / w,
    oy: ((at[1] - b[1]) * CELL + pad) / h,
  };
}

export function imageOf(scene: Phaser.Scene, b: Baked, x = 0, y = 0): Phaser.GameObjects.Image {
  return scene.add.image(x, y, b.key).setOrigin(b.ox, b.oy).setScale(1 / b.px);
}

interface Chunk {
  i: number;
  key: string;
  img: Phaser.GameObjects.Image;
  used: number;
}

/** One ArtDoc layer group rendered as chunk textures with an LRU (camera ± 1 chunk resident). */
export class ChunkLayer {
  private scene: Phaser.Scene;
  private parent: Phaser.GameObjects.Layer;
  private bank: TexBank;
  private doc: ArtDoc;
  private ids: string[];
  private scroll: number;
  private r: number;
  private lru: number;
  private depth: number;
  private chunks = new Map<number, Chunk>();
  private tick = 0;
  private exclude: ReadonlySet<string> | undefined;
  private widthPx: number;
  private readonly cw = PERF.chunk_px[0];
  private readonly ch = PERF.chunk_px[1];
  alpha = 1;

  constructor(scene: Phaser.Scene, parent: Phaser.GameObjects.Layer, bank: TexBank, o: { doc: ArtDoc; ids: string[]; scroll: number; r: number; lru?: number; depth: number; widthPx: number }) {
    this.scene = scene;
    this.parent = parent;
    this.bank = bank;
    this.doc = o.doc;
    this.ids = o.ids;
    this.scroll = o.scroll;
    this.r = o.r;
    this.lru = o.lru ?? PERF.chunk_lru;
    this.depth = o.depth;
    this.widthPx = o.widthPx;
  }

  private drop(c: Chunk): void {
    c.img.destroy();
    this.bank.remove(c.key);
    this.chunks.delete(c.i);
  }

  private make(i: number): void {
    const canvas = rasterizeChunk(this.doc, this.ids, i * this.cw, this.cw, this.ch, this.r, this.exclude);
    const key = this.bank.add(`chunk${this.ids[0]}_${i}`, canvas);
    const img = this.scene.add.image(i * this.cw, 0, key).setOrigin(0, 0).setScale(1 / this.r).setScrollFactor(this.scroll, 1).setDepth(this.depth).setAlpha(this.alpha);
    this.parent.add(img);
    this.chunks.set(i, { i, key, img, used: this.tick });
  }

  /** Ensure the visible chunks (and at most one neighbour per frame) exist; evict beyond the LRU. */
  update(scrollPx: number): void {
    this.tick++;
    const x0 = scrollPx * this.scroll;
    const x1 = x0 + VIEW_W_PX;
    const last = Math.max(0, Math.ceil(this.widthPx / this.cw) - 1);
    const vis0 = Math.max(0, Math.floor(x0 / this.cw));
    const vis1 = Math.min(last, Math.floor(x1 / this.cw));
    for (let i = vis0; i <= vis1; i++) {
      const c = this.chunks.get(i);
      if (c) c.used = this.tick;
      else this.make(i);
    }
    // prefetch one neighbour per frame (camera ± 1)
    for (const i of [vis1 + 1, vis0 - 1]) {
      if (i < 0 || i > last) continue;
      const c = this.chunks.get(i);
      if (c) {
        c.used = this.tick;
        continue;
      }
      this.make(i);
      break;
    }
    if (this.chunks.size > this.lru) {
      const sorted = [...this.chunks.values()].sort((a, b) => a.used - b.used);
      for (const c of sorted) {
        if (this.chunks.size <= this.lru) break;
        if (c.i >= vis0 && c.i <= vis1) continue;
        this.drop(c);
      }
    }
  }

  setDoc(doc: ArtDoc, exclude?: ReadonlySet<string>): void {
    this.doc = doc;
    this.exclude = exclude && exclude.size ? exclude : undefined;
    this.invalidate();
  }

  setScale(r: number): void {
    if (r === this.r) return;
    this.r = r;
    this.invalidate();
  }

  setWidth(px: number): void {
    this.widthPx = px;
  }

  setAlpha(a: number): void {
    this.alpha = a;
    for (const c of this.chunks.values()) c.img.setAlpha(a);
  }

  invalidate(): void {
    for (const c of [...this.chunks.values()]) this.drop(c);
  }

  destroy(): void {
    this.invalidate();
  }
}
