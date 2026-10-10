/**
 * Live drawing text. A `live.<key>` in shared/spec/messages.json wins; until those keys are added, these English
 * sentences are used (≤ 12 words, reading age 7, like every other kid-facing sentence).
 */
import { tMaybe } from '../messages.ts';

const EN: Record<string, string> = {
  draw_together: 'Draw together',
  draw_together_help: 'Draw on this page with a friend, at the same time.',
  share_title: 'Draw together!',
  share_help: 'Send this link to a friend. You both draw on this page.',
  copy: 'Copy link',
  copied: 'Link copied!',
  copy_failed: 'Copy the link by hand.',
  scan: 'Or scan this with a tablet.',
  here: "Who's here",
  you: 'you',
  joined: '{name} joined!',
  left: '{name} left.',
  joined_room: "You're drawing together!",
  connecting: 'Connecting…',
  live: 'Live',
  offline: 'Reconnecting…',
  lost: 'Lost the connection. Trying again…',
  back: 'Back together!',
  pass_mode: 'Pass the pencil',
  pass_help: 'Only the one with the pencil can draw. Tap a friend to pass it.',
  pass_on: 'Pass the pencil is on!',
  pass_off: 'Everyone can draw now.',
  your_turn: 'Your turn with the pencil!',
  their_turn: "It's {name}'s turn with the pencil.",
  passed_to: 'You passed the pencil to {name}.',
  take: 'Take the pencil',
  not_your_turn: 'Wait for the pencil!',
  only_holder: 'Only {name} can pass the pencil.',
  invite: 'Invite',
  share_done: 'Done',
  leave: 'Leave',
  left_room: 'You left. Your copy is still here.',
  react: 'Send a reaction',
  too_long: 'That line was too long to share.',
  room_full: 'This page is full of ink!',
  refused: "That change didn't reach your friends.",
  slow_down: 'Whoa, slow down a little!',
  guest: 'Friend',
  someone: 'Someone',
};

export function lt(key: string, args: Record<string, unknown> = {}): string {
  const fromTable = tMaybe(`live.${key}`, args);
  if (fromTable !== null) return fromTable;
  const tpl = EN[key] ?? '…';
  return tpl.replace(/\{([a-z_]+)\}/g, (_, name: string) => String(args[name] ?? ''));
}
