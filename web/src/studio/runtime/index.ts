/**
 * The Studio runtime (docs/v6/CONTRACTS_V6.md §4): plays a GameDoc with Phaser + Matter physics. v6 skeleton: a
 * placeholder until lane R lands the runtime. The API below is the contract the Studio and the play screen use.
 */
import type { GameDoc } from '../../core/types.gen.ts';

export interface RuntimeEvent {
  type: 'ready' | 'win' | 'lose' | 'scene' | 'counter' | 'say' | 'destroyed' | 'spawned' | 'error';
  scene?: string;
  object?: string;
  counter?: string;
  value?: number;
  text?: string;
}

export interface RuntimeOptions {
  scene?: string; // scene id to start in (default: the first)
  onEvent?: (e: RuntimeEvent) => void;
  muted?: boolean;
}

export interface RuntimeHandle {
  stop(): void;
  restart(): void;
  setPaused(paused: boolean): void;
  /** Live counters: `game` plus one entry per object id that has counters (the Studio's watch panel). */
  counters(): Record<string, Record<string, number>>;
}

export function mountRuntime(parent: HTMLElement, doc: GameDoc, o: RuntimeOptions = {}): RuntimeHandle {
  const note = document.createElement('p');
  note.textContent = `${doc.title}: the runtime is being built.`;
  parent.append(note);
  o.onEvent?.({ type: 'ready' });
  return { stop: () => note.remove(), restart: () => undefined, setPaused: () => undefined, counters: () => ({}) };
}
