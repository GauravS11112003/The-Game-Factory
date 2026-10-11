/**
 * Lane E core API (PLAN_V2 §7, §11.3b): ArtDoc builder, SVG serializer and rig extraction. Pure, deterministic,
 * DOM-free; the Canvas2D renderer (web/src/render/) and the engine (web/src/engine/) draw what this produces.
 */
export { buildArt, characterOf } from './artdoc.ts';
export type { BuildArtOptions } from './artdoc.ts';
export { artToSvg } from './svg.ts';
export type { SvgOptions } from './svg.ts';
export { extractRig } from './rig.ts';
export { buildPlayerArt, houseCharacter } from './player.ts';
export { cleanStroke } from './clean.ts';
export { strokePolygons, pathBoxPx, PAPER_THEMES } from './outline.ts';
export { StyleBook, baseStyles, inkHex, INK } from './styles.ts';
export { decodeGrid } from './terrain.ts';
export { pickupShape, PORTAL_COLORS, portalColors, ZONE_LOOK } from './v4art.ts';
export type { PickupShape } from './v4art.ts';
export { layerWidth } from './parallax.ts';
export { voronoiCells, hash32, rng } from './geom.ts';
export { RigAnimator, shearAt } from './anim.ts';
export type { RigAnimOptions, RigInput, RigPose, RigState } from './anim.ts';
export { bestView, sampleLevel, SAMPLE_VIEW, standPoint, standY, viewHasStart } from './frame.ts';
export type { ViewOptions } from './frame.ts';
export type { PlayerArtOptions } from './player.ts';
export {
  fitRects, hideSkinned, joinNames, normalizeSkin, objectArtBox, placementWorldBox, resolveSkin, sameExceptSkin, shapeBox,
  SKIN_PARALLAX, skinCredits, skinOf, skinSignature, skinTargetOf, withSkin,
} from './skin.ts';
export type { LevelSkin, SkinCredits, SkinEntry, SkinFit, SkinPlacement, SkinSpec, SkinTarget } from './skin.ts';
