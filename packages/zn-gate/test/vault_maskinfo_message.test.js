'use strict';
// The vault failure message carries the "zn could not read" sentence exactly once (it used to be wrapped twice).
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../lib/scrub/engine');

test('a maskInfo shape error is wrapped once, not twice', async () => {
  for (const bad of [null, 'text', [], { names: 'x' }]) {
    await assert.rejects(
      engine.scanAsync('hello', { vault: { maskInfo: async () => bad }, project: 'p-once-' + String(bad) }),
      (err) => {
        const n = (err.message.match(/zn could not read/g) || []).length;
        assert.strictEqual(n, 1, err.message);
        assert.strictEqual((err.message.match(/zn:/g) || []).length <= 1, true, err.message);
        return true;
      });
  }
});
