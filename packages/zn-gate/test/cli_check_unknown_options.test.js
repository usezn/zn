'use strict';
// check and doctor take one option, --hooks. Any other option is refused with exit 2: it is named and the option
// that is accepted is listed. The plain check, --hooks and --help keep working.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function run(args, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: home, NO_COLOR: '1' };
  delete env.ZN_STATS;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '', cwd: home, env, timeout: 60000 });
}

for (const command of ['check', 'doctor']) {
  test(`${command} --json is refused with exit 2, names the flag and lists the option it takes`, (t) => {
    const home = tempDir(t, 'zn-check-flag-');
    const r = run([command, '--json'], home);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /^zn-gate: unknown option "--json"\. The options of zn-gate /m);
    assert.match(r.stderr, /are --hooks\./);
    assert.strictEqual(r.stdout, '');
  });
}

test('check refuses an unknown option that comes after --hooks', (t) => {
  const home = tempDir(t, 'zn-check-flag-');
  const r = run(['check', '--hooks', '--bogus'], home);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown option "--bogus"/);
  assert.strictEqual(r.stdout, '');
});

test('check --hooks is still accepted', (t) => {
  const home = tempDir(t, 'zn-check-flag-');
  const r = run(['check', '--hooks'], home);
  assert.notStrictEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /unknown option/);
});

test('plain check is still accepted', (t) => {
  const home = tempDir(t, 'zn-check-flag-');
  const r = run(['check'], home);
  assert.ok(r.status === 0 || r.status === 1, 'exit code was ' + r.status + ': ' + r.stderr);
  assert.doesNotMatch(r.stderr, /unknown option/);
  assert.match(r.stdout, /zn-gate check/);
});

test('check --help still prints the general help and exits 0', (t) => {
  const home = tempDir(t, 'zn-check-flag-');
  const r = run(['check', '--help'], home);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /USAGE/);
  assert.doesNotMatch(r.stderr, /unknown option/);
});
