'use strict';

// zn-gate check: the hooks keep their compile cache in ~/.zn only while that folder is mode 0700
// (lib/compile-cache.js), so the check advises when it is not. Linux and macOS only.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const cacheAdvice = (res) => res.warnings.filter((w) => /compile cache/.test(w));

function homeWithZn(t, mode) {
  const home = tempDir(t, 'zn-check-dirmode-');
  if (mode !== null) {
    const dir = path.join(home, '.zn');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, mode);
  }
  return home;
}

const run = (home, opts = {}) => check({
  live: false,
  home,
  cwd: home,
  env: { HOME: home, PATH: process.env.PATH },
  nodeVersion: '22.0.0',
  ...opts,
});

test('zn-gate check advises when ~/.zn is mode 0755', { skip: process.platform === 'win32' }, async (t) => {
  const home = homeWithZn(t, 0o755);
  const advice = cacheAdvice(await run(home));
  assert.equal(advice.length, 1);
  assert.match(advice[0], /mode 0755, not 0700/);
  assert.match(advice[0], /chmod 700 ~\/\.zn/);
});

test('zn-gate check gives no advice when ~/.zn is mode 0700', { skip: process.platform === 'win32' }, async (t) => {
  const home = homeWithZn(t, 0o700);
  assert.deepEqual(cacheAdvice(await run(home)), []);
});

test('zn-gate check gives no advice on Windows, whatever the folder mode', async (t) => {
  const home = homeWithZn(t, 0o755);
  assert.deepEqual(cacheAdvice(await run(home, { platform: 'win32' })), []);
});

test('zn-gate check gives no advice when there is no ~/.zn yet', async (t) => {
  const home = homeWithZn(t, null);
  assert.deepEqual(cacheAdvice(await run(home)), []);
});
