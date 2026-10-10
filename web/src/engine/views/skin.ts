/**
 * The level skin in the game (docs/v3/CONTRACTS_V3.md "Skin on levels"): generated pictures over the kid's drawing,
 * never touching the sim.
 *
 * - Entities (enemies, coins, moving platforms, flags, …): the entity view swaps its ink for the picture and keeps
 *   all of its juice (waddle, squash and stretch, the stomp puff, flips when it turns around). This class only
 *   composes the textures; EntityViews places them (EntityViews.reskin).
 * - Other objects (terrain, decoration): a static picture over the object's fitted ink box, and that object's ink
 *   is left out of the ink chunks (`inkDoc`).
 * - The character: a raster CharacterSource for PlayerSprite (the waddle, shear and shatter all work on it).
 * - The backdrop: a TileSprite behind the ink, in front of the paper, scaled to the world height and scrolling at
 *   SKIN_PARALLAX × the camera; the graphite parallax steps aside while it shows.
 *
 * A picture still loading or broken leaves the kid's ink in place: ink is only hidden for pictures that are ready.
 * Loads land in `update` (once per frame, batched), so a skin arriving mid-run re-skins only what changed.
 */
import Phaser from 'phaser';
import type { ArtDoc } from '../../core/art/types.ts';
import type { InkDoc, LevelInk, LevelV2 } from '../../core/types.gen.ts';
import { hideSkinned, joinNames, resolveSkin, skinCredits, skinOf, SKIN_PARALLAX } from '../../core/art/skin.ts';
import type { SkinPlacement, SkinSpec } from '../../core/art/skin.ts';
import { ART } from '../../core/params.ts';
import { composeSkin, loadSkinImage, peekSkinImage } from '../../render/skin.ts';
import type { SkinImage } from '../../render/skin.ts';
import { msg } from '../../render/text.ts';
import { CELL, VIEW_H_PX, VIEW_W_PX } from '../gfx.ts';
import type { Baked, TexBank } from '../gfx.ts';
import type { CharacterSource } from './player.ts';

const SPRITE_PX = 2; // canvas px per logical px for entity and object pictures (displayed with LINEAR filtering)
const PLAYER_PX = 4; // the character, like PlayerSprite's vector bake
const POP_MS = 280;
const FADE_MS = 450;
const BACKDROP_DEPTH = 0.5; // over the paper (0), under the vignette (1) and everything drawn

/** What a (re)skin changed, for the scene to update the matching views. */
export interface SkinChange {
  entities: string[];
  player: boolean;
  hidden: boolean;
  backdrop: boolean;
  credit: boolean;
  /** The change came in live (a fly-in, a picture that finished loading): views may pop. */
  pop: boolean;
}

export interface SkinHost {
  scene: Phaser.Scene;
  bank: TexBank;
  /** Layer for static object pictures (a camera without the ink boil). */
  world: Phaser.GameObjects.Layer;
  /** The background layer (paper, parallax) for the backdrop. */
  bg: Phaser.GameObjects.Layer;
  reduced: boolean;
  changed(c: SkinChange): void;
}

interface StaticPic {
  img: Phaser.GameObjects.Image;
  tex: string;
  base: number; // 1 / px
  popAt: number; // ms (scene time) the pop started; -1 = none, -2 = start on the next update
}

const texKey = (p: SkinPlacement): string => `${p.url}|${p.fit}|${p.box.map((v) => Math.round(v * 64)).join(',')}`;

export class SkinView {
  private host: SkinHost;
  private spec: SkinSpec | null = null;
  private author: string | null = null;
  private placements: SkinPlacement[] = [];
  private tex = new Map<string, Baked>();
  private used = new Set<string>();
  private ent = new Map<string, Baked>();
  private statics = new Map<string, StaticPic>();
  private playerKey = '';
  private playerSrc: CharacterSource | null = null;
  private hiddenKey = '';
  private hiddenIds = new Set<string>();
  private filtered: { doc: ArtDoc; key: string; out: ArtDoc } | null = null;
  private bd: { url: string; ts: Phaser.GameObjects.TileSprite | null; key: string | null; k: number; fadeAt: number } | null = null;
  private shownCredit: string | null = null;
  private dirty = false;
  private gen = 0;
  private dead = false;

  constructor(host: SkinHost) {
    this.host = host;
  }

  /**
   * (Re)resolve the skin of `level` against its ArtDoc. `notify` reports the differences through host.changed (a live
   * re-skin); without it the caller is rebuilding its views and reads entityTex / playerSource / inkDoc itself.
   */
  set(level: LevelV2, ink: InkDoc | LevelInk | null | undefined, doc: ArtDoc, o: { notify: boolean; pop: boolean }): SkinChange {
    const spec = skinOf(level);
    this.spec = spec;
    this.author = level.author || null;
    try {
      this.placements = spec ? resolveSkin(level, ink, doc, spec) : [];
    } catch (e) {
      console.warn('skin placement failed; keeping the drawing', e);
      this.placements = [];
    }
    const gen = ++this.gen;
    const later = (): void => {
      if (!this.dead && gen === this.gen) this.dirty = true;
    };
    for (const p of this.placements) if (peekSkinImage(p.url, 'sprite') === undefined) void loadSkinImage(p.url, 'sprite').then(later);
    const bdUrl = spec?.backdrop?.url ?? null;
    if (bdUrl && peekSkinImage(bdUrl, 'backdrop') === undefined) void loadSkinImage(bdUrl, 'backdrop').then(later);
    const was = this.backdropOn;
    this.setBackdrop(bdUrl, o.pop);
    return this.apply(o.notify, o.pop, was !== this.backdropOn);
  }

  /** The entity's picture texture (anchor-relative origin), or null to draw its ink. */
  entityTex(id: string): Baked | null {
    return this.ent.get(id) ?? null;
  }

  /** The character's picture, or null to draw the kid's character. */
  playerSource(): CharacterSource | null {
    return this.playerSrc;
  }

  /** The ArtDoc for the ink chunks: the kid's ink minus the objects a ready picture replaces. */
  inkDoc(doc: ArtDoc): ArtDoc {
    if (!this.hiddenIds.size) return doc;
    const f = this.filtered;
    if (f && f.doc === doc && f.key === this.hiddenKey) return f.out;
    const out = hideSkinned(doc, this.hiddenIds);
    this.filtered = { doc, key: this.hiddenKey, out };
    return out;
  }

  /** Object ids whose ink a static picture replaces. */
  get hidden(): ReadonlySet<string> {
    return this.hiddenIds;
  }

  get backdropOn(): boolean {
    return !!this.bd?.ts;
  }

  /** The credit line to show ("Art: Adobe Firefly · drawn by Maya") while Firefly art is on screen; null otherwise. */
  get credit(): string | null {
    return this.shownCredit;
  }

  /** The placement for an object / entity id ('player' for the character), if the skin covers it. */
  placementOf(id: string): SkinPlacement | null {
    for (const p of this.placements) {
      if (id === 'player' ? p.target.kind === 'player' : p.target.kind !== 'player' && (p.target.id === id || p.hide.includes(id))) return p;
    }
    return null;
  }

  /** Per frame: land finished loads (batched), scroll the backdrop, play the pops. `now` is scene time (ms). */
  update(scrollX: number, now: number): void {
    if (this.dead) return;
    if (this.dirty) {
      this.dirty = false;
      const was = this.backdropOn;
      this.buildBackdrop(true);
      this.apply(true, true, was !== this.backdropOn);
    }
    const bd = this.bd;
    if (bd?.ts) {
      bd.ts.tilePositionX = (scrollX * SKIN_PARALLAX) / bd.k;
      if (bd.fadeAt !== -1) {
        if (bd.fadeAt === -2) bd.fadeAt = now;
        const k = Math.min(1, (now - bd.fadeAt) / FADE_MS);
        bd.ts.setAlpha(k);
        if (k >= 1) bd.fadeAt = -1;
      }
    }
    for (const s of this.statics.values()) {
      if (s.popAt === -1) continue;
      if (s.popAt === -2) s.popAt = now;
      const k = Math.min(1, (now - s.popAt) / POP_MS);
      const sc = 1 + 0.18 * Math.sin(k * Math.PI) * (1 - k * 0.5);
      s.img.setScale(s.base * sc);
      if (k >= 1) {
        s.popAt = -1;
        s.img.setScale(s.base);
      }
    }
  }

  /** Drop textures no placement uses any more (call after the views that used them were rebuilt). */
  gc(): void {
    for (const [k, b] of this.tex) {
      if (this.used.has(k)) continue;
      this.host.bank.remove(b.key);
      this.tex.delete(k);
    }
  }

  destroy(): void {
    this.dead = true;
    for (const s of this.statics.values()) s.img.destroy();
    this.statics.clear();
    this.bd?.ts?.destroy();
    this.bd = null;
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  private baked(p: SkinPlacement, img: SkinImage): Baked {
    const k = texKey(p);
    this.used.add(k);
    const hit = this.tex.get(k);
    if (hit) return hit;
    const { canvas, px } = composeSkin(img, p.box, p.fit, SPRITE_PX);
    const w = (p.box[2] - p.box[0]) * CELL;
    const h = (p.box[3] - p.box[1]) * CELL;
    const b: Baked = { key: this.host.bank.add('skin', canvas), px, w, h, ox: (-p.box[0] * CELL) / w, oy: (-p.box[1] * CELL) / h };
    this.tex.set(k, b);
    return b;
  }

  private playerFrom(p: SkinPlacement, img: SkinImage): { key: string; src: CharacterSource } {
    const key = `${texKey(p)}|player`;
    if (key === this.playerKey && this.playerSrc) return { key, src: this.playerSrc };
    const { canvas, px } = composeSkin(img, p.box, p.fit, PLAYER_PX);
    return { key, src: { kind: 'raster', canvas, feet: [-p.box[0] * CELL * px, -p.box[1] * CELL * px], px } };
  }

  private apply(notify: boolean, pop: boolean, backdropChanged: boolean): SkinChange {
    const change: SkinChange = { entities: [], player: false, hidden: false, backdrop: backdropChanged, credit: false, pop };
    this.used = new Set();
    const nextEnt = new Map<string, Baked>();
    const nextStatic = new Map<string, { p: SkinPlacement; b: Baked }>();
    const hidden = new Set<string>();
    let player: { key: string; src: CharacterSource } | null = null;
    for (const p of this.placements) {
      const img = peekSkinImage(p.url, 'sprite');
      if (!img) continue; // loading or broken: the kid's ink stays
      try {
        if (p.target.kind === 'player') {
          player = this.playerFrom(p, img);
          continue;
        }
        const b = this.baked(p, img);
        if (p.target.kind === 'entity') nextEnt.set(p.target.id, b);
        else {
          nextStatic.set(p.key, { p, b });
          for (const id of p.hide) hidden.add(id);
        }
      } catch (e) {
        console.warn('skin picture could not be placed; keeping the drawing', p.url, e);
      }
    }
    // entities whose picture changed (added, replaced, removed)
    for (const [id, b] of nextEnt) if (this.ent.get(id)?.key !== b.key) change.entities.push(id);
    for (const id of this.ent.keys()) if (!nextEnt.has(id)) change.entities.push(id);
    this.ent = nextEnt;
    // the character
    const pk = player?.key ?? '';
    if (pk !== this.playerKey) {
      this.playerKey = pk;
      this.playerSrc = player?.src ?? null;
      change.player = true;
    }
    // static pictures: keep the unchanged ones (no flicker), replace the rest
    for (const [k, s] of this.statics) {
      if (nextStatic.get(k)?.b.key === s.tex) continue;
      s.img.destroy();
      this.statics.delete(k);
    }
    for (const [k, n] of nextStatic) {
      if (this.statics.has(k)) continue;
      const { p, b } = n;
      // origin at the bottom centre so the pop grows out of where the object stands
      const img = this.host.scene.add.image(((p.box[0] + p.box[2]) / 2) * CELL, p.box[3] * CELL, b.key).setOrigin(0.5, 1).setScale(1 / b.px);
      img.setDepth(p.fit === 'platform' ? ART.depths.terrain + 1 : ART.depths.terrain - 1);
      this.host.world.add(img);
      const st: StaticPic = { img, tex: b.key, base: 1 / b.px, popAt: -1 };
      // the ink it replaces goes in the same frame, so the picture is never not there: it only bounces
      if (pop && !this.host.reduced) st.popAt = -2;
      this.statics.set(k, st);
    }
    // the ink those pictures replace
    const hk = [...hidden].sort().join('|');
    if (hk !== this.hiddenKey) {
      this.hiddenKey = hk;
      this.hiddenIds = hidden;
      this.filtered = null;
      change.hidden = true;
    }
    // the credit, while some Firefly art is actually on screen
    const shown = nextEnt.size + nextStatic.size + (player ? 1 : 0) + (this.backdropOn ? 1 : 0) > 0;
    const credit = shown ? this.creditLine() : null;
    if (credit !== this.shownCredit) {
      this.shownCredit = credit;
      change.credit = true;
    }
    if (notify) {
      if (change.entities.length || change.player || change.hidden || change.backdrop || change.credit) this.host.changed(change);
      this.gc();
    }
    return change;
  }

  private creditLine(): string | null {
    const c = skinCredits(this.spec, this.author);
    if (!c.firefly) return null;
    const name = joinNames(c.names);
    return name ? msg('skin.credit_by', { name }, 'Art: Adobe Firefly · drawn by {name}') : msg('skin.credit', {}, 'Art: Adobe Firefly');
  }

  private setBackdrop(url: string | null, pop: boolean): void {
    if (this.bd && this.bd.url === url) {
      this.buildBackdrop(pop);
      return;
    }
    if (this.bd) {
      this.bd.ts?.destroy();
      if (this.bd.key) this.host.bank.remove(this.bd.key);
      this.bd = null;
    }
    if (!url) return;
    this.bd = { url, ts: null, key: null, k: 1, fadeAt: -1 };
    this.buildBackdrop(pop);
  }

  private buildBackdrop(pop: boolean): void {
    const bd = this.bd;
    if (!bd || bd.ts) return;
    const img = peekSkinImage(bd.url, 'backdrop');
    if (!img) return; // loading (the paper and its graphite parallax stay) or broken (they stay for good)
    try {
      bd.key = this.host.bank.add('skin_bg', img.canvas);
      bd.k = VIEW_H_PX / img.h;
      bd.ts = this.host.scene.add.tileSprite(0, 0, VIEW_W_PX, VIEW_H_PX, bd.key).setOrigin(0, 0).setScrollFactor(0).setDepth(BACKDROP_DEPTH).setTileScale(bd.k, bd.k);
      this.host.bg.add(bd.ts);
      if (pop && !this.host.reduced) {
        bd.fadeAt = -2;
        bd.ts.setAlpha(0);
      }
    } catch (e) {
      console.warn('skin backdrop failed; keeping the paper', e);
      bd.ts?.destroy();
      bd.ts = null;
    }
  }
}
