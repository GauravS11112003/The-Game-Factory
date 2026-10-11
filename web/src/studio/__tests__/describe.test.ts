/** Plain-language sentences for edits, rules and behaviours (docs/v6/CONTRACTS_V6.md §6). */
import { describe, expect, it } from 'vitest';
import type { StudioEdit } from '../../core/types.gen.ts';
import { ACTIONS, CATALOG, EVENTS } from '../model/catalog.ts';
import { actionText, behaviorText, describeEdits, eventText, ruleText, targetText } from '../model/describe.ts';
import { applyEdits } from '../model/edits.ts';
import { normalizeDoc } from '../model/types.ts';

const doc = normalizeDoc({ id: 'g', scenes: [{ id: 's1', objects: [{ id: 'car', name: 'Red car' }, { id: 'w1', kind: 'wheel' }] }] });

describe('targets', () => {
  it('names keywords, objects and tags', () => {
    expect(targetText('self', doc)).toBe('it');
    expect(targetText('player', doc)).toBe('the player');
    expect(targetText('car', doc)).toBe('Red car');
    expect(targetText('w1', doc)).toBe('Wheel');
    expect(targetText('enemy', doc)).toBe('an enemy');
    expect(targetText('coin', doc)).toBe('a coin');
  });
});

describe('rules', () => {
  it('reads like a sentence', () => {
    expect(ruleText({ when: { type: 'overlap', params: { with: 'enemy' } }, conditions: [], then: [{ type: 'lose', params: {} }] }, doc)).toBe('When it touches an enemy → lose');
    expect(ruleText({
      when: { type: 'collide', params: { with: 'door' } },
      conditions: [{ subject: 'self', counter: 'keys', op: '>=', value: 1 }],
      then: [{ type: 'take', params: { from: 'self', item: 'keys', amount: 1 } }, { type: 'destroy', params: { target: 'other' } }],
    }, doc)).toBe('When it bumps into a door, if its keys ≥ 1 → take 1 keys from it, then destroy the other thing');
    expect(eventText({ type: 'every', params: { seconds: 2 } }, doc)).toBe('Every 2 seconds');
    expect(eventText({ type: 'key_down', params: { key: 'space' } }, doc)).toBe('When space is pressed');
    expect(actionText({ type: 'add', params: { subject: 'game', counter: 'score', amount: -2 } }, doc)).toBe("take 2 from the game's score");
  });

  it('has a sentence for every catalog event and action (no ellipsis, no raw codes)', () => {
    for (const e of EVENTS.keys()) {
      const s = eventText({ type: e }, doc);
      expect(s, e).not.toContain('…');
      expect(/[a-z]_[a-z]/.test(s), e).toBe(false);
    }
    for (const a of ACTIONS.keys()) {
      const s = actionText({ type: a }, doc);
      expect(s, a).not.toContain('…');
    }
    for (const k of CATALOG.keys.names) expect(eventText({ type: 'key_up', params: { key: k } }, doc)).not.toContain('…');
  });
});

describe('behaviours', () => {
  it('shows the label and changed params', () => {
    expect(behaviorText({ type: 'platformer', params: { speed: 280 } })).toBe('Run and jump');
    expect(behaviorText({ type: 'platformer', params: { jump: 900, double_jump: true } })).toBe('Run and jump (jump power 900, double jump yes)');
  });
});

describe('edit sentences', () => {
  it('describes every action', () => {
    const edits: StudioEdit[] = [
      { action: 'set_world', data: { kind: 'hill climb racer' } },
      { action: 'set_world', data: { gravity: [0, 0] } },
      { action: 'set_theme', data: { preset: 'neon' } },
      { action: 'set_hud', data: { items: [{ counter: 'score' }, { counter: 'fuel', label: 'Fuel' }] } },
      { action: 'set_title', data: { title: 'Hill Climb' } },
      { action: 'add_scene', data: { name: 'Level 2' } },
      { action: 'update_object', target: 'zone', data: { name: 'Finish', kind: 'goal', x: 0, y: 0, drawing: { w: 10, h: 10 } } },
      { action: 'update_object', target: 'car', data: { physics: { body: 'dynamic' }, tags: ['player'] } },
      { action: 'duplicate_object', target: 'w1', data: { count: 2 } },
      { action: 'add_behavior', target: 'car', data: { type: 'car' } },
      { action: 'update_behavior', target: 'car', data: { type: 'car', off: true } },
      { action: 'remove_behavior', target: 'car', data: { type: 'car' } },
      { action: 'add_rule', target: 'car', data: { when: { type: 'out_of_bounds' }, then: [{ type: 'lose' }] } },
      { action: 'update_rule', target: 'car', data: { id: 'r1', once: true } },
      { action: 'remove_rule', target: '@scene', data: { id: 'r1' } },
      { action: 'add_joint', target: 'car', data: { type: 'wheel', to: 'w1' } },
      { action: 'set_counters', target: 'car', data: { counters: { fuel: 100, keys: null } } },
      { action: 'set_game_counters', data: { counters: { lives: 3 } } },
      { action: 'ask_draw', data: { id: 'x', prompt: 'Draw your car', object: {} } },
      { action: 'delete_object', target: 'w1', data: {} },
    ];
    const after = applyEdits(doc, 's1', edits, { themes: [{ id: 'neon', name: 'Neon Arcade' }] }).doc;
    const s = describeEdits(edits, after, doc, 's1', [{ id: 'neon', name: 'Neon Arcade' }]);
    expect(s).toEqual([
      'Set the world up as a hill climb racer',
      'Turned gravity off',
      'Switched the look to Neon Arcade',
      'The screen now shows score, Fuel',
      'Named the game “Hill Climb”',
      'Added a level: Level 2',
      'Added Finish',
      'Changed Red car: body, tags',
      'Made 2 copies of Wheel',
      'Red car can now: Drive',
      'Switched off Drive on Red car',
      'Red car no longer: Drive',
      'New rule for Red car: When it falls out of the world → lose',
      'Changed a rule for Red car',
      'Removed a rule from this level',
      'Put Wheel on Red car as a wheel',
      'Red car now has 100 fuel, no keys',
      'The game now keeps 3 lives',
      'Asked you to draw: Draw your car',
      'Removed Wheel',
    ]);
  });
});
