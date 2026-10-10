/**
 * Sites for designer moves: the bot's slots (re-keyed into self-describing ids) plus geometric sites the core
 * derives from the fitted terrain (flat runs, gaps between floors, undrawn faces, jump arcs from the route).
 * Every placement still passes the op's own bounds and the bot's verification before it reaches the menu.
 */
import type { CellXY, PlaytestReport, RouteKind, SceneObject } from '../types.gen.ts';
import { compileWork } from '../build/compile.ts';
import { surfaceYAt } from '../build/fit.ts';
import { fromBotSlot, slotId } from '../edits/slots.ts';
import type { SlotKind, SlotSpec } from '../edits/slots.ts';
import { isDynamic, isFloor, isKid, objBBox } from '../edits/work.ts';
import type { Work } from '../edits/work.ts';
import { rectGap } from '../util/geom.ts';

export interface Flat {
  host: string;
  x0: number;
  x1: number;
  y: number;
  threat: boolean;
  kidFace: boolean; // kid ink sits on this face (not undrawn)
}

export interface GapSite {
  a: string;
  b: string;
  gap: number;
  runway: number;
  x0: number; // right end of a
  x1: number; // left end of b
  ya: number;
  yb: number;
}

export interface JumpSite {
  i: number;
  kind: RouteKind;
  from: CellXY;
  to: CellXY;
  w_f: number;
  blind: boolean;
  segment: string;
  setpiece: string | null;
}

export interface Sites {
  slots: Record<SlotKind, SlotSpec[]>;
  flats: Flat[];
  gaps: GapSite[];
  jumps: JumpSite[];
  botSlotIds: Map<string, string>; // canonical id → bot id
}

const HAZ = new Set(['spikes', 'lava', 'saw', 'enemy']);

function flatsOf(w: Work): Flat[] {
  const g = compileWork(w).grid;
  const out: Flat[] = [];
  for (const o of w.objs) {
    if (!isFloor(o) || o.shape.k !== 'surface' || isDynamic(o)) continue;
    for (const s of o.shape.segs) {
      if (s.slope !== 0) continue;
      const y = s.a[1];
      let c = Math.round(s.a[0]);
      const end = Math.round(s.b[0]);
      while (c < end) {
        while (c < end && !g.standable(c, y)) c++;
        const x0 = c;
        while (c < end && g.standable(c, y)) c++;
        if (c - x0 >= 2) out.push({ host: o.id, x0, x1: c, y, threat: false, kidFace: false });
      }
    }
  }
  for (const f of out) {
    const r: [number, number, number, number] = [f.x0, f.y - 3, f.x1, f.y];
    f.threat = w.objs.some((o) => HAZ.has(o.role) && !o.rel.part_of && rectGap(objBBox(o), r) < 0.5);
    f.kidFace = w.objs.some((o) => isKid(o) && !o.rel.part_of && !isFloor(o) && o.shape.k !== 'wall' && o.collision !== 'none' && rectGap(objBBox(o), [f.x0, f.y - 1, f.x1, f.y]) < 1);
  }
  return out.sort((a, b) => a.x0 - b.x0 || a.y - b.y);
}

function gapsOf(w: Work, flats: Flat[]): GapSite[] {
  const floors = w.objs.filter((o) => isFloor(o) && o.shape.k === 'surface' && !isDynamic(o));
  const ends = floors.map((o) => {
    const b = objBBox(o);
    const yl = o.shape.k === 'surface' ? surfaceYAt(o.shape.segs, b[0] + 0.01) : null;
    const yr = o.shape.k === 'surface' ? surfaceYAt(o.shape.segs, b[2] - 0.01) : null;
    return { o, x0: b[0], x1: b[2], yl: yl ?? b[1], yr: yr ?? b[1] };
  });
  const out: GapSite[] = [];
  for (const A of ends) {
    // the nearest floor to the right whose left end is beyond A's right end, within reach of a jump
    let best: (typeof ends)[number] | null = null;
    for (const B of ends) {
      if (B === A || B.x0 <= A.x1 + 0.5 || B.x0 - A.x1 > 12 || Math.abs(B.yl - A.yr) > 5) continue;
      if (!best || B.x0 < best.x0) best = B;
    }
    if (!best) continue;
    // nothing standing in the gap at a similar height
    const blocked = ends.some((C) => C !== A && C !== best && C.x0 < best!.x0 && C.x1 > A.x1 && Math.abs(C.yl - A.yr) <= 3);
    if (blocked) continue;
    const f = flats.find((x) => x.host === A.o.id && Math.abs(x.x1 - A.x1) <= 0.5);
    out.push({ a: A.o.id, b: best.o.id, gap: best.x0 - A.x1, runway: f ? f.x1 - f.x0 : 0, x0: A.x1, x1: best.x0, ya: A.yr, yb: best.yl });
  }
  return out;
}

function spec(kind: SlotKind, x: number, y: number, extra: Partial<SlotSpec> = {}): SlotSpec {
  return { kind, x, y, host: null, face: null, x0: null, x1: null, w: null, ...extra };
}

export function gatherSites(w: Work, report: PlaytestReport | null): Sites {
  const slots: Record<SlotKind, SlotSpec[]> = { cp: [], coin: [], risk: [], enemy: [], hazard: [], spikes: [], step: [], spring: [], hint: [] };
  const botSlotIds = new Map<string, string>();
  const add = (s: SlotSpec, bot?: string): void => {
    const id = slotId(s);
    if (slots[s.kind].some((x) => slotId(x) === id)) return;
    slots[s.kind].push(s);
    if (bot) botSlotIds.set(id, bot);
  };
  if (report?.slots) {
    for (const [list, arr] of Object.entries(report.slots)) for (const s of arr ?? []) add(fromBotSlot(list, s), s.id);
  }
  const flats = flatsOf(w);
  for (const f of flats) {
    const len = f.x1 - f.x0;
    const host = f.host;
    if (len >= 3) {
      add(spec('cp', f.x0 + 1.5, f.y, { host, face: 'top' }));
      if (len >= 8) add(spec('cp', Math.floor((f.x0 + f.x1) / 2) + 0.5, f.y, { host, face: 'top' }));
    }
    for (let x = f.x0 + 1.5; x < f.x1 - 0.5; x += 3) add(spec('coin', x, f.y - 1.5, { host }));
    if (f.y <= 16 && len >= 2) add(spec('risk', (f.x0 + f.x1) / 2, f.y - 2.5, { host }));
    if (len >= 6) add(spec('enemy', (f.x0 + f.x1) / 2, f.y, { host, face: 'top', x0: f.x0, x1: f.x1, w: len }));
    if (!f.kidFace && len >= 5) add(spec('spikes', f.x0 + 2, f.y, { host, face: 'top', x0: f.x0 + 2, x1: Math.min(f.x1, f.x0 + 5) }));
    if (!f.kidFace && len >= 8) add(spec('spikes', (f.x0 + f.x1) / 2, f.y, { host, face: 'top', x0: Math.floor((f.x0 + f.x1) / 2) - 1, x1: Math.floor((f.x0 + f.x1) / 2) + 1 }));
    if (len >= 6) add(spec('hazard', (f.x0 + f.x1) / 2, f.y - 1, { host, w: 0 }));
    add(spec('hint', f.x1 - 1, f.y - 2, { host }));
  }
  const gaps = gapsOf(w, flats);
  for (const g of gaps) {
    const mid = (g.x0 + g.x1) / 2;
    const top = Math.min(g.ya, g.yb);
    add(spec('step', mid, Math.round((g.ya + g.yb) / 2), { w: 2 }));
    if (g.gap >= 3) add(spec('hazard', mid, top - 3, { w: 3 }));
    add(spec('risk', mid, top - 4.5));
  }
  const jumps: JumpSite[] = (report?.route ?? [])
    .filter((s) => s.kind === 'jump' || s.kind === 'runjump' || s.kind === 'drop')
    .map((s) => ({ i: s.i, kind: s.kind, from: s.from, to: s.to, w_f: s.w_f, blind: s.blind, segment: s.segment, setpiece: s.setpiece }));
  return { slots, flats, gaps, jumps, botSlotIds };
}

/** Kid objects near a point (for "undrawn" checks and setpiece matching). */
export function kidNear(w: Work, x: number, y: number, d: number): SceneObject[] {
  return w.objs.filter((o) => isKid(o) && rectGap(objBBox(o), [x, y, x, y]) <= d);
}
