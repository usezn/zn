'use strict';

// `zn evidence --export jsonl` on an empty ledger: nothing is printed and the exit code is 0 (an empty export is a
// valid export, not an error).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

test('zn evidence --export jsonl on an empty ledger prints nothing and exits 0', (t) => {
  const home = tempDir(t, 'zn-ev-empty-');
  const r = spawnSync(process.execPath, [CLI, 'evidence', '--export', 'jsonl'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: home, ZN_STATS: 'off', NO_COLOR: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});
