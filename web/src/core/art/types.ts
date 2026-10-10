/**
 * ArtDoc: the deterministic display list built by the core and drawn by Canvas2D (play, thumbnails) or SVG
 * (goldens, `art_svg`) (PLAN_V2 §7.4). Pure data: every coordinate is in cells, every width in logical px.
 *
 * Coordinate frames:
 * - layer paths are in world cells (a layer with `scroll` f is drawn at x − f·camX);
 * - sprite and player paths are local cells relative to their `anchor` (see ArtSprite).
 */
import type { RectCells, Rig, Theme, World } from '../types.gen.ts';

export type InkKind = 'marker' | 'pencil' | 'graphite' | 'blue_line';

export interface ArtHatch {
  angle_deg: number;
  spacing_px: number;
  width_px: number;
  alpha: number;
  color?: string; // defaults to the style's stroke, else ink
}

export interface ArtStyle {
  stroke?: string;
  fill?: string;
  width?: number; // logical px; used when the path has no per-point `w`
  opacity?: number; // multiplies stroke and fill alpha
  fill_opacity?: number; // fill alpha (before `opacity`)
  dash?: number[]; // px, constant-width strokes only
  cap?: 'round' | 'butt';
  hatch?: ArtHatch; // hatch lines clipped to the (closed) path
  ink: InkKind;
}

/** Which rig / animation part a path belongs to (sprites and the player). */
export type ArtPart = 'body' | 'leg' | 'arm' | 'eye' | 'pole' | 'cloth' | 'coil' | 'base' | 'shine' | 'outline';

export interface ArtPath {
  pts: number[]; // flat [x0, y0, x1, y1, ...] in cells
  w?: number[]; // per-point width (px): drawn as a variable-width marker outline
  closed: boolean;
  style: string; // key into ArtDoc.styles
  object_id?: string;
  part?: ArtPart;
  pivot?: [number, number]; // rig pivot (hip / shoulder), same frame as pts
}

export type ArtLayerId =
  | 'paper' | 'far' | 'clouds' | 'mid' | 'underlay' | 'decoration' | 'signs' | 'terrain' | 'entities' | 'player'
  | 'foreground';

export interface ArtLayer {
  id: ArtLayerId | string;
  depth: number; // §7.4 depth table
  scroll: number; // parallax factor (1 = world)
  opacity?: number; // group opacity (decoration 0.55, signs 0.7): composited once, never per stroke
  paths: ArtPath[];
}

/**
 * One gameplay entity's art, in local cells relative to `anchor` (the compiled entity's own x/y at spawn, or
 * ((x0+x1)/2, y) for spikes). The engine bakes it into a texture and places it at the sim's EntityView x/y, so
 * the anchor convention cancels out.
 */
export interface ArtSprite {
  id: string; // entity id
  type: string; // entity type
  source: 'kid' | 'house'; // the kid's strokes, or a house doodle
  designer: boolean; // pencil ink (designer addition): plays the 400 ms stroke reveal
  anchor: [number, number];
  bbox: RectCells; // local, includes stroke widths
  paths: ArtPath[];
  eyes: [number, number][]; // local eye centres (pupils that watch the player)
  object_ids: string[]; // scene objects this sprite draws
}

export interface ArtPlayer {
  source: 'kid' | 'house';
  rig: Rig;
  /** Local cells, feet centre at (0, 0); body fits 32 × 48 world px. Paths are tagged body / leg / arm / eye. */
  paths: ArtPath[];
  bbox: RectCells;
  eyes: [number, number][];
  color: string; // main ink colour (synthesized legs, shards)
}

export interface ArtLava {
  x0: number; // cells
  x1: number;
  y: number; // drawn top of the lava (row top)
}

export interface ArtDoc {
  v: 1;
  level_id: string;
  theme: Theme;
  seed: number;
  world: World;
  boilFrame: 0 | 1 | 2;
  styles: Record<string, ArtStyle>;
  layers: ArtLayer[];
  sprites: ArtSprite[];
  player: ArtPlayer;
  lava: ArtLava[];
  /** Diagnostics for the §7.3 acceptance: walkable samples off by > 1 px, collision tops with no art above. */
  stats: { align_max_px: number; uncovered_tops: number; traced_runs: number; strokes_without_object: number };
}
