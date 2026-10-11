import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { roomDocument } from '../rooms/bridge.ts';
function fixture() {
  const emitted: any[] = [], calls: any[] = [], timers: (() => void)[] = [];
  let listener: (event: any) => void = () => {};
  const parent = { postMessage: (m: any) => emitted.push(m) };
  const adapter = { version: 1, start: (m: any) => calls.push(['start', m]), input: (...m: any[]) => calls.push(['input', ...m]), snapshot: () => ({ x: 5 }), restore: (m: any) => calls.push(['restore', m]), pause: (m: any) => calls.push(['pause', m]), result: () => null };
  const html = roomDocument('<html><body></body></html>', 'test-nonce');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1];
  vm.runInNewContext(script, { document: { querySelector: () => ({ width: 1280, height: 720 }) }, window: { drawPlayMultiplayer: adapter, drawPlayGame: { ready: true } }, parent, setInterval: (fn: () => void) => { timers.push(fn); return timers.length; }, clearInterval: () => {}, addEventListener: (_: string, fn: (e: any) => void) => { listener = fn; } });
  timers[0]();
  const message = (data: any, overrides = {}) => listener({ source: parent, data: { channel: 'draw-play-room', nonce: 'test-nonce', ...data }, ...overrides });
  return { emitted, calls, timers, message, html };
}
describe('isolated multiplayer bridge', () => {
  it('accepts only its parent/nonce and pauses until the shared round starts', () => {
    const f = fixture();
    expect(f.emitted.find(m => m.type === 'ready').aspect).toBeCloseTo(16 / 9);
    f.message({ type: 'start', round: 1, seat: 0, seed: 4 }, { source: {} });
    f.message({ type: 'start', round: 1, seat: 0, seed: 4, nonce: 'wrong' });
    expect(f.calls.filter(c => c[0] === 'start')).toHaveLength(0);
    f.message({ type: 'start', round: 1, seat: 0, seed: 4 });
    f.timers[1]();
    expect(f.emitted.filter(m => m.type === 'world')).toHaveLength(0);
    f.message({ type: 'state', round: 1, paused: false, inputs: [['left'], ['attack']] });
    f.timers[1]();
    expect(f.calls).toContainEqual(['input', 1, ['attack']]);
    expect(f.emitted.find(m => m.type === 'world').world).toEqual({ x: 5 });
    f.message({ type: 'pause' });
    f.timers[1]();
    expect(f.emitted.filter(m => m.type === 'world')).toHaveLength(1);
    expect(f.html).toContain("connect-src 'none'");
    expect(f.html).not.toContain('token');
  });
  it('guest restores world but never publishes physics, and ignores stale rounds', () => {
    const f = fixture();
    f.message({ type: 'start', round: 2, seat: 1, seed: 4, world: { x: 1 } });
    f.message({ type: 'state', round: 1, paused: false, world: { x: 99 } });
    f.message({ type: 'state', round: 2, paused: false, world: { x: 7 }, inputs: [[], ['right']] });
    f.timers[1]();
    expect(f.calls).toContainEqual(['restore', { x: 7 }]);
    expect(f.calls).not.toContainEqual(['restore', { x: 99 }]);
    expect(f.calls.filter(c => c[0] === 'input')).toHaveLength(0);
    expect(f.emitted.filter(m => m.type === 'world')).toHaveLength(0);
  });
});
