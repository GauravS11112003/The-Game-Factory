/** Ask cards (§3.3, §3.8): the core asks instead of guessing; every option carries the ops it applies. */
import type { AskCard, AskKind, AskOption, EditOp, MessageArgs, Role, SceneObject } from '../types.gen.ts';
import { hash6 } from '../util/ids.ts';
import { roleNoun } from './roles.ts';

export function askId(kind: AskKind, about: string, extra: unknown = null): string {
  return `ask:${kind}:${about}:${hash6({ kind, about, extra })}`;
}

function relabel(id: string, role: Role, label: string): AskOption {
  const ops: EditOp[] = [{ op: 'set_role', target: id, role }];
  return { id: role, label_key: label, label_args: { role: roleNoun(role) }, ops, tap_target: false };
}

const KEEP = (role: Role): AskOption => ({ id: 'keep', label_key: 'ask.option.keep', label_args: { role: roleNoun(role) }, ops: [], tap_target: false });

export function askCard(kind: AskKind, o: SceneObject, by: AskCard['by'], extra: { roles?: Role[]; args?: MessageArgs; options?: AskOption[] } = {}): AskCard {
  let options: AskOption[] = extra.options ?? [];
  let def: string | null = null;
  if (!options.length) {
    switch (kind) {
      case 'grass_or_spikes':
        options = [relabel(o.id, 'decoration', 'ask.option.grass'), relabel(o.id, 'spikes', 'ask.option.spikes')];
        def = 'decoration';
        break;
      case 'is_door':
        options = [{ ...relabel(o.id, 'door', 'ask.option.yes') }, { ...relabel(o.id, 'wall', 'ask.option.no'), id: 'wall' }];
        def = o.role === 'door' ? 'door' : 'wall';
        break;
      case 'is_decoration':
        options = [relabel(o.id, 'decoration', 'ask.option.decoration'), KEEP(o.role)];
        def = 'keep';
        break;
      case 'which_door':
        // "$tap" is replaced by the tapped object id when the kid answers (D-1 §4)
        options = [{ id: 'tap', label_key: 'ask.option.tap', ops: [{ op: 'link', key: o.id, door: '$tap' }], tap_target: true }];
        def = null;
        break;
      case 'which_flag_is_goal':
        options = [{ id: 'tap', label_key: 'ask.option.tap', ops: [{ op: 'set_role', target: '$tap', role: 'goal' }], tap_target: true }];
        def = null;
        break;
      case 'which_target':
        options = [{ id: 'tap', label_key: 'ask.option.tap', ops: [], tap_target: true }];
        def = null;
        break;
      case 'is_library':
        options = [{ id: 'yes', label_key: 'ask.option.yes', ops: [], tap_target: false }, relabel(o.id, 'decoration', 'ask.option.no')];
        def = 'yes';
        break;
      case 'keep_or_fix':
        options = [{ id: 'keep', label_key: 'ask.option.keep', ops: [], tap_target: false }, { id: 'fix', label_key: 'ask.option.fix', ops: [], tap_target: false }];
        def = 'keep';
        break;
      default: {
        const roles = (extra.roles ?? (o.alt ?? []).map((a) => a.role)).filter((r) => r !== o.role).slice(0, 2);
        options = [KEEP(o.role), ...roles.map((r) => relabel(o.id, r, 'kid.relabel'))];
        def = 'keep';
      }
    }
  } else def = options[0]?.id ?? null;
  return {
    id: askId(kind, o.id, extra.roles ?? null), about: o.id, kind, message_key: `ask.${kind}`, args: { what: roleNoun(o.role), ...(extra.args ?? {}) },
    options, default_option: def, answer: null, by,
  };
}
