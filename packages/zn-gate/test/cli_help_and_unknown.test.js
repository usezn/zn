'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

// Runs the CLI with an empty temporary home so no real user data is read.
function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cli-help-'));
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      input: '',
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, ZN_STATS: 'off', NO_COLOR: '1' },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const flag of ['--help', '-h']) {
  test(`${flag} prints the help text to stdout and exits 0`, () => {
    const r = run([flag]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /zn-gate/);
    assert.match(r.stdout, /usage/i);
    assert.strictEqual(r.stderr, '');
  });
}

test('-h and --help print the same text', () => {
  assert.strictEqual(run(['-h']).stdout, run(['--help']).stdout);
});

test('an unknown command exits 1 with a plain message that points to --help', () => {
  const r = run(['no-such-command']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /Unknown command: no-such-command/);
  assert.match(r.stderr, /--help/);
});

test('an unknown command never prints a stack trace', () => {
  const r = run(['no-such-command']);
  assert.doesNotMatch(r.stderr, /\n\s+at .*\(|\bat Object\.|node:internal|Error:/);
  assert.strictEqual(r.stderr.trim().split('\n').length, 2);
});
