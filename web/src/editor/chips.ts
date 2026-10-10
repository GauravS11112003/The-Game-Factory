/**
 * "What does it do?" (§7.11): chips over the fixed vocabulary. Each chip writes an explicit kid binding into the
 * selected strokes (`label` = Role, `rule` = Behavior, conf 1.0, pinned), so PERCEIVE skips those components:
 * - moves ↔ / ↕ with a distance slider;
 * - walks, hops, flies, shoots, chases, crushes;
 * - bouncy, crumbles, falls;
 * - key → tap a door; door; checkpoint; start here.
 * Key → door links are written as `x_opens: <door stroke id>` on the key strokes (an `x_*` extension key, allowed by
 * the format; see docs/v2/requests/F-1.md) and as a typed rule bound to the key.
 */
import type { Archetype, Behavior, InkColor, InkStroke, Role } from '../core/types.gen.ts';
import { ENEMIES, GRIDS, HAZARDS } from '../core/params.ts';
import { t } from '../app/messages.ts';

export type Speed = 'slow' | 'normal' | 'fast';

export type ChipId =
  | 'move_h' | 'move_v' | 'walker' | 'hopper' | 'flyer' | 'shooter' | 'chaser' | 'crusher'
  | 'bouncy' | 'crumbles' | 'falls' | 'key' | 'door' | 'checkpoint' | 'start' | 'clear';

export interface ChipDef {
  id: ChipId;
  group: 'move' | 'creature' | 'platform' | 'thing';
  key: string; // messages.json label
  icon: string;
}

export const CHIPS: readonly ChipDef[] = [
  { id: 'move_h', group: 'move', key: 'chip.move_h', icon: '↔' },
  { id: 'move_v', group: 'move', key: 'chip.move_v', icon: '↕' },
  { id: 'walker', group: 'creature', key: 'chip.walks', icon: '🚶' },
  { id: 'hopper', group: 'creature', key: 'chip.hops', icon: '🐸' },
  { id: 'flyer', group: 'creature', key: 'chip.flies', icon: '🦇' },
  { id: 'shooter', group: 'creature', key: 'chip.shoots', icon: '💥' },
  { id: 'chaser', group: 'creature', key: 'chip.chases', icon: '😠' },
  { id: 'crusher', group: 'creature', key: 'chip.crushes', icon: '⬇' },
  { id: 'bouncy', group: 'platform', key: 'chip.bouncy', icon: '🌀' },
  { id: 'crumbles', group: 'platform', key: 'chip.crumbles', icon: '🧱' },
  { id: 'falls', group: 'platform', key: 'chip.falls', icon: '⤓' },
  { id: 'key', group: 'thing', key: 'chip.key', icon: '🔑' },
  { id: 'door', group: 'thing', key: 'chip.door', icon: '🚪' },
  { id: 'checkpoint', group: 'thing', key: 'chip.checkpoint', icon: '🚩' },
  { id: 'start', group: 'thing', key: 'chip.start', icon: '🏁' },
  { id: 'clear', group: 'thing', key: 'chip.clear', icon: '✕' },
];

/** One-tap role re-labels (§7.10 "Is this right?" uses the same set). */
export const RELABELS: readonly Role[] = ['ground', 'platform', 'wall', 'ceiling', 'spikes', 'lava', 'enemy', 'coin', 'goal', 'decoration', 'text'];

/** Roles allowed for an ink colour (U1 guard, §3.5); pencil and draft ink take any role. */
const COLOR_ROLES: Partial<Record<InkColor, readonly Role[]>> = {
  black: ['ground', 'platform', 'wall', 'ceiling', 'door', 'pole', 'decoration', 'text', 'arrow', 'spikes', 'spring', 'start_marker'],
  red: ['spikes', 'lava', 'saw', 'enemy', 'text', 'decoration'],
  green: ['goal', 'checkpoint', 'decoration', 'text'],
  blue: ['coin', 'big_coin', 'key', 'decoration', 'text'],
};

export function rolesFor(colors: Iterable<InkColor>, roles: readonly Role[] = RELABELS): Role[] {
  const cs = [...new Set(colors)];
  return roles.filter((r) => cs.every((c) => !COLOR_ROLES[c] || COLOR_ROLES[c]!.includes(r)));
}

const SPEED_GRID: Record<Archetype, keyof typeof GRIDS> = {
  walker: 'walker_speed', hopper: 'hopper_interval', flyer: 'flyer_speed', shooter: 'shooter_interval', chaser: 'chaser_speed',
  crusher: 'crusher_warn',
};

export interface ChipOptions {
  cells: number; // move distance, 2-20
  speed: Speed;
  reverse: boolean; // ← instead of → (or ↓ instead of ↑)
}

export const DEFAULT_CHIP_OPTIONS: ChipOptions = { cells: 6, speed: 'normal', reverse: false };

function enumVal(grid: keyof typeof GRIDS, s: Speed): number {
  const e = GRIDS[grid].enum as Record<string, number>;
  return e[s] ?? e.normal;
}

/** The binding a chip writes. `null` label/rule means "leave as is"; `clear` removes both. */
export function chipBinding(id: ChipId, o: ChipOptions): { label: Role | null; rule: Behavior | null; clear?: boolean } {
  switch (id) {
    case 'move_h':
    case 'move_v': {
      const dir = id === 'move_h' ? (o.reverse ? 'left' : 'right') : o.reverse ? 'down' : 'up';
      const cells = Math.max(2, Math.min(20, Math.round(o.cells)));
      return { label: null, rule: { kind: 'move', dir, cells, speed: enumVal('platform_speed', o.speed), mode: 'pingpong', wait_s: HAZARDS.moving_platform.end_wait_s } };
    }
    case 'walker':
    case 'hopper':
    case 'flyer':
    case 'shooter':
    case 'chaser':
    case 'crusher': {
      const v = enumVal(SPEED_GRID[id], o.speed);
      const params =
        id === 'hopper' ? { interval: v } : id === 'shooter' ? { interval: v } : id === 'crusher' ? { warn: v }
          : id === 'flyer' ? { speed: v, pattern: 'horizontal' as const, range: Math.max(2, Math.min(10, Math.round(o.cells))) }
            : id === 'walker' ? { speed: v, ledge_aware: ENEMIES.walker.ledge_aware } : { speed: v, sight: ENEMIES.chaser.sight };
      return { label: 'enemy', rule: { kind: 'enemy', archetype: id, params } };
    }
    case 'bouncy':
      // Spring strength uses small / normal / big (§5.6): slow → small, fast → big.
      return { label: 'spring', rule: { kind: 'spring', dir: 'up', strength: (GRIDS.spring_strength.enum as Record<string, number>)[o.speed === 'slow' ? 'small' : o.speed === 'fast' ? 'big' : 'normal'] } };
    case 'crumbles':
      return { label: null, rule: { kind: 'crumble', delay_s: enumVal('crumble_delay', o.speed), respawn_s: HAZARDS.crumble.respawn_s } };
    case 'falls':
      return { label: null, rule: { kind: 'falling', delay_s: HAZARDS.falling.delay_s } };
    case 'key':
      return { label: 'key', rule: null };
    case 'door':
      return { label: 'door', rule: null };
    case 'checkpoint':
      return { label: 'checkpoint', rule: null };
    case 'start':
      return { label: 'start_marker', rule: null };
    case 'clear':
      return { label: null, rule: null, clear: true };
  }
}

/** Apply a chip to strokes (returns new stroke objects; ids kept). */
export function applyChip(strokes: InkStroke[], id: ChipId, o: ChipOptions): InkStroke[] {
  const b = chipBinding(id, o);
  return strokes.map((s) => {
    const n: InkStroke & { x_opens?: string } = { ...s };
    if (b.clear) {
      delete n.label;
      delete n.rule;
      delete (n as { x_opens?: string }).x_opens;
      return n;
    }
    if (b.label) n.label = b.label;
    if (b.rule) n.rule = b.rule;
    else if (b.label && b.label !== 'enemy' && b.label !== 'spring') delete n.rule;
    return n;
  });
}

export function linkKey(keys: InkStroke[], doorId: string): InkStroke[] {
  return keys.map((s) => ({ ...s, label: 'key', x_opens: doorId }) as InkStroke);
}

export function opensOf(s: InkStroke): string | null {
  const v = (s as { x_opens?: unknown }).x_opens;
  return typeof v === 'string' ? v : null;
}

/** Kid-readable tag for a stroke's binding ("walks", "moves ↔ 6"), or null. */
export function bindingTag(s: InkStroke): string | null {
  const r = s.rule;
  if (r) {
    switch (r.kind) {
      case 'move':
        return t('chip.tag_moves', { arrow: r.dir === 'left' || r.dir === 'right' ? '↔' : '↕', cells: r.cells });
      case 'enemy':
        return t(`chip.${({ walker: 'walks', hopper: 'hops', flyer: 'flies', shooter: 'shoots', chaser: 'chases', crusher: 'crushes' } as const)[r.archetype]}`);
      case 'spring':
        return t('chip.bouncy');
      case 'crumble':
        return t('chip.crumbles');
      case 'falling':
        return t('chip.falls');
      case 'static':
        return t('chip.stays');
      default:
        return null;
    }
  }
  if (s.label) {
    if (s.label === 'key' && opensOf(s)) return t('chip.tag_key_linked');
    const m: Partial<Record<Role, string>> = { door: 'chip.door', checkpoint: 'chip.checkpoint', start_marker: 'chip.start' };
    const k = m[s.label];
    return k ? t(k) : t('chip.tag_role', { role: t(`role.${s.label}`) });
  }
  return null;
}
