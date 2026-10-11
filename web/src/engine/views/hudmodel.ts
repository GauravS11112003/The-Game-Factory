/**
 * The v4 HUD's pure parts (docs/v4/CONTRACTS_V4.md §4.2): which effect rings show and how full they are, the second
 * HUD row's layout (score, counter chips) and where a speech bubble sits on screen. No Phaser, so node tests run it;
 * views/hud.ts and views/bubble.ts draw what these decide.
 */
import type { EffectsV4 } from '../v4.ts';

export type EffectKind = 'speed' | 'jump' | 'gravity' | 'reverse' | 'freeze' | 'flip';

/** One effect ring: frames left, how full the ring is (0..1), and "until you respawn" (−1 in the view). */
export interface EffectChip {
  kind: EffectKind;
  left: number;
  frac: number;
  forever: boolean;
}

export const EFFECT_ORDER: readonly EffectKind[] = ['speed', 'jump', 'gravity', 'reverse', 'freeze', 'flip'];

const FIELD: Record<Exclude<EffectKind, 'flip'>, keyof EffectsV4> = {
  speed: 'speed_f', jump: 'jump_f', gravity: 'gravity_f', reverse: 'reverse_f', freeze: 'freeze_f',
};

/**
 * Timed effects as rings that empty as time runs out. The view only says frames left, so the ring's full length is
 * the most frames seen since the effect came on (a new effect of the same kind refills it). A flipped player shows a
 * "flip" ring for as long as it lasts (until the next flip or a respawn).
 */
export class EffectClock {
  private totals = new Map<EffectKind, number>();

  update(e: EffectsV4, gravity: 1 | -1): EffectChip[] {
    const out: EffectChip[] = [];
    for (const kind of EFFECT_ORDER) {
      const left = kind === 'flip' ? (gravity === -1 ? -1 : 0) : e[FIELD[kind]];
      if (!left) {
        this.totals.delete(kind);
        continue;
      }
      if (left < 0) {
        this.totals.delete(kind);
        out.push({ kind, left: -1, frac: 1, forever: true });
        continue;
      }
      const prev = this.totals.get(kind) ?? 0;
      const total = Math.max(prev, left);
      this.totals.set(kind, total);
      out.push({ kind, left, frac: total > 0 ? left / total : 0, forever: false });
    }
    return out;
  }

  reset(): void {
    this.totals.clear();
  }
}

/** Left-aligned row: the x of each item that fits before maxX (the rest are left out). */
export function layoutRow(widths: readonly number[], x0: number, gap: number, maxX: number): number[] {
  const out: number[] = [];
  let x = x0;
  for (const w of widths) {
    if (x + w > maxX) break;
    out.push(x);
    x += w + gap;
  }
  return out;
}

/** Counters as chips, in the order the sim lists them (rules mention them), at most `max`. */
export function counterChips(counters: Readonly<Record<string, number>>, max = 4): { name: string; n: number }[] {
  return Object.entries(counters).slice(0, max).map(([name, n]) => ({ name, n }));
}

export interface BubbleIn {
  w: number; // bubble size, px
  h: number;
  x: number; // anchor centre x, world px
  top: number; // the speaker's top and bottom, world px
  bottom: number;
  prefer: 'up' | 'down'; // above the head (or below it for a flipped player)
  camX: number; // the view's left edge, world px
  viewW: number;
  viewH: number;
}

export interface BubbleOut {
  x: number; // bubble top-left, world px
  y: number;
  tailX: number; // where the tail meets the bubble, world px
  side: 'up' | 'down'; // bubble above or below the speaker
}

const GAP = 8; // speaker to bubble (the tail spans it)
const MARGIN = 6;

/** Place a bubble by its speaker, kept inside the view; it goes to the other side when its own side has no room. */
export function bubbleLayout(o: BubbleIn): BubbleOut {
  const minX = o.camX + MARGIN;
  const maxX = o.camX + o.viewW - MARGIN - o.w;
  const x = Math.max(minX, Math.min(Math.max(minX, maxX), o.x - o.w / 2));
  const upY = o.top - GAP - o.h;
  const downY = o.bottom + GAP;
  const upFits = upY >= MARGIN;
  const downFits = downY + o.h <= o.viewH - MARGIN;
  let side: 'up' | 'down' = o.prefer;
  if (side === 'up' && !upFits && downFits) side = 'down';
  else if (side === 'down' && !downFits && upFits) side = 'up';
  const yRaw = side === 'up' ? upY : downY;
  const y = Math.max(MARGIN, Math.min(o.viewH - MARGIN - o.h, yRaw));
  const tailX = Math.max(x + 10, Math.min(x + o.w - 10, o.x));
  return { x, y, tailX, side };
}
