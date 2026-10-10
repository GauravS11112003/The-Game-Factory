/**
 * Synthesized sound (PLAN_V2 §7.8): WebAudio only, no asset files. Every SFX recipe of the table, a generative music
 * loop per theme (4 bars at 100 BPM: triangle bass on beats 1 and 3, a 12.5%-duty square lead seeded by the level id,
 * noise hats), master 0.6 / music 0.25, music ducks 50% under jingles and speeds up 10% in a timer's last 10 s.
 * Mute (M or the HUD button) persists in localStorage; the AudioContext resumes on the first input.
 *
 * The music loop is an option at three levels: the game's rules (`rules.music`), the mount (`MountOptions.music`) and
 * the player's own setting (the HUD ♪ button, persisted as `dal.v2.music`). It fades in over 400 ms, fades out when
 * paused or won, ducks briefly under a death, and alternates two variations of its 4 bars (the second pass adds a
 * melodic fill and an open hat) so the loop doesn't drone. The results card's sounds live here too: the stamp "thunk",
 * the new-record fanfare, the tally tick, the card whoosh.
 */
import { AUDIO } from '../core/params.ts';

export type Sfx = 'jump' | 'double_jump' | 'land' | 'coin' | 'big_coin' | 'stomp' | 'death' | 'spring' | 'checkpoint'
  | 'goal' | 'crumble' | 'skid' | 'door' | 'saw' | 'ui_tap'
  // the results moment (§7.9): the card slides in, stamps slap on, numbers tally, a new best, a beaten rival
  | 'whoosh' | 'stamp' | 'tick' | 'pb' | 'beat' | 'ghost_finish';

export type MusicTheme = 'sketchbook' | 'notebook' | 'graph' | 'kraft';

export interface MusicOptions {
  theme?: MusicTheme;
  seed?: string;
  fadeMs?: number;
}

export interface Mixer {
  play(s: Sfx, o?: { pitch?: number; gain?: number; chain?: number; impact?: number }): void;
  setMuted(m: boolean): void; // persisted
  readonly muted: boolean;
  /** Silence without touching the persisted setting (the preview stays muted until Play). */
  setSessionMuted(m: boolean): void;
  /** Resume the AudioContext; call from a user input handler. */
  resume(): void;
  /** Start (on) or stop (off, faded) the theme's loop. Does nothing while the player's music setting is off. */
  music(on: boolean, o?: MusicOptions): void;
  /** The player's own music setting (persisted); false silences the loop but keeps the sound effects. */
  readonly musicEnabled: boolean;
  setMusicEnabled(v: boolean): void;
  /** True while the loop is scheduled (music(true) was called and the setting allows it). */
  readonly musicPlaying: boolean;
  setTempo(f: number): void;
  setSaw(proximity: number): void; // 0..1, the saw whirr gain follows proximity
  /** Duck the music (×0.5) for ms. */
  duck(ms: number): void;
  dispose(): void;
}

const MUTE_KEY = 'dal.v2.muted';
const MUSIC_KEY = 'dal.v2.music';

function readFlag(key: string, dflt: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === '1';
  } catch {
    return dflt;
  }
}

function writeFlag(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* storage refused: the setting lasts for this page */
  }
}

/** The player's persisted settings (also read by the HUD buttons). */
export function readMuted(): boolean {
  return readFlag(MUTE_KEY, false);
}
export function readMusicEnabled(): boolean {
  return readFlag(MUSIC_KEY, true);
}

let ctxShared: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;
let pulseWave: PeriodicWave | null = null;
const live = new Set<(m: boolean) => void>(); // every mixer's mute sync (a mute in one mixer silences the others)

function audioCtx(): AudioContext | null {
  if (ctxShared) return ctxShared;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctxShared = new AC();
  } catch {
    ctxShared = null;
  }
  return ctxShared;
}

function noise(ac: AudioContext): AudioBuffer {
  if (noiseBuf) return noiseBuf;
  const b = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = b.getChannelData(0);
  let s = 0x2545f491;
  for (let i = 0; i < d.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
  }
  noiseBuf = b;
  return b;
}

/** A 12.5%-duty pulse as a PeriodicWave (cosine series of a pulse train). */
function pulse(ac: AudioContext): PeriodicWave {
  if (pulseWave) return pulseWave;
  const N = 40;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const d = AUDIO.lead_duty;
  for (let n = 1; n < N; n++) re[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * d);
  pulseWave = ac.createPeriodicWave(re, im);
  return pulseWave;
}

const NOTE_IDX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteHz(name: string): number {
  const m = /^([A-G])(#?)(\d)$/.exec(name);
  if (!m) return 440;
  const midi = 12 * (Number(m[3]) + 1) + NOTE_IDX[m[1]] + (m[2] ? 1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}
const midiHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);
const semis = (s: number): number => 2 ** (s / 12);

const SCALES: Record<MusicTheme, { root: number; steps: number[] }> = {
  sketchbook: { root: 60, steps: [0, 2, 4, 7, 9] }, // C major pentatonic
  notebook: { root: 62, steps: [0, 2, 3, 5, 7, 9, 10] }, // D dorian
  graph: { root: 67, steps: [0, 2, 4, 5, 7, 9, 10] }, // G mixolydian
  kraft: { root: 57, steps: [0, 3, 5, 7, 10] }, // A minor pentatonic
};

/** The scale each theme's loop uses (for the theme picker's label). */
export function musicScale(theme: MusicTheme): string {
  return AUDIO.themes[theme] ?? AUDIO.themes.sketchbook;
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0 || 1;
}

interface Pattern {
  leadA: (number | null)[]; // 32 eighth notes (4 bars)
  leadB: (number | null)[]; // the second pass: a variation with a fill in bar 4
  fill: number[]; // 16th-note run over the last 2 beats of the B pass
  bass: number[]; // one root per bar, played on beats 1 and 3
}

/** The 4-bar loop for a theme, seeded by the level id (same level → same tune, everywhere). */
export function makePattern(theme: MusicTheme, seed: string): Pattern {
  const sc = SCALES[theme] ?? SCALES.sketchbook;
  let s = hashStr(`${seed}|${theme}|music`);
  const r = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const n = sc.steps.length;
  const deg = (d: number): number => sc.root + 12 * Math.floor(d / n) + sc.steps[((d % n) + n) % n];
  // I – V – iii – IV feel on 5-note scales, I – vi – IV – V on 7-note modes
  const roots = n === 5 ? [0, 3, 2, 1] : [0, 5, 3, 4];
  const bass: number[] = roots.map((d) => deg(d) - 24);
  const leadA: (number | null)[] = [];
  const degs: (number | null)[] = [];
  let d = n + Math.floor(r() * n);
  for (let i = 0; i < 32; i++) {
    const onBeat = i % 2 === 0;
    const strong = i % 8 === 0;
    if (strong || r() < (onBeat ? 0.68 : 0.36)) {
      d += Math.round((r() - 0.5) * 4);
      d = Math.max(n - 2, Math.min(2 * n + 2, d));
      if (strong) d = n + roots[Math.floor(i / 8)] + (r() < 0.5 ? 0 : 2); // land on a chord tone each bar
      degs.push(d);
      leadA.push(deg(d));
    } else {
      degs.push(null);
      leadA.push(null);
    }
  }
  // B: the same tune with a few notes lifted a step and the last 2 beats replaced by a fill back to the top
  const leadB = leadA.map((m, i) => {
    if (m === null || i >= 28) return i >= 28 ? null : m;
    const dd = degs[i]!;
    return i % 8 === 3 || i % 8 === 6 ? deg(dd + 1) : m;
  });
  const top = n + roots[0];
  const fill: number[] = [];
  for (let k = 0; k < 8; k++) fill.push(deg(top - 4 + k));
  return { leadA, leadB, fill, bass };
}

export function createMixer(o: { muted?: boolean; music?: boolean } = {}): Mixer {
  let persisted = o.muted ?? readMuted();
  let musicSetting = o.music ?? readMusicEnabled();
  let session = false;
  let ac: AudioContext | null = null;
  let master: GainNode | null = null;
  let sfx: GainNode | null = null;
  let musicBus: GainNode | null = null;
  let duckGain: GainNode | null = null;
  let sawSrc: AudioBufferSourceNode | null = null;
  let sawGain: GainNode | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let tempo = 1;
  let musicWanted = false; // music(true) was asked for (the setting may still hold it back)
  let musicTheme: MusicTheme = 'sketchbook';
  let musicSeed = 'level';
  let pattern: Pattern | null = null;
  let step = 0;
  let nextT = 0;
  let coinCombo = 0;
  let lastCoin = -1e9;
  let disposed = false;
  let callGain = 1; // the play() call's gain multiplier (music tones are scheduled with 1)

  const silent = (): boolean => persisted || session;

  const ensure = (): AudioContext | null => {
    if (disposed) return null;
    if (ac && master) return ac;
    ac = audioCtx();
    if (!ac) return null;
    master = ac.createGain();
    master.gain.value = silent() ? 0 : AUDIO.master;
    master.connect(ac.destination);
    sfx = ac.createGain();
    sfx.connect(master);
    duckGain = ac.createGain();
    duckGain.connect(master);
    musicBus = ac.createGain();
    musicBus.gain.value = 0.0001;
    musicBus.connect(duckGain);
    return ac;
  };

  const applyMute = (): void => {
    if (!ac || !master) return;
    master.gain.setTargetAtTime(silent() ? 0 : AUDIO.master, ac.currentTime, 0.02);
  };
  const syncMute = (m: boolean): void => {
    persisted = m;
    applyMute();
  };
  live.add(syncMute);

  function tone(type: OscillatorType | 'pulse', f0: number, f1: number, durMs: number, x: { attackMs?: number; decayMs?: number; gain?: number; when?: number; dest?: AudioNode; detune?: number } = {}): void {
    if (!ac || !sfx) return;
    const t = ac.currentTime + (x.when ?? 0);
    const osc = ac.createOscillator();
    if (type === 'pulse') osc.setPeriodicWave(pulse(ac));
    else osc.type = type;
    if (x.detune) osc.detune.value = x.detune;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + durMs / 1000);
    const g = ac.createGain();
    const a = (x.attackMs ?? 2) / 1000;
    const d = (x.decayMs ?? durMs) / 1000;
    const peak = Math.max(0.0002, (x.gain ?? 0.15) * (x.dest && x.dest !== sfx ? 1 : callGain));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    osc.connect(g).connect(x.dest ?? sfx);
    osc.start(t);
    osc.stop(t + a + d + 0.03);
  }

  function burst(durMs: number, filter: BiquadFilterType, hz: number, x: { gain?: number; when?: number; q?: number; dest?: AudioNode; toHz?: number } = {}): void {
    if (!ac || !sfx) return;
    const t = ac.currentTime + (x.when ?? 0);
    const src = ac.createBufferSource();
    src.buffer = noise(ac);
    const f = ac.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(hz, t);
    if (x.toHz) f.frequency.exponentialRampToValueAtTime(Math.max(20, x.toHz), t + durMs / 1000);
    f.Q.value = x.q ?? 1;
    const g = ac.createGain();
    const d = durMs / 1000;
    g.gain.setValueAtTime(Math.max(0.0002, (x.gain ?? 0.2) * (x.dest && x.dest !== sfx ? 1 : callGain)), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    src.connect(f).connect(g).connect(x.dest ?? sfx);
    src.start(t, Math.random() * 0.5);
    src.stop(t + d + 0.02);
  }

  function duck(ms: number): void {
    if (!ac || !duckGain) return;
    const t = ac.currentTime;
    duckGain.gain.cancelScheduledValues(t);
    duckGain.gain.setTargetAtTime(AUDIO.duck, t, 0.02);
    duckGain.gain.setTargetAtTime(1, t + ms / 1000, 0.15);
  }

  function fm(): void {
    if (!ac || !sfx) return;
    const t = ac.currentTime;
    const d = AUDIO.spring.ms / 1000;
    const car = ac.createOscillator();
    const mod = ac.createOscillator();
    const mg = ac.createGain();
    const g = ac.createGain();
    car.frequency.value = AUDIO.spring.carrier_hz;
    mod.frequency.value = AUDIO.spring.mod_hz;
    mg.gain.setValueAtTime(AUDIO.spring.index[0] * AUDIO.spring.mod_hz, t);
    mg.gain.linearRampToValueAtTime(AUDIO.spring.index[1] * AUDIO.spring.mod_hz + 0.0001, t + d);
    mod.connect(mg).connect(car.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2 * callGain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    car.connect(g).connect(sfx);
    car.start(t);
    mod.start(t);
    car.stop(t + d + 0.03);
    mod.stop(t + d + 0.03);
  }

  // ---- music --------------------------------------------------------------------------------------
  function schedule(): void {
    if (!ac || !musicBus || !pattern) return;
    const stepDur = 60 / AUDIO.bpm / 2 / tempo; // eighth notes
    while (nextT < ac.currentTime + 0.15) {
      const when = Math.max(0, nextT - ac.currentTime);
      const i = step % 32;
      const pass = Math.floor(step / 32) % 2;
      const bar = Math.floor(i / 8);
      if (i % 4 === 0) {
        const f = midiHz(pattern.bass[bar]);
        tone('triangle', f, f, stepDur * 1800, { gain: 0.5, when, dest: musicBus, attackMs: 6, decayMs: stepDur * 1700 });
      }
      const lead = pass ? pattern.leadB : pattern.leadA;
      const ln = lead[i];
      if (ln !== null && ln !== undefined) tone('pulse', midiHz(ln), midiHz(ln), stepDur * 900, { gain: 0.16, when, dest: musicBus, attackMs: 4, decayMs: stepDur * 850 });
      if (pass && i >= 28) {
        // the fill: two sixteenths per eighth, climbing back to the top of the loop
        for (let h = 0; h < 2; h++) {
          const m = pattern.fill[(i - 28) * 2 + h];
          tone('pulse', midiHz(m), midiHz(m), stepDur * 450, { gain: 0.13, when: when + (h * stepDur) / 2, dest: musicBus, attackMs: 3, decayMs: stepDur * 420 });
        }
      }
      // hats: closed on every eighth (accent off the beat); on the B pass an open hat on the "and" of 4
      const open = pass === 1 && i % 8 === 7;
      burst(open ? 110 : 25, 'highpass', open ? 6000 : 7000, { gain: open ? 0.07 : i % 2 ? 0.08 : 0.045, when, dest: musicBus });
      step++;
      nextT += stepDur;
    }
  }

  const musicOn = (): boolean => musicWanted && musicSetting && !disposed;

  function startLoop(fadeMs: number): void {
    const a = ensure();
    if (!a || !musicBus) return;
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    const t = a.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), t);
    musicBus.gain.linearRampToValueAtTime(AUDIO.music, t + Math.max(0.01, fadeMs / 1000));
    if (timer) return; // already looping: just faded back in
    step = 0;
    nextT = a.currentTime + 0.08;
    timer = setInterval(() => {
      if (ac && ac.state === 'running') schedule();
      else if (ac) nextT = ac.currentTime + 0.05;
    }, 30);
  }

  function stopLoop(fadeMs: number): void {
    if (!timer) return;
    if (!ac || !musicBus || fadeMs <= 0) {
      if (timer) clearInterval(timer);
      timer = null;
      if (musicBus && ac) musicBus.gain.setValueAtTime(0.0001, ac.currentTime);
      return;
    }
    const t = ac.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), t);
    musicBus.gain.linearRampToValueAtTime(0.0001, t + fadeMs / 1000);
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (musicOn()) return; // turned back on during the fade
      if (timer) clearInterval(timer);
      timer = null;
    }, fadeMs + 30);
  }

  const mixer: Mixer = {
    get muted() {
      return persisted;
    },
    get musicEnabled() {
      return musicSetting;
    },
    get musicPlaying() {
      return musicOn() && timer !== null;
    },
    setMuted(m) {
      writeFlag(MUTE_KEY, m);
      for (const f of live) f(m);
    },
    setSessionMuted(m) {
      session = m;
      applyMute();
    },
    setMusicEnabled(v) {
      musicSetting = v;
      writeFlag(MUSIC_KEY, v);
      if (musicOn()) startLoop(400);
      else stopLoop(250);
    },
    resume() {
      const a = ensure();
      if (a && a.state === 'suspended') void a.resume().catch(() => undefined);
    },
    duck(ms) {
      duck(ms);
    },
    play(s, x = {}) {
      const a = ensure();
      if (!a || silent() || a.state !== 'running') return;
      const p = semis(x.pitch ?? 0);
      callGain = Math.max(0, Math.min(2, x.gain ?? 1));
      switch (s) {
        case 'jump': {
          const j = 1 + (Math.random() * 2 - 1) * AUDIO.jump.pitch_jitter; // UI-side RNG, never the sim's
          tone('square', AUDIO.jump.hz[0] * j * p, AUDIO.jump.hz[1] * j * p, AUDIO.jump.ms, { attackMs: AUDIO.jump.attack_ms, decayMs: AUDIO.jump.decay_ms, gain: AUDIO.jump.gain });
          break;
        }
        case 'double_jump':
          tone('triangle', AUDIO.double_jump.hz[0] * p, AUDIO.double_jump.hz[1] * p, AUDIO.double_jump.ms, { gain: 0.18 });
          break;
        case 'land': {
          const k = Math.max(0.15, Math.min(1.2, x.impact ?? 0.6));
          burst(AUDIO.land.ms, 'lowpass', AUDIO.land.lowpass_hz, { gain: 0.35 * k });
          break;
        }
        case 'coin': {
          const now = a.currentTime;
          coinCombo = now - lastCoin <= AUDIO.coin.combo_window_s ? Math.min(AUDIO.coin.combo_cap, coinCombo + 1) : 0;
          lastCoin = now;
          const c = semis(coinCombo) * p;
          tone('triangle', AUDIO.coin.notes_hz[0] * c, AUDIO.coin.notes_hz[0] * c, AUDIO.coin.ms[0], { gain: 0.16 });
          tone('triangle', AUDIO.coin.notes_hz[1] * c, AUDIO.coin.notes_hz[1] * c, AUDIO.coin.ms[1], { gain: 0.16, when: AUDIO.coin.ms[0] / 1000 });
          break;
        }
        case 'big_coin': {
          const nm = AUDIO.big_coin.note_ms / 1000;
          AUDIO.big_coin.notes.forEach((n, i) => tone('triangle', noteHz(n), noteHz(n), AUDIO.big_coin.note_ms * 1.6, { gain: 0.17, when: i * nm }));
          const top = noteHz(AUDIO.big_coin.notes[AUDIO.big_coin.notes.length - 1]);
          for (const det of [-9, 9]) tone('triangle', top, top, 380, { gain: 0.07, when: 3 * nm, detune: det, decayMs: 420 });
          duck(700);
          break;
        }
        case 'stomp': {
          const c = semis(AUDIO.stomp.chain_semitones * Math.max(0, (x.chain ?? 1) - 1)) * p;
          tone('square', AUDIO.stomp.hz[0] * c, AUDIO.stomp.hz[1] * c, AUDIO.stomp.ms, { gain: 0.2 });
          burst(18, 'highpass', 2500, { gain: 0.25 });
          break;
        }
        case 'death':
          tone('sawtooth', AUDIO.death.hz[0], AUDIO.death.hz[1], AUDIO.death.ms, { gain: 0.16 });
          burst(AUDIO.death.noise_ms, 'lowpass', 1800, { gain: 0.3 });
          duck(450);
          break;
        case 'spring':
          fm();
          break;
        case 'checkpoint':
          tone('triangle', AUDIO.checkpoint.notes_hz[0], AUDIO.checkpoint.notes_hz[0], 120, { gain: 0.18 });
          tone('triangle', AUDIO.checkpoint.notes_hz[1], AUDIO.checkpoint.notes_hz[1], 260, { gain: 0.18, when: 0.12 });
          break;
        case 'goal': {
          const each = AUDIO.goal.ms / AUDIO.goal.notes.length / 1000;
          AUDIO.goal.notes.forEach((n, i) => {
            const f = noteHz(n);
            const last = i === AUDIO.goal.notes.length - 1;
            tone('square', f, f, each * 1000 * (last ? 2.4 : 0.9), { gain: 0.09, when: i * each });
            tone('triangle', f, f, each * 1000 * (last ? 2.4 : 0.9), { gain: 0.15, when: i * each });
          });
          duck(AUDIO.goal.ms + 500);
          break;
        }
        case 'crumble':
          burst(AUDIO.crumble.ms, 'bandpass', AUDIO.crumble.bandpass_hz, { gain: 0.4, q: 1.2 });
          break;
        case 'skid':
          burst(AUDIO.skid.ms, 'bandpass', AUDIO.skid.bandpass_hz, { gain: 0.25, q: 1.5 });
          break;
        case 'door':
          tone('triangle', AUDIO.door.hz[0], AUDIO.door.hz[1], AUDIO.door.ms, { gain: 0.2 });
          burst(160, 'lowpass', 900, { gain: 0.2 });
          break;
        case 'ui_tap':
          tone('sine', AUDIO.ui_tap.hz * p, AUDIO.ui_tap.hz * p, AUDIO.ui_tap.ms, { gain: 0.12 });
          break;
        case 'whoosh':
          // a paper card sliding in: band-passed noise sweeping up
          burst(240, 'bandpass', 480, { gain: 0.22, q: 0.9, toHz: 2600 });
          break;
        case 'stamp':
          // a rubber stamp's "thunk": a low thud, a dull body and a paper slap
          tone('sine', 150 * p, 52 * p, 120, { gain: 0.42, attackMs: 1, decayMs: 130 });
          burst(80, 'lowpass', 320, { gain: 0.34 });
          burst(32, 'bandpass', 1800, { gain: 0.12, q: 2 });
          break;
        case 'tick':
          tone('sine', 1760 * p, 1760 * p, 16, { gain: 0.05, attackMs: 1, decayMs: 18 });
          break;
        case 'pb': {
          // a new best: a rising arpeggio that rings, with a shimmer
          const notes = ['G5', 'C6', 'E6', 'G6', 'C7'];
          notes.forEach((n, i) => {
            const f = noteHz(n);
            const last = i === notes.length - 1;
            tone('triangle', f, f, last ? 420 : 110, { gain: 0.15, when: i * 0.075 });
            tone('square', f, f, last ? 300 : 80, { gain: 0.05, when: i * 0.075 });
          });
          for (const det of [-11, 11]) tone('triangle', noteHz('C7'), noteHz('C7'), 500, { gain: 0.05, when: 0.3, detune: det, decayMs: 600 });
          duck(1100);
          break;
        }
        case 'beat': {
          // you beat a rival's ghost: a short brass-ish sting
          const notes = ['C5', 'G5', 'C6', 'E6'];
          notes.forEach((n, i) => tone('square', noteHz(n), noteHz(n), i === 3 ? 360 : 90, { gain: 0.08, when: i * 0.06 }));
          burst(220, 'highpass', 5000, { gain: 0.05, when: 0.18 });
          duck(800);
          break;
        }
        case 'ghost_finish':
          // a ghost reached the goal: two soft pencil-light notes
          tone('triangle', noteHz('E5'), noteHz('E5'), 90, { gain: 0.06 });
          tone('triangle', noteHz('A5'), noteHz('A5'), 200, { gain: 0.06, when: 0.09 });
          break;
        case 'saw':
          break; // continuous: setSaw
      }
    },
    music(on, x = {}) {
      if (!on) {
        musicWanted = false;
        stopLoop(x.fadeMs ?? 300);
        return;
      }
      musicWanted = true;
      const theme = x.theme ?? musicTheme;
      const seed = x.seed ?? musicSeed;
      if (!pattern || theme !== musicTheme || seed !== musicSeed) {
        pattern = makePattern(theme, seed);
        if (timer) step = 0; // a new tune starts at its top
      }
      musicTheme = theme;
      musicSeed = seed;
      if (!musicSetting) return;
      startLoop(x.fadeMs ?? 400);
    },
    setTempo(f) {
      tempo = f;
    },
    setSaw(prox) {
      const a = ac;
      if (!a || !sfx) return;
      const g = Math.max(0, Math.min(1, prox)) * 0.12;
      if (!sawSrc && g > 0.001) {
        sawSrc = a.createBufferSource();
        sawSrc.buffer = noise(a);
        sawSrc.loop = true;
        const f = a.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 900;
        f.Q.value = 1.4;
        sawGain = a.createGain();
        sawGain.gain.value = 0;
        sawSrc.connect(f).connect(sawGain).connect(sfx);
        sawSrc.start();
      }
      if (sawGain) sawGain.gain.setTargetAtTime(silent() ? 0 : g, a.currentTime, 0.08);
    },
    dispose() {
      disposed = true;
      live.delete(syncMute);
      if (timer) clearInterval(timer);
      if (stopTimer) clearTimeout(stopTimer);
      timer = null;
      try {
        sawSrc?.stop();
      } catch {
        /* already stopped */
      }
      master?.disconnect();
      sawSrc = null;
      master = null;
    },
  };
  return mixer;
}

/**
 * Let the theme picker play a few bars of a theme's loop (§8.2). Returns a stop function; a new audition stops the
 * previous one. Call from a click handler (the AudioContext needs a user gesture).
 */
let audition: { mixer: Mixer; timer: ReturnType<typeof setTimeout> } | null = null;
export function auditionMusic(theme: MusicTheme, o: { seed?: string; ms?: number } = {}): () => void {
  stopAudition();
  // an audition plays even when the in-game music setting is off: the picker is asking to hear it
  const mixer = createMixer({ music: true });
  mixer.resume();
  mixer.music(true, { theme, seed: o.seed ?? 'theme-picker', fadeMs: 200 });
  const ms = o.ms ?? Math.round((60 / AUDIO.bpm) * 4 * 2 * 1000); // two bars
  const timer = setTimeout(() => stopAudition(), ms);
  audition = { mixer, timer };
  return stopAudition;
}

function stopAudition(): void {
  if (!audition) return;
  const a = audition;
  audition = null;
  clearTimeout(a.timer);
  a.mixer.music(false, { fadeMs: 250 });
  setTimeout(() => a.mixer.dispose(), 320);
}
