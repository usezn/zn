'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: '' });
}

test('reach with an unknown flag prints the usage line and exits 2', () => {
  const r = run(['reach', '--no-such-flag']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /unknown option --no-such-flag/);
  assert.match(r.stderr, /usage: zn-gate reach /);
  assert.strictEqual(r.stdout, '');
});

test('reach --fail-on without a value prints the usage line and exits 2', () => {
  const r = run(['reach', '--fail-on']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /--fail-on must be one of/);
  assert.match(r.stderr, /usage: zn-gate reach /);
});

test('scan --long-input without a value is refused with exit 2', () => {
  const r = run(['scan', '--long-input']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /--long-input needs windows or off/);
});

test('init with an unknown argument names it and exits 2', () => {
  const r = run(['init', '--no-such-flag']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /unknown argument "--no-such-flag"/);
});

test('an unknown subcommand is reported with a pointer to --help and does not succeed', () => {
  const r = run(['no-such-command']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /Unknown command: no-such-command/);
  assert.match(r.stderr, /zn-gate --help/);
});
