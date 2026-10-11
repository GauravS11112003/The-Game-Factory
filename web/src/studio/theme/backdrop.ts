/**
 * Backdrop layout (docs/v7/CONTRACTS_V7.md §4.1), pure (no DOM, tested in node): where a parallax BackdropLayer goes for
 * a camera, with the same device-space camera convention as renderBackground (`cam.x/y` = world point at the view's
 * top left, `zoom` = view px per world px, `view` = the canvas size in px). art.ts paints with it; the runtime turns
 * layers into TileSprites placed by it.
 */

export interface LayerLike {
  w: number;
  h: number;
  depth?: number;
  anchor?: 'top' | 'bottom' | 'fill';
  tile_x?: boolean;
  height?: number;
}

export interface BackdropPlace {
  /** Where the layer's box goes in view px (for repeating layers x = 0 and w = the view's width). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** View px per SVG unit. */
  scale: number;
  /** Repeats sideways (pattern / TileSprite). */
  repeat: boolean;
  /** For repeating layers: how far the pattern is scrolled, in view px (0 ≤ offset < one tile width). */
  offset: number;
  /** One tile's width in view px. */
  tileW: number;
}

/** The size of an SVG from its viewBox (else width/height attributes); null when there is none. */
export function svgSize(svg: string | null | undefined): { w: number; h: number } | null {
  if (typeof svg !== 'string') return null;
  const m = /<svg\b[^>]*>/i.exec(svg);
  if (!m) return null;
  const vb = /viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)\s*["']/i.exec(m[0]);
  if (vb) {
    const w = Number(vb[3]);
    const h = Number(vb[4]);
    if (w > 0 && h > 0) return { w, h };
  }
  const wm = /\swidth\s*=\s*["']?([\d.]+)/i.exec(m[0]);
  const hm = /\sheight\s*=\s*["']?([\d.]+)/i.exec(m[0]);
  if (wm && hm && Number(wm[1]) > 0 && Number(hm[1]) > 0) return { w: Number(wm[1]), h: Number(hm[1]) };
  return null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Placement of one layer: `height` is its share of the view height (`fill` = all of it), `depth` the parallax (0 =
 * fixed to the screen like a distant sky, 1 = moves with the world), `anchor` hangs it from the top, stands it on the
 * bottom (sinking a little when the camera rises above the world's floor) or fills the view.
 */
export function backdropPlacement(layer: LayerLike, world: { width: number; height: number }, cam: { x: number; y: number; zoom?: number },
  view: { w: number; h: number }): BackdropPlace {
  const zoom = cam.zoom && cam.zoom > 0 ? cam.zoom : 1;
  const depth = clamp(Number.isFinite(layer.depth) ? (layer.depth as number) : 0.5, 0, 1);
  const anchor = layer.anchor ?? 'bottom';
  const lw = layer.w > 0 ? layer.w : 1;
  const lh = layer.h > 0 ? layer.h : 1;
  const hpx = anchor === 'fill' ? view.h : clamp(Number.isFinite(layer.height) ? (layer.height as number) : 0.5, 0.05, 1) * view.h;
  let scale = hpx / lh;
  let tileW = lw * scale;
  // a fill layer must also cover the width when it does not repeat
  if (anchor === 'fill' && layer.tile_x === false && tileW < view.w) {
    scale = view.w / lw;
    tileW = view.w;
  }
  const h = lh * scale;
  let y: number;
  if (anchor === 'bottom') {
    const camBottom = cam.y + view.h / zoom;
    const sink = clamp((world.height - camBottom) * zoom * depth * 0.5, 0, h * 0.6);
    y = view.h - h + sink;
  } else if (anchor === 'top') {
    y = -clamp(cam.y * zoom * depth * 0.3, 0, h * 0.6);
  } else y = (view.h - h) / 2;
  const shift = cam.x * zoom * depth; // view px the layer has scrolled
  if (layer.tile_x !== false) {
    const offset = ((shift % tileW) + tileW) % tileW;
    return { x: 0, y, w: view.w, h, scale, repeat: true, offset, tileW };
  }
  // one picture centred on the world's middle, sliding with the parallax
  const camCx = cam.x + view.w / zoom / 2;
  const x = (view.w - tileW) / 2 - (camCx - world.width / 2) * zoom * depth;
  return { x, y, w: tileW, h, scale, repeat: false, offset: 0, tileW };
}
