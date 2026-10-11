/**
 * The speech bubble (docs/v4/CONTRACTS_V4.md §2.2 `say`, §5 npcs): SimView.say drawn as a paper bubble with a marker
 * outline and a tail, in the hand font, over the player (or over the entity it belongs to). It lives in world space
 * (the act layer) so it follows its speaker, but stays inside the view (hudmodel.bubbleLayout) and moves to the other
 * side of the speaker when its own side has no room. A new line pops in; the bubble fades when the sim drops it.
 */
import Phaser from 'phaser';
import { ART } from '../../core/params.ts';
import { HAND_FONT } from '../../render/fonts.ts';
import { VIEW_H_PX, VIEW_W_PX } from '../gfx.ts';
import { bubbleLayout } from './hudmodel.ts';
import { COLORS } from './juice.ts';

const WRAP_PX = 190;
const PAD_X = 9;
const PAD_Y = 5;
const POP_MS = 160;
const FADE_MS = 150;

/** The speaker on screen: its centre x and its top / bottom (world px), and which side the bubble prefers. */
export interface Speaker {
  x: number;
  top: number;
  bottom: number;
  prefer: 'up' | 'down';
}

export class SayBubble {
  private c: Phaser.GameObjects.Container;
  private g: Phaser.GameObjects.Graphics;
  private t: Phaser.GameObjects.Text;
  private text = '';
  private side: 'up' | 'down' | null = null;
  private tailX = NaN;
  private shownAt = -1;
  private k = 0; // 0..1 shown
  private reduced: boolean;

  constructor(scene: Phaser.Scene, layer: Phaser.GameObjects.Layer, r: number, reduced: boolean) {
    this.reduced = reduced;
    this.c = scene.add.container(0, 0).setDepth(ART.depths.overlays - 1).setVisible(false);
    this.g = scene.add.graphics();
    this.t = scene.add.text(0, 0, '', {
      fontFamily: HAND_FONT, fontSize: '15px', color: '#1F1B18', resolution: r, align: 'center', lineSpacing: -2,
      wordWrap: { width: WRAP_PX, useAdvancedWrap: true },
    }).setOrigin(0, 0);
    this.c.add([this.g, this.t]);
    layer.add(this.c);
  }

  /** One frame: the sim's say (null = none), where its speaker is, the camera's left edge (world px), real ms. */
  update(text: string | null, who: Speaker | null, camX: number, now: number, dt: number): void {
    const want = !!(text && who);
    if (want && text !== this.text) {
      this.text = text!;
      this.t.setText(this.text);
      this.side = null; // redraw the bubble for the new size
      this.shownAt = now;
    }
    this.k = want ? Math.min(1, this.k + (this.reduced ? 1 : dt / POP_MS)) : Math.max(0, this.k - (this.reduced ? 1 : dt / FADE_MS));
    if (this.k <= 0) {
      this.c.setVisible(false);
      if (!want) this.text = '';
      return;
    }
    if (!who) return; // fading out where it last was
    const w = Math.ceil(this.t.width) + PAD_X * 2;
    const h = Math.ceil(this.t.height) + PAD_Y * 2;
    const l = bubbleLayout({ w, h, x: who.x, top: who.top, bottom: who.bottom, prefer: who.prefer, camX, viewW: VIEW_W_PX, viewH: VIEW_H_PX });
    if (l.side !== this.side || Math.abs(l.tailX - l.x - this.tailX) > 0.5) this.draw(w, h, l.side, l.tailX - l.x);
    this.t.setPosition(PAD_X, PAD_Y);
    // pop: a quick overshoot about the tail's tip, then still
    const age = now - this.shownAt;
    const pop = this.reduced || age > POP_MS * 2 ? 1 : 0.7 + 0.3 * Math.min(1, age / POP_MS) + 0.08 * Math.sin(Math.min(1, age / (POP_MS * 2)) * Math.PI);
    const ox = l.tailX - l.x;
    const oy = l.side === 'up' ? h + 7 : -7;
    this.c.setVisible(true).setAlpha(this.k);
    this.c.setPosition(l.x + ox * (1 - pop), l.y + oy * (1 - pop)).setScale(pop);
  }

  /** The paper bubble with its tail toward the speaker (local px; tail at tx). */
  private draw(w: number, h: number, side: 'up' | 'down', tx: number): void {
    this.side = side;
    this.tailX = tx;
    const g = this.g;
    g.clear();
    g.fillStyle(COLORS.ink, 0.12);
    g.fillRoundedRect(1.5, 2.5, w, h, 9); // a soft paper shadow
    g.fillStyle(COLORS.paper, 0.98);
    g.lineStyle(2, COLORS.ink, 1);
    g.fillRoundedRect(0, 0, w, h, 9);
    g.strokeRoundedRect(0, 0, w, h, 9);
    // the tail: a small marker wedge over the outline
    const by = side === 'up' ? h : 0;
    const tip = side === 'up' ? h + 7 : -7;
    g.fillTriangle(tx - 5, by, tx + 5, by, tx - 1, tip);
    g.fillStyle(COLORS.paper, 1);
    g.fillRect(tx - 4, side === 'up' ? by - 2 : by, 8, 2);
    g.lineBetween(tx - 5, by, tx - 1, tip);
    g.lineBetween(tx - 1, tip, tx + 5, by);
  }

  setResolution(r: number): void {
    this.t.setResolution(r);
  }

  refreshFont(): void {
    this.t.setFontFamily(HAND_FONT);
  }

  destroy(): void {
    this.c.destroy();
  }
}
