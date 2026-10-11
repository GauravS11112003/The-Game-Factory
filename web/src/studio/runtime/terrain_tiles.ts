/**
 * Solid terrain in the runtime (docs/v7/CONTRACTS_V7.md §4.1): the same painter as the Studio canvas (art.ts
 * paintTerrain), streamed into world-space canvas tiles around the camera. Tiles are rendered at the camera's zoom
 * (crisp), a couple per frame (the visible ones first), re-rendered when the zoom changes a lot, and freed when far
 * away, so a 12 000 px hill costs only what is on screen.
 */
import Phaser from 'phaser';
import { paintTerrain, type TerrainModel } from '../theme/art.ts';
import { boxesOverlap, type Box, type ResolvedSkin } from '../theme/terrain.ts';

const TILE_PX = 768;
const MAX_TILES = 28;
let uidSeq = 0;
let keySeq = 0;

interface Tile {
  key: string;
  img: Phaser.GameObjects.Image;
  scale: number;
  tx: number;
  ty: number;
}

/** The tile scale for a camera zoom: zoom rounded up to quarter steps (0.25..3). */
export function tileScaleFor(zoom: number): number {
  return Math.max(0.25, Math.min(3, Math.ceil(Math.max(0.01, zoom) * 4) / 4));
}

/** Tile indices (of size `size` world px) covering a window, nearest to its centre first. */
export function tilesFor(view: Box, size: number): [number, number][] {
  const out: [number, number][] = [];
  const x0 = Math.floor(view.minX / size);
  const x1 = Math.floor(view.maxX / size);
  const y0 = Math.floor(view.minY / size);
  const y1 = Math.floor(view.maxY / size);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return out;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  const cx = (view.minX + view.maxX) / 2 / size - 0.5;
  const cy = (view.minY + view.maxY) / 2 / size - 0.5;
  return out.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
}

export class TerrainTiles {
  readonly container: Phaser.GameObjects.Container;
  private tiles = new Map<string, Tile>();
  private uid = ++uidSeq;
  private scale = 1;
  private dead = false;

  constructor(private scene: Phaser.Scene, public model: TerrainModel, public skin: ResolvedSkin, layer: Phaser.GameObjects.Layer, depth: number) {
    this.container = scene.add.container(0, 0);
    this.container.setDepth(depth);
    layer.add(this.container);
  }

  /** Bring the tiles up to date for a camera window (world px, already offset by the container) and zoom. */
  update(view: Box, zoom: number, budget: { n: number }): void {
    if (this.dead || !this.model.pieces.length) return;
    const scale = tileScaleFor(zoom);
    // a big zoom change re-renders progressively; small ones keep the current tiles
    if (Math.abs(scale - this.scale) / this.scale > 0.3 || (scale > this.scale && scale - this.scale >= 0.5)) this.scale = scale;
    const size = TILE_PX / this.scale;
    const box = this.model.box;
    const want = new Set<string>();
    const mx = (view.maxX - view.minX) * 0.35;
    const my = (view.maxY - view.minY) * 0.35;
    const visible = tilesFor(view, size);
    const near = tilesFor({ minX: view.minX - mx, minY: view.minY - my, maxX: view.maxX + mx, maxY: view.maxY + my }, size);
    let visibleDone = true;
    [visible, near].forEach((list, li) => {
      for (const [tx, ty] of list) {
        const tb: Box = { minX: tx * size, minY: ty * size, maxX: (tx + 1) * size, maxY: (ty + 1) * size };
        if (!boxesOverlap(tb, box)) continue;
        const id = `${this.scale}|${tx},${ty}`;
        want.add(id);
        if (this.tiles.has(id)) continue;
        if (budget.n <= 0) {
          if (li === 0) visibleDone = false;
          continue;
        }
        budget.n--;
        this.render(id, tx, ty, size);
      }
    });
    // tiles of an old zoom stay until the new ones cover the screen; far tiles go when there are too many
    for (const [id, t] of [...this.tiles]) {
      if (want.has(id)) continue;
      if (t.scale !== this.scale ? visibleDone : this.tiles.size > MAX_TILES) this.drop(id, t);
    }
  }

  private render(id: string, tx: number, ty: number, size: number): void {
    const s = this.scale;
    const px = TILE_PX + 2; // one pixel of overlap on each side hides seams
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const x0 = tx * size - 1 / s;
    const y0 = ty * size - 1 / s;
    ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
    try {
      paintTerrain(ctx, this.model, this.skin, { minX: x0, minY: y0, maxX: x0 + px / s, maxY: y0 + px / s }, s);
    } catch {
      /* keep the tile empty */
    }
    const key = `ter${this.uid}_${++keySeq}`;
    this.scene.textures.addCanvas(key, c);
    const img = this.scene.add.image(x0, y0, key).setOrigin(0, 0).setScale(1 / s);
    this.container.add(img); // added last = drawn above leftovers of an old zoom
    this.tiles.set(id, { key, img, scale: s, tx, ty });
  }

  private drop(id: string, t: Tile): void {
    t.img.destroy();
    if (this.scene.textures.exists(t.key)) this.scene.textures.remove(t.key);
    if (this.tiles.get(id) === t) this.tiles.delete(id);
  }

  /** Re-render everything (new skin / look). */
  reset(model: TerrainModel, skin: ResolvedSkin): void {
    this.model = model;
    this.skin = skin;
    for (const [id, t] of [...this.tiles]) this.drop(id, t);
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    for (const [id, t] of [...this.tiles]) this.drop(id, t);
    this.container.destroy();
  }
}
