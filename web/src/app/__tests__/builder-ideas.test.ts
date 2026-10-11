import { describe, expect, it } from 'vitest';
import { addIdea, briefReply, gameSuggestions, nextIdeas } from '../builder-ideas.ts';

describe('game additions', () => {
  it('uses model suggestions for the current game', () => {
    const suggestions = [{ title: 'Moon delivery', description: 'Carry fragile parcels.', prompt: 'Add fragile delivery parcels to the moon race.', kind: 'mechanic' as const }];
    expect(gameSuggestions({ suggestions, category: 'racing' })).toEqual(suggestions);
  });
  it('offers suitable additions for an older straight race without suggesting laps', () => {
    const ideas = gameSuggestions({ category: 'racing', summary: 'A straight sprint to the finish line. Dodge craters.' });
    expect(ideas).toHaveLength(3);
    expect(ideas[0].prompt).toContain('near-miss');
    expect(ideas[1].prompt).toContain('completed run');
    expect(ideas.map(i => i.prompt).join(' ')).not.toMatch(/lap|corner/);
  });
  it('avoids offering drift or ghost racing when already implemented', () => {
    const ideas = gameSuggestions({ category: 'racing', summary: 'Drift around the track and race your ghost.' });
    expect(ideas.map(i => i.title)).not.toContain('Drift around corners');
    expect(ideas.map(i => i.title)).not.toContain('Race your ghost');
  });
  it('combines ideas with the user request without duplicating them', () => {
    const ideas = gameSuggestions({ category: 'racing' });
    const request = addIdea(addIdea('Keep the blue car.', ideas[0]), ideas[1]);
    expect(request).toContain('Keep the blue car.');
    expect(request).toContain(ideas[0].prompt);
    expect(request).toContain(ideas[1].prompt);
    expect(addIdea(request, ideas[0])).toBe(request);
  });
  it('never truncates the user request to fit a suggestion', () => {
    const request = 'x'.repeat(7999);
    expect(addIdea(request, gameSuggestions({})[0])).toBe(request);
  });
});

describe('compact game conversation', () => {
  it('offers two different types of addition when available', () => {
    const suggestions = gameSuggestions({ category: 'racing' });
    expect(nextIdeas(suggestions).map(s => s.kind)).toEqual(['mechanic', 'world']);
    expect(nextIdeas([])).toEqual([]);
    expect(nextIdeas(suggestions.slice(0, 1))).toEqual(suggestions.slice(0, 1));
  });
  it('keeps short replies intact and cuts long ones at a word boundary', () => {
    expect(briefReply('A tiny moon race.')).toBe('A tiny moon race.');
    expect(briefReply('Add a boost meter and keep the cars.', 20)).toBe('Add a boost meter…');
  });
});
