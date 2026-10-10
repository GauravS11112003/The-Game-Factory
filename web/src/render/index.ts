/** Canvas2D ink renderer (lane E, §7.4): ArtDoc → chunk textures. P0 stub of drawInk (§11.3g). */
import type { ArtDoc } from '../core/art/types.ts';
import type { RectCells } from '../core/types.gen.ts';

export function drawInk(ctx: CanvasRenderingContext2D, doc: ArtDoc, view: RectCells, o?: { style?: 'final' | 'underlay' }): void {
  void ctx;
  void doc;
  void view;
  void o;
  throw new Error('NotImplemented: drawInk');
}
