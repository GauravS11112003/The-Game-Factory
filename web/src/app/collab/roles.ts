/**
 * Who am I in this game? The server's `viewer` block (on the bible) decides: role, keeper (owner or maintainer, who
 * review, post quests and edit the bible), can_manage_members (the owner), claimable (an ownerless game this profile
 * may claim by joining). The members list is the fallback when there is no viewer block.
 */
import { currentPlayer, type Player } from '../identity.ts';
import { collab, type Bible, type Member, type Role } from './api.ts';

export interface GameTeam {
  me: Player | null;
  role: Role | null;
  /** Owner or maintainer: review, post quests, edit the game book. */
  keeper: boolean;
  /** The owner: make maintainers, remove people. */
  canManage: boolean;
  /** No owner yet and this profile may claim it (by joining). */
  claimable: boolean;
  members: Member[];
  bible: Bible | null;
}

export function roleOf(me: Player | null, members: Member[], bible: Bible | null): Role | null {
  if (!me) return null;
  if (bible?.viewer && bible.viewer.role) return bible.viewer.role;
  if (bible?.owner_id && bible.owner_id === me.id) return 'owner';
  return members.find((m) => m.player.id === me.id)?.role ?? null;
}

export function canMaintain(r: Role | null): boolean {
  return r === 'owner' || r === 'maintainer';
}

/** Members and bible together; either may be missing while the backend settles. */
export async function loadTeam(gameId: string): Promise<GameTeam> {
  const [members, bible] = await Promise.all([
    collab.members(gameId).catch(() => [] as Member[]),
    collab.bible(gameId).catch(() => null),
  ]);
  const me = currentPlayer();
  const role = roleOf(me, members, bible);
  const v = me ? bible?.viewer ?? null : null;
  return {
    me, role, members, bible,
    keeper: v ? v.keeper : canMaintain(role),
    canManage: v ? v.can_manage_members : role === 'owner',
    claimable: !!v?.claimable,
  };
}
