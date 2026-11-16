'use strict';
// bin/cli.js stats --days through a real process: 1 to 90 is accepted, anything else exits with 2.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-days-test-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const run = (args) => {
  const env = { ...process.env, ZN_HOME: home, HOME: home, USERPROFILE: home };
  delete env.ZN_STATS;
  return spawnSync(process.execPath, [CLI, 'stats', ...args], { encoding: 'utf8', env });
};

test('--days 1 and --days 90 exit with 0', () => {
  for (const n of ['1', '90']) {
    const r = run(['--days', n]);
    assert.equal(r.status, 0, n);
  }
});

test('--days 0, 91, a word and a missing value exit with 2', () => {
  for (const args of [['--days', '0'], ['--days', '91'], ['--days', 'week'], ['--days']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stdout + r.stderr, /Usage: zn-gate stats/, args.join(' '));
  }
});

test('--json prints one valid JSON object for the edges of the range', () => {
  for (const n of ['1', '90']) {
    const r = run(['--days', n, '--json']);
    assert.equal(r.status, 0, n);
    const j = JSON.parse(r.stdout);
    assert.equal(typeof j, 'object');
    assert.ok(j && !Array.isArray(j));
    assert.equal(j.days, Number(n));
  }
  assert.equal(JSON.parse(run(['--json']).stdout).days, 30);
});

test('--json with a value outside the range does not print a JSON object', () => {
  for (const n of ['0', '91']) {
    const r = run(['--days', n, '--json']);
    assert.equal(r.status, 2, n);
    assert.throws(() => JSON.parse(r.stdout), n);
  }
});
