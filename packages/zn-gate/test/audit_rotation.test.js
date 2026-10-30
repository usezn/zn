'use strict';
/*
 * B-2196: the audit log is closed as a segment (audit.<n>.jsonl) when it passes a
 * size limit. The chain, the checkpoint, the upload, the export, reset and purge
 * all work across segments, and a crash between the rename and the next record
 * is recovered from.
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
const { exportAuditStream, exportAuditFile } = require('../lib/team/otel');
const reset = require('../lib/vault/reset');
const purge = require('../lib/vault/purge');
const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const clientMod = require('../lib/vault/client');
const store = require('../lib/vault/store');

const INSTALL = '6f1c2b1e-0000-4000-8000-000000000001';
const EVENT = { secret: 'DB_PASSWORD', mode: 'env', agent: 'claude-code', tool: 'Bash', argv0: 'curl', host: 'example.com', decision: 'allow' };

/* Appends n records the way the daemon does: rotate first when the file is over the limit. */
function fill(file, key, n, maxBytes) {
  let last = null;
  for (let i = 0; i < n; i++) {
    audit.rotate({ file, key, maxBytes });
    last = audit.append(EVENT, { file, key });
  }
  return last;
}

function setup(t, n, maxBytes) {
  const dir = tempDir(t, 'zn-rot-');
  const file = path.join(dir, 'audit.jsonl');
  const key = crypto.randomBytes(32);
  const last = fill(file, key, n, maxBytes);
  return { dir, file, key, last };
}

const lines = (f) => fs.readFileSync(f, 'utf8').trim().split('\n');

test('rotation: closed segments end with a rotate record and the chain continues in the new file', (t) => {
  const { file, key } = setup(t, 40, 2000);
  const segs = audit.segments(file);
  assert.ok(segs.length >= 3, 'several segments at a 2000-byte limit, got ' + segs.length);
  assert.deepStrictEqual(segs.map((s) => s.n), segs.map((_, i) => i + 1));
  for (const s of segs) {
    const last = JSON.parse(lines(s.file).pop());
    assert.strictEqual(last.decision, 'rotate');
    assert.strictEqual(last.reason, 'segment:' + s.n);
  }
  // The first record of the active file links to the rotate record of the last segment.
  const prevLast = JSON.parse(lines(segs[segs.length - 1].file).pop());
  const first = JSON.parse(lines(file)[0]);
  assert.strictEqual(first.prev, prevLast.mac);
  assert.strictEqual(first.seq, prevLast.seq + 1);
  const r = audit.verify({ file, key });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.records, 40 + segs.length, 'every rotate record is one more record');
});

test('rotation: no limit, or a small file, never rotates', (t) => {
  const { file, key } = setup(t, 10, undefined);
  assert.deepStrictEqual(audit.segments(file), []);
  assert.strictEqual(audit.rotate({ file, key, maxBytes: 10 * 1024 * 1024 }), null);
  assert.strictEqual(audit.verify({ file, key }).ok, true);
});

test('rotation: the checkpoint stays the last record, and a lost tail is still found', (t) => {
  const { file, key, last } = setup(t, 25, 1500);
  const head = { seq: last.seq, mac: last.mac };
  assert.strictEqual(audit.verify({ file, key, checkpoint: head }).ok, true);
  assert.strictEqual(audit.checkHead(file, head).ok, true);
  // Cut the active file: the log ends before the checkpoint.
  const l = lines(file);
  fs.writeFileSync(file, l.slice(0, 1).join('\n') + '\n');
  const r = audit.verify({ file, key, checkpoint: head });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /log truncated/);
  assert.strictEqual(audit.checkHead(file, head).ok, false);
});

test('a checkpoint inside an old segment still verifies after more rotations', (t) => {
  const { file, key } = setup(t, 12, 1500);
  const seg1 = audit.segments(file)[0];
  const rec = JSON.parse(lines(seg1.file)[2]);
  const head = { seq: rec.seq, mac: rec.mac };
  assert.strictEqual(audit.verify({ file, key, checkpoint: head }).ok, true);
  assert.strictEqual(audit.verify({ file, key, checkpoint: { seq: rec.seq, mac: 'a'.repeat(64) } }).ok, false);
});

test('a changed record in an old segment is detected', (t) => {
  const { file, key } = setup(t, 30, 1500);
  const seg = audit.segments(file)[0];
  const l = lines(seg.file);
  const rec = JSON.parse(l[1]);
  rec.decision = 'deny';
  l[1] = JSON.stringify(rec);
  fs.writeFileSync(seg.file, l.join('\n') + '\n');
  const r = audit.verify({ file, key });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'bad mac');
  assert.strictEqual(r.line, 2);
});

test('a deleted, swapped or relabelled segment is detected', (t) => {
  const a = setup(t, 30, 1500);
  const segs = audit.segments(a.file);
  assert.ok(segs.length >= 3);
  // Middle segment deleted: the chain breaks at the next one.
  fs.unlinkSync(segs[1].file);
  const r1 = audit.verify({ file: a.file, key: a.key });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.error, /broken chain|bad sequence/);
  // Oldest segment deleted: the first record no longer starts the chain.
  const b = setup(t, 30, 1500);
  fs.unlinkSync(audit.segments(b.file)[0].file);
  assert.strictEqual(audit.verify({ file: b.file, key: b.key }).ok, false);
  // A segment under the wrong number does not end with its own rotate record.
  const c = setup(t, 30, 1500);
  const cs = audit.segments(c.file);
  fs.renameSync(cs[0].file, audit.segmentPath(c.file, 99));
  const r3 = audit.verify({ file: c.file, key: c.key });
  assert.strictEqual(r3.ok, false);
});

test('a closed segment that does not end with a rotate record is refused', (t) => {
  const dir = tempDir(t, 'zn-rot-');
  const file = path.join(dir, 'audit.jsonl');
  const key = crypto.randomBytes(32);
  for (let i = 0; i < 4; i++) audit.append(EVENT, { file, key });
  fs.renameSync(file, audit.segmentPath(file, 1)); // an active log renamed by hand
  const r = audit.verify({ file, key });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /does not end with its rotate record/);
});

test('a caller cannot write a rotate record through an event', (t) => {
  const dir = tempDir(t, 'zn-rot-');
  const file = path.join(dir, 'audit.jsonl');
  const key = crypto.randomBytes(32);
  const rec = audit.append({ decision: 'rotate', reason: 'segment:1' }, { file, key });
  assert.strictEqual(rec.decision, 'other');
});

test('crash between the rename and the first new record: verify and append go on', (t) => {
  const { file, key } = setup(t, 8, undefined);
  const rot = audit.rotate({ file, key, maxBytes: 1 });
  assert.ok(rot && rot.decision === 'rotate');
  assert.strictEqual(fs.existsSync(file), false, 'no active file after the rename');
  assert.strictEqual(audit.segments(file).length, 1);
  const head = { seq: rot.seq, mac: rot.mac };
  assert.deepStrictEqual(audit.verify({ file, key, checkpoint: head }), { ok: true, records: 9 });
  assert.strictEqual(audit.checkHead(file, head).ok, true);
  assert.strictEqual(audit.tailRecord(file).mac, rot.mac);
  const next = audit.append(EVENT, { file, key });
  assert.strictEqual(next.seq, rot.seq + 1);
  assert.strictEqual(next.prev, rot.mac);
  assert.strictEqual(audit.verify({ file, key }).ok, true);
  // The active file was deleted behind the daemon: the checkpoint notices.
  fs.unlinkSync(file);
  assert.strictEqual(audit.checkHead(file, { seq: next.seq, mac: next.mac }).ok, false);
});

test('crash between the rotate record and the rename: the next rotate only finishes the rename', (t) => {
  const { file, key } = setup(t, 5, undefined);
  const rec = audit.append({}, { file, key, rotateSegment: 1 }); // the rotate record, no rename
  assert.strictEqual(audit.verify({ file, key }).ok, true);
  const done = audit.rotate({ file, key, maxBytes: 10 * 1024 * 1024 }); // far under the limit: still finishes
  assert.strictEqual(done.mac, rec.mac, 'no second rotate record');
  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(audit.segments(file).length, 1);
  assert.strictEqual(audit.verify({ file, key }).ok, true);
});

test('rotate never overwrites an existing segment file', (t) => {
  const { file, key } = setup(t, 5, undefined);
  fs.writeFileSync(audit.segmentPath(file, 1), 'x');
  // audit.1.jsonl is not a chain segment of a valid log, but the next number is 2, so no clash; force one.
  const rec = audit.append({}, { file, key, rotateSegment: 1 });
  assert.ok(rec);
  assert.throws(() => audit.rotate({ file, key, maxBytes: 1 }), /unexpected rotate record|already exists/);
  assert.strictEqual(fs.readFileSync(audit.segmentPath(file, 1), 'utf8'), 'x');
});

test('read() returns the events of every segment in order, with limit and since', (t) => {
  const { file } = setup(t, 20, 1500);
  const all = audit.read({ file });
  assert.ok(all.length > 20, 'the rotate records are events too');
  assert.deepStrictEqual(all.map((e) => e.seq), all.map((_, i) => i + 1));
  assert.deepStrictEqual(audit.read({ file, limit: 3 }).map((e) => e.seq), all.slice(-3).map((e) => e.seq));
  assert.strictEqual(audit.read({ file, since: '1d' }).length, all.length);
});

/* A server that stores what it is given and checks nothing else. */
function fakeApi() {
  const got = [];
  return {
    got,
    api: { ingest: async (body) => { for (const e of body.events) got.push(e); const l = body.events[body.events.length - 1]; return { status: 200, body: { accepted: body.events.length, head: { seq: l.seq, mac: l.mac } } }; } },
  };
}

test('upload sends every record across the segment boundaries and resumes from a head in an old segment', async (t) => {
  const { dir, file } = setup(t, 40, 1500);
  const total = audit.read({ file }).length;
  const stateFile = path.join(dir, 'upload.json');
  const lockFile = path.join(dir, 'upload.lock');
  const f = fakeApi();
  const base = { auditFile: file, stateFile, lockFile, installId: INSTALL, api: f.api, batchSize: 7, maxBatches: 3 };
  assert.strictEqual(pendingCount({ auditFile: file, stateFile }), total);
  let r = await uploadPending(base);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.uploaded, 21);
  assert.strictEqual(r.pending, total - 21);
  while (r.pending > 0) { r = await uploadPending(base); assert.ok(['ok', 'nothing'].includes(r.status), r.status); }
  assert.deepStrictEqual(f.got.map((e) => e.seq), Array.from({ length: total }, (_, i) => i + 1));
  assert.ok(f.got.some((e) => e.decision === 'rotate'));
  assert.strictEqual(pendingCount({ auditFile: file, stateFile }), 0);
  // The server head sits inside the first segment: only newer records are sent.
  const seg1 = audit.segments(file)[0];
  const rec = JSON.parse(lines(seg1.file)[3]);
  fs.writeFileSync(stateFile, JSON.stringify({ head: { seq: rec.seq, mac: rec.mac }, last_status: 'ok' }));
  const g = fakeApi();
  const r2 = await uploadPending(Object.assign({}, base, { api: g.api, batchSize: 500, maxBatches: 20 }));
  assert.strictEqual(r2.status, 'ok');
  assert.strictEqual(g.got[0].seq, rec.seq + 1);
  assert.strictEqual(g.got.length, total - rec.seq);
  assert.strictEqual(r2.pending, 0);
});

test('upload detects a head whose record changed in a closed segment', async (t) => {
  const { dir, file } = setup(t, 30, 1500);
  const stateFile = path.join(dir, 'upload.json');
  const seg1 = audit.segments(file)[0];
  const rec = JSON.parse(lines(seg1.file)[2]);
  fs.writeFileSync(stateFile, JSON.stringify({ head: { seq: rec.seq, mac: 'b'.repeat(64) }, last_status: 'ok' }));
  const f = fakeApi();
  const r = await uploadPending({ auditFile: file, stateFile, lockFile: path.join(dir, 'l'), installId: INSTALL, api: f.api });
  assert.strictEqual(r.status, 'diverged');
  assert.strictEqual(f.got.length, 0);
});

test('upload resyncs to a record in an old segment when the server expects an earlier position', async (t) => {
  const { dir, file } = setup(t, 30, 1500);
  const total = audit.read({ file }).length;
  const stateFile = path.join(dir, 'upload.json');
  const rec = JSON.parse(lines(audit.segments(file)[0].file)[4]); // the server really holds up to rec.seq
  let first = true;
  const got = [];
  const api = { ingest: async (body) => {
    if (first) { first = false; const e = new Error('conflict'); e.status = 409; e.body = { expected: { seq: rec.seq + 1, prev: rec.mac } }; throw e; }
    for (const e of body.events) got.push(e);
    const l = body.events[body.events.length - 1];
    return { status: 200, body: { accepted: body.events.length, head: { seq: l.seq, mac: l.mac } } };
  } };
  const last = JSON.parse(lines(file).pop());
  fs.writeFileSync(stateFile, JSON.stringify({ head: { seq: last.seq, mac: last.mac }, last_status: 'ok' }));
  // Local head is the newest record, so nothing is pending and the server is never asked.
  assert.strictEqual((await uploadPending({ auditFile: file, stateFile, lockFile: path.join(dir, 'l'), installId: INSTALL, api })).status, 'nothing');
  // A head just before the end: one record pending, the server answers 409 for an earlier position.
  const prevRec = JSON.parse(lines(file).slice(-2)[0]);
  fs.writeFileSync(stateFile, JSON.stringify({ head: { seq: prevRec.seq, mac: prevRec.mac }, last_status: 'ok' }));
  const r = await uploadPending({ auditFile: file, stateFile, lockFile: path.join(dir, 'l'), installId: INSTALL, api, batchSize: 500, maxBatches: 20 });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(got[0].seq, rec.seq + 1);
  assert.strictEqual(got.length, total - rec.seq);
});

test('the OTLP export walks the segments and matches the same log in one file', (t) => {
  const { file } = setup(t, 30, 1500);
  const total = audit.read({ file }).length;
  const out = [];
  const r = exportAuditStream({ auditFile: file, installId: INSTALL }, (s) => out.push(s));
  assert.strictEqual(r.records, total);
  const seqs = [];
  for (const line of out.join('').trim().split('\n')) {
    for (const lr of JSON.parse(line).resourceLogs[0].scopeLogs[0].logRecords) {
      const a = lr.attributes.find((x) => x.key === 'zn.audit.seq');
      seqs.push(Number(a.value.intValue));
    }
  }
  assert.deepStrictEqual(seqs, Array.from({ length: total }, (_, i) => i + 1));
  assert.strictEqual(exportAuditFile({ auditFile: file, installId: INSTALL }).records, total);
  assert.match(out.join(''), /"rotate"/, 'the rotate decision is kept');
});

test('reset and purge list and remove every segment', (t) => {
  const home = tempDir(t, 'zn-rot-home-');
  const file = path.join(home, 'audit.jsonl');
  const key = crypto.randomBytes(32);
  fill(file, key, 30, 1500);
  const n = audit.segments(file).length;
  assert.ok(n >= 2);
  const found = reset.vaultFiles({ home }).map((f) => path.basename(f.src)).sort();
  for (const s of audit.segments(file)) assert.ok(found.includes(path.basename(s.file)), 'reset lists ' + path.basename(s.file));
  assert.ok(found.includes('audit.jsonl'));
  const tg = purge.targets({ home });
  const kinds = tg.files.filter((x) => /audit\.\d*\.?jsonl$/.test(x.path)).map((x) => x.kind);
  assert.strictEqual(kinds.length, n + 1);
  assert.ok(kinds.every((k) => k === 'audit log'));
  assert.ok(store.hasPriorState({ home }));
  // Only the segments left (a crash after the rename): still history.
  fs.unlinkSync(file);
  assert.ok(store.hasPriorState({ home }));
});

test('the real daemon rotates, keeps verifying across lock and unlock, and the checkpoint follows', async (t) => {
  process.env.ZN_HOME = tempDir(t, 'znrot-d-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const opts = { identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true, auditMaxBytes: 3000 };
  let srv = await daemon.serve(opts);
  let c = clientMod.createClient({});
  t.after(async () => { try { c.close(); await srv.close(); } catch (e) { /* closed */ } });
  const auditFile = store.paths().auditFile;
  for (let i = 0; i < 30; i++) await c.setSecret('K' + i, 'value-' + i + '-' + crypto.randomBytes(8).toString('hex'), { mode: 'env' });
  assert.ok(audit.segments(auditFile).length >= 2, 'the daemon closed segments');
  let v = await c.auditVerify();
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  const rd = await c.auditRead({});
  assert.strictEqual(rd.ok, true);
  assert.ok(rd.events.some((e) => e.decision === 'rotate'));
  for (let cycle = 0; cycle < 2; cycle++) {
    c.close(); await srv.close();
    srv = await daemon.serve(opts); c = clientMod.createClient({});
    for (let i = 0; i < 6; i++) await c.setSecret('L' + cycle + i, 'value-' + i + '-' + crypto.randomBytes(8).toString('hex'), { mode: 'env' });
    v = await c.auditVerify();
    assert.strictEqual(v.ok, true, JSON.stringify(v));
  }
  // A closed segment edited behind the daemon is reported.
  const seg = audit.segments(auditFile)[0];
  const l = lines(seg.file);
  const rec = JSON.parse(l[0]); rec.decision = 'deny'; l[0] = JSON.stringify(rec);
  fs.writeFileSync(seg.file, l.join('\n') + '\n');
  v = await c.auditVerify();
  assert.strictEqual(v.ok, false);
});

test('the daemon recovers from a crash between the rename and the first new record', async (t) => {
  process.env.ZN_HOME = tempDir(t, 'znrot-c-');
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  const identity = created.identity || created;
  const opts = { identity, ttlMs: 60000, idleMs: 60000, confirm: async () => true, auditMaxBytes: 1 };
  let srv = await daemon.serve(opts);
  let c = clientMod.createClient({});
  t.after(async () => { try { c.close(); await srv.close(); } catch (e) { /* closed */ } });
  await c.setSecret('K0', 'value-0-' + crypto.randomBytes(8).toString('hex'), { mode: 'env' });
  const file = store.paths().auditFile;
  // The daemon "dies" right after it closed a segment: the next audit.append of the daemon never happens.
  const realAppend = audit.append;
  let crash = true;
  audit.append = function patched(ev, o) { if (crash) throw new Error('simulated crash'); return realAppend.call(this, ev, o); };
  t.after(() => { audit.append = realAppend; });
  await assert.rejects(c.setSecret('K1', 'value-1-' + crypto.randomBytes(8).toString('hex'), { mode: 'env' }));
  assert.strictEqual(fs.existsSync(file), false, 'segment closed, no active file');
  assert.ok(audit.segments(file).length >= 1);
  try { c.close(); await srv.close(); } catch (e) { /* the lock record could not be written either */ }
  crash = false;
  srv = await daemon.serve(opts);
  c = clientMod.createClient({});
  let v = await c.auditVerify();
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  await c.setSecret('LATER', 'value-later-' + crypto.randomBytes(8).toString('hex'), { mode: 'env' });
  v = await c.auditVerify();
  assert.strictEqual(v.ok, true, JSON.stringify(v));
});
