'use strict';
/*
 * Team audit upload: batching, resume, resync and failure handling.
 * The fake server checks the chain the way the real ingest does (MAC, links,
 * sequence continuity against its stored head, and no unexpected fields).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempDir } = require('./helpers/tmp');
const audit = require('../lib/vault/audit');
const { uploadPending, pendingCount } = require('../lib/team/upload');

const INSTALL = '6f1c2b1e-0000-4000-8000-000000000001';
const VERSION = '1.6.0';
const ALLOWED = ['v', 'seq', 'ts', 'secret', 'mode', 'agent', 'tool', 'argv0', 'host', 'decision', 'reason', 'prev', 'mac'];
const MINUTE = 60 * 1000;

function setup(t) {
  const dir = tempDir(t, 'zn-team-up-');
  return {
    dir,
    auditFile: path.join(dir, 'audit.jsonl'),
    stateFile: path.join(dir, 'team-upload.json'),
    lockFile: path.join(dir, 'team-upload.lock'),
  };
}

function fillLog(file, key, count) {
  for (let i = 0; i < count; i++) {
    audit.append({
      decision: 'allow', secret: 'API_KEY_' + (i % 50), mode: 'env',
      agent: 'claude-code', tool: 'Bash', host: 'api.example.com', reason: 'policy',
    }, { file, key });
  }
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function macFor(key, ev) {
  const rec = { v: ev.v, seq: ev.seq, ts: ev.ts };
  for (const f of audit.FIELDS) if (ev[f] !== undefined) rec[f] = ev[f];
  rec.prev = ev.prev;
  return crypto.createHmac('sha256', key).update(JSON.stringify(rec)).digest('hex');
}

function httpError(step) {
  return Object.assign(new Error('HTTP ' + step.status), { status: step.status, body: step.body });
}

/* Same checks as the server's ingest, on a single in-memory chain head. */
function handle(srv, body) {
  if (!body || body.install_id !== INSTALL || !Array.isArray(body.events) ||
      body.events.length === 0 || body.events.length > 500) {
    throw httpError({ status: 400, body: { error: 'Invalid audit batch' } });
  }
  for (const ev of body.events) {
    if (Object.keys(ev).some((k) => !ALLOWED.includes(k))) {
      throw httpError({ status: 400, body: { error: 'unexpected field' } });
    }
  }
  let evs = body.events;
  const head = srv.head;
  if (head && evs[0].seq <= head.seq) {
    const i = evs.findIndex((e) => e.seq === head.seq);
    if (i < 0 || evs[i].mac !== head.mac) {
      throw httpError({ status: 409, body: { error: 'does not continue the chain', expected: { seq: head.seq + 1, prev: head.mac } } });
    }
    evs = evs.slice(i + 1);
    if (!evs.length) return { status: 200, body: { accepted: 0, duplicate: true, head: { seq: head.seq } } };
  }
  let expSeq = head ? head.seq + 1 : null;
  let expPrev = head ? head.mac : null;
  for (const ev of evs) {
    if (expSeq !== null && (ev.seq !== expSeq || ev.prev !== expPrev)) {
      throw httpError({ status: 409, body: { error: 'does not continue the chain', expected: { seq: expSeq, prev: expPrev } } });
    }
    if (macFor(srv.key, ev) !== ev.mac) {
      throw httpError({ status: 422, body: { error: 'Audit chain check failed: bad mac' } });
    }
    expSeq = ev.seq + 1;
    expPrev = ev.mac;
  }
  const last = evs[evs.length - 1];
  srv.head = { seq: last.seq, mac: last.mac };
  return { status: 200, body: { accepted: evs.length, head: { seq: last.seq } } };
}

/* plan: one entry per call, consumed in order. null = normal answer, {status, body} = failure. */
function fakeServer(key) {
  const srv = { key, head: null, batches: [], plan: [], calls: 0 };
  srv.seed = (records, n) => {
    srv.head = { seq: records[n - 1].seq, mac: records[n - 1].mac };
  };
  srv.api = {
    ingest: async (body) => {
      srv.calls += 1;
      srv.batches.push(JSON.parse(JSON.stringify(body)));
      const step = srv.plan.length ? srv.plan.shift() : null;
      if (step) throw httpError(step);
      return handle(srv, body);
    },
  };
  return srv;
}

function opts(f, srv, extra) {
  return Object.assign({
    auditFile: f.auditFile,
    stateFile: f.stateFile,
    lockFile: f.lockFile,
    api: srv.api,
    installId: INSTALL,
    version: VERSION,
  }, extra || {});
}

test('first upload sends 1200 records in three batches and persists the head', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 1200);
  const srv = fakeServer(key);
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 1200);

  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.uploaded, 1200);
  assert.strictEqual(r.pending, 0);
  assert.deepStrictEqual(srv.batches.map((b) => b.events.length), [500, 500, 200]);
  assert.strictEqual(srv.batches[0].install_id, INSTALL);
  assert.strictEqual(srv.batches[0].zn_gate_version, VERSION);

  const last = readLines(f.auditFile).at(-1);
  assert.deepStrictEqual(r.head, { seq: 1200, mac: last.mac });
  const state = readState(f.stateFile);
  assert.deepStrictEqual(state.head, { seq: 1200, mac: last.mac });
  assert.strictEqual(state.last_status, 'ok');
  assert.match(state.last_upload, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 0);
});

test('nothing pending after a full upload: no further calls', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 1200);
  const srv = fakeServer(key);
  await uploadPending(opts(f, srv));
  const calls = srv.calls;
  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'nothing');
  assert.strictEqual(r.uploaded, 0);
  assert.strictEqual(r.pending, 0);
  assert.strictEqual(srv.calls, calls);
});

test('resume after an offline error mid-way keeps the head and uploads the rest', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 1200);
  const srv = fakeServer(key);
  srv.plan = [null, { status: 0 }];

  const first = await uploadPending(opts(f, srv));
  assert.strictEqual(first.status, 'offline');
  assert.strictEqual(first.uploaded, 500);
  assert.strictEqual(first.pending, 700);
  assert.strictEqual(readState(f.stateFile).head.seq, 500);
  assert.strictEqual(readState(f.stateFile).last_status, 'offline');
  assert.ok(readState(f.stateFile).last_error);

  const second = await uploadPending(opts(f, srv));
  assert.strictEqual(second.status, 'ok');
  assert.strictEqual(second.uploaded, 700);
  assert.strictEqual(second.pending, 0);
  assert.strictEqual(srv.batches[2].events[0].seq, 501);
});

test('HTTP 503 counts as offline and leaves the head unset', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 10);
  const srv = fakeServer(key);
  srv.plan = [{ status: 503, body: { error: 'busy' } }];
  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'offline');
  assert.strictEqual(r.head, null);
  assert.strictEqual(r.pending, 10);
});

test('409 with expected position resyncs to the server head and continues', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 1200);
  const srv = fakeServer(key);
  srv.seed(readLines(f.auditFile), 800);

  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.uploaded, 400);
  assert.strictEqual(r.pending, 0);
  assert.strictEqual(srv.calls, 2);
  assert.strictEqual(srv.batches[1].events[0].seq, 801);
  assert.strictEqual(readState(f.stateFile).head.seq, 1200);
});

test('409 whose expected prev matches no local record is diverged', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 1200);
  const srv = fakeServer(key);
  srv.head = { seq: 800, mac: 'ab'.repeat(32) };

  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'diverged');
  assert.strictEqual(r.uploaded, 0);
  assert.strictEqual(srv.calls, 1);
  assert.strictEqual(readState(f.stateFile).last_status, 'diverged');
});

test('duplicate resend: the server already holds the batch', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 1200);
  const records = readLines(f.auditFile);
  const srv = fakeServer(key);
  srv.seed(records, 1200);
  // Local state says 1199 is uploaded, so only record 1200 is sent and the server answers duplicate.
  fs.writeFileSync(f.stateFile, JSON.stringify({ head: { seq: 1199, mac: records[1198].mac }, last_upload: null, last_status: 'ok' }));

  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(srv.calls, 1);
  assert.strictEqual(srv.batches[0].events.length, 1);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.uploaded, 0);
  assert.strictEqual(r.pending, 0);
  assert.deepStrictEqual(r.head, { seq: 1200, mac: records[1199].mac });
});

test('422 from the server stops with rejected and no record contents in the state', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 20);
  const srv = fakeServer(key);
  srv.plan = [{ status: 422, body: { error: 'Audit chain check failed: bad mac' } }];

  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'rejected');
  assert.strictEqual(r.uploaded, 0);
  assert.strictEqual(r.head, null);
  assert.strictEqual(r.pending, 20);
  assert.strictEqual(srv.calls, 1);
  const raw = fs.readFileSync(f.stateFile, 'utf8');
  assert.doesNotMatch(raw, /API_KEY_/);
  assert.strictEqual(readState(f.stateFile).last_status, 'rejected');
});

test('401 is revoked and 402 is inactive; both stop the upload', async (t) => {
  const cases = [[401, 'revoked'], [402, 'inactive']];
  for (const [code, status] of cases) {
    const f = setup(t);
    const key = crypto.randomBytes(32);
    fillLog(f.auditFile, key, 20);
    const srv = fakeServer(key);
    srv.plan = [{ status: code, body: { error: 'no' } }];
    const r = await uploadPending(opts(f, srv));
    assert.strictEqual(r.status, status, `HTTP ${code}`);
    assert.strictEqual(srv.calls, 1);
    assert.strictEqual(r.pending, 20);
    assert.strictEqual(readState(f.stateFile).last_status, status);
  }
});

test('a fresh lock makes the call return busy and leaves the lock alone', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 20);
  fs.writeFileSync(f.lockFile, 'other run\n');
  const srv = fakeServer(key);

  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'busy');
  assert.strictEqual(srv.calls, 0);
  assert.strictEqual(fs.existsSync(f.lockFile), true);
});

test('a stale lock (older than 10 minutes) is taken over and released afterwards', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 10);
  fs.writeFileSync(f.lockFile, 'crashed run\n');
  const srv = fakeServer(key);

  const r = await uploadPending(opts(f, srv, { now: () => Date.now() + 11 * MINUTE }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.uploaded, 10);
  assert.strictEqual(fs.existsSync(f.lockFile), false);
});

test('a local log rewritten with a different chain is diverged and nothing is sent', async (t) => {
  const f = setup(t);
  const keyA = crypto.randomBytes(32);
  fillLog(f.auditFile, keyA, 1200);
  const srv = fakeServer(keyA);
  const first = await uploadPending(opts(f, srv));
  assert.strictEqual(first.status, 'ok');
  const calls = srv.calls;

  fs.unlinkSync(f.auditFile);
  fillLog(f.auditFile, crypto.randomBytes(32), 1200);
  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'diverged');
  assert.strictEqual(r.uploaded, 0);
  assert.strictEqual(srv.calls, calls);
  assert.strictEqual(r.head.seq, 1200);
});

test('extra keys in a log line are not sent', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 3);
  const lines = fs.readFileSync(f.auditFile, 'utf8').split('\n');
  const rec = JSON.parse(lines[1]);
  rec.ip = '10.0.0.5';
  rec.note = 'extra';
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(f.auditFile, lines.join('\n'));
  const srv = fakeServer(key);

  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.uploaded, 3);
  const events = srv.batches[0].events;
  assert.strictEqual(events.length, 3);
  for (const ev of events) {
    assert.deepStrictEqual(Object.keys(ev), ALLOWED.filter((k) => k in ev));
    assert.ok(!('ip' in ev) && !('note' in ev));
  }
});

test('maxBatches caps one call and the rest is reported as pending', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 1200);
  const srv = fakeServer(key);

  const first = await uploadPending(opts(f, srv, { batchSize: 100, maxBatches: 3 }));
  assert.strictEqual(first.status, 'ok');
  assert.strictEqual(first.uploaded, 300);
  assert.strictEqual(first.pending, 900);
  assert.strictEqual(first.head.seq, 300);
  assert.strictEqual(srv.calls, 3);

  const second = await uploadPending(opts(f, srv, { batchSize: 100 }));
  assert.strictEqual(second.status, 'ok');
  assert.strictEqual(second.uploaded, 900);
  assert.strictEqual(second.pending, 0);
});

test('a gap in the local sequence uploads only the records before it', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 10);
  const lines = fs.readFileSync(f.auditFile, 'utf8').split('\n');
  lines.splice(4, 1); // drop seq 5
  fs.writeFileSync(f.auditFile, lines.join('\n'));
  const srv = fakeServer(key);

  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'local_gap');
  assert.strictEqual(r.uploaded, 4);
  assert.deepStrictEqual(srv.batches[0].events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.strictEqual(r.pending, 5);
});

test('unparseable lines are skipped without breaking the chain', async (t) => {
  const f = setup(t);
  const key = crypto.randomBytes(32);
  fillLog(f.auditFile, key, 5);
  const lines = fs.readFileSync(f.auditFile, 'utf8').split('\n');
  lines.splice(2, 0, '{not json');
  fs.writeFileSync(f.auditFile, lines.join('\n'));
  const srv = fakeServer(key);

  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.uploaded, 5);
});

test('a missing audit log is nothing to do', async (t) => {
  const f = setup(t);
  const srv = fakeServer(crypto.randomBytes(32));
  const r = await uploadPending(opts(f, srv));
  assert.strictEqual(r.status, 'nothing');
  assert.strictEqual(r.pending, 0);
  assert.strictEqual(srv.calls, 0);
});

test('bad options throw a TypeError', async (t) => {
  const f = setup(t);
  await assert.rejects(() => uploadPending({ ...opts(f, fakeServer(crypto.randomBytes(32))), batchSize: 501 }), TypeError);
  await assert.rejects(() => uploadPending({ ...opts(f, fakeServer(crypto.randomBytes(32))), api: {} }), TypeError);
});
