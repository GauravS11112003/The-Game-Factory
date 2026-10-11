import type { ImaginedGameStatus } from './api.ts';

export interface GameSuggestion {
  title: string;
  description: string;
  prompt: string;
  kind: 'mechanic' | 'world' | 'feel';
}

/** Older saved games get useful starting points without another model call. */
export function gameSuggestions(game: Pick<ImaginedGameStatus, 'suggestions' | 'category' | 'summary' | 'context'>): GameSuggestion[] {
  if (game.suggestions?.length) return game.suggestions.slice(0, 3);
  const existing = `${game.summary ?? ''} ${game.context ?? ''}`.toLowerCase();
  const straightRace = /straight|sprint|finish line/.test(existing) && !/laps?/.test(existing);
  const candidates: GameSuggestion[] = game.category === 'racing' ? [
    straightRace ? idea('Reward close calls', 'Earn a little energy for a perfectly timed dodge.', 'Add a near-miss reward when I narrowly dodge an obstacle: a little bonus energy and a clear visual response. Preserve the current straight race and cars.', 'mechanic') :
      idea('Drift around corners', 'Reward a well-timed slide with a burst of speed.', 'Add a drift mechanic with a visible drift meter and a small speed reward. Keep the current track, cars and controls.', 'mechanic'),
    straightRace ? idea('Race your ghost', 'Try to beat a replay of your fastest run.', 'Add a ghost car that replays my fastest completed run during this play session, with a best-time display. Keep the existing straight race.', 'mechanic') :
      idea('Race your ghost', 'Chase a replay of your best lap.', 'Add a ghost car that replays my best completed lap during this play session, with a best-lap timer. Keep the existing race.', 'mechanic'),
    idea('A changing sky', 'Let the world shift as the race heats up.', 'Add a gentle animated sky and changing environmental lighting as the race progresses. Preserve the track and gameplay.', 'world'),
  ] : game.category === 'puzzle' || game.category === 'strategy' ? [
    idea('A helpful hint', 'Offer a nudge when a player gets stuck.', 'Add an optional hint button that gives one useful clue at a time without solving the puzzle for me.', 'mechanic'),
    idea('One more challenge', 'Introduce a new twist after the first win.', 'Add a second challenge after winning, reusing the existing mechanics and art with a new arrangement.', 'mechanic'),
    idea('Make every move feel good', 'Give successful actions a satisfying response.', 'Add gentle animation, particles and optional synthesized sound for successful interactions, with a mute control.', 'feel'),
  ] : [
    idea('A secret to discover', 'Give curious players a hidden reward.', 'Add a discoverable secret area or hidden bonus suited to this game, with a visual clue and a small reward. Preserve the current goals.', 'world'),
    idea('A new power-up', 'Add a temporary ability that changes how you play.', 'Add one clearly marked temporary power-up suited to this game, with a visible duration and an explanation of its effect. Keep all current mechanics.', 'mechanic'),
    idea('Celebrate the win', 'Make the finish feel like an achievement.', 'Improve the win moment with a short celebration, animated particles, a results card and a replay button. Preserve the existing game.', 'feel'),
  ];
  const extra = idea('Choose your challenge', 'Let players pick a relaxed or tougher run.', 'Add an easy and hard difficulty choice before play. Explain what changes and preserve the existing mechanics and art.', 'mechanic');
  return [...candidates, extra].filter(s => !(
    /ghost/.test(s.prompt) && /ghost/.test(existing) ||
    /drift/.test(s.prompt) && /drift/.test(existing) ||
    /power-up/.test(s.prompt) && /power.up/.test(existing) ||
    /hint button/.test(s.prompt) && /hint button/.test(existing)
  )).slice(0, 3);
}

function idea(title: string, description: string, prompt: string, kind: GameSuggestion['kind']): GameSuggestion {
  return { title, description, prompt, kind };
}

/** Queue ideas for review without replacing the user's own request. */
export function addIdea(request: string, suggestion: GameSuggestion): string {
  if (request.includes(suggestion.prompt)) return request;
  const combined = request.trim() ? `${request.trim()}\n\n${suggestion.prompt}` : suggestion.prompt;
  return combined.length <= 8000 ? combined : request;
}

/** Keep the next choices small and varied; the complete proposals stay intact. */
export function nextIdeas(suggestions: GameSuggestion[]): GameSuggestion[] {
  const first = suggestions[0];
  if (!first) return [];
  const second = suggestions.find(s => s.kind !== first.kind) ?? suggestions[1];
  return second ? [first, second] : [first];
}

export function briefReply(text: string, limit = 180): string {
  if (text.length <= limit) return text;
  const end = text.lastIndexOf(' ', limit);
  return text.slice(0, end > 0 ? end : limit).trimEnd() + '…';
}
