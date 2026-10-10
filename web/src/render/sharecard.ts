/**
 * Share cards (PLAN_V2 §7.9 "at publish, the client uploads a 640 × 360 PNG for share cards"; §8.4 "beat my level").
 * The picture is the level's liveliest screen drawn by the same ArtDoc → Canvas2D path as play (or a frame captured
 * from the game, e.g. the win moment), with the character standing in it. The 'card' style adds the paper chrome:
 * a taped title plate (title, "by …", difficulty band with 0-5 ink drops, length), and for a run the big time,
 * falls and coins, the four stamps and "Beat my time!". 'clean' is the bare picture (feed thumbnails).
 */
import type { InkDoc, LevelInk, LevelV2, RectCells, Stamp } from '../core/types.gen.ts';
import { ART, UI } from '../core/params.ts';
import { bestView, standPoint, standY, viewHasStart } from '../core/art/frame.ts';
import { drawInk } from './canvas_ink.ts';
import { drawCharacter, stillPose } from './rig2d.ts';
import { HAND_FONT, loadHandFont } from './fonts.ts';
import { clipText, coinIcon, fitText, inkDrop, plate, roundRectPath, skull, stamp, starIcon, tape, underline } from './paper2d.ts';
import { fmtClock, msg } from './text.ts';
import { skinOf } from '../core/art/skin.ts';
import { drawSkinFitted, skinImagesReady } from './skin.ts';
import { artFor, drawLevelArt, playerSkin } from './thumbnail.ts';

const CELL = 16;
const P = ART.palette;
const STAMPS: readonly Stamp[] = ['clear', 'collector', 'speedy', 'flawless'];

export interface ShareCardRun {
  player?: string | null;
  time_ms: number;
  deaths?: number;
  coins?: number;
  big_coins?: number;
  stamps?: Stamp[];
}

export interface ShareCardOptions {
  /** Canvas size in px; default 640 × 360 (UI.thumbnail_px). Wider ratios (e.g. 1200 × 630) widen the view. */
  size?: [number, number];
  /** 'card' (default): paper chrome with title and run; 'clean': the picture only. */
  style?: 'card' | 'clean';
  /** The view (cells) or how to pick it: 'best' (default), 'start' or 'goal' (default for a run). */
  view?: RectCells | 'best' | 'start' | 'goal';
  title?: string | null;
  author?: string | null;
  /** A cleared run: the big time, falls, coins and the stamps. */
  run?: ShareCardRun | null;
  /** Add the call to action ("Beat my time!" for runs, "Can you clear it?" otherwise). Default: true with a run. */
  challenge?: boolean;
  /** A captured game frame (GameHandle.snapshot) drawn as the picture instead of re-rendering the level. */
  picture?: CanvasImageSource | null;
  seed?: number;
}

function viewFor(level: LevelV2, o: ShareCardOptions, W: number, H: number): RectCells {
  // a run's card shows the finish (the character cheering at the flag); a level's card its liveliest screen
  const pick = (o.view as 'best' | 'start' | 'goal' | undefined) ?? (o.run ? 'goal' : 'best');
  const base: RectCells = Array.isArray(o.view) ? (o.view as RectCells) : bestView(level, { pick });
  const vh = base[3] - base[1];
  const vw = (vh * W) / H;
  const cx = (base[0] + base[2]) / 2;
  const maxX = Math.max(0, level.world.w - vw);
  const x = vw >= level.world.w ? (level.world.w - vw) / 2 : Math.max(0, Math.min(maxX, cx - vw / 2));
  return [x, base[1], x + vw, base[3]];
}

/** Draw the picture: the level (character included) or a captured frame, cover-fitted. */
function drawPicture(ctx: CanvasRenderingContext2D, level: LevelV2, ink: InkDoc | LevelInk | null, o: ShareCardOptions, W: number, H: number): void {
  if (o.picture) {
    const pic = o.picture as CanvasImageSource & { width: number; height: number };
    const pw = Number(pic.width) || W;
    const ph = Number(pic.height) || H;
    const s = Math.max(W / pw, H / ph);
    ctx.drawImage(o.picture, (W - pw * s) / 2, (H - ph * s) / 2, pw * s, ph * s);
    return;
  }
  const doc = artFor(level, ink, o.seed ?? 1);
  const view = viewFor(level, o, W, H);
  // the hero: after a clear the character cheers beside the flag; otherwise it stands where the card can see it
  const goal = (level.compiled?.entities ?? []).find((e) => e.type === 'goal');
  let hero: { at: [number, number]; state: 'idle' | 'win' } | null = null;
  if (o.run && goal && goal.x > view[0] + 2 && goal.x < view[2]) {
    const hx = goal.x - 1.8;
    const hy = standY(level, hx) ?? goal.y;
    hero = { at: [hx, hy], state: 'win' };
  } else if (!viewHasStart(level, view)) {
    const at = standPoint(level, view);
    if (at) hero = { at, state: 'idle' };
  }
  const layers = hero ? doc.layers.map((l) => String(l.id)).filter((id) => id !== 'player') : undefined;
  // the level's skin (generated art over the objects, its backdrop behind) when it has one, else the plain ink
  const sk = skinOf(level) ? drawLevelArt(ctx, level, ink, doc, view, layers ? { layers } : {}) : null;
  if (!sk) drawInk(ctx, doc, view, layers ? { layers } : {});
  if (!hero) return;
  const scale = Math.min(W / ((view[2] - view[0]) * CELL), H / ((view[3] - view[1]) * CELL));
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, -view[0] * CELL * scale, -view[1] * CELL * scale);
  const pic = sk ? playerSkin(sk) : null;
  if (pic) {
    // the character's generated picture stands where the drawn hero would (feet on the ground)
    const b = pic.p.box;
    const x = hero.at[0];
    const y = hero.at[1];
    drawSkinFitted(ctx, pic.img, [(b[0] + x) * CELL, (b[1] + y) * CELL, (b[2] + x) * CELL, (b[3] + y) * CELL], pic.p.fit);
  } else drawCharacter(ctx, doc, doc.player, stillPose(doc.player, { state: hero.state }), hero.at[0] * CELL, hero.at[1] * CELL);
  ctx.restore();
}

function bandRow(ctx: CanvasRenderingContext2D, level: LevelV2, x: number, y: number, k: number): void {
  const d = level.design;
  let cx = x;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  if (d) {
    const label = msg(`band.${d.band}`, {}, d.band.charAt(0).toUpperCase() + d.band.slice(1));
    ctx.font = `${17 * k}px ${HAND_FONT}`;
    ctx.fillStyle = P.ink;
    ctx.fillText(label, cx, y);
    cx += ctx.measureText(label).width + 8 * k;
    const n = Math.max(0, Math.min(5, Math.round((d.score ?? 0) / 20)));
    for (let i = 0; i < 5; i++) inkDrop(ctx, cx + i * 13 * k + 5 * k, y, 5.2 * k, i < n);
    cx += 5 * 13 * k + 10 * k;
  }
  const n = level.world.screens ?? Math.max(1, Math.round(level.world.w / 48));
  const len = n === 1 ? msg('share.screen_one', {}, '1 screen') : msg('share.screens', { n }, '{n} screens');
  ctx.font = `${15 * k}px ${HAND_FONT}`;
  ctx.fillStyle = '#5a524b';
  ctx.fillText(len, cx, y + 0.5 * k);
}

function drawCardChrome(ctx: CanvasRenderingContext2D, level: LevelV2, o: ShareCardOptions, W: number, H: number): void {
  const k = Math.min(W / 640, H / 360);
  const run = o.run ?? null;
  const title = (o.title ?? level.title ?? '').trim() || msg('ui.untitled', {}, 'My level');
  const author = (o.author ?? level.author ?? '').trim();

  // ---- the title plate, taped at the bottom left ----
  const pw = Math.min(W * (run ? 0.56 : 0.66), 420 * k);
  const ph = 92 * k;
  const px = 18 * k + pw / 2;
  const py = H - 18 * k - ph / 2;
  plate(ctx, px, py, pw, ph, { rotDeg: -1.2, k }, () => {
    ctx.fillStyle = P.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const tx = -pw / 2 + 14 * k;
    const size = fitText(ctx, title, pw - 28 * k, 32 * k, 18 * k);
    const shown = clipText(ctx, title, pw - 28 * k);
    ctx.fillText(shown, tx, -ph / 2 + 36 * k);
    underline(ctx, tx, tx + Math.min(pw - 28 * k, ctx.measureText(shown).width), -ph / 2 + 41 * k, k * (size / (32 * k)));
    if (author) {
      ctx.font = `${16 * k}px ${HAND_FONT}`;
      ctx.fillStyle = '#5a524b';
      ctx.fillText(clipText(ctx, msg('play.by', { author }, 'by {author}'), pw - 28 * k), tx, -ph / 2 + 62 * k);
    }
    bandRow(ctx, level, tx, -ph / 2 + 80 * k, k);
  });
  tape(ctx, px - pw / 2 + 16 * k, py - ph / 2 - 2 * k, 44 * k, 14 * k, -24);
  tape(ctx, px + pw / 2 - 18 * k, py - ph / 2 - 1 * k, 40 * k, 13 * k, 18);

  // ---- the run plate: big time, falls / coins / stars, then the four stamps ----
  if (run) {
    const rw = Math.min(W * 0.36, 230 * k);
    const rh = 112 * k;
    const rx = W - 18 * k - rw / 2;
    const ry = H - 18 * k - rh / 2 - 4 * k;
    plate(ctx, rx, ry, rw, rh, { rotDeg: 1.1, k }, () => {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = P.ink;
      ctx.font = `${42 * k}px ${HAND_FONT}`;
      ctx.fillText(fmtClock(run.time_ms), 0, -rh / 2 + 44 * k);
      if (run.player) {
        ctx.font = `${15 * k}px ${HAND_FONT}`;
        ctx.fillStyle = '#5a524b';
        ctx.fillText(clipText(ctx, run.player, rw - 20 * k), 0, -rh / 2 + 62 * k);
      }
      // falls · coins · stars
      const y = -rh / 2 + 86 * k;
      const items: [(x: number) => void, string][] = [
        [(x) => skull(ctx, x, y - 1 * k, 7 * k), String(run.deaths ?? 0)],
        [(x) => coinIcon(ctx, x, y, 6.5 * k), String(run.coins ?? 0)],
      ];
      if (run.big_coins !== undefined) items.push([(x) => starIcon(ctx, x, y, 8 * k), String(run.big_coins)]);
      const slot = rw / items.length;
      ctx.font = `${18 * k}px ${HAND_FONT}`;
      items.forEach(([icon, label], i) => {
        const cx = -rw / 2 + slot * (i + 0.5) - 8 * k;
        icon(cx);
        ctx.fillStyle = P.ink;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, cx + 11 * k, y + 1 * k);
      });
    });
    tape(ctx, rx, ry - rh / 2 - 2 * k, 46 * k, 14 * k, 4);
    // the stamps, slapped on above the plate
    const got = new Set(run.stamps ?? ['clear']);
    const sr = 19 * k;
    const sy = ry - rh / 2 - sr - 12 * k;
    STAMPS.forEach((s, i) => {
      const sx = rx - rw / 2 + sr + 4 * k + i * ((rw - 2 * sr - 8 * k) / 3);
      stamp(ctx, sx, sy + (i % 2 ? 3 * k : -2 * k), sr, msg(`stamp.${s}`, {}, s), { rotDeg: [-10, 7, -5, 11][i], earned: got.has(s) });
    });
  }

  // ---- the call to action, a pill at the top left ----
  const cta = o.challenge ?? !!run;
  if (cta) {
    const text = run ? msg('share.beat_my_time', {}, 'Beat my time!') : msg('share.play_it', {}, 'Can you clear it?');
    ctx.font = `${22 * k}px ${HAND_FONT}`;
    const tw = ctx.measureText(text).width;
    const w = tw + 30 * k;
    const h = 36 * k;
    plate(ctx, 18 * k + w / 2, 18 * k + h / 2, w, h, { rotDeg: -2, k, fill: '#FFF3B8' }, () => {
      ctx.fillStyle = P.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${22 * k}px ${HAND_FONT}`;
      ctx.fillText(text, 0, 1 * k);
    });
  }

  // ---- the brand, small, and a marker frame around the whole card ----
  ctx.save();
  ctx.font = `${13 * k}px ${HAND_FONT}`;
  ctx.fillStyle = 'rgba(59,54,50,0.55)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText('draw-a-level', W - 12 * k, 9 * k);
  ctx.strokeStyle = P.ink;
  ctx.lineWidth = 3 * k;
  roundRectPath(ctx, 1.5 * k, 1.5 * k, W - 3 * k, H - 3 * k, 14 * k);
  ctx.stroke();
  ctx.restore();
}

/** The share card as a canvas (waits for the hand font so the text is drawn in it). */
export async function shareCardCanvas(level: LevelV2, ink: InkDoc | LevelInk | null, o: ShareCardOptions = {}): Promise<HTMLCanvasElement> {
  const [W, H] = o.size ?? (UI.thumbnail_px as unknown as [number, number]);
  const c = document.createElement('canvas');
  c.width = Math.max(64, Math.round(W));
  c.height = Math.max(36, Math.round(H));
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  if ((o.style ?? 'card') === 'card') await loadHandFont();
  // skin pictures first (bounded wait): a card is a one-off render, so it waits instead of repainting
  if (!o.picture) await skinImagesReady(skinOf(level), 5000);
  ctx.save();
  // the picture, clipped to the card's rounded corners
  roundRectPath(ctx, 0, 0, c.width, c.height, 14 * Math.min(c.width / 640, c.height / 360));
  ctx.clip();
  try {
    drawPicture(ctx, level, ink, o, c.width, c.height);
  } catch (e) {
    ctx.fillStyle = '#FBF6EA';
    ctx.fillRect(0, 0, c.width, c.height);
    console.warn('share card picture failed', level.id, e);
  }
  ctx.restore();
  if ((o.style ?? 'card') === 'card') {
    try {
      drawCardChrome(ctx, level, o, c.width, c.height);
    } catch (e) {
      console.warn('share card chrome failed', level.id, e);
    }
  }
  return c;
}

/** The share card as a PNG blob (640 × 360 by default): the publish upload and "Challenge a friend". */
export async function shareCardPNG(level: LevelV2, ink: InkDoc | LevelInk | null, o: ShareCardOptions = {}): Promise<Blob | null> {
  const c = await shareCardCanvas(level, ink, o);
  return new Promise((res) => {
    try {
      c.toBlob((b) => res(b), 'image/png');
    } catch {
      res(null);
    }
  });
}

/** The card as a File for the Web Share API (`navigator.share({ files: [file] })`). */
export async function shareCardFile(level: LevelV2, ink: InkDoc | LevelInk | null, o: ShareCardOptions = {}): Promise<File | null> {
  const b = await shareCardPNG(level, ink, o);
  if (!b || typeof File === 'undefined') return null;
  const name = `${(level.title || 'level').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'level'}.png`;
  return new File([b], name, { type: 'image/png' });
}
