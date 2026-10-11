/**
 * Synthesized sound for the Studio runtime (docs/v6/CONTRACTS_V6.md §4.1): WebAudio only, no files. Short SFX recipes
 * (the catalog's sound names plus the runtime's juice sounds), a car engine hum and a small procedural music loop per
 * theme.music style, seeded by the game id. Everything is silent until the first input resumes the AudioContext and
 * stays silent when muted. Never throws.
 */

type Ctx = AudioContext;

const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 7, 9, 12, 14, 16],
  minor: [0, 3, 5, 7, 10, 12, 15, 17],
  dorian: [0, 2, 3, 5, 7, 9, 10, 12],
  spooky: [0, 1, 3, 6, 7, 10, 12, 13],
};

interface MusicStyle {
  bpm: number;
  scale: number[];
  root: number; // midi
  lead: OscillatorType;
  bass: OscillatorType;
  hats: boolean;
  kick: boolean;
  density: number;
  gain: number;
}

const STYLES: Record<string, MusicStyle> = {
  calm: { bpm: 84, scale: SCALES.major, root: 60, lead: 'sine', bass: 'triangle', hats: false, kick: false, density: 0.35, gain: 0.5 },
  upbeat: { bpm: 116, scale: SCALES.major, root: 62, lead: 'square', bass: 'triangle', hats: true, kick: true, density: 0.55, gain: 0.35 },
  spooky: { bpm: 88, scale: SCALES.spooky, root: 57, lead: 'sine', bass: 'sawtooth', hats: false, kick: false, density: 0.3, gain: 0.45 },
  heroic: { bpm: 108, scale: SCALES.dorian, root: 57, lead: 'sawtooth', bass: 'triangle', hats: true, kick: true, density: 0.5, gain: 0.3 },
  chiptune: { bpm: 138, scale: SCALES.major, root: 64, lead: 'square', bass: 'square', hats: true, kick: true, density: 0.7, gain: 0.25 },
  racing: { bpm: 150, scale: SCALES.minor, root: 59, lead: 'sawtooth', bass: 'sawtooth', hats: true, kick: true, density: 0.6, gain: 0.25 },
};

const midi = (m: number): number => 440 * 2 ** ((m - 69) / 12);

function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Sound {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private muted: boolean;
  private musicStyle: string = 'none';
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private nextNote = 0;
  private step = 0;
  private pattern: { lead: (number | null)[]; bass: (number | null)[] } | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private last = new Map<string, number>();
  private disposed = false;

  constructor(muted = false) {
    this.muted = muted;
  }

  private ensure(): Ctx | null {
    if (this.disposed) return null;
    if (this.ctx) return this.ctx;
    try {
      const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!AC) return null;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp);
      comp.connect(ctx.destination);
      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = 0.16;
      this.musicGain.connect(this.master);
      const len = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return ctx;
    } catch {
      return null;
    }
  }

  /** Call from an input handler (browsers start audio only after a gesture). */
  resume(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => undefined);
    if (this.musicStyle !== 'none' && !this.musicTimer) this.startMusicLoop();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  // ---- building blocks -----------------------------------------------------------------------------

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, at = 0, dest?: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest ?? this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, freq: number, q = 1, at = 0, type: BiquadFilterType = 'bandpass', f1?: number, dest?: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuf) return;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest ?? this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  /** Play a sound effect by name (catalog names: ding boing zap whoosh boom fanfare hit coin jump lose; plus juice). */
  play(name: string, o: { pitch?: number; gain?: number } = {}): void {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running') return;
    // don't stack the same sound in the same few ms
    const now = ctx.currentTime;
    if ((this.last.get(name) ?? -1) > now - 0.035) return;
    this.last.set(name, now);
    const p = o.pitch ?? 1;
    const g = o.gain ?? 1;
    try {
      switch (name) {
        case 'ding':
          this.tone('sine', 1320 * p, 1320 * p, 0.35, 0.25 * g);
          this.tone('sine', 1980 * p, 1980 * p, 0.25, 0.1 * g, 0.01);
          break;
        case 'coin':
        case 'pickup':
          this.tone('square', 988 * p, 988 * p, 0.07, 0.12 * g);
          this.tone('square', 1319 * p, 1319 * p, 0.22, 0.12 * g, 0.07);
          break;
        case 'boing':
          this.tone('sine', 180 * p, 620 * p, 0.28, 0.35 * g);
          this.tone('triangle', 90 * p, 300 * p, 0.3, 0.2 * g);
          break;
        case 'zap':
        case 'shoot':
          this.tone('sawtooth', 1400 * p, 180 * p, 0.14, 0.12 * g);
          break;
        case 'whoosh':
        case 'launch':
          this.noise(0.35, 0.25 * g, 400 * p, 0.8, 0, 'bandpass', 2400 * p);
          break;
        case 'swing':
          this.noise(0.14, 0.16 * g, 900 * p, 1.2, 0, 'bandpass', 3000 * p);
          break;
        case 'boom':
          this.tone('sine', 120 * p, 30, 0.6, 0.55 * g);
          this.noise(0.5, 0.35 * g, 600, 0.6, 0, 'lowpass', 80);
          break;
        case 'poof':
          this.noise(0.22, 0.18 * g, 1200, 0.7, 0, 'lowpass', 200);
          break;
        case 'hit':
          this.tone('square', 220 * p, 70 * p, 0.12, 0.22 * g);
          this.noise(0.08, 0.25 * g, 1800, 1, 0, 'highpass');
          break;
        case 'jump':
          this.tone('square', 300 * p, 620 * p, 0.14, 0.09 * g);
          break;
        case 'land':
          this.noise(0.09, 0.12 * g, 300, 0.8, 0, 'lowpass', 90);
          break;
        case 'checkpoint':
          [0, 4, 7, 12].forEach((s, i) => this.tone('triangle', midi(72 + s) * p, midi(72 + s) * p, 0.18, 0.12 * g, i * 0.07));
          break;
        case 'fanfare':
        case 'win':
          [0, 4, 7, 12, 7, 12].forEach((s, i) => this.tone(i % 2 ? 'square' : 'triangle', midi(67 + s), midi(67 + s), i === 5 ? 0.7 : 0.16,
            0.14 * g, [0, 0.12, 0.24, 0.36, 0.52, 0.64][i]));
          break;
        case 'lose':
          [0, -3, -6, -10].forEach((s, i) => this.tone('triangle', midi(64 + s), midi(64 + s) * 0.97, 0.3, 0.14 * g, i * 0.18));
          break;
        case 'blip':
          this.tone('square', 660 * p, 760 * p, 0.05, 0.06 * g);
          break;
        case 'thrust':
          this.noise(0.12, 0.08 * g, 300, 0.7, 0, 'lowpass', 120);
          break;
        case 'spawn':
          this.tone('sine', 500 * p, 900 * p, 0.12, 0.06 * g);
          break;
        case 'heal':
          this.tone('sine', 660 * p, 1320 * p, 0.3, 0.12 * g);
          break;
        default:
          this.tone('sine', 880 * p, 880 * p, 0.2, 0.15 * g);
      }
    } catch {
      /* audio is best effort */
    }
  }

  /** A continuous engine hum (0 = off, 1 = full revs). */
  engine(level: number): void {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running') {
      if (this.engineGain && ctx) this.engineGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      return;
    }
    try {
      if (!this.engineOsc) {
        this.engineOsc = ctx.createOscillator();
        this.engineOsc.type = 'sawtooth';
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 420;
        this.engineGain = ctx.createGain();
        this.engineGain.gain.value = 0;
        this.engineOsc.connect(f);
        f.connect(this.engineGain);
        this.engineGain.connect(this.master!);
        this.engineOsc.start();
      }
      const l = Math.max(0, Math.min(1, level));
      this.engineOsc.frequency.setTargetAtTime(48 + l * 90, ctx.currentTime, 0.08);
      this.engineGain!.gain.setTargetAtTime(l > 0.01 ? 0.05 + l * 0.05 : 0.025, ctx.currentTime, 0.1);
    } catch {
      /* best effort */
    }
  }

  // ---- music ---------------------------------------------------------------------------------------

  music(style: string, seed: number): void {
    this.stopMusic();
    this.musicStyle = STYLES[style] ? style : 'none';
    if (this.musicStyle === 'none') return;
    const st = STYLES[this.musicStyle];
    const r = seeded(seed);
    // 4 bars of 16th steps: a lead motif repeated with a variation, and a bass on the beats
    const motif: (number | null)[] = Array.from({ length: 16 }, () => (r() < st.density ? Math.floor(r() * st.scale.length) : null));
    const lead = [...motif, ...motif.map((m) => (m !== null && r() < 0.4 ? Math.min(st.scale.length - 1, m + 1) : m)), ...motif,
      ...motif.map((m, i) => (i > 11 ? (m === null ? Math.floor(r() * 4) : m) : m))];
    const prog = [0, 3, 4, 3].map((d) => st.scale[d % st.scale.length]);
    const bass = Array.from({ length: 64 }, (_, i) => (i % 4 === 0 ? prog[Math.floor(i / 16)] : i % 8 === 6 && st.kick ? prog[Math.floor(i / 16)] + 12 : null));
    this.pattern = { lead, bass };
    if (this.ctx && this.ctx.state === 'running') this.startMusicLoop();
  }

  private startMusicLoop(): void {
    const ctx = this.ctx;
    if (!ctx || !this.pattern || this.musicTimer) return;
    this.nextNote = ctx.currentTime + 0.1;
    this.step = 0;
    this.musicTimer = setInterval(() => this.schedule(), 60);
  }

  private schedule(): void {
    const ctx = this.ctx;
    const st = STYLES[this.musicStyle];
    if (!ctx || !st || !this.pattern || !this.musicGain) return;
    const stepDur = 60 / st.bpm / 4;
    while (this.nextNote < ctx.currentTime + 0.25) {
      const i = this.step % 64;
      const at = this.nextNote - ctx.currentTime;
      const l = this.pattern.lead[i];
      if (!this.muted) {
        if (l !== null && l !== undefined) this.tone(st.lead, midi(st.root + st.scale[l]), midi(st.root + st.scale[l]), stepDur * 1.8, 0.09 * st.gain * 2, at, this.musicGain);
        const b = this.pattern.bass[i];
        if (b !== null && b !== undefined) this.tone(st.bass, midi(st.root - 24 + b), midi(st.root - 24 + b), stepDur * 3, 0.16 * st.gain * 2, at, this.musicGain);
        if (st.kick && i % 4 === 0) this.tone('sine', 140, 40, 0.18, 0.3 * st.gain * 2, at, this.musicGain);
        if (st.hats && i % 2 === 1) this.noise(0.04, 0.05 * st.gain * 2, 8000, 1, at, 'highpass', undefined, this.musicGain);
      }
      this.nextNote += stepDur;
      this.step++;
    }
  }

  stopMusic(): void {
    if (this.musicTimer) clearInterval(this.musicTimer);
    this.musicTimer = null;
  }

  /** Fade the music under a moment (win/lose cards). */
  duckMusic(on: boolean): void {
    if (this.musicGain && this.ctx) this.musicGain.gain.setTargetAtTime(on ? 0.04 : 0.16, this.ctx.currentTime, 0.2);
  }

  dispose(): void {
    this.disposed = true;
    this.stopMusic();
    try {
      this.engineOsc?.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.ctx?.close().catch(() => undefined);
    } catch {
      /* closed */
    }
    this.ctx = null;
  }
}
