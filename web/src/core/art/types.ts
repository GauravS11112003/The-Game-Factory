/** ArtDoc: the deterministic display list built by the core and drawn by Canvas2D (play) or SVG (goldens) (§7.4). */
import type { Theme, World } from '../types.gen.ts';

export interface ArtStyle {
  stroke?: string;
  fill?: string;
  width?: number; // logical px; per-point widths live on the path
  opacity?: number;
  dash?: number[];
  hatch?: { angle_deg: number; spacing_px: number; width_px: number; alpha: number };
  ink: 'marker' | 'pencil' | 'graphite' | 'blue_line';
}

export interface ArtPath {
  pts: number[]; // flat [x0, y0, x1, y1, ...] in cells
  w?: number[]; // per-point width (px)
  closed: boolean;
  style: string; // key into ArtDoc.styles
  object_id?: string;
}

export interface ArtLayer {
  id: string;
  depth: number; // §7.4 depth table
  scroll: number; // parallax factor (1 = world)
  paths: ArtPath[];
}

export interface ArtDoc {
  v: 1;
  theme: Theme;
  seed: number;
  world: World;
  boilFrame: 0 | 1 | 2;
  styles: Record<string, ArtStyle>;
  layers: ArtLayer[];
}
