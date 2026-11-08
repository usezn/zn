'use strict';
// bin/cli.js stats --days 0: exit 2, and the usage line names the allowed window (1-90).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-zero-range-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const run = (args) => {
  const env = { ...process.env, ZN_HOME: home, HOME: home, USERPROFILE: home };
  delete env.ZN_STATS;
  return spawnSync(process.execPath, [CLI, 'stats', ...args], { encoding: 'utf8', env });
};

test('stats --days 0 exits 2 and the usage line names the 1-90 window', () => {
  const r = run(['--days', '0']);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /Usage: zn-gate stats \[--days 1-90\]/);
});

test('stats --days 91 exits 2 with the same 1-90 window in the usage line', () => {
  const r = run(['--days', '91']);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /\[--days 1-90\]/);
});
