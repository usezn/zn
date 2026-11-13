'use strict';

// zn-gate check: for Codex, an OK line carries a note that the hooks need approval with /hooks.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { getAdapter } = require('../lib/agents');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');

test('check: Codex OK carries the /hooks approval note and stays protected', async (t) => {
  const home = tempDir(t, 'zn-check-approve-');
  const env = { HOME: home, PATH: process.env.PATH };
  getAdapter('codex').install({ scope: 'user', home, env, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  const r = (await check({ home, env, cwd: tempDir(t, 'zn-check-approve-cwd-') })).results.find((x) => x.id === 'codex');
  assert.equal(r.state, 'protected');
  assert.ok(r.notes.some((n) => /approve it with \/hooks|approve new hooks with \/hooks/.test(n) && /does not prove/.test(n)), JSON.stringify(r.notes));
});
