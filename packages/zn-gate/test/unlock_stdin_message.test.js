'use strict';
/* `zn unlock --passphrase-stdin`: an empty stdin gets its own message, and the Node 18 X25519
 * ExperimentalWarning is dropped while every other warning is kept. Values are fake. */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { installX25519WarningFilter, isX25519ExperimentalWarning } = require('../lib/warnings');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const LIB = path.join(__dirname, '..', 'lib', 'warnings.js');
const X25519_TEXT = 'X25519 Web Crypto API algorithm is an experimental feature and might change at any time';

/** A fake process with a recording emitWarning, so the filter can be checked without Node's own printer. */
function fakeProcess() {
  const calls = [];
  return { calls, emitWarning(...args) { calls.push(args); } };
}

test('the filter drops the X25519 ExperimentalWarning only', () => {
  const p = fakeProcess();
  assert.equal(installX25519WarningFilter(p), true);

  // The three ways Node takes a warning: a string with a type, an Error, and a string with an options object.
  p.emitWarning(X25519_TEXT, 'ExperimentalWarning');
  p.emitWarning(Object.assign(new Error(X25519_TEXT), { name: 'ExperimentalWarning' }));
  p.emitWarning(X25519_TEXT, { type: 'ExperimentalWarning', code: 'FAKE_CODE' });
  assert.equal(p.calls.length, 0, 'all three forms of the X25519 warning are dropped');
});

test('the filter keeps every other warning', () => {
  const p = fakeProcess();
  installX25519WarningFilter(p);

  p.emitWarning('Buffer() is deprecated', 'DeprecationWarning');
  p.emitWarning('X25519 is not a deprecation', 'DeprecationWarning');
  p.emitWarning('The fetch feature is an experimental feature', 'ExperimentalWarning');
  p.emitWarning('Something else happened');
  p.emitWarning(X25519_TEXT, 'UserWarning');
  assert.deepEqual(p.calls.map((c) => c[0]), [
    'Buffer() is deprecated',
    'X25519 is not a deprecation',
    'The fetch feature is an experimental feature',
    'Something else happened',
    X25519_TEXT,
  ]);
  assert.equal(p.calls.length, 5);
});

test('the filter is installed once', () => {
  const p = fakeProcess();
  assert.equal(installX25519WarningFilter(p), true);
  const wrapped = p.emitWarning;
  assert.equal(installX25519WarningFilter(p), false);
  assert.equal(p.emitWarning, wrapped);
});

test('isX25519ExperimentalWarning matches the name and the text together', () => {
  assert.equal(isX25519ExperimentalWarning(X25519_TEXT, 'ExperimentalWarning'), true);
  assert.equal(isX25519ExperimentalWarning(X25519_TEXT, 'Warning'), false);
  assert.equal(isX25519ExperimentalWarning('Ed25519 is an experimental feature', 'ExperimentalWarning'), false);
  assert.equal(isX25519ExperimentalWarning(X25519_TEXT, { type: 'ExperimentalWarning' }), true);
});

test('in a real process the X25519 warning is not printed and another one is', () => {
  const script = [
    'require(' + JSON.stringify(LIB) + ').installX25519WarningFilter();',
    'process.emitWarning(' + JSON.stringify(X25519_TEXT) + ", 'ExperimentalWarning');",
    "process.emitWarning('fake-other-notice is an experimental feature', 'ExperimentalWarning');",
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /X25519/);
  assert.match(r.stderr, /fake-other-notice is an experimental feature/);
});

test('the empty-stdin message names the command to pipe into', () => {
  const text = require('../lib/messages').passphraseStdinEmpty();
  // The command is `zn` on PATH, or `npx -y zn-gate@<version>` when it is not (see lib/zn-command.js).
  assert.match(text, /^No passphrase was read from standard input\. Pipe it in, for example: printf '%s' "\$PASS" \| (zn|npx(?:\.cmd)? -y zn-gate@\S+) unlock --passphrase-stdin$/);
});

function cleanEnv(home) {
  return { PATH: process.env.PATH || '', HOME: home, USERPROFILE: home, LANG: 'C' };
}

test('unlock with an empty stdin says no passphrase was read, with the same exit code', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stdin-empty-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'unlock', '--passphrase-stdin', '--backend', 'passphrase'], {
      input: '', encoding: 'utf8', env: cleanEnv(home), timeout: 60000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No passphrase was read from standard input\. Pipe it in, for example: printf '%s' "\$PASS" \| (zn|npx(?:\.cmd)? -y zn-gate@\S+) unlock --passphrase-stdin/);
    assert.doesNotMatch(r.stderr, /at least 12/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unlock with a short passphrase on stdin still gets the 12-character message', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stdin-short-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'unlock', '--passphrase-stdin', '--backend', 'passphrase'], {
      input: 'fake-short\n', encoding: 'utf8', env: cleanEnv(home), timeout: 60000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /passphrase must be at least 12 characters/);
    assert.doesNotMatch(r.stderr, /No passphrase was read/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
