/**
 * Themes for the Studio (docs/v6/CONTRACTS_V6.md §4.3). One import point for lane E:
 *   renderDrawing, drawingCanvasOrigin, drawingExtent, clearRenderCache      (render.ts: strokes under a theme)
 *   renderBackground, backgroundLayers, layerPlacement                        (background.ts: the 14 backgrounds)
 *   fullTheme, buildRecolorMap, docDrawings, fontStack, contrast, mix, hexNum (color.ts: theme defaults and colours)
 *   THEMES, DEFAULT_THEME, themePreset                                        (presets.ts: shared/studio/themes.json)
 */
export { renderDrawing, drawingCanvasOrigin, drawingExtent, clearRenderCache, wobblePoints, type RenderOpts } from './render.ts';
export { renderBackground, backgroundLayers, layerPlacement, REF_W, REF_H, type BgLayer, type CameraView } from './background.ts';
export { fullTheme, buildRecolorMap, docDrawings, fontStack, contrast, luminance, mix, rgba, hexNum, parseHex, fillFor,
  strokePalette, type FullTheme } from './color.ts';
export { THEMES, DEFAULT_THEME, themePreset } from './presets.ts';
// v7: the finished look (AI art, terrain, backdrop) shared by the runtime and the Studio canvas — see art.ts header
export { objectLook, chosenVariant, isTerrainObject, objectBitmap, renderTerrain, terrainSkinFor, renderBackdrop, renderLookBackground,
  hasBackdrop, artImage, artImageSync, artCanvas, artCanvasSync, onArtReady, preloadArt, docArtSvgs, artBox, inkCenter, paintTerrain,
  terrainModel, skyCanvas, type Look, type LookObj, type LookDoc, type LookBitmap, type TerrainModel, type ResolvedSkin } from './art.ts';
export { backdropPlacement, svgSize, type BackdropPlace } from './backdrop.ts';
export { defaultSkin, resolveSkin, buildTerrain, decorSpots } from './terrain.ts';
