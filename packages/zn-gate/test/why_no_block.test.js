'use strict';

// `zn why` with no recorded block: no evidence log yet, so there is nothing to explain.
// docs/cli.md ("### `why`") documents exit 1 for "nothing to explain (no log, no block, ...)",
// and lib/why.js prints the message below on stderr. Nothing goes to stdout.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { tempDir } = require('./helpers/tmp');

const BIN = path.join(__dirname, '..', 'bin', 'cli.js');

test('zn why with no recorded block prints a clear message and exits 1', (t) => {
  const home = tempDir(t, 'zn-why-noblock-');
  const r = spawnSync(process.execPath, [BIN, 'why'], {
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ZN_STATS: 'off' },
    encoding: 'utf8',
    cwd: home,
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, '', 'nothing is printed on stdout');
  assert.match(r.stderr, /^zn why: there is no evidence log yet, so no block has been recorded on this computer\.\n$/);
});
