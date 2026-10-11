export type Command = { kind: 'race'; levelId: string; version?: number } | { kind: 'invite'; matchId: string; invite: string } | { kind: 'help' };

export function parseCommand(text: string): Command | null {
  const input = text.trim();
  if (/^(help|hi|hello|start)$/i.test(input)) return { kind: 'help' };
  const race = /^race\s+([A-Za-z0-9_-]{1,100})(?:\s+v([1-9][0-9]{0,5}))?$/i.exec(input);
  if (race) return { kind: 'race', levelId: race[1], ...(race[2] ? { version: Number(race[2]) } : {}) };
  const invite = /^invite\s+(r_[a-f0-9]{24})\s+([A-Za-z0-9_-]{32,100})$/i.exec(input);
  if (invite) return { kind: 'invite', matchId: invite[1], invite: invite[2] };
  return null;
}

export interface Match {
  id: string; title: string; phase: string; round: number; winner: number | null; expires_at: number;
  players: { seat: number; name: string; forfeit: boolean; result: { elapsed_ms: number; verified: boolean } | null }[];
}

export function resultText(match: Match): string {
  const winner = match.players.find(player => player.seat === match.winner);
  const outcome = winner ? `${winner.name} wins!` : match.players.every(player => player.result) ? "It's a tie!" : 'Neither player finished.';
  const times = match.players.map(player => player.result?.verified
    ? `${player.name}: ${(player.result.elapsed_ms / 1000).toFixed(2)}s (verified)`
    : `${player.name}: did not finish`).join('\n');
  return `${match.title}\n${outcome}\n${times}\nOpen your game card to rematch.`;
}

export const HELP = 'Race a friend in draw.play!\nOpen a platformer, tap “Play with a friend”, then “Start a race in iMessage”. Forward the card to your friend.\nYou can also text: race <level-id>\nBoth players join the card and tap Ready inside the game. Install Spectrum’s Messages app once to play inside iMessage.';
