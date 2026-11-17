'use strict';

// The dashboard reads the evidence log incrementally: a poll scans only the bytes added since the
// last one, answers match a full recompute, and anything but plain growth is verified again from
// the start. Requests share one scan and a pile-up is answered with 503.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// A throwaway home, set before the module is loaded: the real log is never touched.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-incr-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.ZN_HOME = path.join(HOME, '.zn');
const {
  logEvidence, verifyEvidenceLedger, getEvidenceStats, startEvidenceUi, _createLedgerIndex,
} = require('../lib/evidence');

function tmpLedger(n = 5) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-incr-'));
  const file = path.join(dir, 'evidence.jsonl');
  append(file, 0, n);
  return { dir, file };
}
function append(file, from, count) {
  for (let i = from; i < from + count; i++) {
    logEvidence({
      payload: `example-${i}`, tool_name: i % 3 ? 'bash' : 'read',
      verdict: i % 4 === 0 ? 'block' : (i % 7 === 0 ? 'shadow' : 'allow'), rule: i % 4 === 0 ? `rule-${i % 2}` : null,
    }, file);
  }
}
// Same answers as the synchronous functions the command line uses.
async function assertMatchesFull(index, file) {
  const snap = await index.get();
  assert.deepEqual(snap.verify, verifyEvidenceLedger(file));
  assert.deepEqual(JSON.parse(JSON.stringify(snap.stats)), JSON.parse(JSON.stringify(getEvidenceStats(file))));
}
function spyOnReads(fn) {
  const real = fs.promises.open;
  let opens = 0;
  fs.promises.open = (...a) => { opens++; return real.apply(fs.promises, a); };
  return Promise.resolve().then(fn).then(() => opens, (e) => { throw e; }).finally(() => { fs.promises.open = real; });
}

test('the index gives the same answers as a full recompute', async () => {
  const { dir, file } = tmpLedger(12);
  try {
    await assertMatchesFull(_createLedgerIndex(file), file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a poll with the file unchanged answers from the cache without opening it', async () => {
  const { dir, file } = tmpLedger(6);
  try {
    const index = _createLedgerIndex(file);
    const first = await index.get();
    const opens = await spyOnReads(async () => {
      const second = await index.get();
      assert.equal(second, first);
    });
    assert.equal(opens, 0);
    assert.equal(index.counters.cacheHits, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('growth is scanned incrementally and equals a full recompute', async () => {
  const { dir, file } = tmpLedger(8);
  try {
    const index = _createLedgerIndex(file);
    await index.get();
    assert.equal(index.counters.fullScans, 1);
    for (let round = 0; round < 3; round++) {
      append(file, 100 + round * 10, 5);
      await assertMatchesFull(index, file);
    }
    assert.equal(index.counters.fullScans, 1);
    assert.equal(index.counters.incrementalScans, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an incremental scan reads only the new bytes', async () => {
  const { dir, file } = tmpLedger(40);
  try {
    const index = _createLedgerIndex(file);
    await index.get();
    const size = fs.statSync(file).size;
    append(file, 500, 2);
    const reads = [];
    const realOpen = fs.promises.open;
    fs.promises.open = async (...a) => {
      const fh = await realOpen.apply(fs.promises, a);
      const realRead = fh.read.bind(fh);
      fh.read = (buf, off, len, pos) => { reads.push(pos); return realRead(buf, off, len, pos); };
      return fh;
    };
    try { await index.get(); } finally { fs.promises.open = realOpen; }
    // Past the verified block, nothing before the old end of the file is scanned again.
    assert.ok(reads.every((pos) => pos >= size - 4096), JSON.stringify(reads));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a half-written last line is not trusted and is read once finished', async () => {
  const { dir, file } = tmpLedger(4);
  try {
    const whole = fs.readFileSync(file);
    const lastNl = whole.lastIndexOf(0x0a, whole.length - 2);
    // Cut the last record in half, as a crash would.
    fs.writeFileSync(file, whole.subarray(0, lastNl + 1 + 40));
    const index = _createLedgerIndex(file);
    const cut = await index.get();
    assert.equal(cut.verify.valid, false);
    assert.equal(cut.verify.truncated_tail, true);
    assert.deepEqual(cut.verify, verifyEvidenceLedger(file));
    // The write finishes.
    fs.writeFileSync(file, whole);
    await assertMatchesFull(index, file);
    assert.equal((await index.get()).verify.valid, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file that got smaller is verified again from the start', async () => {
  const { dir, file } = tmpLedger(10);
  try {
    const index = _createLedgerIndex(file);
    await index.get();
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, lines.slice(0, 4).join('\n') + '\n');
    await assertMatchesFull(index, file);
    assert.equal(index.counters.fullScans, 2);
    assert.equal((await index.get()).verify.total, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a replaced file (new inode) is verified again from the start', async () => {
  const { dir, file } = tmpLedger(5);
  try {
    const index = _createLedgerIndex(file);
    await index.get();
    const other = path.join(dir, 'new.jsonl');
    append(other, 200, 9);
    fs.renameSync(other, file);
    await assertMatchesFull(index, file);
    assert.equal(index.counters.fullScans, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a tampered earlier record is reported after the file is rewritten', async () => {
  const { dir, file } = tmpLedger(6);
  try {
    const index = _createLedgerIndex(file);
    assert.equal((await index.get()).verify.valid, true);
    // Edit record 2 and add records, as one rewrite.
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    lines[1] = lines[1].replace('example-1', 'example-X');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    append(file, 50, 3);
    const snap = await index.get();
    assert.equal(snap.verify.valid, false);
    assert.equal(snap.verify.broken_index, 1);
    assert.match(snap.verify.error, /Tamper detected at line 2/);
    assert.equal(snap.stats.valid, false);
    assert.deepEqual(snap.verify, verifyEvidenceLedger(file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an in-place edit of the last verified block with more records added is caught', async () => {
  const { dir, file } = tmpLedger(6);
  try {
    const index = _createLedgerIndex(file);
    await index.get();
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    lines[5] = lines[5].replace('example-5', 'example-Y');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.appendFileSync(file, '');
    // Records appended by hand after the edit; the chain no longer matches either way.
    fs.appendFileSync(file, lines[5] + '\n');
    const snap = await index.get();
    assert.deepEqual(snap.verify, verifyEvidenceLedger(file));
    assert.equal(snap.verify.valid, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an edit earlier in the file is caught by the periodic full pass', async () => {
  const { dir, file } = tmpLedger(300);
  try {
    const index = _createLedgerIndex(file, { fullEveryMs: 0 });
    assert.equal((await index.get()).verify.valid, true);
    // A same-size edit near the start, then growth: size and time look like plain growth.
    const data = fs.readFileSync(file);
    const at = data.indexOf('example-3');
    data[at + 8] = 0x58; // 3 -> X
    fs.writeFileSync(file, data);
    append(file, 900, 2);
    const snap = await index.get();
    assert.equal(snap.verify.valid, false);
    assert.equal(index.counters.fullScans, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bad bytes, a malformed line and a missing file behave like the full check', async () => {
  const { dir, file } = tmpLedger(4);
  try {
    const index = _createLedgerIndex(file);
    await assertMatchesFull(index, file);
    fs.appendFileSync(file, Buffer.from([0xff, 0xfe, 0x0a]));
    await assertMatchesFull(index, file);
    fs.appendFileSync(file, 'not json\n   \n[1]\n');
    await assertMatchesFull(index, file);
    fs.unlinkSync(file);
    const gone = await index.get();
    assert.deepEqual(gone.verify, verifyEvidenceLedger(file));
    assert.deepEqual(JSON.parse(JSON.stringify(gone.stats)), JSON.parse(JSON.stringify(getEvidenceStats(file))));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a log that is a folder is reported as unreadable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-incr-dir-'));
  try {
    const snap = await _createLedgerIndex(dir).get();
    assert.equal(snap.verify.valid, false);
    assert.match(snap.verify.error, /Cannot read the evidence log/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('requests that arrive during a scan share it', async () => {
  const { dir, file } = tmpLedger(10);
  try {
    const index = _createLedgerIndex(file);
    const results = await Promise.all([index.get(), index.get(), index.get(), index.get()]);
    assert.ok(results.every((r) => r === results[0]));
    assert.equal(index.counters.fullScans, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function get(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}
function listening(server) {
  return new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
}

test('the dashboard answers stats and verify from the index and serves other requests meanwhile', async () => {
  const { dir, file } = tmpLedger(20);
  const server = startEvidenceUi(0, file);
  try {
    await listening(server);
    const port = server.address().port;
    const [s, v, page] = await Promise.all([get(port, '/api/stats'), get(port, '/api/verify'), get(port, '/')]);
    assert.equal(s.status, 200);
    assert.equal(JSON.parse(s.body).total, 20);
    assert.equal(JSON.parse(v.body).valid, true);
    assert.equal(page.status, 200);
    assert.match(page.body, /10000/);
    assert.match(page.body, /visibilityState/);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('more waiting requests than the limit get 503 with Retry-After', async () => {
  const { dir, file } = tmpLedger(10);
  const server = startEvidenceUi(0, file, { maxPending: 2 });
  const realStat = fs.promises.stat;
  fs.promises.stat = async (...a) => { await new Promise((r) => setTimeout(r, 150)); return realStat.apply(fs.promises, a); };
  try {
    await listening(server);
    const port = server.address().port;
    const answers = await Promise.all([1, 2, 3, 4].map(() => get(port, '/api/stats')));
    const statuses = answers.map((a) => a.status).sort();
    assert.deepEqual(statuses, [200, 200, 503, 503]);
    const busy = answers.find((a) => a.status === 503);
    assert.equal(busy.headers['retry-after'], '2');
    // Once the scan is over, the next poll is served.
    fs.promises.stat = realStat;
    assert.equal((await get(port, '/api/stats')).status, 200);
  } finally { fs.promises.stat = realStat; server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
