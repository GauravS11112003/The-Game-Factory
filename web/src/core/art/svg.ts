/**
 * ArtDoc → SVG (PLAN_V2 §7.4) for golden baselines, the spec's reference images and the worker's `art_svg`.
 * Same geometry as the Canvas2D renderer (outline.ts). Deterministic: numbers are printed with ≤ 2 decimals.
 */
import type { RectCells } from '../types.gen.ts';
import { ART } from '../params.ts';
import { CELL } from './geom.ts';
import { PAPER_THEMES, pathBoxPx, strokePolygons } from './outline.ts';
import type { ArtDoc, ArtPath, ArtStyle } from './types.ts';

const f = (x: number): string => {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

function polyD(polys: number[][]): string {
  let d = '';
  for (const p of polys) {
    if (p.length < 6) continue;
    d += `M${f(p[0])} ${f(p[1])}`;
    for (let i = 2; i + 1 < p.length; i += 2) d += `L${f(p[i])} ${f(p[i + 1])}`;
    d += 'Z';
  }
  return d;
}

function lineD(pts: number[], closed: boolean): string {
  let d = '';
  for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${f(pts[i] * CELL)} ${f(pts[i + 1] * CELL)}`;
  return closed ? d + 'Z' : d;
}

function hatchId(key: string): string {
  return 'h_' + key.replace(/[^A-Za-z0-9]/g, '_');
}

function pathSvg(p: ArtPath, s: ArtStyle, key: string): string {
  const op = s.opacity ?? 1;
  let out = '';
  const n = p.pts.length / 2;
  if (s.fill && p.closed && n >= 3) {
    out += `<path d="${lineD(p.pts, true)}" fill="${esc(s.fill)}" fill-opacity="${f((s.fill_opacity ?? 1) * op)}"/>`;
  }
  if (s.hatch && p.closed && n >= 3) out += `<path d="${lineD(p.pts, true)}" fill="url(#${hatchId(key)})"/>`;
  if (s.stroke) {
    if (p.w && p.w.length) {
      out += `<path d="${polyD(strokePolygons(p.pts, p.w, p.closed))}" fill="${esc(s.stroke)}" fill-opacity="${f(op)}"/>`;
    } else if (n === 1) {
      out += `<circle cx="${f(p.pts[0] * CELL)}" cy="${f(p.pts[1] * CELL)}" r="${f((s.width ?? 2) / 2)}" fill="${esc(s.stroke)}" fill-opacity="${f(op)}"/>`;
    } else {
      const dash = s.dash ? ` stroke-dasharray="${s.dash.map(f).join(' ')}"` : '';
      out += `<path d="${lineD(p.pts, p.closed)}" fill="none" stroke="${esc(s.stroke)}" stroke-opacity="${f(op)}" stroke-width="${f(s.width ?? 2)}" stroke-linecap="${s.cap ?? 'round'}" stroke-linejoin="round"${dash}/>`;
    }
  }
  return out;
}

function paperSvg(doc: ArtDoc, X0: number, Y0: number, W: number, H: number): { defs: string; body: string } {
  const t = PAPER_THEMES[doc.theme] ?? PAPER_THEMES.sketchbook;
  let defs = '';
  let body = `<rect x="${f(X0)}" y="${f(Y0)}" width="${f(W)}" height="${f(H)}" fill="${t.base}"/>`;
  const g = ART.themes.sketchbook.grid_px;
  if (doc.theme === 'sketchbook') {
    defs += `<pattern id="paper" patternUnits="userSpaceOnUse" width="${g}" height="${g}"><circle cx="0" cy="0" r="0.9" fill="${PAPER_THEMES.sketchbook.dot}"/><circle cx="${g}" cy="0" r="0.9" fill="${PAPER_THEMES.sketchbook.dot}"/><circle cx="0" cy="${g}" r="0.9" fill="${PAPER_THEMES.sketchbook.dot}"/><circle cx="${g}" cy="${g}" r="0.9" fill="${PAPER_THEMES.sketchbook.dot}"/></pattern>`;
    body += `<rect x="${f(X0)}" y="${f(Y0)}" width="${f(W)}" height="${f(H)}" fill="url(#paper)"/>`;
  } else if (doc.theme === 'notebook') {
    const rp = ART.themes.notebook.rule_px;
    defs += `<pattern id="paper" patternUnits="userSpaceOnUse" width="${rp}" height="${rp}"><line x1="0" y1="${rp - 0.5}" x2="${rp}" y2="${rp - 0.5}" stroke="${PAPER_THEMES.notebook.rule}" stroke-width="1"/></pattern>`;
    body += `<rect x="${f(X0)}" y="${f(Y0)}" width="${f(W)}" height="${f(H)}" fill="url(#paper)"/>`;
    body += `<line x1="40" y1="${f(Y0)}" x2="40" y2="${f(Y0 + H)}" stroke="${PAPER_THEMES.notebook.margin}" stroke-width="1.5"/>`;
  } else if (doc.theme === 'graph') {
    defs += `<pattern id="paper" patternUnits="userSpaceOnUse" width="${g}" height="${g}"><path d="M${g} 0L0 0L0 ${g}" fill="none" stroke="${PAPER_THEMES.graph.grid}" stroke-width="0.8"/></pattern>`;
    body += `<rect x="${f(X0)}" y="${f(Y0)}" width="${f(W)}" height="${f(H)}" fill="url(#paper)"/>`;
  } else {
    defs += `<pattern id="paper" patternUnits="userSpaceOnUse" width="64" height="64"><path d="M3 9l11 2M30 4l9 3M50 20l10-2M8 40l12 1M33 33l8 4M47 52l12 2M18 58l9-3" stroke="${PAPER_THEMES.kraft.fibre}" stroke-width="0.8" fill="none"/></pattern>`;
    body += `<rect x="${f(X0)}" y="${f(Y0)}" width="${f(W)}" height="${f(H)}" fill="url(#paper)"/>`;
  }
  defs += `<radialGradient id="vignette" cx="50%" cy="50%" r="75%"><stop offset="60%" stop-color="#3C2814" stop-opacity="0"/><stop offset="100%" stop-color="#3C2814" stop-opacity="${ART.paper_grain.vignette}"/></radialGradient>`;
  return { defs, body };
}

export interface SvgOptions {
  scale?: number;
  paper?: boolean;
  layers?: string[]; // default: every layer
}

export function artToSvg(doc: ArtDoc, view: RectCells, o: SvgOptions = {}): string {
  const scale = o.scale ?? 1;
  const X0 = view[0] * CELL;
  const Y0 = view[1] * CELL;
  const W = (view[2] - view[0]) * CELL;
  const H = (view[3] - view[1]) * CELL;
  let defs = '';
  let body = '';
  const hatched = new Set<string>();
  if (o.paper !== false) {
    const p = paperSvg(doc, X0, Y0, W, H);
    defs += p.defs;
    body += p.body;
  }
  const layers = [...doc.layers].filter((l) => l.id !== 'paper' && (!o.layers || o.layers.includes(String(l.id)))).sort((a, b) => a.depth - b.depth);
  for (const l of layers) {
    const dx = (1 - l.scroll) * X0; // a layer with scroll f is drawn at x − f·camX; in world units that is x + (1 − f)·camX
    let inner = '';
    for (const p of l.paths) {
      const s = doc.styles[p.style];
      if (!s) continue;
      const b = pathBoxPx(p, s);
      if (b[2] + dx < X0 || b[0] + dx > X0 + W || b[3] < Y0 || b[1] > Y0 + H) continue;
      if (s.hatch && !hatched.has(p.style)) {
        hatched.add(p.style);
        const h = s.hatch;
        const color = h.color ?? s.stroke ?? '#1F1B18';
        defs += `<pattern id="${hatchId(p.style)}" patternUnits="userSpaceOnUse" width="${f(h.spacing_px)}" height="${f(h.spacing_px)}" patternTransform="rotate(${f(h.angle_deg)})"><line x1="0" y1="0" x2="0" y2="${f(h.spacing_px)}" stroke="${esc(color)}" stroke-opacity="${f(h.alpha * (s.opacity ?? 1))}" stroke-width="${f(h.width_px)}"/></pattern>`;
      }
      inner += pathSvg(p, s, p.style);
    }
    if (!inner) continue;
    const attrs = [`data-layer="${esc(String(l.id))}"`];
    if (dx) attrs.push(`transform="translate(${f(dx)} 0)"`);
    if (l.opacity !== undefined && l.opacity < 1) attrs.push(`opacity="${f(l.opacity)}"`);
    body += `<g ${attrs.join(' ')}>${inner}</g>`;
  }
  if (o.paper !== false) body += `<rect x="${f(X0)}" y="${f(Y0)}" width="${f(W)}" height="${f(H)}" fill="url(#vignette)"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(W * scale)}" height="${f(H * scale)}" viewBox="${f(X0)} ${f(Y0)} ${f(W)} ${f(H)}">` +
    (defs ? `<defs>${defs}</defs>` : '') +
    body +
    '</svg>'
  );
}
