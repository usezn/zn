'use strict';

// The vault client (lib/vault/client.js) when no vault is running: every module-level call refuses with a clear
// error, a socket path that is too long is refused before connecting, and the Windows pipe address is used on Windows.
// Everything runs in a temporary ZN_HOME; no daemon is started.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const client = require('../lib/vault/client');

const ENV = ['HOME', 'USERPROFILE', 'ZN_HOME'];

function temporaryHome(t) {
  const home = tempDir(t, 'zn-client-');
  const saved = {};
  for (const k of ENV) saved[k] = process.env[k];
  Object.assign(process.env, { HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn') });
  t.after(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  return home;
}

test('every vault call made through the module refuses while no vault is running', async (t) => {
  temporaryHome(t);
  const calls = [
    () => client.mapToken('p', 'EMAIL', 'x@example.invalid'),
    () => client.resolve('p', 'tok'),
    () => client.setSecret('NAME', 'value', {}),
    () => client.listSecrets({ effective: false }),
    () => client.removeSecret('NAME'),
    () => client.maskInfo('p'),
    () => client.maskSpans('p', ['text']),
    () => client.exactValues('p'),
    () => client.audit({ kind: 'test' }),
    () => client.updateSecretMeta('NAME', {}),
    () => client.isApproved('p', 'NAME', 'psql'),
    () => client.recordApproval('p', 'NAME', 'psql'),
    () => client.confirmFileWrite('p', 'file.txt', ['NAME'], 'reason'),
    () => client.confirmApproval('command', 'p', 'summary'),
    () => client.adoptToken('p', 'tok', 'NAME', {}),
    () => client.sameSecretValue('NAME', 'value'),
    () => client.readBackup('p', 'NAME', 'backup.env'),
  ];
  for (const call of calls) await assert.rejects(call());
});

test('a socket path that is too long is refused with a hint, before anything connects', async (t) => {
  temporaryHome(t);
  if (process.platform === 'win32') return; // the Windows pipe name has no length limit here
  const home = tempDir(t, 'zn-client-long-') + path.sep + 'x'.repeat(120);
  const c = client.createClient({ home });
  try {
    await assert.rejects(c.status(), /socket path too long .* set ZN_HOME to a shorter directory/);
  } finally {
    c.close();
  }
});

test('on Windows the vault is reached through its named pipe, not a socket file', async (t) => {
  const home = temporaryHome(t);
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', realPlatform));
  const c = client.createClient({ home });
  try {
    // Nothing listens on that pipe here, so the call fails, but it never reports a socket path problem.
    await assert.rejects(c.status(), (err) => !/socket path too long/.test(String(err && err.message)));
  } finally {
    c.close();
  }
});
