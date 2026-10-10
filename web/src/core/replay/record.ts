/**
 * Replay recording (§8.4) for hosts that drive a Sim themselves (the engine, the #/dev conformance page, bots that
 * hand a run to verifyRun). One byte per sim step, from frame 0; mark()/truncate() keep the log consistent with a
 * rewind; replay() packs it as a Replay with the level and profile hashes. A Sim created with
 * createSim(level, { record: true }) records the same bytes by itself (sim.inputs(), sim.replay()).
 */
import { INPUT_MASK } from '../sim/types.ts';
import type { LevelV2, Replay } from '../types.gen.ts';
import { CORE_VERSION } from '../util/version.ts';
import { MAX_RUN_FRAMES, makeReplay, traceToInputs } from './verify.ts';

/** The bot's run (report.trace, run-length pairs from frame 0) as a Replay: "Watch the bot" ghosts, bot proofs. */
export function replayOfTrace(level: LevelV2, trace: number[], coreVersion: string = CORE_VERSION): Replay {
  return makeReplay(level, traceToInputs(trace ?? []), coreVersion);
}

export class ReplayRecorder {
  private buf = new Uint8Array(4096);
  private n = 0;
  private first = -1;

  /** Records the input of one sim step (call it with exactly the byte passed to sim.step). */
  push(bits: number): void {
    if (this.n >= this.buf.length) {
      const b = new Uint8Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    const v = bits & INPUT_MASK;
    if (this.first < 0 && v !== 0) this.first = this.n;
    this.buf[this.n++] = v;
  }

  /** Steps recorded. */
  get frames(): number {
    return this.n;
  }

  /** Frame index of the first non-zero input (where the speedrun clock starts), −1 before any input. */
  get firstInput(): number {
    return this.first;
  }

  /** Over the 20-minute limit verifyRun enforces (a longer run can be played but never submitted). */
  get tooLong(): boolean {
    return this.n > MAX_RUN_FRAMES;
  }

  /** The current length, to truncate back to after a rewind to a snapshot taken now. */
  mark(): number {
    return this.n;
  }

  /** Drops every step after `frames` (a rewind to a snapshot taken at mark() === frames). */
  truncate(frames: number): void {
    this.n = Math.max(0, Math.min(this.n, Math.floor(frames)));
    if (this.first >= this.n) {
      this.first = -1;
      for (let i = 0; i < this.n; i++) if (this.buf[i] !== 0) {
        this.first = i;
        break;
      }
    }
  }

  clear(): void {
    this.n = 0;
    this.first = -1;
  }

  inputs(): Uint8Array {
    return this.buf.slice(0, this.n);
  }

  replay(level: LevelV2, coreVersion: string = CORE_VERSION): Replay {
    return makeReplay(level, this.inputs(), coreVersion);
  }
}
