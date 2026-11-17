'use strict';
/**
 * `zn secret set NAME` without --force stores a new secret only: the daemon refuses an existing name inside its
 * serial section, so two terminals that both saw "not there" cannot both store it. `zn secret rm` of a name that is
 * already gone fails instead of printing "Removed". Fake values only.
 */
process.env.ZN_STATS = 'off';
process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');
const { tempDir } = require('./helpers/tmp');

const cli = require('../lib/broker/cli');
const { createFakeVault } = require('./helpers/fake_vault');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

// A barrier: every caller waits until `n` have arrived, so both commands have looked before either one acts.
function barrier(n) {
  let waiting = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  return () => { if (++waiting >= n) release(); return gate; };
}

async function startDaemon(t) {
  const keychain = require('../lib/vault/keychain');
  const daemon = require('../lib/vault/daemon');
  const clientMod = require('../lib/vault/client');
  process.env.ZN_HOME = tempDir(t, 'znvt-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const srv = await daemon.serve({ identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true });
  const clients = [];
  const make = () => { const c = clientMod.createClient({}); clients.push(c); return c; };
  t.after(async () => { for (const c of clients) c.close(); await srv.close(); });
  return make;
}

function ioFor(vault, over = {}) {
  return { cwd: process.cwd(), home: process.cwd(), vault, stdout: sink(), stderr: sink(), human: true, confirm: async () => true, ...over };
}

test('daemon: createOnly refuses an existing name and keeps its value; without it the value is replaced', async (t) => {
  const make = await startDaemon(t);
  const c = make();
  assert.equal(await c.setSecret('FAKE_KEY', 'first-value-1234', { mode: 'env' }, { createOnly: true }), true);
  await assert.rejects(c.setSecret('FAKE_KEY', 'second-value-5678', { mode: 'env' }, { createOnly: true }), (e) => e.code === 'ZN_POLICY_DENIED' && /already exists; use --force/.test(e.message));
  assert.equal(await c.sameSecretValue('FAKE_KEY', 'first-value-1234'), true, 'the first value is still there');
  // An older client sends no options: the old behaviour (replace) stays.
  assert.equal(await c.setSecret('FAKE_KEY', 'third-value-9012', { mode: 'env' }), true);
  assert.equal(await c.sameSecretValue('FAKE_KEY', 'third-value-9012'), true);
});

test('two concurrent `secret set` of the same new name: one stores, the other is refused, the first value stays', async (t) => {
  const make = await startDaemon(t);
  const gate = barrier(2);
  const run = (value) => {
    const io = ioFor(make(), { readSecret: async () => { await gate(); return value; } });
    return cli.dispatch('secret', ['set', 'RACE_KEY'], io).then((code) => ({ code, io }));
  };
  const results = await Promise.all([run('value-from-one-1234'), run('value-from-two-5678')]);
  const stored = results.filter((r) => r.code === 0);
  const refused = results.filter((r) => r.code !== 0);
  assert.equal(stored.length, 1, 'exactly one "Stored"');
  assert.equal(refused.length, 1);
  assert.match(stored[0].io.stdout.text(), /Stored RACE_KEY/);
  assert.match(refused[0].io.stderr.text(), /RACE_KEY already exists; use --force to replace it/);
  assert.doesNotMatch(refused[0].io.stdout.text(), /Stored/);
  const winner = stored[0] === results[0] ? 'value-from-one-1234' : 'value-from-two-5678';
  assert.equal(await make().sameSecretValue('RACE_KEY', winner), true);
});

test('concurrent `secret set --force` still both succeed', async (t) => {
  const make = await startDaemon(t);
  const gate = barrier(2);
  const run = (value) => {
    const io = ioFor(make(), { readSecret: async () => { await gate(); return value; } });
    return cli.dispatch('secret', ['set', 'RACE_KEY', '--force'], io);
  };
  assert.deepEqual(await Promise.all([run('value-from-one-1234'), run('value-from-two-5678')]), [0, 0]);
});

test('two concurrent `secret rm` of the same name: one removes, the other says it is not in the vault', async (t) => {
  const make = await startDaemon(t);
  await make().setSecret('GONE_KEY', 'some-value-1234', { mode: 'env' });
  const gate = barrier(2);
  const run = () => {
    const io = ioFor(make(), { confirm: async () => { await gate(); return true; } });
    return cli.dispatch('secret', ['rm', 'GONE_KEY'], io).then((code) => ({ code, io }));
  };
  const results = await Promise.all([run(), run()]);
  const removed = results.filter((r) => r.code === 0);
  const failed = results.filter((r) => r.code !== 0);
  assert.equal(removed.length, 1, 'exactly one "Removed"');
  assert.match(removed[0].io.stdout.text(), /Removed GONE_KEY\./);
  assert.equal(failed.length, 1);
  assert.match(failed[0].io.stderr.text(), /GONE_KEY is not in the vault/);
  assert.doesNotMatch(failed[0].io.stdout.text(), /Removed/);
});

test('rm: a removeSecret that answers false is a failure, not "Removed"', async () => {
  const vault = createFakeVault();
  await vault.setSecret('SOME_KEY', 'some-value-1234', { mode: 'env' });
  vault.removeSecret = async () => false;
  const io = ioFor(vault);
  const code = await cli.dispatch('secret', ['rm', 'SOME_KEY'], io);
  assert.notEqual(code, 0);
  assert.match(io.stderr.text(), /SOME_KEY is not in the vault/);
  assert.doesNotMatch(io.stdout.text(), /Removed/);
});

test('set against a vault that ignores the option (an older daemon) still stores', async () => {
  const vault = createFakeVault();
  const real = vault.setSecret;
  vault.setSecret = async (name, value, meta) => real(name, value, meta); // three parameters, as before
  const io = ioFor(vault, { readSecret: async () => 'abcd1234-fake' });
  assert.equal(await cli.dispatch('secret', ['set', 'OLD_DAEMON'], io), 0);
  assert.equal((await vault.listSecrets()).length, 1);
});

test('set with --force does not ask for create-only', async () => {
  const vault = createFakeVault();
  let opts = 'unset';
  const real = vault.setSecret;
  vault.setSecret = async (name, value, meta, o) => { opts = o; return real(name, value, meta); };
  const io = ioFor(vault, { readSecret: async () => 'abcd1234-fake' });
  assert.equal(await cli.dispatch('secret', ['set', 'FORCED', '--force'], io), 0);
  assert.equal(opts, undefined);
  assert.equal(await cli.dispatch('secret', ['set', 'PLAIN'], io), 0);
  assert.deepEqual(opts, { createOnly: true });
});
