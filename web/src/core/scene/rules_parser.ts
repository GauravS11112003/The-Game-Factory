/**
 * Typed rules parser (§3.3, `core/scene/rules_parser.ts`), offline. It runs only for sentences the model did not
 * answer and is never merged on top of the model [B F10].
 *   patterns  <target> moves|slides [dir] [N] · walks|hops|flies|shoots|chases|crushes · sleeps|stays · is bouncy ·
 *             crumbles · falls · key opens door · N seconds · <target> is <role> · start here
 *   targets   nouns → roles; adjectives narrow (high/top, low, left/first, right/last, big/long, small) and colours;
 *             ground spanning > 60% of a screen is never a move target; several matches → an Ask ("Which platform
 *             moves? Tap it."), never "the largest".
 *   "@<component id> …" binds to that component exactly (a rule typed while a stroke was selected).
 * v4 (docs/v4/CONTRACTS_V4.md §2.4): a sentence the logic parser turns into rules or a mode ("space flips gravity")
 * is logic, never also a v2 edit; it is skipped here.
 */
import { ENEMIES, GRIDS, PERCEPTION, WORLD } from '../params.ts';
import type { AskCard, Behavior, Dir4, EditOp, EditRecord, Role, SceneGraph, SceneObject } from '../types.gen.ts';
import { OP_CLASS, explain } from '../edits/vocabulary.ts';
import { clamp } from '../util/geom.ts';
import { editId } from '../util/ids.ts';
import { isLogicSentence, typedRuleTargets } from '../logic/index.ts';
import { askCard } from './asks.ts';

const NOUNS: [RegExp, Role[]][] = [
  [/\b(platforms?|ledges?|steps?|blocks?|bricks?|floating|cloud platform)\b/, ['platform']],
  [/\b(floor|ground|land)\b/, ['ground', 'platform']],
  [/\b(walls?|towers?|pillars?)\b/, ['wall']],
  [/\b(monsters?|enem(y|ies)|bad ?guys?|creatures?|dragons?|ghosts?|bugs?|aliens?|zombies?|slimes?|blobs?)\b/, ['enemy']],
  [/\b(spikes?|thorns?|pricklies)\b/, ['spikes']],
  [/\b(saws?|blades?)\b/, ['saw']],
  [/\b(springs?|trampolines?|bouncers?|jump ?pads?)\b/, ['spring']],
  [/\bkeys?\b/, ['key']],
  [/\b(doors?|gates?)\b/, ['door']],
  [/\b(coins?|gems?|stars?)\b/, ['coin', 'big_coin']],
  [/\b(flags?|goal|finish|end)\b/, ['goal']],
  [/\blava\b/, ['lava']],
];

const ROLE_WORDS: [RegExp, Role][] = [
  [/\blava\b/, 'lava'],
  [/\bspikes?\b/, 'spikes'],
  [/\b(a |the )?door\b/, 'door'],
  [/\b(a |the )?key\b/, 'key'],
  [/\b(a |the )?spring\b|\bbouncy\b/, 'spring'],
  [/\b(a |the )?monster\b|\benemy\b/, 'enemy'],
  [/\b(a |the )?(coin|gem)\b/, 'coin'],
  [/\b(a |the )?(checkpoint)\b/, 'checkpoint'],
  [/\b(the )?(goal|finish)\b/, 'goal'],
  [/\b(just )?(decoration|for looks|a picture|scenery|a tree|a cloud|grass)\b/, 'decoration'],
  [/\b(a |the )?(platform|ledge)\b/, 'platform'],
  [/\b(a |the )?wall\b/, 'wall'],
];

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30, sixty: 60 };

function numberIn(s: string): number | null {
  const m = /\b(\d{1,3})\b/.exec(s);
  if (m) return Number(m[1]);
  for (const [w, n] of Object.entries(NUM_WORDS)) if (new RegExp(`\\b${w}\\b`).test(s)) return n;
  return null;
}

function dirIn(s: string): Dir4 | null {
  if (/\b(up and down|down and up|up\b|upwards|rises)/.test(s)) return 'up';
  if (/\bdown\b|\bdownwards\b/.test(s)) return 'down';
  if (/\bleft\b/.test(s)) return 'left';
  if (/\b(right|side to side|back and forth|across|left and right)\b/.test(s)) return 'right';
  return null;
}

function speedWord(s: string): 'slow' | 'normal' | 'fast' {
  return /\b(slow|slowly|lazy|sleepy)\b/.test(s) ? 'slow' : /\b(fast|quick|quickly|speedy|zoom)\b/.test(s) ? 'fast' : 'normal';
}

function bbox(o: SceneObject): [number, number, number, number] {
  const s = o.shape;
  if (s.k === 'surface') {
    const xs = s.segs.flatMap((g) => [g.a[0], g.b[0]]);
    const ys = s.segs.flatMap((g) => [g.a[1], g.b[1]]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys) + 1];
  }
  if (s.k === 'wall') return [s.x, s.y0, s.x + (s.w ?? 1), s.y1];
  if (s.k === 'strip') return [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])];
  if (s.k === 'point') return [s.p[0] - 0.3, s.p[1] - 0.3, s.p[0] + 0.3, s.p[1] + 0.3];
  return s.bbox;
}

/** Narrow candidates by adjectives; returns the narrowed list (possibly still several). */
function narrow(cands: SceneObject[], s: string): SceneObject[] {
  let c = cands;
  const pickBy = (f: (o: SceneObject) => number, max: boolean): SceneObject[] => {
    if (c.length <= 1) return c;
    const v = c.map(f);
    const best = max ? Math.max(...v) : Math.min(...v);
    return c.filter((_, i) => v[i] === best);
  };
  if (/\b(high|higher|highest|top|upper)\b/.test(s)) c = pickBy((o) => bbox(o)[1], false);
  if (/\b(low|lower|lowest|bottom)\b/.test(s)) c = pickBy((o) => bbox(o)[3], true);
  if (/\b(left|first|leftmost)\b/.test(s) && !/\bmoves? left\b/.test(s)) c = pickBy((o) => bbox(o)[0], false);
  if (/\b(right|last|rightmost)\b/.test(s) && !/\bmoves? right\b/.test(s)) c = pickBy((o) => bbox(o)[2], true);
  if (/\b(big|bigger|biggest|long|longer|longest|large)\b/.test(s)) c = pickBy((o) => (bbox(o)[2] - bbox(o)[0]) * Math.max(1, bbox(o)[3] - bbox(o)[1]), true);
  if (/\b(small|smaller|smallest|tiny|little|short)\b/.test(s)) c = pickBy((o) => (bbox(o)[2] - bbox(o)[0]) * Math.max(1, bbox(o)[3] - bbox(o)[1]), false);
  return c;
}

function rec(op: EditOp, extra: Partial<EditRecord> = {}): EditRecord {
  const ex = explain(op, null);
  return {
    id: editId(op), op, class: OP_CLASS[op.op], by: 'parser', stage: 'ink', tier: 'faithful', status: 'applied',
    reason_key: ex.reason_key, reason_args: {}, reason_text: null, depends_on: [], required: false, group: null,
    validation: null, ghost: null, reject_reason: null, cid: null, ...extra,
  };
}

const MOVE_RE = /\b(moves?|moving|slides?|sliding|goes|floats?)\b/;

export function parseRules(text: string, g: SceneGraph, target?: number | null): { edits: EditRecord[]; asks: AskCard[] } {
  const edits: EditRecord[] = [];
  const asks: AskCard[] = [];
  const objs = (g.objects ?? []).filter((o) => !o.rel.part_of);
  const add = (r: EditRecord): void => {
    if (!edits.some((e) => e.id === r.id)) edits.push(r);
  };
  let last: SceneObject | null = null;
  const sentences = String(text ?? '').slice(0, 600).split(/[.!?\n;]+/).map((s) => s.trim()).filter(Boolean);
  const lt = typedRuleTargets(objs, target);
  for (const raw of sentences) {
    if (isLogicSentence(raw.replace(/^@\d+\s+/, ''), lt.ids, { aliases: lt.aliases })) continue;
    let s = raw.toLowerCase();
    // an exact binding: "@<component id> …"
    let exact: SceneObject | null = null;
    const at = /^@(\d+)\s+/.exec(s);
    const typedTarget = typeof target === 'number' && target > 0 ? target : null;
    if (at || typedTarget !== null) {
      const cid = at ? Number(at[1]) : typedTarget!;
      exact = objs.find((o) => o.id === `o${cid}`) ?? objs.find((o) => o.components.includes(cid)) ?? null;
      if (at) s = s.slice(at[0].length);
    }
    // targets
    const resolve = (roles: Role[] | null, pred?: (o: SceneObject) => boolean): SceneObject | 'ask' | null => {
      if (exact) return exact;
      let cands = roles ? objs.filter((o) => roles.includes(o.role)) : [];
      if (pred) cands = cands.filter(pred);
      if (/\b(it|this|that)\b/.test(s) && last && (!roles || roles.includes(last.role))) return last;
      cands = narrow(cands, s);
      if (cands.length === 1) return cands[0];
      if (cands.length > 1) return 'ask';
      return null;
    };
    const noun = NOUNS.find(([re]) => re.test(s));
    const roles = noun ? noun[1] : null;
    const askWhich = (what: string, ops: EditOp[] = []): void => {
      const o = objs.find((x) => roles?.includes(x.role)) ?? objs[0];
      if (!o) return;
      const card = askCard('which_target', o, 'parser', { args: { what } });
      if (ops.length) card.options = [{ id: 'tap', label_key: 'ask.option.tap', ops, tap_target: true }];
      asks.push({ ...card, about: roles?.[0] ?? o.id });
    };
    // "key opens door"
    if (/\bkey\b.*\b(opens?|unlocks?)\b.*\b(door|gate)\b/.test(s)) {
      const keys = objs.filter((o) => o.role === 'key');
      const doors = objs.filter((o) => o.role === 'door' || (o.shape.k === 'wall' && o.role === 'wall'));
      const rd = doors.filter((o) => o.role === 'door');
      const door = rd.length === 1 ? rd[0] : doors.length === 1 ? doors[0] : null;
      if (keys.length === 1 && door) add(rec({ op: 'link', key: keys[0].id, door: door.id }));
      else if (keys.length >= 1) asks.push(askCard('which_door', keys[0], 'parser'));
      continue;
    }
    // "N seconds"
    if (/\bseconds?\b/.test(s) && numberIn(s) !== null) {
      const sec = clamp(numberIn(s)!, 10, 300);
      add(rec({ op: 'set_timer', k: 2, x_seconds: sec } as EditOp, { class: 'U', reason_key: 'challenge.set_timer', reason_args: { seconds: sec } }));
      continue;
    }
    // "start here" / "S is start"
    if (/\bstart(s)?\b/.test(s) && !MOVE_RE.test(s)) {
      const t = exact ?? objs.find((o) => o.role === 'start_marker') ?? null;
      if (t) add(rec({ op: 'set_start', near: t.id }, { reason_args: { text: t.text ?? 'S' } }));
      continue;
    }
    // movement
    if (MOVE_RE.test(s)) {
      const t = resolve(roles ?? ['platform'], (o) => !(o.role === 'ground' && bbox(o)[2] - bbox(o)[0] > PERCEPTION.ground_no_move_screen_frac * WORLD.screen_w));
      if (t === 'ask') {
        const dir0 = dirIn(s) ?? 'right';
        askWhich(roles?.[0] ?? 'platform', [{ op: 'bind', target: '$tap', behavior: { kind: 'move', dir: dir0, cells: clamp(numberIn(s) ?? 4, 1, 12), speed: GRIDS.platform_speed.enum[speedWord(s)], mode: 'pingpong' } }]);
        continue;
      }
      if (!t) continue;
      last = t;
      const dir = dirIn(s) ?? 'right';
      const cells = clamp(numberIn(s) ?? 4, 1, 12);
      const speed = GRIDS.platform_speed.enum[speedWord(s)];
      const pinned = ['dir', ...(numberIn(s) !== null ? ['cells'] : []), ...(speedWord(s) !== 'normal' ? ['speed'] : [])];
      if (t.role === 'enemy') {
        add(rec({ op: 'bind', target: t.id, behavior: { kind: 'enemy', archetype: dir === 'up' || dir === 'down' ? 'flyer' : 'walker', spiky: false, params: { speed: GRIDS.walker_speed.enum[speedWord(s)], ...(dir === 'up' || dir === 'down' ? { pattern: 'vertical', range: cells } : {}) } }, x_pinned: ['archetype'] } as EditOp));
      } else if (t.role === 'saw') {
        add(rec({ op: 'bind', target: t.id, behavior: { kind: 'saw', dir, cells, speed: GRIDS.saw_speed.enum[speedWord(s)] }, x_pinned: pinned } as EditOp));
      } else add(rec({ op: 'bind', target: t.id, behavior: { kind: 'move', dir, cells, speed, mode: 'pingpong' }, x_pinned: pinned } as EditOp, { reason_args: { dir, cells } }));
      continue;
    }
    // enemy verbs
    const verbs: [RegExp, Behavior][] = [
      [/\b(walks?|walking|patrols?|paces?)\b/, { kind: 'enemy', archetype: 'walker', spiky: false, params: { speed: ENEMIES.walker.speed, ledge_aware: true } }],
      [/\b(hops?|hopping|jumps?|jumping|bounces? around)\b/, { kind: 'enemy', archetype: 'hopper', spiky: false, params: { interval: ENEMIES.hopper.interval } }],
      [/\b(flies|flying|fly|floats around)\b/, { kind: 'enemy', archetype: 'flyer', spiky: false, params: { pattern: 'hover' } }],
      [/\b(shoots?|shooting|spits?|throws?)\b/, { kind: 'enemy', archetype: 'shooter', spiky: false, params: { interval: ENEMIES.shooter.interval, facing: 'toward_player' } }],
      [/\b(chases?|chasing|follows?|hunts?)\b/, { kind: 'enemy', archetype: 'chaser', spiky: false, params: { speed: ENEMIES.chaser.speed } }],
      [/\b(crushes?|smashes?|squashes?|stomps? down)\b/, { kind: 'enemy', archetype: 'crusher', spiky: false, params: { warn: ENEMIES.crusher.warn } }],
      [/\b(sleeps?|sleeping|doesn'?t move|stays?|still|guards?)\b/, { kind: 'static' }],
    ];
    const verb = verbs.find(([re]) => re.test(s));
    if (verb && (!roles || roles.includes('enemy'))) {
      const t = resolve(['enemy']);
      if (t === 'ask') {
        askWhich('monster', [{ op: 'bind', target: '$tap', behavior: JSON.parse(JSON.stringify(verb[1])) as Behavior }]);
        continue;
      }
      if (!t) continue;
      last = t;
      const beh = JSON.parse(JSON.stringify(verb[1])) as Behavior;
      if (beh.kind === 'enemy') {
        if (/\bspik(y|es)\b/.test(s)) beh.spiky = true;
        const sw = speedWord(s);
        if (sw !== 'normal' && beh.params && 'speed' in beh.params) beh.params.speed = (beh.archetype === 'chaser' ? GRIDS.chaser_speed.enum : GRIDS.walker_speed.enum)[sw];
      }
      add(rec({ op: 'bind', target: t.id, behavior: beh, x_pinned: ['archetype', ...(speedWord(s) !== 'normal' ? ['speed'] : [])] } as EditOp, { reason_key: beh.kind === 'enemy' && beh.archetype === 'walker' ? 'understand.walks' : 'understand.bound', reason_args: { what: 'monster', does: raw.slice(0, 30) } }));
      continue;
    }
    // platform behaviours
    if (/\b(bouncy|bounces?|springy)\b/.test(s)) {
      const t = resolve(roles ?? ['platform', 'spring']);
      if (t === 'ask') {
        askWhich('platform');
        continue;
      }
      if (!t) continue;
      last = t;
      if (t.role !== 'spring') add(rec({ op: 'set_role', target: t.id, role: 'spring' }));
      add(rec({ op: 'bind', target: t.id, behavior: { kind: 'spring', dir: 'up', strength: /\b(super|really|big)\b/.test(s) ? GRIDS.spring_strength.enum.big : 1.0 }, x_pinned: [] } as EditOp));
      continue;
    }
    if (/\b(crumbles?|breaks?|cracks?|falls apart)\b/.test(s) || /\bfalls?\b/.test(s)) {
      const crumble = !/\bfalls?\b/.test(s) || /\bfalls apart\b/.test(s);
      const t = resolve(roles ?? ['platform'], (o) => o.role !== 'ground');
      if (t === 'ask') {
        askWhich('platform');
        continue;
      }
      if (!t) continue;
      last = t;
      add(rec({ op: 'bind', target: t.id, behavior: crumble ? { kind: 'crumble' } : { kind: 'falling' }, x_pinned: [] } as EditOp));
      continue;
    }
    // "<target> is <role>"
    const isM = /\b(is|are)\b(.*)$/.exec(s);
    if (isM) {
      const rw = ROLE_WORDS.find(([re]) => re.test(isM[2]));
      if (rw) {
        const lhs = s.slice(0, isM.index);
        const ln = NOUNS.find(([re]) => re.test(lhs));
        const colour = /\b(red|blue|green|black)\b/.exec(lhs)?.[1] ?? null;
        let cands = exact ? [exact] : ln ? objs.filter((o) => ln[1].includes(o.role)) : objs;
        if (!exact && colour) cands = cands.filter((o) => o.strokes.length && o.components.length && (g.objects ?? []).some((x) => x.id === o.id) && colourOf(o, g) === colour);
        if (!exact && /\b(it|this|that)\b/.test(lhs) && last) cands = [last];
        cands = exact ? cands : narrow(cands, lhs);
        if (cands.length === 1) {
          last = cands[0];
          if (cands[0].role !== rw[1]) add(rec({ op: 'set_role', target: cands[0].id, role: rw[1] }, { reason_key: 'kid.relabel', reason_args: { role: rw[1] } }));
        } else if (cands.length > 1) askWhich(rw[1]);
      }
    }
  }
  return { edits, asks };
}

function colourOf(o: SceneObject, g: SceneGraph): string | null {
  void g;
  // the heuristic keeps ink colour implicit in roles; ids of kid strokes carry no colour, so infer from the role
  if (o.role === 'coin' || o.role === 'big_coin' || o.role === 'key') return 'blue';
  if (o.role === 'goal' || o.role === 'checkpoint') return 'green';
  if (o.role === 'spikes' || o.role === 'lava' || o.role === 'enemy' || o.role === 'saw') return 'red';
  return 'black';
}
