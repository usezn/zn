'use strict';
process.env.ZN_STATS = 'off';
// setWinPrivate checks the account id before it runs anything and reports a failing PowerShell call;
// runnerSha is '' for a file that cannot be read and a SHA-256 hex digest for a real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const launcher = require('../lib/agents/launcher');
const { tempDir } = require('./helpers/tmp');

const PS_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';

test('setWinPrivate: an account id that is not an S-1 id throws before PowerShell is started', () => {
  for (const bad of ['', 'alice', 'S-2-5-21-1', 'S-1-', 'S-1-5-21 1', 'S-1-5-21-1\n', undefined, null]) {
    const calls = [];
    const io = { powershell: PS_PATH, spawnSync: (...a) => { calls.push(a); return { status: 0, stdout: '', stderr: '' }; } };
    assert.throws(() => launcher.setWinPrivate('C:\\a', bad, io), /could not make the folder private \(unexpected account id\)/, String(bad));
    assert.equal(calls.length, 0);
  }
});

test('setWinPrivate: a failing PowerShell call throws the could-not-make-private text', () => {
  const failing = [
    [{ status: 1, stdout: '', stderr: 'access denied' }, /could not make the folder private \(access denied\)/],
    [{ status: 1, stdout: 'only stdout', stderr: '' }, /could not make the folder private \(only stdout\)/],
    [{ status: 3, stdout: '', stderr: '' }, /could not make the folder private \(exit 3\)/],
    [{ status: null, error: new Error('spawn failed') }, /could not make the folder private \(spawn failed\)/],
  ];
  for (const [reply, re] of failing) {
    const io = { powershell: PS_PATH, spawnSync: () => reply };
    assert.throws(() => launcher.setWinPrivate('C:\\a', SID, io), re);
  }
});

test('setWinPrivate: a succeeding PowerShell call returns without an error', () => {
  const io = { powershell: PS_PATH, spawnSync: () => ({ status: 0, stdout: '', stderr: '' }) };
  assert.doesNotThrow(() => launcher.setWinPrivate('C:\\a', SID, io));
});

test('runnerSha: an empty string for a missing file', (t) => {
  const dir = tempDir(t, 'zn-sha-');
  assert.equal(launcher.runnerSha(path.join(dir, 'missing.js')), '');
});

test('runnerSha: 64 hex characters for a real file, and the same for the same content', (t) => {
  const dir = tempDir(t, 'zn-sha-');
  const a = path.join(dir, 'a.js');
  const b = path.join(dir, 'b.js');
  fs.writeFileSync(a, 'console.log(1);\n');
  fs.writeFileSync(b, 'console.log(1);\n');
  const sha = launcher.runnerSha(a);
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.equal(launcher.runnerSha(b), sha);
  fs.writeFileSync(b, 'console.log(2);\n');
  assert.notEqual(launcher.runnerSha(b), sha);
});
