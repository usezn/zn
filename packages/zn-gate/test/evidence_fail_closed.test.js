'use strict';

process.env.ZN_STATS = 'off';

// The evidence ledger and its export fail closed on the paths that the other tests do not reach:
// a lock that Windows refuses, a lock that cannot be removed, a Python-written confidence, a record
// that does not link to the one before it, a log that shrinks or changes during an export, and a
// failing output stream. Each one must refuse or report the problem, never write or end a result
// as if it were fine. Fake records and temporary folders only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PassThrough, Writable } = require('stream');
const { tempDir } = require('./helpers/tmp');
const ev = require('../lib/evidence');

function ledgerFile(t) {
  return path.join(tempDir(t, 'zn-ev-failclosed-'), 'evidence.jsonl');
}

function event(i, extra = {}) {
  return {
    agent: 'test-agent', phase: 'tool-call', tool_name: `tool${i}`, payload: `payload ${i}`,
    verdict: 'allow', rule: null, reason: `reason ${i}`, latency_us: i, engine: 'test', ...extra,
  };
}

function write(file, n) {
  for (let i = 0; i < n; i++) ev.logEvidence(event(i), file, { noStats: true });
}

// Runs fn with process.platform reported as name; only for the synchronous calls inside fn.
function asPlatform(name, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

function breakLink(file, lineIndex) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rec = JSON.parse(lines[lineIndex]);
  rec.prev_hash = '0'.repeat(64);
  lines[lineIndex] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join('\n'));
}

function resetHooks(t) {
  t.after(() => {
    ev._testHooks.exportChunkSize = null;
    ev._testHooks.beforeExportRead = null;
  });
}

test('on Windows a lock that cannot be created is reported at once and nothing is written', (t) => {
  const file = ledgerFile(t);
  const realOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (p, flags, ...rest) => {
    if (String(p).endsWith('.lock')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return realOpen(p, flags, ...rest);
  });
  // logEvidence does not throw here: it writes a message to stderr and returns null (its callers ignore the
  // return value; see the note in the report). What must hold: no record, no lock wait, the message is shown.
  const realWrite = process.stderr.write;
  let seen = '';
  process.stderr.write = (chunk) => { seen += chunk; return true; };
  t.after(() => { process.stderr.write = realWrite; });
  const started = Date.now();
  const r = asPlatform('win32', () => ev.logEvidence(event(0), file, { noStats: true }));
  process.stderr.write = realWrite;
  assert.equal(r, null);
  assert.ok(Date.now() - started < 1500, 'it must not wait for the lock deadline');
  assert.equal(fs.existsSync(file), false, 'no record may be written without the lock');
  assert.match(seen, /cannot write to the evidence log/);
});

test('on Windows a lock that cannot be removed is retried, then left in place without losing the record', (t) => {
  const file = ledgerFile(t);
  const lock = file + '.lock';
  const realUnlink = fs.unlinkSync;
  let tries = 0;
  t.mock.method(fs, 'unlinkSync', (p) => {
    if (String(p) === lock) {
      tries++;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return realUnlink(p);
  });
  t.after(() => { try { realUnlink(lock); } catch { /* already gone */ } });
  asPlatform('win32', () => write(file, 1));
  assert.equal(tries, 40, 'the removal is retried 40 times and then given up');
  assert.equal(ev.verifyEvidenceLedger(file).valid, true, 'the record written under the lock is intact');
});

test('a confidence written the Python way (1e-05) verifies, and a changed one breaks the chain', (t) => {
  const file = ledgerFile(t);
  ev.logEvidence(event(0, { confidence: 0.00001 }), file, { noStats: true });
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /"confidence":0\.00001/, 'the JSON form is what the record was hashed with');
  fs.writeFileSync(file, raw.replace('"confidence":0.00001', '"confidence":1e-05'));
  assert.equal(ev.verifyEvidenceLedger(file).valid, true, 'the Python form of the same number must verify');

  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"confidence":1e-05', '"confidence":2e-05'));
  const r = ev.verifyEvidenceLedger(file);
  assert.equal(r.valid, false);
  assert.match(r.error, /hash mismatch|Tamper/);
});

test('verify fails closed when a record does not link to the one before it', (t) => {
  const file = ledgerFile(t);
  write(file, 3);
  breakLink(file, 1);
  const r = ev.verifyEvidenceLedger(file);
  assert.equal(r.valid, false);
  assert.equal(r.broken_index, 1);
  assert.match(r.error, /Broken chain link at line 2/);
});

test('an export of a log with a broken chain link reports it as not valid', async (t) => {
  const file = ledgerFile(t);
  write(file, 3);
  breakLink(file, 1);
  const sink = new PassThrough();
  sink.on('data', () => {});
  const result = await ev.writeEvidenceExport(file, 'jsonl', sink);
  sink.end();
  assert.equal(result.valid, false);
  assert.equal(result.broken_index, 1);
  assert.match(result.error, /Broken chain link at line 2/);
});

test('a log that shrinks while it is exported fails the export instead of ending it', async (t) => {
  resetHooks(t);
  const file = ledgerFile(t);
  write(file, 20);
  ev._testHooks.exportChunkSize = 64;
  ev._testHooks.beforeExportRead = (pos) => { if (pos > 0) fs.truncateSync(file, 10); };
  const sink = new PassThrough();
  sink.on('data', () => {});
  await assert.rejects(ev.writeEvidenceExport(file, 'jsonl', sink), /Cannot read the evidence log: ESHRUNK/);
});

test('a write error on the output stops the export and is thrown, not reported as complete', async (t) => {
  const file = ledgerFile(t);
  write(file, 5);
  const out = new Writable({
    highWaterMark: 1,
    write(chunk, enc, cb) { setImmediate(() => cb(new Error('disk gone'))); },
  });
  await assert.rejects(
    ev.writeEvidenceExport(file, 'jsonl', out),
    (e) => e.message === 'disk gone' && e.writeError === true,
  );
});

test('a plain decimal confidence (0.5, 12.5) verifies, and a changed one breaks the chain', (t) => {
  const file = ledgerFile(t);
  ev.logEvidence(event(0, { confidence: 0.5 }), file, { noStats: true });
  ev.logEvidence(event(1, { confidence: 12.5 }), file, { noStats: true });
  assert.equal(ev.verifyEvidenceLedger(file).valid, true);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"confidence":12.5', '"confidence":12.75'));
  const r = ev.verifyEvidenceLedger(file);
  assert.equal(r.valid, false);
  assert.equal(r.broken_index, 1);
});

// Starts the dashboard on the log, requests the JSONL download and resolves with what the client got.
async function download(t, file) {
  const server = ev.startEvidenceUi(0, file);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/export?format=jsonl' }, (res) => {
      const done = () => resolve({ status: res.statusCode, integrity: res.headers['x-evidence-integrity'], complete: res.complete === true });
      res.on('data', () => {});
      res.on('end', done);
      res.on('aborted', done);
      res.on('close', done);
      res.on('error', done);
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

test('the download is cut when the log changes between the chain check and the send', async (t) => {
  resetHooks(t);
  const file = ledgerFile(t);
  write(file, 3);
  // Pass 1 (the chain check) reads at position 0 first; pass 2 (the download) is the second time.
  let passes = 0;
  ev._testHooks.beforeExportRead = (pos) => {
    if (pos !== 0) return;
    passes++;
    if (passes === 2) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('tool0', 'toolX'));
  };
  const outcome = await download(t, file);
  assert.equal(passes, 2, 'the export ran its second pass');
  assert.notEqual(outcome.complete, true, `a changed log must not download as complete: ${JSON.stringify(outcome)}`);
});

test('a read error during the download cuts the answer instead of ending it', async (t) => {
  resetHooks(t);
  const file = ledgerFile(t);
  write(file, 3);
  let passes = 0;
  ev._testHooks.beforeExportRead = (pos) => {
    if (pos !== 0) return;
    if (++passes === 2) throw Object.assign(new Error('i/o error'), { code: 'EIO' });
  };
  const outcome = await download(t, file);
  assert.equal(passes, 2, 'the export reached its second pass');
  assert.notEqual(outcome.complete, true, `a failed read must not download as complete: ${JSON.stringify(outcome)}`);
});

test('a read(2) failure while exporting is thrown, not ended as a short export', async (t) => {
  const file = ledgerFile(t);
  write(file, 20);
  ev._testHooks.exportChunkSize = 64;
  t.after(() => { ev._testHooks.exportChunkSize = null; });
  const realRead = fs.readSync;
  let failed = false;
  t.mock.method(fs, 'readSync', (fd, buf, off, len, pos) => {
    if (!failed && pos > 0) {
      failed = true;
      throw Object.assign(new Error('i/o error'), { code: 'EIO' });
    }
    return realRead(fd, buf, off, len, pos);
  });
  const sink = new PassThrough();
  sink.on('data', () => {});
  await assert.rejects(ev.writeEvidenceExport(file, 'jsonl', sink), /Cannot read the evidence log: EIO/);
  assert.equal(failed, true);
});
