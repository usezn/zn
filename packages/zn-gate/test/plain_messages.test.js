'use strict';
/* Block and error messages a person reads: plain words, the next step, no
 * internal codes or token names. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { znCommand, znOnPath, PACKAGE_VERSION } = require('../lib/zn-command');
const { humanError, CODES } = require('../lib/errors');
const { decidePrompt } = require('../lib/hooks/runner');
const { dispatch } = require('../lib/broker/cli');

const NPX = 'npx -y zn-gate@' + PACKAGE_VERSION;

function writeFile(dir, name, mode) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\necho zn\n');
  fs.chmodSync(p, mode);
  return p;
}

function deps(spans = []) {
  return { engine: () => ({ scan: () => spans }), vault: async () => null, detectors: () => [] };
}

function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

test('znCommand: plain zn when zn is an executable on PATH, npx with this version when not', (t) => {
  const withZn = tempDir(t, 'zn-path-yes-');
  writeFile(withZn, 'zn', 0o755);
  const without = tempDir(t, 'zn-path-no-');
  if (process.platform !== 'win32') {
    // A file that is not executable is not a program to run.
    writeFile(without, 'zn', 0o644);
    assert.equal(znOnPath({ PATH: without }), false);
  }
  assert.equal(znCommand('env shadow .env', { env: { PATH: withZn } }), 'zn env shadow .env');
  assert.equal(znCommand('unlock', { env: { PATH: without } }), NPX + ' unlock');
  assert.equal(znCommand('env shadow .env', { env: { PATH: '' } }), NPX + ' env shadow .env');
});

test('znCommand: Windows finds zn.cmd through PATHEXT and not an extensionless shim',
  { skip: process.platform !== 'win32' && 'PATHEXT lookup only applies on Windows' }, (t) => {
    const dir = tempDir(t, 'zn-path-win-');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    writeFile(dir, 'zn', 0o644);
    assert.equal(znOnPath(env), false);
    fs.writeFileSync(path.join(dir, 'zn.cmd'), '@echo zn\r\n');
    assert.equal(znOnPath(env), true);
    assert.equal(znCommand('unlock', { env }), 'zn unlock');
  });

test('humanError: plain text for the vault, policy and not-found errors, no code', () => {
  const locked = humanError(Object.assign(new Error('vault is locked; run `zn unlock`'), { code: CODES.LOCKED }), {});
  assert.match(locked, /^Your secret vault is locked\. Unlock it in this terminal with: .* unlock \(it asks for your vault passphrase\)\. Then run this command again\.$/);
  assert.doesNotMatch(locked, /ZN_|irreversib|marker|broker/);
  assert.equal(humanError(Object.assign(new Error('nope'), { code: CODES.POLICY_DENIED }), {}), 'Not allowed: nope');
  assert.equal(humanError(Object.assign(new Error('secret X is missing'), { code: CODES.NOT_FOUND }), {}), 'Not found: secret X is missing');
  assert.equal(humanError(new Error('plain failure'), {}), 'plain failure');
});

test('humanError: the code is shown only with ZN_VERBOSE=1 or DEBUG', () => {
  const err = Object.assign(new Error('nope'), { code: CODES.POLICY_DENIED });
  assert.equal(humanError(err, { ZN_VERBOSE: '1' }), '[ZN_POLICY_DENIED] Not allowed: nope');
  assert.equal(humanError(err, { DEBUG: '1' }), '[ZN_POLICY_DENIED] Not allowed: nope');
  assert.equal(humanError(err, { ZN_VERBOSE: '0' }), 'Not allowed: nope');
});

test('CLI: refusing to print a secret says what to do instead, without the code', async () => {
  const out = sink();
  const err = sink();
  const code = await dispatch('secret', ['get', 'DB_PASSWORD'], { stdout: out, stderr: err, env: {}, cwd: process.cwd() });
  assert.equal(code, 77);
  assert.match(err.text(), /^zn secret: Not allowed: zn does not print secret values\. To use one in a command, run: /);
  assert.match(err.text(), /run --secrets NAME -- <command>/);
  assert.doesNotMatch(err.text(), /ZN_|marker|\[/);
});

test('prompt block names the secret and gives the next step', async () => {
  const d = await decidePrompt({ event: 'user_prompt', input: { prompt: 'DB_PASSWORD=sunshine2024, can you connect?' } }, deps(), 'claude-code');
  assert.equal(d.decision, 'deny');
  assert.match(d.message, /contains a secret \(DB_PASSWORD\)\. Save it in your vault instead: .*secret set DB_PASSWORD, then ask your agent to use it\.$/);
  assert.doesNotMatch(d.message, /SECRET|__ZN_|marker/);
});

test('prompt block uses a readable kind when no name is known', async () => {
  const prompt = 'my key AKIAIOSFODNN7EXAMPLE is in the file';
  const start = prompt.indexOf('AKIA');
  const span = { start, end: start + 20, type: 'AWS_KEY', source: 'pattern' };
  const d = await decidePrompt({ event: 'user_prompt', input: { prompt } }, deps([span]), 'claude-code');
  assert.equal(d.decision, 'deny');
  assert.match(d.message, /contains a secret \(an AWS key\)/);
  assert.match(d.message, /secret set AWS_KEY/);
  assert.doesNotMatch(d.message, /\(SECRET\)|__ZN_/);
});
