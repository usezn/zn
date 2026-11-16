'use strict';

// zn-gate check returns a plain object that can be written as JSON. Its top-level keys are the same
// whether the home folder is empty or zn is set up in it.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const KEYS = ['removed', 'results', 'warnings'];

function cleanHome(t) {
  const home = tempDir(t, 'zn-keys-clean-');
  return { home, env: { HOME: home, PATH: process.env.PATH }, cwd: tempDir(t, 'zn-keys-cwd-') };
}

function setUpHome(t) {
  const ctx = cleanHome(t);
  getAdapter('claude-code').install({ scope: 'user', home: ctx.home, env: ctx.env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  return ctx;
}

const asJson = (res) => JSON.parse(JSON.stringify(res));

for (const live of [true, false]) {
  test(`check JSON: same top-level keys for a clean and a set-up home (live: ${live})`, async (t) => {
    const clean = asJson(await check({ ...cleanHome(t), live, nodeVersion: '22.0.0' }));
    const setUp = asJson(await check({ ...setUpHome(t), live, nodeVersion: '22.0.0' }));
    assert.deepEqual(Object.keys(clean).sort(), KEYS);
    assert.deepEqual(Object.keys(setUp).sort(), KEYS);
    assert.ok(Array.isArray(clean.results) && Array.isArray(setUp.results));
    assert.ok(Array.isArray(clean.warnings) && Array.isArray(setUp.warnings));
    assert.equal(typeof clean.removed, 'boolean');
    assert.equal(typeof setUp.removed, 'boolean');
    assert.deepEqual(clean.results.map((r) => r.id), setUp.results.map((r) => r.id));
  });
}
