'use strict';
// `zn-gate status` writes to a pipe, not a terminal: no ANSI escape sequences,
// even when the environment could show colours. The child gets its own HOME and
// ZN_HOME, and its environment is built from scratch, so NO_COLOR and
// FORCE_COLOR of the caller never reach it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const ESC = /\u001b/;

function isolatedEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    ZN_HOME: path.join(home, '.zn'),
    ZN_KEYCHAIN_BACKEND: 'passphrase',
    ZN_LOCAL_ONLY: 'true',
    TERM: 'xterm-256color',
    ...extra,
  };
}

function statusPiped(env) {
  return spawnSync(process.execPath, [CLI, 'status'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('zn-gate status writes no ANSI escape sequences when stdout is a pipe', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-status-ansi-'));
  try {
    const r = statusPiped(isolatedEnv(home));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /zn-gate Status:/);
    assert.doesNotMatch(r.stdout, ESC, 'an escape sequence was printed to a pipe');
    assert.doesNotMatch(r.stderr, ESC, 'an escape sequence was printed to stderr');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('zn-gate status stays free of escape sequences with a key in the environment', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-status-ansi-'));
  try {
    const key = 'zn_' + 'TESTFAKE' + '0000000000000000';
    const r = statusPiped(isolatedEnv(home, { ZN_API_KEY: key }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /API key {9}: Set \(ZN_API_KEY\)/);
    assert.doesNotMatch(r.stdout, ESC, 'an escape sequence was printed to a pipe');
    assert.ok(!r.stdout.includes(key), 'the key was printed');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
