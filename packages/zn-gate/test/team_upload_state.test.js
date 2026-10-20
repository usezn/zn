'use strict';
/*
 * Team audit upload: state file, corrupt log records, HTTP error mapping and
 * payload contents. No network: the API is an in-memory fake. Everything runs
 * in temporary directories with fictitious values.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const audit = require('../lib/vault/audit');
const { uploadPending, pendingCount } = require('../lib/team/upload');

const INSTALL = '6f1c2b1e-0000-4000-8000-000000000002';
const KEY = Buffer.alloc(32, 7);
const FAKE_SECRET_VALUE = 'sk-fake-0000000000000000000000000000';

function setup(t) {
  const dir = tempDir(t, 'zn-team-upstate-');
  return {
    dir,
    auditFile: path.join(dir, 'audit.jsonl'),
    stateFile: path.join(dir, 'sub', 'team-upload.json'),
    lockFile: path.join(dir, 'team-upload.lock'),
  };
}

function fillLog(file, count) {
  for (let i = 0; i < count; i++) {
    audit.append({
      decision: 'allow', secret: 'API_KEY_' + (i % 5), mode: 'env',
      agent: 'claude-code', tool: 'Bash', host: 'api.example.com', reason: 'policy',
    }, { file, key: KEY });
  }
}

function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/* Fake API: records every body; plan entries are consumed in order. */
function fakeApi(plan) {
  const api = { calls: [], plan: plan || [] };
  api.ingest = async (body) => {
    api.calls.push(JSON.parse(JSON.stringify(body)));
    const step = api.plan.length ? api.plan.shift() : {};
    if ('throw' in step) throw step.throw;
    if (step.status !== undefined) {
      throw Object.assign(new Error('HTTP ' + step.status), { status: step.status, body: step.body });
    }
    if ('response' in step) return step.response;
    return { status: 200, body: { accepted: body.events.length } };
  };
  return api;
}

function opts(f, api, extra) {
  return Object.assign({
    auditFile: f.auditFile, stateFile: f.stateFile, lockFile: f.lockFile,
    api, installId: INSTALL,
  }, extra || {});
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/* ---------------- state file: corrupt or odd content ---------------- */

const BAD_STATES = [
  ['empty file', ''],
  ['truncated JSON', '{"head":{"seq":3,"mac":"ab'],
  ['garbage bytes', '\u0000\u0001\u0002 not json'],
  ['JSON null', 'null'],
  ['JSON array', '[1,2,3]'],
  ['JSON string', '"head"'],
  ['head with seq 0', JSON.stringify({ head: { seq: 0, mac: 'aa' } })],
  ['head with negative seq', JSON.stringify({ head: { seq: -4, mac: 'aa' } })],
  ['head with float seq', JSON.stringify({ head: { seq: 1.5, mac: 'aa' } })],
  ['head with string seq', JSON.stringify({ head: { seq: '3', mac: 'aa' } })],
  ['head with empty mac', JSON.stringify({ head: { seq: 3, mac: '' } })],
  ['head that is an array', JSON.stringify({ head: [3, 'aa'] })],
];

for (const [name, content] of BAD_STATES) {
  test(`state file with ${name} means no head: the next upload starts from record 1`, async (t) => {
    const f = setup(t);
    fillLog(f.auditFile, 6);
    fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
    fs.writeFileSync(f.stateFile, content);
    assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 6);

    const api = fakeApi();
    const r = await uploadPending(opts(f, api));
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.uploaded, 6);
    assert.deepStrictEqual(api.calls[0].events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
    // The bad file is replaced by a valid one.
    assert.strictEqual(readJson(f.stateFile).head.seq, 6);
  });
}

test('a missing state file and a missing state directory behave like a first run', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 3);
  assert.strictEqual(fs.existsSync(path.dirname(f.stateFile)), false);
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 3);
  const r = await uploadPending(opts(f, fakeApi()));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(fs.existsSync(f.stateFile), true);
});

test('a state file that is a directory counts as no state and the call does not throw', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 3);
  fs.mkdirSync(f.stateFile, { recursive: true });
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 3);
  const r = await uploadPending(opts(f, fakeApi()));
  // The state cannot be saved, so the result is a reported error, never a throw.
  assert.strictEqual(r.status, 'error');
  assert.ok(fs.statSync(f.stateFile).isDirectory());
});

test('unknown fields and wrong-typed metadata in the state file are ignored', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 4);
  const recs = lines(f.auditFile).map((l) => JSON.parse(l));
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  fs.writeFileSync(f.stateFile, JSON.stringify({
    head: { seq: 2, mac: recs[1].mac, extra: 'x' }, last_upload: 12, last_status: 5, last_error: {}, other: true,
  }));
  const api = fakeApi();
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(api.calls[0].events.map((e) => e.seq), [3, 4]);
  const saved = readJson(f.stateFile);
  assert.deepStrictEqual(Object.keys(saved).sort(), ['head', 'last_status', 'last_upload']);
  assert.deepStrictEqual(Object.keys(saved.head).sort(), ['mac', 'seq']);
});

test('a saved head with the wrong mac is diverged: nothing is re-uploaded', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 5);
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  fs.writeFileSync(f.stateFile, JSON.stringify({ head: { seq: 3, mac: 'ff'.repeat(32) }, last_status: 'ok' }));
  const api = fakeApi();
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.status, 'diverged');
  assert.strictEqual(api.calls.length, 0);
});

test('a saved head beyond the end of the local log is diverged', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 3);
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  fs.writeFileSync(f.stateFile, JSON.stringify({ head: { seq: 10, mac: 'ab'.repeat(32) }, last_status: 'ok' }));
  const api = fakeApi();
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.status, 'diverged');
  assert.strictEqual(api.calls.length, 0);
});

/* ---------------- state file: atomic write ---------------- */

test('state is written atomically: no temp files remain and the file is valid JSON', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 20);
  await uploadPending(opts(f, fakeApi(), { batchSize: 5 }));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f.stateFile)), ['team-upload.json']);
  assert.strictEqual(readJson(f.stateFile).last_status, 'ok');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(f.stateFile).mode & 0o777, 0o600);
  }
});

test('the state is saved by renaming a temp file in the same directory', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 3);
  const realRename = fs.renameSync;
  const seen = [];
  fs.renameSync = (from, to) => { seen.push([from, to]); return realRename(from, to); };
  t.after(() => { fs.renameSync = realRename; });
  await uploadPending(opts(f, fakeApi()));
  fs.renameSync = realRename;
  assert.ok(seen.length >= 1);
  for (const [from, to] of seen) {
    assert.strictEqual(to, f.stateFile);
    assert.notStrictEqual(from, to);
    assert.strictEqual(path.dirname(from), path.dirname(to));
    assert.match(path.basename(from), /\.tmp$/);
  }
});

test('if the rename fails the previous state file is untouched and no temp file is left', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 6);
  const recs = lines(f.auditFile).map((l) => JSON.parse(l));
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  const before = JSON.stringify({ head: { seq: 2, mac: recs[1].mac }, last_upload: null, last_status: 'ok' });
  fs.writeFileSync(f.stateFile, before);

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('simulated'), { code: 'EIO' }); };
  t.after(() => { fs.renameSync = realRename; });
  const r = await uploadPending(opts(f, fakeApi()));
  fs.renameSync = realRename;

  assert.strictEqual(r.status, 'error');
  assert.strictEqual(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f.stateFile)), ['team-upload.json']);
  assert.strictEqual(fs.existsSync(f.lockFile), false);
});

test('a failed upload stores the status and a fixed error text, never log or server contents', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 3);
  const api = fakeApi([{ status: 500, body: { error: FAKE_SECRET_VALUE } }]);
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.status, 'offline');
  const raw = fs.readFileSync(f.stateFile, 'utf8');
  assert.doesNotMatch(raw, /sk-fake/);
  assert.doesNotMatch(raw, /API_KEY_/);
  const s = JSON.parse(raw);
  assert.strictEqual(s.last_status, 'offline');
  assert.strictEqual(s.last_error, 'server unavailable (HTTP 500)');
});

/* ---------------- resume from the saved offset ---------------- */

test('resume: records already covered by the saved head are never sent again', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 10);
  await uploadPending(opts(f, fakeApi(), { batchSize: 4, maxBatches: 1 }));
  assert.strictEqual(readJson(f.stateFile).head.seq, 4);

  fillLog(f.auditFile, 3); // new records appended later
  const second = fakeApi();
  const r = await uploadPending(opts(f, second));
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(second.calls[0].events.map((e) => e.seq), [5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.strictEqual(r.uploaded, 9);
  assert.strictEqual(r.pending, 0);
});

test('state is saved after every batch, so a failure between batches resumes at the last one', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 9);
  const api = fakeApi([{}, {}, { throw: new Error('process died') }]);
  const r = await uploadPending(opts(f, api, { batchSize: 3 }));
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.uploaded, 6);
  assert.strictEqual(readJson(f.stateFile).head.seq, 6);
  const again = fakeApi();
  await uploadPending(opts(f, again, { batchSize: 3 }));
  assert.deepStrictEqual(again.calls[0].events.map((e) => e.seq), [7, 8, 9]);
});

test('uploaded counts what the server reports as accepted', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 5);
  const api = fakeApi([{ response: { status: 200, body: { accepted: 2 } } }]);
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.uploaded, 2);
  assert.strictEqual(r.head.seq, 5);
});

/* ---------------- corrupt records in the source log ---------------- */

test('a corrupt line that replaces a record leaves a gap: reported as local_gap, later records are not sent', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 8);
  const ls = lines(f.auditFile);
  ls[3] = ls[3].slice(0, 30); // truncated record (seq 4)
  fs.writeFileSync(f.auditFile, ls.join('\n') + '\n');
  const api = fakeApi();
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.status, 'local_gap');
  assert.deepStrictEqual(api.calls[0].events.map((e) => e.seq), [1, 2, 3]);
  assert.strictEqual(r.pending, 4);
  assert.strictEqual(readJson(f.stateFile).last_status, 'local_gap');
  assert.ok(readJson(f.stateFile).last_error);
});

test('lines that parse but are not audit records are skipped and never uploaded raw', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 4);
  const ls = lines(f.auditFile);
  const junk = [
    'null', '42', '"text"', '[1,2]', '{}',
    JSON.stringify({ seq: 0, prev: 'a', mac: 'b' }),
    JSON.stringify({ seq: 'x', prev: 'a', mac: 'b' }),
    JSON.stringify({ seq: 9, mac: 'b', note: FAKE_SECRET_VALUE }),
    JSON.stringify({ seq: 9, prev: 'a', note: FAKE_SECRET_VALUE }),
  ];
  fs.writeFileSync(f.auditFile, [ls[0], junk[0], ls[1], junk[1], junk[2], ls[2], ...junk.slice(3), ls[3]].join('\n') + '\n');
  const api = fakeApi();
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.uploaded, 4);
  assert.deepStrictEqual(api.calls[0].events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.doesNotMatch(JSON.stringify(api.calls), /sk-fake/);
});

test('a log of only corrupt and blank lines is nothing to do', async (t) => {
  const f = setup(t);
  fs.writeFileSync(f.auditFile, '{oops\n\n   \n\u0000\u0000\n');
  const api = fakeApi();
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.status, 'nothing');
  assert.strictEqual(r.pending, 0);
  assert.strictEqual(api.calls.length, 0);
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 0);
});

test('an audit log that cannot be read (it is a directory) is a reported error, not a throw', async (t) => {
  const f = setup(t);
  fs.mkdirSync(f.auditFile);
  const api = fakeApi();
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(r.pending, -1);
  assert.strictEqual(api.calls.length, 0);
  assert.strictEqual(fs.existsSync(f.lockFile), false);
});

test('CRLF line endings in the log still parse', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 3);
  fs.writeFileSync(f.auditFile, lines(f.auditFile).join('\r\n') + '\r\n');
  const r = await uploadPending(opts(f, fakeApi()));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.uploaded, 3);
});

/* ---------------- HTTP errors (mocked, no network) ---------------- */

test('5xx answers are offline: one attempt, head kept, records re-sent on the next run', async (t) => {
  for (const code of [500, 502, 503, 504, 599]) {
    const f = setup(t);
    fillLog(f.auditFile, 5);
    const api = fakeApi([{ status: code, body: { error: 'down' } }]);
    const r = await uploadPending(opts(f, api));
    assert.strictEqual(r.status, 'offline', `HTTP ${code}`);
    assert.strictEqual(r.pending, 5);
    assert.strictEqual(api.calls.length, 1, 'no retry inside one call');
    const next = fakeApi();
    assert.strictEqual((await uploadPending(opts(f, next))).status, 'ok');
    assert.strictEqual(next.calls[0].events[0].seq, 1);
  }
});

test('other 4xx answers are a reported error: one attempt, not retried', async (t) => {
  for (const code of [400, 403, 404, 413, 429]) {
    const f = setup(t);
    fillLog(f.auditFile, 5);
    const api = fakeApi([{ status: code, body: {} }]);
    const r = await uploadPending(opts(f, api));
    assert.strictEqual(r.status, 'error', `HTTP ${code}`);
    assert.strictEqual(r.uploaded, 0);
    assert.strictEqual(r.pending, 5);
    assert.strictEqual(api.calls.length, 1);
    assert.strictEqual(readJson(f.stateFile).last_error, `unexpected HTTP ${code}`);
  }
});

test('status 0 (no network) is offline; a throw without a status is a generic error', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 2);
  assert.strictEqual((await uploadPending(opts(f, fakeApi([{ status: 0 }])))).status, 'offline');
  assert.strictEqual((await uploadPending(opts(f, fakeApi([{ throw: new Error('boom') }])))).status, 'error');
  assert.strictEqual((await uploadPending(opts(f, fakeApi([{ throw: 'a string' }])))).status, 'error');
  assert.strictEqual((await uploadPending(opts(f, fakeApi([{ throw: null }])))).status, 'error');
});

test('an answer that is not HTTP 200 is an error and does not move the head', async (t) => {
  for (const response of [{ status: 204, body: {} }, {}, null]) {
    const f = setup(t);
    fillLog(f.auditFile, 3);
    const r = await uploadPending(opts(f, fakeApi([{ response }])));
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.head, null);
    assert.strictEqual(r.uploaded, 0);
  }
});

test('409 without a usable expected position is a plain error', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 3);
  for (const body of [undefined, {}, { expected: { seq: 0, prev: 'a' } }, { expected: { seq: 2 } }]) {
    const r = await uploadPending(opts(f, fakeApi([{ status: 409, body }])));
    assert.strictEqual(r.status, 'error');
  }
});

test('repeated 409 answers stop after three resyncs', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 6);
  const recs = lines(f.auditFile).map((l) => JSON.parse(l));
  const conflict = { status: 409, body: { expected: { seq: 3, prev: recs[1].mac } } };
  const api = fakeApi([conflict, conflict, conflict, conflict, conflict]);
  const r = await uploadPending(opts(f, api));
  assert.strictEqual(r.status, 'error');
  assert.strictEqual(api.calls.length, 4);
  assert.strictEqual(readJson(f.stateFile).last_error, 'too many resyncs with the server');
});

test('the lock is released after every kind of failure', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 3);
  for (const step of [{ status: 500 }, { status: 401 }, { status: 422 }, { throw: new Error('x') }]) {
    await uploadPending(opts(f, fakeApi([step])));
    assert.strictEqual(fs.existsSync(f.lockFile), false);
  }
});

test('shouldStop before the first batch sends nothing', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 3);
  const api = fakeApi();
  const r = await uploadPending(opts(f, api, { shouldStop: () => true }));
  assert.strictEqual(api.calls.length, 0);
  assert.strictEqual(r.status, 'nothing');
  assert.strictEqual(r.pending, 3);
});

/* ---------------- payload contents ---------------- */

test('payloads carry only allowed fields; secret values and extra fields never leave', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 3);
  const ls = lines(f.auditFile).map((l) => JSON.parse(l));
  ls[1].value = FAKE_SECRET_VALUE;
  ls[1].env = { TOKEN: FAKE_SECRET_VALUE };
  ls[1].cmd = 'curl -H "Authorization: Bearer ' + FAKE_SECRET_VALUE + '" https://api.example.com';
  fs.writeFileSync(f.auditFile, ls.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const api = fakeApi();
  await uploadPending(opts(f, api, { version: '1.0.0' }));

  const allowed = new Set(['v', 'seq', 'ts', ...audit.FIELDS, 'prev', 'mac']);
  const body = api.calls[0];
  assert.deepStrictEqual(Object.keys(body), ['install_id', 'zn_gate_version', 'events']);
  for (const ev of body.events) {
    for (const k of Object.keys(ev)) assert.ok(allowed.has(k), `unexpected field ${k}`);
  }
  assert.doesNotMatch(JSON.stringify(api.calls), /sk-fake/);
  assert.doesNotMatch(fs.readFileSync(f.stateFile, 'utf8'), /sk-fake/);
});

test('without a version the body has no zn_gate_version key', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 1);
  const api = fakeApi();
  await uploadPending(opts(f, api, { version: undefined }));
  assert.deepStrictEqual(Object.keys(api.calls[0]), ['install_id', 'events']);
});

test('pendingCount counts records after the saved head and ignores corrupt lines', async (t) => {
  const f = setup(t);
  fillLog(f.auditFile, 6);
  fs.appendFileSync(f.auditFile, '{broken\n');
  await uploadPending(opts(f, fakeApi(), { batchSize: 2, maxBatches: 1 }));
  assert.strictEqual(pendingCount({ auditFile: f.auditFile, stateFile: f.stateFile }), 4);
});
