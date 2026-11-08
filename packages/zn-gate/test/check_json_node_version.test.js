'use strict';
/**
 * `zn-gate check --json` reports node_version as a JSON string (the Node.js version that runs zn-gate),
 * not a number or an object. The child runs with process.execPath, so the value is this process's version.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('check --json: node_version is a JSON string equal to the running Node.js version', (t) => {
  const home = tempDir(t, 'zn-check-node-home-');
  const cwd = tempDir(t, 'zn-check-node-cwd-');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ZN_STATS: 'off' };
  const r = spawnSync(process.execPath, [CLI, 'check', '--json'], { cwd, env, encoding: 'utf8', timeout: 120000 });
  const j = JSON.parse(r.stdout);
  assert.equal(typeof j.node_version, 'string');
  assert.match(j.node_version, /^\d+\.\d+\.\d+$/);
  assert.equal(j.node_version, process.versions.node);
  assert.equal(typeof j.exit_code, 'number');
});
