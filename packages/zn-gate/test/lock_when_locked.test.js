'use strict';
// `zn-gate lock` when the vault is already locked (a temporary home with no unlocked vault) exits 0 and
// prints one line, "Vault was not unlocked." (docs/cli.md: exit `0` "done (also when the vault was not
// unlocked)"). Running it again gives the same answer. Nothing is written to stderr.
// The home is temporary; no real vault is read.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const NO_OP_LINE = 'Vault was not unlocked.\n';

function runLock(home, cwd) {
  return spawnSync(process.execPath, [CLI, 'lock'], {
    cwd,
    input: '',
    encoding: 'utf8',
    timeout: 60000,
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ZN_STATS: 'off', NO_COLOR: '1' },
  });
}

test('lock when the vault is already locked exits 0 with the no-op line', (t) => {
  const home = tempDir(t, 'zn-lock-home-');
  const cwd = tempDir(t, 'zn-lock-cwd-');
  const r = runLock(home, cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, NO_OP_LINE);
  assert.equal(r.stderr, '');
});

test('lock run twice in the same home: both exit 0 with the same no-op line', (t) => {
  const home = tempDir(t, 'zn-lock-home-');
  const cwd = tempDir(t, 'zn-lock-cwd-');
  const first = runLock(home, cwd);
  const second = runLock(home, cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.equal(second.stdout, NO_OP_LINE);
  assert.equal(second.stderr, '');
});
