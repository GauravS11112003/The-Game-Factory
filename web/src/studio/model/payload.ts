/**
 * Request payloads for the v7 Studio (docs/v7/CONTRACTS_V7.md §5): docs now carry SVG art (a few MB in a big game), so
 * the copilot and recognize get the doc without it, and an art job gets only what it draws from. Pure functions; the
 * input doc is never changed and untouched parts are shared.
 */
import type { SArt, SDoc, SObj, SScene } from './types.ts';

function stripObjects(sc: SScene, keep: (o: SObj) => SObj): SScene {
  let changed = false;
  const objects = sc.objects.map((o) => {
    const n = keep(o);
    if (n !== o) changed = true;
    return n;
  });
  return changed ? { ...sc, objects } : sc;
}

function noArt(o: SObj): SObj {
  if (o.art === undefined) return o;
  const { art: _art, ...rest } = o;
  return rest;
}

/** Only which look plays (no SVGs): what the server needs to know about objects it is not drawing. */
function lightArt(o: SObj): SObj {
  if (!o.art) return o;
  if (!o.art.variants.length && !o.art.terrain) return o;
  const art: SArt = { use: o.art.use, chosen: null, variants: [], terrain: null, asked: o.art.asked };
  return { ...o, art };
}

/** The doc for /studio/chat and /studio/recognize: no `art`, no `backdrop`, no `art_direction.guide`. */
export function slimDoc(doc: SDoc): SDoc {
  const out: SDoc = { ...doc, scenes: doc.scenes.map((sc) => stripObjects(sc, noArt)) };
  delete out.backdrop;
  if (doc.art_direction) {
    const { guide: _guide, ...rest } = doc.art_direction;
    out.art_direction = rest;
  }
  return out;
}

/**
 * The doc for an art job: the art direction in full (the server draws from it), the target objects with their art,
 * every other object without its variants or skin, and no backdrop.
 */
export function jobDoc(doc: SDoc, targets: Iterable<string>): SDoc {
  const keep = new Set(targets);
  const out: SDoc = { ...doc, scenes: doc.scenes.map((sc) => stripObjects(sc, (o) => (keep.has(o.id) ? o : lightArt(o)))) };
  delete out.backdrop;
  return out;
}

/** The doc's JSON size in characters (for the "is this request small?" checks). */
export function docChars(doc: unknown): number {
  try {
    return JSON.stringify(doc).length;
  } catch {
    return 0;
  }
}
