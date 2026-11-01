'use strict';
// Usage errors of stats and report go to standard error with exit 2; help goes to standard output with exit 0.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = path.join(__dirname, '..', 'bin', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-usage-stderr-test-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const run = (args) => spawnSync(process.execPath, [cli, ...args], {
  input: '',
  encoding: 'utf8',
  cwd: home,
  env: { ...process.env, ZN_HOME: home, HOME: home, USERPROFILE: home, CI: 'true', NO_COLOR: '1' },
  timeout: 30000,
});

const usageErrors = [
  ['stats', '--days', '0'],
  ['stats', '--days', '91'],
  ['stats', '--days'],
  ['stats', '--days=0'],
  ['stats', '--days', '0', '--json'],
  ['stats', 'extra'],
  ['stats', 'share', 'bogus'],
  ['report', '--since', '0d'],
  ['report', '--since=0d'],
  ['report', '--since', 'abc'],
  ['report', '--json', '--since', '0d'],
  ['report', '--since'],
  ['report', 'extra'],
];

for (const args of usageErrors) {
  test(`zn-gate ${args.join(' ')}: usage on stderr only, exit 2`, () => {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, /^Usage: zn-gate (stats|report)/, args.join(' '));
  });
}

for (const args of [['stats', '--help'], ['stats', '-h'], ['report', '--help'], ['report', '-h']]) {
  test(`zn-gate ${args.join(' ')}: help on stdout, exit 0`, () => {
    const r = run(args);
    assert.equal(r.status, 0, args.join(' '));
    assert.notEqual(r.stdout, '', args.join(' '));
    assert.equal(r.stderr, '', args.join(' '));
  });
}
