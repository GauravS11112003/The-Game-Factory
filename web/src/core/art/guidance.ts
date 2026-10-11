import type { GameGuidance, World } from '../types.gen.ts';
import type { ArtPath, ArtPlayer, ArtSprite } from './types.ts';
import type { Grid } from './terrain.ts';
import { isFloor } from './terrain.ts';
import type { ParallaxOut } from './parallax.ts';
import { layerWidth } from './parallax.ts';
import { StyleBook } from './styles.ts';
import { circlePts } from './geom.ts';

const path = (pts: number[], style: string, closed = true): ArtPath => ({ pts, style, closed });
const box = (x: number, y: number, w: number, h: number, style: string): ArtPath =>
  path([x, y, x + w, y, x + w, y + h, x, y + h], style);

/** Theme scenery and house sprites share the same display list in play, previews and exports. */
export function guidanceArt(guidance: GameGuidance | null | undefined, b: StyleBook, world: World,
  grid: Grid, terrain: ArtPath[], sprites: ArtSprite[], player: ArtPlayer, generatedObjects: ReadonlySet<string>): ParallaxOut | null {
  if (!guidance || guidance.scene === 'custom') return null;
  const valid = (value: string, fallback: string): string => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  const [sky, scenery, earth, accent] = guidance.palette.map((color) => valid(color, '#c6bfda'));
  b.styles.guidance_sky = { fill: sky, ink: 'marker' };
  b.styles.guidance_scenery = { fill: scenery, fill_opacity: 0.6, ink: 'marker' };
  b.styles.guidance_accent = { fill: accent, stroke: accent, width: 1, ink: 'marker' };
  b.styles.guidance_light = { fill: '#fff4bd', fill_opacity: 0.85, ink: 'marker' };
  b.styles.guidance_outline = { stroke: accent, width: 1, opacity: 0.4, ink: 'marker' };
  b.styles.ground_tint = { ...b.styles.ground_tint, fill: earth, fill_opacity: 0.55 };
  for (const style of Object.values(b.styles)) if (style.ink === 'blue_line') {
    if (style.stroke) style.stroke = accent;
    if (style.fill) style.fill = accent;
  }
  const far: ArtPath[] = [box(-2, 0, layerWidth(world.w, 0.2) + 4, world.h ?? 27, 'guidance_sky')];
  const mid: ArtPath[] = [];
  const width = layerWidth(world.w, 0.5);
  for (let x = -2, i = 0; x < width; x += 9, i++) {
    const y = 11 + (i % 3);
    switch (guidance.scene) {
      case 'castle':
        mid.push(box(x, y, 5, 16, 'guidance_scenery'),
          path([x - 1, y, x + 2.5, y - 4, x + 6, y], 'guidance_scenery'));
        for (let row = 0; row < 3; row++) mid.push(box(x + 1.8, y + 1.5 + row * 3.5, 1, 1.6, 'guidance_light'));
        break;
      case 'haunted':
        mid.push(path([x + 3, 27, x + 2, 17, x, 13, x + 1, 12, x + 3, 16, x + 4, 9,
          x + 5, 9, x + 4.5, 15, x + 7, 12, x + 8, 13, x + 4, 18, x + 5, 27], 'guidance_scenery'));
        break;
      case 'blocks':
        mid.push(box(x + 3, 13, 1.2, 14, 'guidance_scenery'), box(x + 1, 10, 5, 4, 'guidance_scenery'),
          box(x + 2, 8, 3, 3, 'guidance_scenery'));
        break;
      case 'mountain':
        mid.push(path([x - 4, 27, x + 3, 6 + i % 4, x + 11, 27], 'guidance_scenery'),
          path([x + 1, 12 + i % 4, x + 3, 6 + i % 4, x + 5, 12 + i % 4, x + 3, 11 + i % 4], 'guidance_light'));
        break;
      case 'cavern':
        mid.push(path([x, 0, x + 3, 8 + i % 4, x + 5, 0], 'guidance_scenery'),
          box(x + 2.7, 19, 0.6, 8, 'guidance_scenery'), path(circlePts(x + 3, 19, 1.4, 12), 'guidance_light'));
        break;
      case 'meadow':
        mid.push(path([x - 3, 27, x, 18, x + 3, 15, x + 6, 18, x + 10, 27], 'guidance_scenery'),
          box(x + 4.7, 21, 0.6, 6, 'guidance_scenery'), path(circlePts(x + 5, 21, 1.4, 12), 'guidance_light'));
        break;
    }
  }
  if (guidance.scene === 'castle' || guidance.scene === 'haunted') {
    far.push(path(circlePts(34, 6, 2.5, 24), 'guidance_light'));
    for (let i = 0; i < 14; i++) far.push(path(circlePts(i * 3.7, 2 + (i * 7 % 9), 0.08, 6), 'guidance_light'));
  }
  if (guidance.scene === 'blocks') {
    for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) {
      if (!isFloor(grid.rows[y][x]) || (y > 0 && isFloor(grid.rows[y - 1][x]))) continue;
      terrain.push(box(x, y + 0.15, 1, 0.3, 'guidance_accent'), box(x, y + 0.5, 1, 0.8, 'guidance_outline'));
    }
  }
  for (const sprite of sprites) {
    if (sprite.source !== 'house' && !sprite.object_ids.every((id) => generatedObjects.has(id))) continue;
    if (sprite.type === 'coin' && guidance.scene === 'castle') {
      const star = Array.from({ length: 10 }, (_, i) => {
        const angle = i * Math.PI / 5 - Math.PI / 2, radius = i % 2 ? 0.16 : 0.38;
        return [Math.cos(angle) * radius, Math.sin(angle) * radius];
      }).flat();
      sprite.paths = [path(star, 'guidance_light')];
    }
    if (sprite.type === 'coin' && (guidance.scene === 'blocks' || guidance.scene === 'mountain')) {
      sprite.paths = [path([0, -0.4, 0.3, 0, 0, 0.4, -0.3, 0], 'guidance_accent'),
        path([0, -0.25, 0.13, 0, 0, 0.1], 'guidance_light')];
    }
    if (sprite.type === 'enemy' && guidance.scene === 'haunted') {
      sprite.paths = [path([-0.45, 0, -0.45, -0.7, -0.3, -1, 0, -1.1, 0.3, -1, 0.45, -0.7,
        0.45, 0, 0.23, -0.15, 0, 0, -0.23, -0.15], 'guidance_light'),
        path(circlePts(-0.16, -0.65, 0.07, 8), 'guidance_accent'),
        path(circlePts(0.16, -0.65, 0.07, 8), 'guidance_accent')];
      sprite.eyes = [[-0.16, -0.65], [0.16, -0.65]];
      sprite.bbox = [-0.5, -1.15, 0.5, 0.05];
    }
  }
  if (player.source === 'house' && guidance.scene === 'castle') {
    const brim = player.bbox[1] + 0.25, tip = brim - 0.8;
    player.paths.push({ ...path([-0.6, brim, 0, tip, 0.6, brim], 'guidance_accent'), part: 'body' });
    player.bbox = [Math.min(player.bbox[0], -0.6), Math.min(player.bbox[1], tip), Math.max(player.bbox[2], 0.6), player.bbox[3]];
  }
  return { far, mid, clouds: [], fg: [] };
}
