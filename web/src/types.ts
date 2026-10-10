/**
 * TypeScript mirror of shared/level.schema.json and vision/app/models.py (PLAN.md section 3).
 * Same field names, snake_case. All coordinates are grid cells, origin top-left,
 * x right, y down. bbox is [x0, y0, x1, y1] inclusive.
 */

export type Color = 'black' | 'red' | 'green' | 'blue';

export type EntityType =
  | 'player_start'
  | 'goal'
  | 'coin'
  | 'moving_platform'
  | 'enemy'
  | 'bounce_pad'
  | 'key'
  | 'door'
  | 'checkpoint';

export type SourceKind = 'paper' | 'canvas' | 'fixture';

/** [x0, y0, x1, y1] inclusive grid cells. */
export type BBox = [number, number, number, number];
/** [x, y] grid cell. */
export type Cell = [number, number];

export interface Component {
  id: number;
  color: Color;
  bbox: BBox;
  area_cells: number;
}

export interface Patrol {
  /** cells walked to the right of the start before turning */
  dx: number;
  /** cells per second */
  speed: number;
}

export interface Entity {
  id: string;
  type: EntityType;
  x?: number | null;
  y?: number | null;
  component_id?: number | null;
  bbox?: BBox | null;
  /** Crop of the component from the drawing (RGBA PNG); null means the engine draws a placeholder. */
  image_url?: string | null;
  /** moving_platform: bbox top-left positions to ping-pong between. */
  path?: Cell[] | null;
  /** cells per second */
  speed?: number | null;
  patrol?: Patrol | null;
  /** bounce_pad multiplier of BOUNCE_VY */
  strength?: number | null;
  /** key: id of the door it opens */
  opens?: string | null;
}

export interface Rule {
  /** collect:<entity id> | touch:<entity id> | timer:<seconds> */
  when: string;
  /** open:<entity id> | win | lose */
  then: string;
}

export interface Grid {
  w: number;
  h: number;
  cell: number;
  /** 27 strings of 48 chars: 0 empty, 1 solid, 2 hazard. Row 0 is the top. */
  rows: string[];
}

export interface Source {
  kind: SourceKind;
  photo_url?: string | null;
  /** 768x432 PNG; null means the engine draws a plain background. */
  backdrop_url?: string | null;
  template_version?: number;
}

export interface Sprites {
  /** URL of the drawn character PNG (32x48 RGBA); null means the default doodle. */
  player?: string | null;
}

export interface Meta {
  solvable?: boolean | null;
  warnings?: string[];
  notes_transcript?: string;
}

export interface Level {
  schema_version?: number;
  id: string;
  game_id?: string | null;
  parent_id?: string | null;
  order_index?: number;
  title: string;
  author: string;
  created_at: string;
  source: Source;
  grid: Grid;
  sprites: Sprites;
  components: Component[];
  entities: Entity[];
  rules: Rule[];
  meta: Meta;
}

export const TILE_EMPTY = '0';
export const TILE_SOLID = '1';
export const TILE_HAZARD = '2';
