/**
 * "My original sketch" (PLAN_V2 §7.2, §7.4 depth 30): the photo of each paper sheet as an optional underlay at 15%
 * opacity with linear filtering, behind the re-inked level. Sheet n covers world x ∈ [48·(n−1), 48·n) (§6.4); the
 * rectified sheet image is stretched over its 48 × 27-cell drawing area. Off by default; GameHandle.setUnderlay
 * toggles it. Images load lazily and a sheet that fails to load is simply not drawn.
 */
import Phaser from 'phaser';
import type { LevelV2 } from '../../core/types.gen.ts';
import { ART } from '../../core/params.ts';
import { loadImage } from '../../render/pencilize.ts';
import { CELL } from '../gfx.ts';
import type { TexBank } from '../gfx.ts';

export interface UnderlaySheet {
  url: string;
  /** Sheet index from 1 (sheet n covers cells 48·(n−1) … 48·n). */
  index: number;
}

/** The sheets a level's source lists (the rectified sketch when there is one, else the photo). */
export function underlaySheets(level: LevelV2): UnderlaySheet[] {
  const out: UnderlaySheet[] = [];
  for (const s of level.source?.sheets ?? []) {
    const url = s.sketch_url ?? s.photo_url ?? null;
    if (url) out.push({ url, index: Math.max(1, s.index ?? out.length + 1) });
  }
  return out;
}

export class Underlay {
  private scene: Phaser.Scene;
  private layer: Phaser.GameObjects.Layer;
  private bank: TexBank;
  private imgs: Phaser.GameObjects.Image[] = [];
  private keys: string[] = [];
  private opacity: number;
  private visible = false;
  private loaded = false;
  private sheets: UnderlaySheet[];
  private destroyed = false;
  private loading: Promise<void> | null = null;

  constructor(scene: Phaser.Scene, layer: Phaser.GameObjects.Layer, bank: TexBank, sheets: UnderlaySheet[], opacity: number = ART.underlay_opacity) {
    this.scene = scene;
    this.layer = layer;
    this.bank = bank;
    this.sheets = sheets;
    this.opacity = opacity;
  }

  get available(): boolean {
    return this.sheets.length > 0;
  }

  private load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      for (const s of this.sheets) {
        const img = await loadImage(s.url);
        if (!img || this.destroyed) continue;
        const c = document.createElement('canvas');
        // keep textures modest: 1024 px across a 768 px screen is plenty at 15%
        const k = Math.min(1, 1024 / Math.max(1, img.width));
        c.width = Math.max(2, Math.round(img.width * k));
        c.height = Math.max(2, Math.round(img.height * k));
        const ctx = c.getContext('2d');
        if (!ctx) continue;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const key = this.bank.add(`underlay${s.index}`, c);
        this.keys.push(key);
        const x0 = (s.index - 1) * 48 * CELL;
        const im = this.scene.add.image(x0, 0, key).setOrigin(0, 0).setDisplaySize(48 * CELL, 27 * CELL).setScrollFactor(1, 1).setDepth(ART.depths.underlay).setAlpha(this.opacity).setVisible(this.visible);
        this.layer.add(im);
        this.imgs.push(im);
      }
      this.loaded = true;
    })();
    return this.loading;
  }

  set(on: boolean): void {
    this.visible = on && this.available;
    if (this.visible && !this.loaded) void this.load();
    for (const im of this.imgs) im.setVisible(this.visible);
  }

  get on(): boolean {
    return this.visible;
  }

  destroy(): void {
    this.destroyed = true;
    for (const im of this.imgs) im.destroy();
    for (const k of this.keys) this.bank.remove(k);
    this.imgs = [];
    this.keys = [];
  }
}
