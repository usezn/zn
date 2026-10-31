'use strict';

// zn-gate check: both hook calls of the live check get the same start timeout (15 s by default,
// longer only when a test passes hookTimeoutMs).

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');

const calls = [];
const realSpawnSync = cp.spawnSync;
cp.spawnSync = (file, args, opts) => {
  if (file === 'fake-hook') { calls.push(opts.timeout); return { status: 0, stdout: '{}', stderr: '' }; }
  return realSpawnSync(file, args, opts);
};
const { _internal } = require('../lib/check');

const spec = { request: (dir, file) => ({ file }) };
const live = { file: 'fake-hook', args: [], env: {}, timeout: 15000 };

test('the second hook call gets the same timeout as the first', () => {
  calls.length = 0;
  _internal.runLive(spec, { dir: '/d', envFile: '/d/.env', readme: '/d/README.txt', hookTimeoutMs: 60000 }, live);
  assert.deepEqual(calls, [60000, 60000]);
});

test('without the option both calls keep the 15 s default', () => {
  calls.length = 0;
  _internal.runLive(spec, { dir: '/d', envFile: '/d/.env', readme: '/d/README.txt' }, live);
  assert.deepEqual(calls, [15000, 15000]);
});
