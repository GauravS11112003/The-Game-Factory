/**
 * Render API (lane E, PLAN_V2 §7.4, §11.3g): Canvas2D ink renderer, paper themes, InkBoilFX and thumbnails.
 * drawInk(ctx, doc, view) fills the canvas with the view rect (cells) of an ArtDoc.
 */
export { bakePaths, drawInk, drawLayer, drawPath, drawPaths, rasterizeChunk } from './canvas_ink.ts';
export type { DrawInkOptions, DrawOpts } from './canvas_ink.ts';
export { paintPaper, paintVignette, paperBase, paperTile, vignetteCanvas } from './paper.ts';
export { artFor, drawLevelArt, renderThumbnail, skinnedArt, thumbnailURL } from './thumbnail.ts';
export { composeSkin, drawBackdrop, drawSkinFitted, loadSkinImage, peekSkinImage, skinImagesReady } from './skin.ts';
export type { SkinImage, SkinImageKind } from './skin.ts';
export { shareCardCanvas, shareCardFile, shareCardPNG } from './sharecard.ts';
export type { ShareCardOptions, ShareCardRun } from './sharecard.ts';
export { auditionTheme, renderThemeSwatch, resolveTheme, themeCatalog, themeInfo, themeSwatch, THEME_IDS } from './themes.ts';
export type { ThemeInfo } from './themes.ts';
export { HAND_FONT, loadHandFont } from './fonts.ts';
export { fmtClock, msg } from './text.ts';
export { drawCharacter, hasSwingParts, RigPreview, stillPose } from './rig2d.ts';
export { loadImage, pencilize } from './pencilize.ts';
export type { PencilSprite } from './pencilize.ts';
