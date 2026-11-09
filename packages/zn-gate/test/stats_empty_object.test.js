'use strict';
// A stats file holding `{}` is valid JSON with none of the fields zn-gate writes. lib/stats.js load() reads
// it as an empty history, so `zn-gate stats` and `zn-gate stats --json` exit 0, the text output says
// nothing is recorded yet, and neither output carries a stack trace. The file is in the temporary home's
// .zn folder (stats.json under ZN_HOME or the home directory).

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const STACK_TRACE = /\n\s+at\s|TypeError|ReferenceError|SyntaxError/;

function runStats(t, args) {
  const home = tempDir(t, 'zn-stats-empty-home-');
  const cwd = tempDir(t, 'zn-stats-empty-cwd-');
  fs.mkdirSync(path.join(home, '.zn'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zn', 'stats.json'), '{}');
  return spawnSync(process.execPath, [CLI, 'stats', ...args], {
    cwd,
    input: '',
    encoding: 'utf8',
    timeout: 60000,
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ZN_STATS: 'off', NO_COLOR: '1' },
  });
}

test('stats with a stats file holding {} exits 0, says nothing is recorded and prints no stack trace', (t) => {
  const r = runStats(t, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /Nothing recorded yet/);
  assert.doesNotMatch(r.stdout, STACK_TRACE);
});

test('stats --json with a stats file holding {} exits 0 with zero counts and no stack trace', (t) => {
  const r = runStats(t, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.doesNotMatch(r.stdout, STACK_TRACE);
  const out = JSON.parse(r.stdout);
  assert.equal(out.total.checked, 0);
  assert.equal(out.total.blocked, 0);
  assert.deepEqual(out.byKey, {});
});
