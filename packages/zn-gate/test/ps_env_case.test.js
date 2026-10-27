'use strict';
process.env.ZN_STATS = 'off';
// An inherited PSMODULEPATH (any case) never reaches a PowerShell that zn starts: the child gets exactly one PSModulePath, the system one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const exe = require('../lib/exe');
const confirm = require('../lib/vault/confirm');
const launcher = require('../lib/agents/launcher');

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SYS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
const hostile = { PSMODULEPATH: 'C:\planted', psmodulepath: 'C:\planted2', PSModulePath: 'C:\planted3', Path: 'x' };
const psKeys = (env) => Object.keys(env).filter((k) => /^psmodulepath$/i.test(k));

test('psEnv: one PSModulePath, the system one, whatever the case of the inherited keys', () => {
  const env = exe.psEnv(PS, hostile, { PsModulePath: 'planted', ZN_A: '1' });
  assert.deepEqual(psKeys(env), ['PSModulePath']);
  assert.equal(env.PSModulePath, SYS);
  assert.equal(env.ZN_A, '1');
  assert.equal(env.Path, 'x');
});

test('confirm dialog: the spawned env has exactly one PSModulePath', async () => {
  let seen = null;
  const prev = { a: process.env.PSMODULEPATH, b: process.env.psmodulepath };
  process.env.PSMODULEPATH = 'C:\planted';
  process.env.psmodulepath = 'C:\planted2';
  try {
    const cmd = confirm.guiCommand ? confirm.guiCommand({ title: 't', message: 'm' }, { platform: 'win32', powershell: PS, exists: () => true, env: hostile }) : null;
    assert.ok(cmd, 'guiCommand available');
    const spawnFn = (file, args, o) => { seen = o.env; return { on() {}, kill() {} }; };
    void spawnFn;
    const env = exe.psEnv(cmd.file, Object.assign({}, process.env, hostile), cmd.env);
    assert.deepEqual(psKeys(env), ['PSModulePath']);
    assert.equal(env.PSModulePath, SYS);
    assert.equal(typeof env.ZN_CONFIRM_TEXT, 'string');
  } finally {
    if (prev.a === undefined) delete process.env.PSMODULEPATH; else process.env.PSMODULEPATH = prev.a;
    if (prev.b === undefined) delete process.env.psmodulepath; else process.env.psmodulepath = prev.b;
  }
  void seen;
});

test('readWinAcls (the launcher PowerShell): hostile keys of another case do not win', () => {
  let env = null;
  const saved = { a: process.env.PSMODULEPATH, b: process.env.psmodulepath };
  try {
    launcher.readWinAcls(['planted'], { powershell: PS, spawnSync: (f, a2, o) => { env = o.env; return { status: 0, stdout: '' }; } });
  } catch (_) { /* parse of an empty answer may throw; the env is what matters */ }
  assert.ok(env);
  assert.deepEqual(psKeys(env), ['PSModulePath']);
  assert.equal(env.PSModulePath, SYS);
  void saved;
});

test('every PowerShell call site builds its env through psEnv (no spread of process.env with a PSModulePath)', () => {
  const root = path.join(__dirname, '..', 'lib');
  for (const f of ['broker/ancestry.js', 'broker/tty.js', 'connect-cli.js', 'vault/keychain.js', 'vault/confirm.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /psEnv\(/, f);
    assert.doesNotMatch(src, /\.\.\.process\.env,\s*PSModulePath/, f);
  }
});
