'use strict';
/*
 * B-2122: the audit log is read in chunks, never as one string. A string over
 * ~512 MiB throws ERR_STRING_TOO_LONG, which used to break upload and verify for
 * good and was then stored as tampering. These tests use a ~50 MB log and prove
 * the point by making any whole-file read of it fail, so they do not need 565 MB.
 * A read error is reported as a read error, never as tampering.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempDir } = require('./helpers/tmp');

process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';
const audit = require('../lib/vault/audit');
const { uploadPending, pendingCount } = require('../lib/team/upload');

const KEY = crypto.randomBytes(32);

/* Builds a valid chained log of n records; returns the last {seq, mac}. */
function writeLog(file, n) {
  const fd = fs.openSync(file, 'w', 0o600);
  let prev = audit.GENESIS;
  let buf = [];
  let last = null;
  try {
    for (let seq = 1; seq <= n; seq++) {
      const rec = { v: 1, seq, ts: '2026-10-30T10:00:00.000Z', secret: 'API_KEY', mode: 'env', agent: 'claude-code', tool: 'Bash', argv0: 'curl', host: 'example.com', decision: 'allow', prev };
      rec.mac = crypto.createHmac('sha256', KEY).update(JSON.stringify(rec)).digest('hex');
      prev = rec.mac;
      last = { seq, mac: rec.mac };
      buf.push(JSON.stringify(rec));
      if (buf.length === 5000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; }
    }
    if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n');
  } finally { fs.closeSync(fd); }
  return last;
}

/* Makes any whole-file read of `file` throw, like a string that is too long. */
function forbidWholeRead(t, file) {
  const real = fs.readFileSync;
  fs.readFileSync = function patched(p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(file)) {
      const e = new Error('Cannot create a string longer than 0x1fffffe8 characters');
      e.code = 'ERR_STRING_TOO_LONG';
      throw e;
    }
    return real.call(this, p, ...rest);
  };
  t.after(() => { fs.readFileSync = real; });
}

test('forEachLine: lines across chunks, blank lines, multibyte text, no final newline', (t) => {
  const dir = tempDir(t, 'zn-stream-');
  const file = path.join(dir, 'a.jsonl');
  const lines = ['{"a":"é€😀"}', '', 'second line', '', '{"z":1}'];
  fs.writeFileSync(file, lines.join('\n'));
  for (const chunkSize of [1, 2, 3, 7, 4096]) {
    const got = [];
    assert.strictEqual(audit.forEachLine(file, (l, n) => { got.push([l, n]); }, { chunkSize }), true);
    assert.deepStrictEqual(got.map((x) => x[0]), ['{"a":"é€😀"}', 'second line', '{"z":1}'], 'chunk ' + chunkSize);
    assert.deepStrictEqual(got.map((x) => x[1]), [1, 2, 3]);
  }
  assert.strictEqual(audit.forEachLine(path.join(dir, 'missing'), () => {}), false);
});

test('forEachLine: a line over maxLine is handed over as null; stopping early works', (t) => {
  const dir = tempDir(t, 'zn-stream-');
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, 'ok\n' + 'x'.repeat(100) + '\nafter\n');
  const got = [];
  audit.forEachLine(file, (l) => { got.push(l); }, { chunkSize: 8, maxLine: 20 });
  assert.deepStrictEqual(got, ['ok', null, 'after']);
  let calls = 0;
  audit.forEachLine(file, () => { calls++; return true; }, { chunkSize: 8 });
  assert.strictEqual(calls, 1);
});

test('large log: verify, pendingCount and uploadPending never read the whole file', async (t) => {
  const dir = tempDir(t, 'zn-stream-');
  const file = path.join(dir, 'audit.jsonl');
  const N = 250000;
  const last = writeLog(file, N);
  assert.ok(fs.statSync(file).size > 40 * 1024 * 1024, 'about 50 MB');
  forbidWholeRead(t, file);

  const v = audit.verify({ file, key: KEY, checkpoint: last });
  assert.deepStrictEqual(v, { ok: true, records: N });
  assert.strictEqual(audit.read({ file, limit: 3 }).length, 3);
  assert.deepStrictEqual(audit.read({ file, limit: 3 }).map((e) => e.seq), [N - 2, N - 1, N]);

  const stateFile = path.join(dir, 'up.json');
  assert.strictEqual(pendingCount({ auditFile: file, stateFile, startAfterSeq: 100 }), N - 100);

  const seen = [];
  const api = { ingest: async (body) => {
    const ev = body.events[body.events.length - 1];
    seen.push(body.events.length);
    return { status: 200, body: { accepted: body.events.length, head: { seq: ev.seq, mac: ev.mac } } };
  } };
  const r = await uploadPending({ auditFile: file, stateFile, lockFile: path.join(dir, 'up.lock'), installId: '6f1c2b1e-0000-4000-8000-000000000001', api, batchSize: 500, maxBatches: 2 });
  assert.strictEqual(r.status, 'ok', JSON.stringify(r));
  assert.strictEqual(r.uploaded, 1000);
  assert.strictEqual(r.head.seq, 1000);
  assert.strictEqual(r.pending, N - 1000);
  assert.deepStrictEqual(seen, [500, 500]);
});

test('large log: chunk size does not change the answer (tiny chunks)', (t) => {
  const dir = tempDir(t, 'zn-stream-');
  const file = path.join(dir, 'audit.jsonl');
  const last = writeLog(file, 300);
  for (const chunkSize of [5, 97, 1 << 20]) {
    assert.deepStrictEqual(audit.verify({ file, key: KEY, checkpoint: last, chunkSize }), { ok: true, records: 300 }, 'chunk ' + chunkSize);
  }
  // A changed record in the middle is still found with small chunks.
  const l = fs.readFileSync(file, 'utf8').split('\n');
  const rec = JSON.parse(l[150]);
  rec.decision = 'deny';
  l[150] = JSON.stringify(rec);
  fs.writeFileSync(file, l.join('\n'));
  const bad = audit.verify({ file, key: KEY, checkpoint: last, chunkSize: 13 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.line, 151);
  assert.strictEqual(bad.error, 'bad mac');
});

test('verify: a line that is JSON but not a record is a finding, not a read error', (t) => {
  const dir = tempDir(t, 'zn-stream-');
  const file = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(file, 'null\n');
  assert.deepStrictEqual(audit.verify({ file, key: KEY }), { ok: false, records: 0, line: 1, error: 'unparseable record' });
});

test('a log that cannot be read is an error from verify and upload, not a finding', async (t) => {
  const dir = tempDir(t, 'zn-stream-');
  const file = path.join(dir, 'audit.jsonl');
  fs.mkdirSync(file); // a directory where the log should be: reading it fails with EISDIR
  assert.throws(() => audit.verify({ file, key: KEY }), (e) => e.code === 'EISDIR');
  const r = await uploadPending({
    auditFile: file, stateFile: path.join(dir, 's.json'), lockFile: path.join(dir, 's.lock'),
    installId: '6f1c2b1e-0000-4000-8000-000000000001', api: { ingest: async () => { throw new Error('must not be called'); } },
  });
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.pending, -1);
});

test('daemon: a read error is reported as a read error and stores no tamper mark', async (t) => {
  const keychain = require('../lib/vault/keychain');
  const daemon = require('../lib/vault/daemon');
  const clientMod = require('../lib/vault/client');
  const store = require('../lib/vault/store');
  process.env.ZN_HOME = tempDir(t, 'znvt-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const srv = await daemon.serve({ identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true });
  const c = clientMod.createClient({});
  t.after(async () => { c.close(); await srv.close(); });
  await c.setSecret('K1', 'value-' + crypto.randomBytes(8).toString('hex'), { mode: 'env' });
  assert.strictEqual((await c.auditVerify()).ok, true);

  const file = store.paths().auditFile;
  const realOpen = fs.openSync;
  fs.openSync = function patched(p, flags, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(file) && flags === 'r') {
      const e = new Error('EACCES: permission denied, open'); e.code = 'EACCES'; throw e;
    }
    return realOpen.call(this, p, flags, ...rest);
  };
  let v; let rd;
  try {
    v = await c.auditVerify();
    rd = await c.auditRead({});
  } finally { fs.openSync = realOpen; }
  assert.strictEqual(v.ok, false);
  assert.notStrictEqual(v.tampered, true, JSON.stringify(v));
  assert.match(v.error, /cannot be read/);
  assert.match(v.error, /not a sign that it was changed/);
  assert.strictEqual(rd.ok, false);
  assert.notStrictEqual(rd.tampered, true);
  // Once the log can be read again, the vault is as it was: no mark was stored.
  const again = await c.auditVerify();
  assert.strictEqual(again.ok, true, JSON.stringify(again));
  assert.notStrictEqual(again.tampered, true);
});
