/** Synthesized WebAudio SFX and music (lane E, §7.8). P0 placeholder: a silent mixer with the final shape. */
export type Sfx = 'jump' | 'double_jump' | 'land' | 'coin' | 'big_coin' | 'stomp' | 'death' | 'spring' | 'checkpoint'
  | 'goal' | 'crumble' | 'skid' | 'door' | 'saw' | 'ui_tap';

export interface Mixer {
  play(s: Sfx, o?: { pitch?: number; gain?: number }): void;
  setMuted(m: boolean): void;
  readonly muted: boolean;
}

export function createMixer(): Mixer {
  let muted = true;
  return {
    play() {},
    setMuted(m) {
      muted = m;
    },
    get muted() {
      return muted;
    },
  };
}
