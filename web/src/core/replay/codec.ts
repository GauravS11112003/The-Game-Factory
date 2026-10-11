/**
 * Replay input codec (§8.4): base64 of RLE records (u16 little-endian run length 1..65535, u8 input bits
 * L=1 R=2 J=4 RUN=8 D=16, RESTART=32, v4 SPACE=64 ACTION=128). One input byte per sim frame. A 60 s run is ≈ 0.3-0.8 KB.
 * All 8 bits are valid (docs/v4/CONTRACTS_V4.md §4.1); Replay.v stays 1 because old replays never set 64 or 128.
 */
import { fromBase64, toBase64 } from '../util/base64.ts';

const MAX_RUN = 0xffff;
const BITS_MASK = 0xff; // L R J RUN D + RESTART (32, docs/v2/requests/E-1.md) + SPACE 64, ACTION 128 (v4 §4.1)

export function encodeReplay(inputs: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < inputs.length) {
    const bits = inputs[i];
    if (bits > BITS_MASK) throw new Error(`input byte ${bits} at frame ${i} is not a byte`);
    let j = i + 1;
    while (j < inputs.length && inputs[j] === bits && j - i < MAX_RUN) j++;
    const run = j - i;
    out.push(run & 0xff, run >> 8, bits);
    i = j;
  }
  return toBase64(Uint8Array.from(out));
}

export function decodeReplay(s: string): Uint8Array {
  const bytes = fromBase64(s);
  if (bytes.length % 3 !== 0) throw new Error('replay input is not a whole number of RLE records');
  let frames = 0;
  for (let k = 0; k < bytes.length; k += 3) {
    const run = bytes[k] | (bytes[k + 1] << 8);
    if (run === 0) throw new Error(`zero-length run in record ${k / 3}`);
    if (bytes[k + 2] > BITS_MASK) throw new Error(`invalid input bits in record ${k / 3}`);
    frames += run;
  }
  const out = new Uint8Array(frames);
  let f = 0;
  for (let k = 0; k < bytes.length; k += 3) {
    const run = bytes[k] | (bytes[k + 1] << 8);
    out.fill(bytes[k + 2], f, f + run);
    f += run;
  }
  return out;
}
