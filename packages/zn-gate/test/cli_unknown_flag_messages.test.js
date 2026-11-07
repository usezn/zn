'use strict';
// What version, status, check, stats and report do today when they are given a flag they do not know.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const FLAG = '--no-such-flag';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-unknown-flag-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function run(command) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share') };
  delete env.ZN_API_KEY;
  return spawnSync(process.execPath, [CLI, command, FLAG], { encoding: 'utf8', input: '', cwd: home, env, timeout: 60000 });
}

function assertNoStackTrace(r) {
  assert.strictEqual(r.signal, null);
  assert.doesNotMatch(r.stdout + r.stderr, /\n\s+at .*[(:]\d+:\d+\)?|TypeError|ReferenceError|Unhandled|node:internal/);
}

for (const command of ['stats', 'report']) {
  test(`${command} with an unknown flag exits 2 with its usage line and no stack trace`, () => {
    const r = run(command);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr + r.stdout, new RegExp('Usage: zn-gate ' + command));
    assertNoStackTrace(r);
  });
}

test('version with an unknown flag still prints the version and exits 0', () => {
  const r = run('version');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^zn-gate \d+\.\d+\.\d+/);
  assertNoStackTrace(r);
});

test('status with an unknown flag does not crash and prints no stack trace', () => {
  const r = run('status');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /zn-gate Status/);
  assertNoStackTrace(r);
});

test('check with an unknown flag exits 2, names the flag and prints no stack trace', () => {
  const r = run('check');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown option "--no-such-flag"/);
  assert.strictEqual(r.stdout, '');
  assertNoStackTrace(r);
});
