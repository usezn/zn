'use strict';
// `zn-gate help` prints the same text as `--help` with exit 0; `help <command>` prints that command's own help.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-help-cmd-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
    return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '', env, cwd: home });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function assertSameAsFlag(helpArgs, flagArgs) {
  const h = run(helpArgs);
  const f = run(flagArgs);
  assert.strictEqual(h.status, 0, `help exit code: ${h.status}`);
  assert.strictEqual(h.stderr, '');
  assert.notStrictEqual(h.stdout, '');
  assert.strictEqual(f.status, 0);
  assert.strictEqual(h.stdout, f.stdout);
}

test('zn-gate help prints the general help with exit 0 and nothing on stderr', () => {
  assertSameAsFlag(['help'], ['--help']);
  assert.match(run(['help']).stdout, /USAGE:/);
});

test('zn-gate help <command> prints that command help when it has its own', () => {
  assertSameAsFlag(['help', 'audit'], ['audit', '--help']);
  assertSameAsFlag(['help', 'reach'], ['reach', '--help']);
  assertSameAsFlag(['help', 'unlock'], ['unlock', '--help']);
});

test('zn-gate help <command> prints the general help for a command without its own', () => {
  assertSameAsFlag(['help', 'scan'], ['--help']);
  assertSameAsFlag(['help', 'no-such-command'], ['--help']);
});
