'use strict';

// `zn why` with no recorded block: expected to print a plain message and exit 0.
//
// Skipped on purpose. There is no `why` command in bin/cli.js (it ends in "Unknown command"
// with exit 1) and docs/cli.md has no `why` heading, so there is nothing to test yet.
// Bug to fix in the product: either implement `zn why` as described above, or remove it
// from the plan. The body below states the expected behaviour and runs once the command exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { tempDir } = require('./helpers/tmp');

const BIN = path.join(__dirname, '..', 'bin', 'cli.js');

test(
  'zn why with no recorded block prints a clear message and exits 0',
  { skip: 'zn why is not implemented: bin/cli.js has no why command and docs/cli.md does not document it (bug)' },
  (t) => {
    const home = tempDir(t, 'zn-why-noblock-');
    const r = spawnSync(process.execPath, [BIN, 'why'], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ZN_STATS: 'off' },
      encoding: 'utf8',
      cwd: home,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim().length > 0, 'prints a message');
  },
);
