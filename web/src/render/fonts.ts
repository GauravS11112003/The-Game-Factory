/**
 * The hand-drawn type (PLAN_V2 §7.1): "Patrick Hand" (OFL), bundled as TrueType in web/public/fonts/ so it works offline,
 * used for the HUD, the share cards and the theme swatches. Until the file is there (or if it fails to load) the
 * stack falls back to the system's hand-style fonts.
 */
export const HAND_FONT = '"Patrick Hand", "Comic Sans MS", "Chalkboard SE", "Marker Felt", "Segoe Print", system-ui, sans-serif';

let fontPromise: Promise<boolean> | null = null;

/** Load the bundled font once (resolves false when it is missing; text still renders in the fallback). */
export function loadHandFont(): Promise<boolean> {
  if (fontPromise) return fontPromise;
  fontPromise = (async () => {
    try {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false;
      for (const f of document.fonts) if (f.family.replace(/"/g, '') === 'Patrick Hand' && f.status === 'loaded') return true;
      const ff = new FontFace('Patrick Hand', 'url(/fonts/PatrickHand-Regular.ttf) format("truetype")', { display: 'swap' });
      await ff.load();
      document.fonts.add(ff);
      return true;
    } catch {
      return false;
    }
  })();
  return fontPromise;
}
