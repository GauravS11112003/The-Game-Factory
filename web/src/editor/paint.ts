/**
 * Canvas2D painting of vector ink strokes (cells → px), shared by the editor, the minimap, the Character Studio and
 * the preview's "What I saw" thumbnails. Marker palette from §7.1.
 */
import type { InkColor, InkStroke, RectCells } from '../core/types.gen.ts';
import { ART, PAPER } from '../core/params.ts';

export const INK: Record<InkColor, string> = {
  black: ART.palette.ink,
  red: ART.palette.red,
  green: ART.palette.green,
  blue: ART.palette.blue,
  pencil: ART.palette.pencil_violet,
  draft: ART.palette.blue_line,
};

export const PARENT_GRAY = PAPER.remix_gray;

export interface PaintOpts {
  scale: number; // px per cell
  ox: number; // view origin in cells
  oy: number;
  color?: string; // override (locked parent ink, ghosts)
  alpha?: number;
  minWidthPx?: number;
}

export function paintStroke(ctx: CanvasRenderingContext2D, s: InkStroke, o: PaintOpts): void {
  const col = o.color ?? INK[s.color] ?? INK.black;
  const X = (x: number): number => (x - o.ox) * o.scale;
  const Y = (y: number): number => (y - o.oy) * o.scale;
  const minW = o.minWidthPx ?? 0.6;
  ctx.save();
  if (o.alpha !== undefined) ctx.globalAlpha *= o.alpha;
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.kind === 'dot' || s.pts.length === 1) {
    const r = Math.max(minW, ((s.w[0] ?? 0.875) / 2) * o.scale);
    ctx.beginPath();
    ctx.arc(X(s.pts[0][0]), Y(s.pts[0][1]), r, 0, Math.PI * 2);
    ctx.fill();
  } else if (s.kind === 'blob') {
    ctx.beginPath();
    s.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
    ctx.closePath();
    ctx.globalAlpha *= 0.9;
    ctx.fill();
    ctx.globalAlpha /= 0.9;
    ctx.lineWidth = Math.max(minW, (s.w[0] ?? 0.25) * o.scale);
    ctx.stroke();
  } else {
    const n = s.pts.length;
    const uniform = s.w.every((w) => Math.abs(w - s.w[0]) < 0.02);
    if (uniform) {
      ctx.lineWidth = Math.max(minW, (s.w[0] ?? 0.75) * o.scale);
      ctx.beginPath();
      s.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
      if (s.closed) ctx.closePath();
      ctx.stroke();
    } else {
      const segs = s.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = s.pts[i];
        const b = s.pts[(i + 1) % n];
        const w = ((s.w[Math.min(i, s.w.length - 1)] ?? 0.75) + (s.w[Math.min((i + 1) % n, s.w.length - 1)] ?? 0.75)) / 2;
        ctx.lineWidth = Math.max(minW, w * o.scale);
        ctx.beginPath();
        ctx.moveTo(X(a[0]), Y(a[1]));
        ctx.lineTo(X(b[0]), Y(b[1]));
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** Paint strokes fitted into a canvas (thumbnails): keeps aspect, pads by `pad` cells. */
export function paintFit(canvas: HTMLCanvasElement, strokes: InkStroke[], box: RectCells | null, o: { pad?: number; bg?: string } = {}): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (o.bg) {
    ctx.fillStyle = o.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (!box || !strokes.length) return;
  const pad = o.pad ?? 0.4;
  const bw = box[2] - box[0] + pad * 2;
  const bh = box[3] - box[1] + pad * 2;
  const scale = Math.min(canvas.width / bw, canvas.height / bh);
  const ox = box[0] - pad - (canvas.width / scale - bw) / 2;
  const oy = box[1] - pad - (canvas.height / scale - bh) / 2;
  for (const s of strokes) paintStroke(ctx, s, { scale, ox, oy, minWidthPx: 1 });
}
