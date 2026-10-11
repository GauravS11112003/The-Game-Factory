import type { CellXY } from '../core/types.gen.ts';
import type { Pt } from './geom.ts';

/** Shapes use the same vector strokes as the brush, so selection, erase and undo still work. */
export function sketchShape(kind: 'rectangle' | 'ellipse', from: CellXY, to: CellXY, width: number, worldW: number, worldH: number): Pt[] {
  const x0 = Math.max(0, Math.min(worldW, Math.min(from[0], to[0])));
  const y0 = Math.max(0, Math.min(worldH, Math.min(from[1], to[1])));
  const x1 = Math.max(0, Math.min(worldW, Math.max(from[0], to[0])));
  const y1 = Math.max(0, Math.min(worldH, Math.max(from[1], to[1])));
  if (x1 - x0 < .1 || y1 - y0 < .1) return [];
  const pts: CellXY[] = kind === 'rectangle' ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] :
    Array.from({ length: 49 }, (_, n) => {
      const angle = n / 48 * Math.PI * 2;
      return [(x0 + x1) / 2 + Math.cos(angle) * (x1 - x0) / 2, (y0 + y1) / 2 + Math.sin(angle) * (y1 - y0) / 2];
    });
  return pts.map(([x, y]) => ({ x, y, w: width }));
}
