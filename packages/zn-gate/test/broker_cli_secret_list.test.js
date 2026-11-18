'use strict';

// zn secret list and zn secret log / zn vault log (lib/broker/cli.js), with a fake vault and a fake client for
// the audit chain. Nothing is stored; the home folder is temporary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const { tempDir } = require('./helpers/tmp');
const broker = require('../lib/broker/cli');
const client = require('../lib/vault/client');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

// Runs dispatch with a fake vault and a temporary home; ZN_HOME is unset so the request file is read from home/.zn.
async function run(t, args, vault, group = 'secret') {
  const saved = process.env.ZN_HOME;
  delete process.env.ZN_HOME;
  t.after(() => { if (saved !== undefined) process.env.ZN_HOME = saved; });
  const home = tempDir(t, 'zn-broker-list-');
  const stdout = sink();
  const stderr = sink();
  const rc = await broker.dispatch(group, args, { vault, home, stdout, stderr });
  return { rc, out: stdout.text(), err: stderr.text(), home };
}

const fakeVault = (list) => ({ listSecrets: async () => list });

test('zn secret list with nothing stored says so and how to add a secret', async (t) => {
  const r = await run(t, ['list'], fakeVault([]));
  assert.equal(r.rc, 0);
  assert.match(r.out, /No secrets stored\. Add one with: zn secret set NAME/);
});

test('zn secret list shows each secret with its mode, allowed hosts and commands, and last use', async (t) => {
  const list = [
    { name: 'DB_PASSWORD', mode: 'env', allowCommands: ['psql'], allowHosts: [], lastUsed: '2026-11-01 10:00' },
    { name: 'API_KEY', allowHosts: ['api.example.com', 'files.example.com'], allowCommands: [] },
  ];
  const r = await run(t, ['list'], fakeVault(list));
  assert.equal(r.rc, 0);
  const lines = r.out.split('\n');
  const db = lines.find((l) => l.includes('DB_PASSWORD'));
  assert.match(db, /env\s+commands=psql\s+last used 2026-11-01 10:00/);
  const api = lines.find((l) => l.includes('API_KEY'));
  assert.match(api, /proxy\s+hosts=api\.example\.com,files\.example\.com/);
  assert.doesNotMatch(api, /commands=|last used/);
});

test('zn secret list adds the secrets agents asked for and that are not stored yet, once each', async (t) => {
  const vaultOnly = fakeVault([{ name: 'DB_PASSWORD' }]);
  const saved = process.env.ZN_HOME;
  delete process.env.ZN_HOME;
  t.after(() => { if (saved !== undefined) process.env.ZN_HOME = saved; });
  const home = tempDir(t, 'zn-broker-req-');
  fs.mkdirSync(path.join(home, '.zn'));
  fs.writeFileSync(path.join(home, '.zn', 'requests.jsonl'), [
    JSON.stringify({ name: 'NEW_TOKEN', reason: 'needed for the deploy' }),
    JSON.stringify({ name: 'DB_PASSWORD', reason: 'already stored' }),
    'this line is not JSON',
    JSON.stringify({ reason: 'no name' }),
    JSON.stringify({ name: 'NEW_TOKEN', reason: 'asked again' }),
    JSON.stringify({ name: 'OTHER_KEY' }),
    '',
  ].join('\n'));
  const stdout = sink();
  const rc = await broker.dispatch('secret', ['list'], { vault: vaultOnly, home, stdout, stderr: sink() });
  assert.equal(rc, 0);
  const text = stdout.text();
  assert.match(text, /Requested by agents \(add with zn secret set NAME\):/);
  assert.match(text, /NEW_TOKEN {2}- asked again/, 'the last request for a name is the one shown');
  assert.match(text, /OTHER_KEY/);
  assert.doesNotMatch(text, /DB_PASSWORD {2}- already stored/);
});

test('zn vault log with a verified chain shows each event, one per line', async (t) => {
  t.mock.method(client, 'createClient', () => ({
    isUnlocked: async () => true,
    auditRead: async () => ({ ok: true, events: [{ ts: '2026-11-01T10:00:00Z', decision: 'allow', secret: 'DB_PASSWORD', mode: 'env', agent: 'claude', tool: 'Bash', argv0: 'psql', reason: '' }] }),
    close() {},
  }));
  const r = await run(t, ['log'], {}, 'vault');
  assert.equal(r.rc, 0, r.err);
  assert.match(r.out, /2026-11-01T10:00:00Z {2}allow {2}DB_PASSWORD {2}env {2}claude {2}Bash {2}psql/);
});

test('zn vault log refuses to show a chain that does not verify', async (t) => {
  t.mock.method(client, 'createClient', () => ({
    isUnlocked: async () => true,
    auditRead: async () => ({ ok: false, reason: 'record 4 has a bad MAC', events: [] }),
    close() {},
  }));
  const r = await run(t, ['log'], {}, 'vault');
  assert.equal(r.rc, 1);
  assert.match(r.out, /chain: BROKEN: record 4 has a bad MAC/);
  assert.match(r.out, /The log is not shown because it did not verify/);
});

test('zn vault log when the unlocked vault cannot check the log (an older daemon) says so and shows nothing', async (t) => {
  t.mock.method(client, 'createClient', () => ({
    isUnlocked: async () => true,
    auditRead: async () => { throw new Error('unknown operation auditRead'); },
    close() {},
  }));
  const r = await run(t, ['log'], {}, 'vault');
  assert.equal(r.rc, 1);
  assert.match(r.out, /The log is not shown because the unlocked vault could not check it \(unknown operation auditRead\)/);
  assert.match(r.out, /restart the vault/);
});
