const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/creative/imagine_runtime.js'), 'utf8');
function load() {
  const window = { __drawPlayAssetManifest: {
    hero: { src: 'data:image/svg+xml;base64,good', frames: 4, fps: 8 },
    broken: { src: 'data:image/svg+xml;base64,bad', frames: 1, fps: 8 },
  }};
  class Image {
    naturalWidth = 1024;
    naturalHeight = 256;
    set src(value) { queueMicrotask(() => value.endsWith('bad') ? this.onerror?.() : this.onload?.()); }
  }
  vm.runInNewContext(source, { window, Image, setTimeout, clearTimeout, queueMicrotask });
  return window;
}

test('ready waits for packaged images, tolerates failures, and removes the temporary manifest', async () => {
  const window = load(), art = window.drawPlayArt;
  assert.equal(window.__drawPlayAssetManifest, undefined);
  assert.equal(art.images.hero, undefined);
  await art.ready;
  assert.equal(art.images.hero.naturalWidth, 1024);
  assert.deepEqual(Array.from(art.failures), ['broken']);
  assert.equal(art.draw({}, 'broken', 0, 0, 50, 50), false);
  assert.equal(art.draw({}, 'missing', 0, 0, 50, 50), false);
});

test('animation crops equal cells, wraps frames, flips, rotates, and restores the canvas', async () => {
  const art = load().drawPlayArt;
  await art.ready;
  const calls = [];
  const ctx = {
    globalAlpha: 0.8,
    save() { calls.push(['save']); }, restore() { calls.push(['restore']); },
    translate(...args) { calls.push(['translate', ...args]); },
    rotate(...args) { calls.push(['rotate', ...args]); },
    scale(...args) { calls.push(['scale', ...args]); },
    drawImage(image, ...args) { calls.push(['image', ...args]); },
  };
  assert.equal(art.draw(ctx, 'hero', 10, 20, 64, 80, {time: 250, flip: true, rotation: 0.1, alpha: 0.5}), true);
  assert.deepEqual(calls, [
    ['save'], ['translate', 42, 60], ['rotate', 0.1], ['scale', -1, 1],
    ['image', 512, 0, 256, 256, -32, -40, 64, 80], ['restore'],
  ]);
  assert.equal(ctx.globalAlpha, 0.4);
  assert.equal(art.used.has('hero'), true);
  calls.length = 0;
  art.draw(ctx, 'hero', 0, 0, 64, 80, { frame: -1 });
  assert.equal(calls.find(c => c[0] === 'image')[1], 768);
  assert.equal(art.draw(ctx, 'hero', 0, 0, 0, 80), false);
});
