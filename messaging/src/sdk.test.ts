import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Spectrum, app } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';

test('the pinned SDK loads on Node and exposes app cards and the cloud provider', () => {
  assert.equal(typeof Spectrum, 'function');
  assert.ok(imessage.config());
  assert.ok(app('https://draw.example/race', { live: true }));
});
