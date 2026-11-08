'use strict';
/**
 * `zn secret list` shows the names, mode and policy of the stored secrets and never their values.
 * The vault is the in-memory fake (test/helpers/fake_vault.js, same contract as the daemon client);
 * the listing is the real code path of lib/broker/cli.js. Fake values only.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');

const cli = require('../lib/broker/cli');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

const VALUES = {
  DEMO_API_TOKEN: 'fake-demo-value-AAAA-0001',
  DEMO_DB_PASSWORD: 'fake-demo-value-BBBB-0002',
};

// The same value in the encodings a leak could take.
function encodingsOf(value) {
  const buf = Buffer.from(value, 'utf8');
  return [value, buf.toString('base64'), buf.toString('hex'), encodeURIComponent(value)];
}

async function listing(t, vault) {
  const home = tempDir(t, 'zn-secret-list-home-');
  const io = { cwd: home, home, vault, stdout: sink(), stderr: sink(), human: true };
  const code = await cli.dispatch('secret', ['list'], io);
  return { code, out: io.stdout.text(), err: io.stderr.text() };
}

test('secret list shows the names, mode and policy of a populated vault', async (t) => {
  const vault = createFakeVault();
  await vault.setSecret('DEMO_API_TOKEN', VALUES.DEMO_API_TOKEN, { mode: 'proxy', allowHosts: ['api.example.com'] });
  await vault.setSecret('DEMO_DB_PASSWORD', VALUES.DEMO_DB_PASSWORD, { mode: 'env', allowCommands: ['psql'] });
  const r = await listing(t, vault);
  assert.equal(r.code, 0, r.err);
  const api = r.out.split('\n').find((l) => l.includes('DEMO_API_TOKEN'));
  const db = r.out.split('\n').find((l) => l.includes('DEMO_DB_PASSWORD'));
  assert.ok(api, r.out);
  assert.ok(db, r.out);
  assert.match(api, /proxy/);
  assert.match(api, /hosts=api\.example\.com/);
  assert.match(db, /env/);
  assert.match(db, /commands=psql/);
});

test('secret list never prints a stored value, plain or encoded', async (t) => {
  const vault = createFakeVault();
  for (const [name, value] of Object.entries(VALUES)) {
    await vault.setSecret(name, value, { mode: 'proxy', allowHosts: ['api.example.com'] });
  }
  const r = await listing(t, vault);
  assert.equal(r.code, 0, r.err);
  for (const value of Object.values(VALUES)) {
    for (const form of encodingsOf(value)) {
      assert.ok(!r.out.includes(form), 'value leaked on stdout: ' + form.slice(0, 6));
      assert.ok(!r.err.includes(form), 'value leaked on stderr: ' + form.slice(0, 6));
    }
  }
});

test('secret list on an empty vault says so and prints no values', async (t) => {
  const r = await listing(t, createFakeVault());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /No secrets stored/);
  assert.equal(r.err, '');
});
