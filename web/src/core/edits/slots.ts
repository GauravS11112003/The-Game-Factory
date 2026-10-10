/**
 * Self-describing slot, arc and gap ids. Added content goes only into slots (§3.5); the bot's report lists them
 * (`slots.checkpoint[...]`, `slot.cp.3`). Because build() is a pure function of the edit records, a slot id must
 * resolve without the report that produced it, so the core re-keys every bot slot into a canonical id that
 * carries its own geometry (docs/v2/CONTRACTS.md §3.10):
 *
 *   slot.<kind>.x<X>-y<Y>[-h<host>][-f<face>][-a<x0>-b<x1>][-w<w>]      kind ∈ cp coin risk enemy hazard spikes step spring hint
 *   arc.<fx>-<fy>-<tx>-<ty>-<h>                                          a route jump: takeoff, landing (feet), apex height
 *   gap.<left surface id>-<right surface id>
 *
 * Numbers are cells with ≤ 2 decimals. Ids stay valid edit-id targets ([A-Za-z0-9_.-]).
 */
import type { Face, Slot } from '../types.gen.ts';
import { fmt } from '../util/geom.ts';

export type SlotKind = 'cp' | 'coin' | 'risk' | 'enemy' | 'hazard' | 'spikes' | 'step' | 'spring' | 'hint';

export interface SlotSpec {
  kind: SlotKind;
  x: number;
  y: number;
  host: string | null;
  face: Face | null;
  x0: number | null;
  x1: number | null;
  w: number | null;
}

const FACES: readonly Face[] = ['top', 'bottom', 'left', 'right'];

export function slotId(s: SlotSpec): string {
  let id = `slot.${s.kind}.x${fmt(s.x)}-y${fmt(s.y)}`;
  if (s.host) id += `-h${s.host}`;
  if (s.face) id += `-f${s.face}`;
  if (s.x0 !== null && s.x1 !== null) id += `-a${fmt(s.x0)}-b${fmt(s.x1)}`;
  if (s.w !== null) id += `-w${fmt(s.w)}`;
  return id;
}

export function parseSlot(id: string): SlotSpec | null {
  const m = /^slot\.([a-z]+)\.(.+)$/.exec(id);
  if (!m) return null;
  const kind = m[1] as SlotKind;
  if (!['cp', 'coin', 'risk', 'enemy', 'hazard', 'spikes', 'step', 'spring', 'hint'].includes(kind)) return null;
  const out: SlotSpec = { kind, x: NaN, y: NaN, host: null, face: null, x0: null, x1: null, w: null };
  for (const f of m[2].split('-')) {
    const tag = f[0];
    const v = f.slice(1);
    const num = Number(v);
    switch (tag) {
      case 'x':
        out.x = num;
        break;
      case 'y':
        out.y = num;
        break;
      case 'h':
        out.host = v || null;
        break;
      case 'f':
        out.face = (FACES as readonly string[]).includes(v) ? (v as Face) : null;
        break;
      case 'a':
        out.x0 = num;
        break;
      case 'b':
        out.x1 = num;
        break;
      case 'w':
        out.w = num;
        break;
      default:
        return null;
    }
  }
  if (!Number.isFinite(out.x) || !Number.isFinite(out.y)) return null;
  return out;
}

const KIND_OF: Record<string, SlotKind> = {
  checkpoint: 'cp', coin: 'coin', risk: 'risk', enemy: 'enemy', hazard: 'hazard', spikes: 'spikes', step: 'step', spring: 'spring', hint: 'hint',
};

/** Re-key a bot slot (report.slots[list][i]) into a canonical self-describing slot id. */
export function fromBotSlot(list: string, s: Slot): SlotSpec {
  return {
    kind: KIND_OF[list] ?? 'coin', x: s.x, y: s.y, host: s.host ?? null, face: s.face ?? null,
    x0: s.x0 ?? null, x1: s.x1 ?? null, w: s.w ?? null,
  };
}

export interface Arc {
  from: [number, number];
  to: [number, number];
  h: number;
}

export function arcId(a: Arc): string {
  return `arc.${fmt(a.from[0])}-${fmt(a.from[1])}-${fmt(a.to[0])}-${fmt(a.to[1])}-${fmt(a.h)}`;
}

export function parseArc(id: string): Arc | null {
  const m = /^arc\.(.+)$/.exec(id);
  if (!m) return null;
  const v = m[1].split('-').map(Number);
  if (v.length !== 5 || v.some((x) => !Number.isFinite(x))) return null;
  return { from: [v[0], v[1]], to: [v[2], v[3]], h: v[4] };
}

/** Feet height along a jump arc at t ∈ [0, 1] (a parabola through takeoff and landing with apex h above the chord). */
export function arcFeet(a: Arc, t: number): [number, number] {
  const x = a.from[0] + (a.to[0] - a.from[0]) * t;
  const y = a.from[1] + (a.to[1] - a.from[1]) * t - 4 * a.h * t * (1 - t);
  return [x, y];
}

export function gapId(a: string, b: string): string {
  return `gap.${a}-${b}`;
}

export function parseGap(id: string): { a: string; b: string } | null {
  const m = /^gap\.([A-Za-z0-9_]+)-([A-Za-z0-9_]+)$/.exec(id);
  return m ? { a: m[1], b: m[2] } : null;
}
