/** Replay codec (§8.4, lane A): RLE (u16 LE run, u8 bits) in base64. */
import { describe, expect, it } from 'vitest';
import { decodeReplay, encodeReplay } from '../replay/codec.ts';
import { fromBase64, toBase64 } from '../util/base64.ts';

describe('replay codec', () => {
  it('round-trips long runs (split at 65535) and random inputs', () => {
    const frames = new Uint8Array(140_000);
    let s = 7;
    for (let i = 70_000; i < frames.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      frames[i] = (s >>> 16) & 31;
    }
    expect(decodeReplay(encodeReplay(frames))).toEqual(frames);
  });

  it('a 60 s run with typical inputs stays under 1 KB', () => {
    const frames = new Uint8Array(3600);
    for (let i = 0; i < frames.length; i++) frames[i] = (i >> 5) % 3 === 0 ? 2 | 8 : (i >> 5) % 3 === 1 ? 2 | 4 | 8 : 0;
    expect(encodeReplay(frames).length).toBeLessThan(1024);
  });

  it('base64 matches the RFC 4648 vectors', () => {
    const v: [string, string][] = [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']];
    for (const [plain, enc] of v) {
      const bytes = Uint8Array.from([...plain].map((c) => c.charCodeAt(0)));
      expect(toBase64(bytes)).toBe(enc);
      expect(Array.from(fromBase64(enc))).toEqual(Array.from(bytes));
    }
  });
});
