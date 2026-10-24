'use strict';
/*
 * An audit append does not verify the whole log: it checks the tail (the record
 * the vault remembers and the last records) and appends. The whole chain is
 * checked at unlock, on every read, export and upload, and on an append once the
 * last full check is older than a minute. These tests pin what is and is not
 * caught at write time, and that nothing a write leaves behind can make a later
 * read, export or upload trust an edited log.
 * Runs the real daemon and client against a temporary ZN_HOME.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tempDir } = require('./helpers/tmp');

process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';
const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const clientMod = require('../lib/vault/client');
const store = require('../lib/vault/store');
const audit = require('../lib/vault/audit');

const origAppend = audit.append;
const origVerify = audit.verify;

async function harness(t, extra, records) {
  process.env.ZN_HOME = tempDir(t, 'znincr-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const h = { open: true };
  const opts = Object.assign({ identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true }, extra || {});
  h.srv = await daemon.serve(opts);
  h.c = clientMod.createClient({});
  h.file = () => store.paths().auditFile;
  h.lines = () => fs.readFileSync(h.file(), 'utf8').split('\n').filter(Boolean);
  h.set = (i) => h.c.setSecret('K' + i, 'fakevalue' + i, { mode: 'env' });
  // Same-length edit of one digit of the timestamp of record number `index` (0-based), in place.
  h.editRecord = (index) => {
    const lines = h.lines();
    let off = 0;
    for (let k = 0; k < index; k++) off += Buffer.byteLength(lines[k]) + 1;
    const p = lines[index].indexOf('"ts":"') + 6 + 3;
    const fd = fs.openSync(h.file(), 'r+');
    fs.writeSync(fd, lines[index][p] === '1' ? '2' : '1', off + p);
    fs.closeSync(fd);
  };
  h.editMiddle = () => h.editRecord(Math.floor(h.lines().length / 2));
  h.close = async () => { if (h.open) { h.open = false; h.c.close(); await h.srv.close(); } };
  t.after(async () => { audit.append = origAppend; audit.verify = origVerify; await h.close(); });
  for (let i = 0; i < (records || 6); i++) await h.set(i);
  return h;
}

async function outcome(h) {
  const r = await h.c.auditRead({});
  const e = await h.c.auditExport({});
  const v = await h.c.auditVerify();
  return { read: r.ok, export: e.ok, verify: v.ok, tampered: r.tampered === true && v.tampered === true };
}
const REFUSED = { read: false, export: false, verify: false, tampered: true };

test('an append does not verify the whole log', async (t) => {
  const h = await harness(t, null, 20);
  let calls = 0;
  audit.verify = function (o) { calls++; return origVerify(o); };
  for (let i = 100; i < 120; i++) await h.set(i);
  assert.strictEqual(calls, 0, 'no full verify during 20 writes');
  assert.strictEqual((await h.c.auditRead({})).ok, true);
  assert.strictEqual(calls, 1, 'the first read after the writes checks the whole chain once');
  assert.strictEqual((await h.c.auditRead({})).ok, true);
  assert.strictEqual(calls, 1, 'and the unchanged log is then cached');
});

test('a change in the last records is marked by the next write', async (t) => {
  const h = await harness(t, null, 20);
  h.editRecord(h.lines().length - 3);
  await h.set(200);
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.tampered, true);
  assert.match(v.error, /last records/);
});

test('a change far inside the log: the write goes on, read, export and verify refuse', async (t) => {
  const h = await harness(t, null, 160);
  assert.ok(h.lines().slice(6).join('\n').length > 16384 + 2048, 'record 5 is outside the tail window');
  assert.strictEqual((await h.c.auditRead({})).ok, true); // warm cache
  h.editRecord(5);
  await h.set(300);
  assert.deepStrictEqual(await outcome(h), REFUSED);
});

test('with a full check on every write (fullVerifyMs 0) the same change is marked by the write', async (t) => {
  const h = await harness(t, { fullVerifyMs: 0 }, 160);
  const before = h.lines();
  h.editRecord(5);
  await h.set(301);
  // Put the edited record back: only a stored mark can still report it.
  const now = h.lines();
  now[5] = before[5];
  fs.writeFileSync(h.file(), now.join('\n') + '\n');
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, false, JSON.stringify(v));
  assert.strictEqual(v.tampered, true);
});

test('a truncated tail is still marked by the next write', async (t) => {
  const h = await harness(t, null, 20);
  const lines = h.lines();
  fs.writeFileSync(h.file(), lines.slice(0, lines.length - 2).join('\n') + '\n');
  await h.set(400);
  const v = await h.c.auditVerify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.tampered, true);
});

test('reviewer probe P1: edit between the tail check and the write', async (t) => {
  const h = await harness(t, null, 160);
  assert.strictEqual((await h.c.auditRead({})).ok, true);
  audit.append = function (ev, o) { audit.append = origAppend; h.editMiddle(); return origAppend(ev, o); };
  await h.set(50);
  assert.deepStrictEqual(await outcome(h), REFUSED);
});

test('reviewer probe P2: edit right after the write', async (t) => {
  const h = await harness(t, null, 160);
  assert.strictEqual((await h.c.auditRead({})).ok, true);
  audit.append = function (ev, o) { audit.append = origAppend; const r = origAppend(ev, o); h.editMiddle(); return r; };
  await h.set(51);
  assert.deepStrictEqual(await outcome(h), REFUSED);
});

test('reviewer probe P3: another process edits as soon as the file grows (15 trials, none is trusted)', async (t) => {
  const attacker = path.join(__dirname, 'helpers', 'vault_race_attacker.js');
  let won = 0;
  for (let n = 0; n < 15; n++) {
    const h = await harness(t, null, 60);
    assert.strictEqual((await h.c.auditRead({})).ok, true);
    const size0 = fs.statSync(h.file()).size;
    const child = spawn(process.execPath, [attacker, h.file(), String(size0)], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((res) => child.on('exit', res));
    await new Promise((res) => child.stdout.once('data', res));
    await h.set(60);
    await exited;
    const r = await h.c.auditRead({});
    const e = await h.c.auditExport({});
    if (r.ok || e.ok) won++;
    await h.close();
  }
  assert.strictEqual(won, 0, 'the attacker won ' + won + ' of 15');
});
