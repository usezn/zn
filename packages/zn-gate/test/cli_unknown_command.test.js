'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cmd-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
    return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '', env, cwd: home });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function assertShortError(r, command) {
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(
    r.stderr,
    `Unknown command: ${command}\nRun 'zn-gate --help' for usage.\n`
  );
  assert.doesNotMatch(r.stderr, /\n\s+at |Error:|node:internal|\.js:\d+/);
}

test('an unknown command exits 1 with a message and a pointer to --help, no stack text', () => {
  assertShortError(run(['no-such-command']), 'no-such-command');
});

test('a misspelled command is reported as unknown, with the same pointer and no stack text', () => {
  assertShortError(run(['stauts']), 'stauts');
});

test('no arguments prints the usage text on stdout and exits 0 with nothing on stderr', () => {
  const r = run([]);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /USAGE:/);
  assert.match(r.stdout, /zn-gate <command> \[options\]/);
  assert.strictEqual(r.stderr, '');
});
