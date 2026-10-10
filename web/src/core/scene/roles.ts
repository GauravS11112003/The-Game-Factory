/** Role tables (§3.3): default collision, ink-colour allowances (U1), families (I1), stamps. */
import type { Behavior, Collision, InkColor, Role, StampKind } from '../types.gen.ts';

export const ROLES: readonly Role[] = [
  'ground', 'platform', 'wall', 'ceiling', 'spikes', 'lava', 'saw', 'enemy', 'coin', 'big_coin', 'key', 'door', 'spring',
  'checkpoint', 'goal', 'pole', 'start_marker', 'text', 'arrow', 'decoration', 'library_tag', 'unknown',
];

export const DEFAULT_COLLISION: Record<Role, Collision> = {
  ground: 'solid', platform: 'solid', wall: 'solid', ceiling: 'solid', spikes: 'hazard', lava: 'hazard', saw: 'hazard',
  enemy: 'hazard', coin: 'none', big_coin: 'none', key: 'none', door: 'solid', spring: 'solid', checkpoint: 'trigger',
  goal: 'trigger', pole: 'none', start_marker: 'none', text: 'none', arrow: 'none', decoration: 'none',
  library_tag: 'none', unknown: 'none',
};

export const SURFACE_ROLES: ReadonlySet<Role> = new Set<Role>(['ground', 'platform', 'ceiling']);
export const TERRAIN_ROLES: ReadonlySet<Role> = new Set<Role>(['ground', 'platform', 'wall', 'ceiling']);
export const HAZARD_ROLES: ReadonlySet<Role> = new Set<Role>(['spikes', 'lava', 'saw']);
export const NONCOLLIDING_ROLES: ReadonlySet<Role> = new Set<Role>(['text', 'arrow', 'decoration', 'unknown', 'pole', 'start_marker', 'library_tag']);
/** Gameplay-relevant roles get an "Is this right?" chip below conf 0.75 (§3.3 merge step 7). */
export const GAMEPLAY_ROLES: ReadonlySet<Role> = new Set<Role>([
  'ground', 'platform', 'wall', 'ceiling', 'spikes', 'lava', 'saw', 'enemy', 'coin', 'big_coin', 'key', 'door', 'spring',
  'checkpoint', 'goal',
]);

/** U1: roles allowed per ink colour (pencil and draft are designer inks: anything). */
const BLACK: Role[] = ['ground', 'platform', 'wall', 'ceiling', 'door', 'pole', 'decoration', 'text', 'arrow', 'spikes', 'spring', 'start_marker', 'library_tag', 'unknown'];
const RED: Role[] = ['spikes', 'lava', 'saw', 'enemy', 'text', 'decoration', 'library_tag', 'unknown'];
const GREEN: Role[] = ['goal', 'checkpoint', 'decoration', 'text', 'pole', 'library_tag', 'unknown'];
const BLUE: Role[] = ['coin', 'big_coin', 'key', 'decoration', 'text', 'library_tag', 'unknown'];

export function roleAllowed(color: InkColor, role: Role): boolean {
  switch (color) {
    case 'black':
      return BLACK.includes(role);
    case 'red':
      return RED.includes(role);
    case 'green':
      return GREEN.includes(role);
    case 'blue':
      return BLUE.includes(role);
    default:
      return true;
  }
}

/** I1 role families. */
export function roleFamily(role: Role): string {
  switch (role) {
    case 'ground':
    case 'platform':
    case 'wall':
    case 'ceiling':
      return 'terrain';
    case 'spikes':
    case 'lava':
    case 'saw':
      return 'hazard';
    case 'enemy':
      return 'enemy';
    case 'coin':
    case 'big_coin':
    case 'key':
      return 'pickup';
    case 'door':
      return 'door';
    case 'spring':
      return 'spring';
    case 'checkpoint':
    case 'goal':
    case 'pole':
      return 'flag';
    case 'text':
    case 'arrow':
    case 'start_marker':
      return 'sign';
    default:
      return 'scenery';
  }
}

export function stampRole(stamp: StampKind): Role {
  switch (stamp) {
    case 'flag':
      return 'goal';
    case 'walker':
    case 'hopper':
    case 'flyer':
      return 'enemy';
    case 'start':
      return 'start_marker';
    case 'library':
      return 'library_tag';
    default:
      return stamp;
  }
}

export function stampBehavior(stamp: StampKind): Behavior | null {
  switch (stamp) {
    case 'walker':
    case 'hopper':
    case 'flyer':
      return { kind: 'enemy', archetype: stamp, spiky: false };
    case 'spring':
      return { kind: 'spring', dir: 'up', strength: 1.0 };
    default:
      return null;
  }
}

/** Kid-readable noun for a role (message args). */
export function roleNoun(role: Role): string {
  switch (role) {
    case 'ground':
      return 'ground';
    case 'platform':
      return 'ledge';
    case 'wall':
      return 'wall';
    case 'ceiling':
      return 'ceiling';
    case 'big_coin':
      return 'big star';
    case 'enemy':
      return 'monster';
    case 'goal':
      return 'flag';
    case 'checkpoint':
      return 'checkpoint';
    case 'start_marker':
      return 'start';
    case 'library_tag':
      return 'thing';
    case 'unknown':
      return 'scribble';
    default:
      return role;
  }
}
