'use strict';

// zn vault commands (lib/vault/cli.js) run for real in a temporary ZN_HOME, with no daemon running: status, forget,
// verify, team and the restart wait for an older vault. Nothing touches the real home or keychain.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const keychain = require('../lib/vault/keychain');
const cli = require('../lib/vault/cli');

const ENV = ['HOME', 'USERPROFILE', 'ZN_HOME', 'ZN_KEYCHAIN_BACKEND'];

// A temporary home for the vault; the environment is put back when the test ends.
function zn(t) {
  const home = tempDir(t, 'zn-vault-cmd-');
  const znHome = path.join(home, '.zn');
  const saved = {};
  for (const k of ENV) saved[k] = process.env[k];
  Object.assign(process.env, { HOME: home, USERPROFILE: home, ZN_HOME: znHome, ZN_KEYCHAIN_BACKEND: 'passphrase' });
  t.after(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  return { home, znHome };
}

// Captures what the command prints on stdout and stderr.
function capture(t) {
  const out = { stdout: '', stderr: '' };
  const w = (key) => (chunk) => { out[key] += String(chunk); return true; };
  const so = process.stdout.write;
  const se = process.stderr.write;
  process.stdout.write = w('stdout');
  process.stderr.write = w('stderr');
  t.after(() => { process.stdout.write = so; process.stderr.write = se; });
  return out;
}

test('zn vault team says the shared vault is not there yet, and sends nothing', (t) => {
  zn(t);
  const out = capture(t);
  return cli.runVaultCommand(['vault', 'team']).then((rc) => {
    assert.equal(rc, 0);
    assert.match(out.stdout, /A shared vault for teams is planned, not available yet/);
    assert.match(out.stdout, /Nothing was sent/);
  });
});

test('zn vault status before any vault exists says so and points to unlock', async (t) => {
  zn(t);
  const out = capture(t);
  assert.equal(await cli.runVaultCommand(['vault']), 0);
  assert.match(out.stdout, /Vault: not created yet/);
});

test('zn vault status with a vault that is not running says it is locked and shows where it is', async (t) => {
  const { znHome } = zn(t);
  keychain.writeMeta({ backend: 'passphrase', recipient: 'age1' + 'q'.repeat(58) }, {});
  const out = capture(t);
  assert.equal(await cli.runVaultCommand(['vault', 'status']), 0);
  assert.match(out.stdout, /Vault: locked \(backend passphrase\)/);
  assert.ok(out.stdout.includes('Location: ' + path.join(znHome, 'vault')), out.stdout);
});

test('zn vault forget on a folder with no stored token map says so', async (t) => {
  const { home } = zn(t);
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  const out = capture(t);
  assert.equal(await cli.runVaultCommand(['vault', 'forget', project]), 0);
  assert.match(out.stdout, /No token map stored for /);
});

test('zn vault verify --acknowledge is refused without a person at a terminal, and changes nothing', async (t) => {
  zn(t);
  const out = capture(t);
  assert.equal(await cli.runVaultCommand(['vault', 'verify', '--acknowledge']), 1);
  assert.match(out.stderr, /\S/, 'the refusal is printed');
  assert.doesNotMatch(out.stdout, /accepted as it is now/);
});

test('zn vault verify with no running vault fails cleanly with exit 1', async (t) => {
  zn(t);
  const out = capture(t);
  assert.equal(await cli.runVaultCommand(['vault', 'verify']), 1);
  assert.doesNotMatch(out.stdout, /Audit log OK/);
});

test('an unknown vault command prints the usage and exits 2', async (t) => {
  zn(t);
  const out = capture(t);
  assert.equal(await cli.runVaultCommand(['vault', 'nonsense']), 2);
  assert.match(out.stderr, /usage: /);
});

test('restartIfOutdated: an older vault whose process is gone is restarted at once', async () => {
  const said = [];
  let locked = 0;
  const restarted = await cli.restartIfOutdated({
    clientFactory: () => ({ status: async () => ({ unlocked: true, expiresAt: 'T', pid: 4194000 }), close() {} }),
    out: (s) => said.push(s),
    lock: async () => { locked += 1; },
    sleep: async () => {},
  });
  assert.equal(restarted, true);
  assert.equal(locked, 1);
  assert.deepEqual(said, ['The running vault is from an older zn-gate; restarting it.']);
});

test('restartIfOutdated: an older vault process that still exists blocks the restart with a clear message', { skip: process.platform === 'win32' && 'pid 1 is not a process to signal on Windows' }, async () => {
  // Pid 1 always exists here (and is not ours to signal unless we are root), so the wait can never end.
  await assert.rejects(cli.restartIfOutdated({
    clientFactory: () => ({ status: async () => ({ unlocked: true, expiresAt: 'T', pid: 1 }), close() {} }),
    out: () => {},
    lock: async () => {},
    sleep: async () => {},
    timeoutMs: 0,
  }), /did not stop; run `.*lock`, wait a moment, then `.*unlock`/);
});
