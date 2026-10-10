/**
 * Run verification (§8.4): re-simulate a replay on the level it was recorded on and recompute every number the
 * player claims. The replay is the proof of the run because the Sim is deterministic (§5.2).
 *
 * A replay is finished only when: its input decodes, it is ≤ 20 min long, its frame count matches the decoded
 * input, its level_hash and profile_hash match the level (the recomputed hash or the level's stored meta hash), and
 * the goal is touched. With a claim ({time_ms, deaths, coins, big_coins}) the run is `accepted` only when every
 * claimed number equals the re-simulated one exactly; otherwise `reason` is 'claim_mismatch' and `mismatch` names
 * the fields. Stamps are computed here, never trusted from clients:
 *   clear; collector (every big coin banked, levels with ≥ 1 big coin); speedy (time ≤ par, when the level has a
 *   par); flawless (0 deaths).
 */
import { levelHash } from '../build/hash.ts';
import { RUNS } from '../params.ts';
import { clockMs } from '../sim/core.ts';
import { profileHash } from '../sim/profiles.ts';
import { INPUT_MASK } from '../sim/types.ts';
import type { LevelV2, ProfileId, Replay, RunClaim, RunVerdict, Stamp } from '../types.gen.ts';
import { decodeReplay, encodeReplay } from './codec.ts';
import { simulateInputs } from './run.ts';

export const MAX_RUN_FRAMES = RUNS.max_log_minutes * 60 * 60;

export type VerifyReason =
  | 'ok' | 'bad_input' | 'level_hash' | 'profile_hash' | 'frames_mismatch' | 'too_long' | 'not_finished' | 'claim_mismatch';

export interface VerifyDetail extends RunVerdict {
  reason: VerifyReason;
  /** finished, and (when a claim was given) every claimed number matches: the run counts. */
  accepted: boolean;
  /** Claimed fields that differ from the re-simulation (empty without a claim). */
  mismatch: string[];
  /** Sim frame (1-based) at which the goal was touched; 0 when not finished. */
  win_frame: number;
  /** Frames of the replay (input bytes). */
  input_frames: number;
}

function emptyVerdict(reason: VerifyReason, inputFrames = 0): VerifyDetail {
  return {
    finished: false, frames: 0, time_ms: 0, deaths: 0, coins: 0, big_coins: 0, stamps: [], reason, accepted: false, mismatch: [],
    win_frame: 0, input_frames: inputFrames,
  };
}

function profileOf(level: LevelV2): ProfileId {
  return (level.rules?.physics_profile ?? 'v2-standard') as ProfileId;
}

/** Fields of a claim that differ from a verdict (time, deaths, coins, big coins); [] when everything matches. */
export function checkClaim(v: RunVerdict, c: RunClaim | null | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  const eq = (a: unknown, b: number): boolean => typeof a === 'number' && a === b;
  if (!eq(c.time_ms, v.time_ms)) out.push('time_ms');
  if (!eq(c.deaths, v.deaths)) out.push('deaths');
  if (!eq(c.coins, v.coins)) out.push('coins');
  if (!eq(c.big_coins, v.big_coins)) out.push('big_coins');
  return out;
}

/** Does the replay name this level (its recomputed gameplay hash, or the hash stored in its meta)? */
export function replayMatchesLevel(level: LevelV2, r: Replay): { level: boolean; profile: boolean } {
  let lh = '';
  try {
    lh = levelHash(level);
  } catch {
    lh = '';
  }
  const levelOk = !r.level_hash || r.level_hash === lh || (!!level.meta?.level_hash && r.level_hash === level.meta.level_hash);
  const ph = profileHash(profileOf(level));
  const profileOk = !r.profile_hash || r.profile_hash === ph || (!!level.rules?.profile_hash && r.profile_hash === level.rules.profile_hash);
  return { level: levelOk, profile: profileOk };
}

/** Stamps of a finished run (§5.9). */
export function stampsOf(level: LevelV2, v: { finished: boolean; time_ms: number; deaths: number; big_coins: number }, bigTotal: number): Stamp[] {
  const stamps: Stamp[] = [];
  if (!v.finished) return stamps;
  stamps.push('clear');
  if (bigTotal > 0 && v.big_coins >= bigTotal) stamps.push('collector');
  const par = level.design?.par_ms;
  if (typeof par === 'number' && par > 0 && v.time_ms <= par) stamps.push('speedy');
  if (v.deaths === 0) stamps.push('flawless');
  return stamps;
}

/** Full verdict with the reason; verifyRun returns the same object. */
export function verifyRunDetail(level: LevelV2, r: Replay, o?: { checkHashes?: boolean; claimed?: RunClaim | null }): VerifyDetail {
  let input: Uint8Array;
  try {
    input = decodeReplay(String(r?.input ?? ''));
  } catch {
    return emptyVerdict('bad_input');
  }
  if (input.length > MAX_RUN_FRAMES) return emptyVerdict('too_long', input.length);
  if (typeof r.frames === 'number' && r.frames !== input.length) return emptyVerdict('frames_mismatch', input.length);
  if (o?.checkHashes !== false) {
    const m = replayMatchesLevel(level, r);
    if (!m.level) return emptyVerdict('level_hash', input.length);
    if (!m.profile) return emptyVerdict('profile_hash', input.length);
  }
  const run = simulateInputs(level, input);
  const S = run.sim.S;
  const finished = S.won === 1;
  const frames = S.clockF;
  const time_ms = clockMs(frames);
  const v: VerifyDetail = {
    finished, frames, time_ms, deaths: S.deaths, coins: S.coins, big_coins: S.bigBanked, stamps: [],
    reason: finished ? 'ok' : 'not_finished', accepted: finished, mismatch: [], win_frame: run.winFrame, input_frames: input.length,
  };
  v.stamps = stampsOf(level, v, run.sim.W.bigs.length);
  if (finished && o?.claimed) {
    v.mismatch = checkClaim(v, o.claimed);
    if (v.mismatch.length) {
      v.reason = 'claim_mismatch';
      v.accepted = false;
    }
  }
  return v;
}

/**
 * §11.3(b) verifyRun. The optional claim makes `accepted` / `reason` / `mismatch` meaningful: a run is accepted only if
 * it reaches the goal and every claimed number matches exactly (a tampered run is rejected).
 */
export function verifyRun(level: LevelV2, r: Replay, claimed?: RunClaim | null): VerifyDetail {
  return verifyRunDetail(level, r, { claimed: claimed ?? null });
}

/** Builds a Replay record for recorded inputs (engine 'win' payload, bot traces, conformance replays). */
export function makeReplay(level: LevelV2, inputs: Uint8Array, coreVersion: string): Replay {
  let lh = '';
  try {
    lh = levelHash(level);
  } catch {
    lh = level.meta?.level_hash ?? '';
  }
  return {
    v: 1, core: coreVersion, profile_hash: profileHash(profileOf(level)), level_id: level.id, level_version: level.version,
    level_hash: lh, frames: inputs.length, input: encodeReplay(inputs),
  };
}

/** Expands a trace ([run, bits, run, bits, …]) into per-frame inputs (RESTART kept). */
export function traceToInputs(trace: number[]): Uint8Array {
  let n = 0;
  for (let k = 0; k + 1 < trace.length; k += 2) n += Math.max(0, trace[k] | 0);
  const out = new Uint8Array(n);
  let f = 0;
  for (let k = 0; k + 1 < trace.length; k += 2) {
    const run = Math.max(0, trace[k] | 0);
    out.fill(trace[k + 1] & INPUT_MASK, f, f + run);
    f += run;
  }
  return out;
}

/** Run-length encodes per-frame inputs into a trace ([run, bits, …]). */
export function inputsToTrace(inputs: ArrayLike<number>): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < inputs.length) {
    const b = inputs[i] & INPUT_MASK;
    let j = i + 1;
    while (j < inputs.length && (inputs[j] & INPUT_MASK) === b) j++;
    out.push(j - i, b);
    i = j;
  }
  return out;
}
