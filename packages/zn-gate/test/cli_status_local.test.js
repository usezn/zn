'use strict';

// `zn-gate status` with the cloud check off: the lines that say what runs and what leaves the machine.
// HOME, USERPROFILE and ZN_HOME point at an empty temporary folder, so no marker exists and the system
// keychain is never read.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const PKG = require('../package.json');

function runStatus(t, extra = {}) {
  const home = tempDir(t, 'zn-status-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), NO_COLOR: '1' };
  delete env.ZN_CLOUD;
  delete env.ZN_API_KEY;
  delete env.ZN_LOCAL_ONLY;
  Object.assign(env, extra);
  return spawnSync(process.execPath, [CLI, 'status'], { env, encoding: 'utf8', timeout: 30000 });
}

function line(out, label) {
  const m = out.match(new RegExp('^\\s*' + label + '\\s*: (.*)$', 'm'));
  assert.ok(m, `no "${label}" line in:\n${out}`);
  return m[1];
}

test('status with the cloud check off shows local-only lines', (t) => {
  const r = runStatus(t);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(line(r.stdout, 'Package Version'), PKG.version);
  assert.equal(line(r.stdout, 'Active Engine'), 'Local rules only');
  assert.equal(line(r.stdout, 'Endpoint'), 'None (nothing leaves this machine)');
  assert.equal(line(r.stdout, 'API key'), 'Not set');
  assert.equal(line(r.stdout, 'Leaves machine'), 'Nothing');
  assert.doesNotMatch(r.stdout, /Connected\s*:/);
});

test('ZN_LOCAL_ONLY=true keeps the engine local even with ZN_CLOUD=1', (t) => {
  const r = runStatus(t, { ZN_LOCAL_ONLY: 'true', ZN_CLOUD: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(line(r.stdout, 'Active Engine'), 'Local rules only');
  assert.equal(line(r.stdout, 'Leaves machine'), 'Nothing');
});

test('ZN_LOCAL_ONLY=true keeps the engine local with a key and ZN_CLOUD=1', (t) => {
  const r = runStatus(t, { ZN_LOCAL_ONLY: 'true', ZN_CLOUD: '1', ZN_API_KEY: 'zn_fake_key_for_tests_0000' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(line(r.stdout, 'Active Engine'), 'Local rules only');
  assert.equal(line(r.stdout, 'Endpoint'), 'None (nothing leaves this machine)');
  assert.match(line(r.stdout, 'API key'), /^Set \(ZN_API_KEY\) \(unused/);
  assert.equal(line(r.stdout, 'Leaves machine'), 'Nothing');
  assert.ok(!r.stdout.includes('zn_fake_key_for_tests_0000'));
});
