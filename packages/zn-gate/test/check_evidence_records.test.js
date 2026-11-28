'use strict';

// zn-gate check writes evidence records only for the agents whose installed hook it really ran, one each.
// The in-process rules self-test (every adapter, installed or not) must leave nothing in the log.

const fs = require('fs');
const os = require('os');
const path = require('path');
// The hooks check starts inherit this process's environment, so the home folder is set before anything loads.
const HOME = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-checkev-')));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.ZN_HOME = path.join(HOME, '.zn');
process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getAdapter } = require('../lib/agents');
const { check } = require('../lib/check');
const { tempDir } = require('./helpers/tmp');

const RUNNER = path.join(__dirname, '..', 'lib', 'hooks', 'runner.js');
const ENV = { HOME, PATH: process.env.PATH };

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

function records() {
  const file = path.join(HOME, '.zn', 'evidence.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('check with no agent installed writes no evidence record', async (t) => {
  await check({ home: HOME, env: ENV, cwd: tempDir(t, 'zn-checkev-cwd-'), nodeVersion: '22.0.0' });
  assert.deepEqual(records(), []);
});

test('check writes one block record for the one agent whose hook it ran', async (t) => {
  getAdapter('claude-code').install({ scope: 'user', home: HOME, env: ENV, nodePath: process.execPath, runnerPath: RUNNER, mcp: false });
  await check({ home: HOME, env: ENV, cwd: tempDir(t, 'zn-checkev-cwd-'), nodeVersion: '22.0.0' });
  const recs = records();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].agent_environment, 'claude-code');
  assert.equal(recs[0].verdict, 'block');
});
