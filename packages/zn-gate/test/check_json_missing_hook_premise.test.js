'use strict';

// `zn check` with no agent set up. Plain `check` exits 1 and lists each agent as not found. `check --json` is not an
// option: it exits 2 and names the options `check` takes (--hooks), as docs/cli.md says.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function zn(home, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: home, ZN_STATS: 'off', NO_COLOR: '1' },
  });
}

test('zn check with no agent set up exits 1 and lists the agents as not found', (t) => {
  const home = tempDir(t, 'zn-check-home-');
  const r = zn(home, ['check']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /Claude Code\s+not found on this machine/);
  assert.match(r.stdout, /No supported coding agent was found/);
});

test('zn check --json is refused with exit 2 and names the option check takes', (t) => {
  const home = tempDir(t, 'zn-check-home-');
  const r = zn(home, ['check', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--json/);
  assert.match(r.stderr, /--hooks/);
});

test('zn check --json exits 1 and lists the missing hook',
  { todo: 'premise false: check has no --json option (exit 2, see docs/cli.md); with no hook the plain check exits 1' },
  (t) => {
    const home = tempDir(t, 'zn-check-home-');
    const r = zn(home, ['check', '--json']);
    assert.equal(r.status, 1);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  });
