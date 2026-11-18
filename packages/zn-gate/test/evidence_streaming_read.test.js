'use strict';

process.env.ZN_STATS = 'off';

// `evidence --verify`, `evidence` (stats) and `evidence --export` read the log once, line by line:
// the results and messages are the same as when the whole file was read into memory, and the
// memory they use does not grow with the size of the log.
//
// The memory test is opt-in (it writes about 1 GB): ZN_SLOW_TESTS=1 node --test test/evidence_streaming_read.test.js
// ZN_SLOW_LEDGER_MB changes the size (default 1024). It needs Linux and /usr/bin/time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');
const ev = require('../lib/evidence');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function ledger(t, n) {
  const home = tempDir(t, 'zn-stream-read-');
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < n; i++) {
    const r = ev.logEvidence({
      agent: 'test-agent', phase: 'tool-call', tool_name: `tool${(i * 7) % 5}`, payload: `payload ${i} é 漢`,
      verdict: i % 4 === 0 ? 'block' : (i % 9 === 0 ? 'shadow' : 'allow'), rule: i % 4 === 0 ? `RULE_${(i * 3) % 4}` : null,
      reason: `line ${i}`, latency_us: i, engine: 'test',
    }, file, { noStats: true });
    assert.ok(r, 'record written');
  }
  return { home, file };
}

function withChunk(t, size) {
  ev._testHooks.exportChunkSize = size;
  t.after(() => { ev._testHooks.exportChunkSize = null; });
}

// The stats of earlier versions: the whole file in memory, the lines walked from the newest.
function referenceStats(file, limit) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/^[ \t\r]+|[ \t\r]+$/g, '')).filter(Boolean);
  let blocked = 0; let allowed = 0; let shadows = 0;
  const topRules = {}; const topTools = {}; const recent = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]);
      if (rec === null || typeof rec !== 'object') continue;
      if (rec.verdict === 'shadow') shadows++;
      else if (rec.verdict === 'block') { blocked++; if (rec.rule) topRules[rec.rule] = (topRules[rec.rule] || 0) + 1; } else allowed++;
      if (rec.tool_name) topTools[rec.tool_name] = (topTools[rec.tool_name] || 0) + 1;
      if (recent.length < limit) recent.push(rec);
    } catch { /* skipped */ }
  }
  return { total: lines.length, blocks: blocked, blocked, allows: allowed, allowed, shadows, top_rules: topRules, top_tools: topTools, recent };
}

function sameStats(got, want) {
  for (const k of ['total', 'blocks', 'blocked', 'allows', 'allowed', 'shadows']) assert.equal(got[k], want[k], k);
  assert.deepEqual(got.recent, want.recent);
  assert.deepEqual(got.top_rules, want.top_rules);
  assert.deepEqual(Object.keys(got.top_rules), Object.keys(want.top_rules), 'same key order');
  assert.deepEqual(got.top_tools, want.top_tools);
  assert.deepEqual(Object.keys(got.top_tools), Object.keys(want.top_tools), 'same key order');
}

for (const chunk of [null, 29]) {
  const label = chunk ? `chunks of ${chunk} bytes` : 'default chunks';

  test(`stats match the whole-file result (${label})`, (t) => {
    const { file } = ledger(t, 45);
    if (chunk) withChunk(t, chunk);
    for (const limit of [50, 7, 1, 0]) {
      const got = ev.getEvidenceStats(file, limit);
      assert.equal(got.valid, true);
      assert.equal(got.error, null);
      sameStats(got, referenceStats(file, limit));
    }
    // A blank line, a line that is not JSON and a JSON value that is not an object do not stop the count.
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.splice(20, 0, '', 'not json', '42', '[1]');
    fs.writeFileSync(file, lines.join('\n'));
    const got = ev.getEvidenceStats(file, 50);
    assert.equal(got.valid, false);
    assert.match(got.error, /Malformed JSON at line 21/);
    sameStats(got, referenceStats(file, 50));
  });

  test(`verify results and messages (${label})`, (t) => {
    const { file } = ledger(t, 12);
    if (chunk) withChunk(t, chunk);
    const clean = fs.readFileSync(file, 'utf8');
    assert.deepEqual(ev.verifyEvidenceLedger(file), { valid: true, total: 12, verified: 12, broken_index: null, error: null });
    // A log whose last line has no newline is still valid.
    fs.writeFileSync(file, clean.trimEnd());
    assert.equal(ev.verifyEvidenceLedger(file).valid, true);

    const lines = clean.trimEnd().split('\n');
    const edit = (fn) => { const c = lines.slice(); fn(c); fs.writeFileSync(file, c.join('\n') + '\n'); return ev.verifyEvidenceLedger(file); };

    let r = edit((c) => { c[5] = c[5].replace('payload', 'pAyload'); });
    assert.equal(r.valid, false);
    assert.equal(r.total, 12);
    assert.equal(r.verified, 5);
    assert.equal(r.broken_index, 5);
    assert.match(r.error, /^Tamper detected at line 6 \(record ev_[0-9a-z_]+\): hash mismatch\. The content of this log was altered!$/);

    r = edit((c) => { c.splice(3, 1); });
    assert.equal(r.total, 11);
    assert.equal(r.broken_index, 3);
    assert.match(r.error, /^Broken chain link at line 4 \(record ev_[0-9a-z_]+\): expected prev_hash [0-9a-f]{8}\.\.\. but found [0-9a-f]{8}\.\.\.$/);

    r = edit((c) => { c[8] = '{"id":'; });
    assert.equal(r.total, 12);
    assert.equal(r.broken_index, 8);
    assert.match(r.error, /^Malformed JSON at line 9: /);

    r = edit((c) => { c[2] = '[1,2]'; });
    assert.equal(r.error, 'Malformed record at line 3: not a JSON object.');

    // A line with bytes that are not UTF-8 is reported at its line, and the lines after it are still counted.
    const buf = Buffer.concat([Buffer.from(lines.slice(0, 4).join('\n') + '\n'), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(lines.slice(4).join('\n') + '\n')]);
    fs.writeFileSync(file, buf);
    r = ev.verifyEvidenceLedger(file);
    assert.equal(r.valid, false);
    assert.equal(r.total, 13);
    assert.equal(r.broken_index, 4);
    assert.equal(r.error, 'Invalid UTF-8 bytes at line 5: the log was corrupted or modified.');
  });

  test(`a truncated last line is reported as cut off, not as tampering (${label})`, (t) => {
    const { file } = ledger(t, 10);
    if (chunk) withChunk(t, chunk);
    const text = fs.readFileSync(file, 'utf8');
    // Cut the last record in the middle and leave no newline, as a crash or a full disk does.
    fs.writeFileSync(file, text.slice(0, text.length - 60));
    const r = ev.verifyEvidenceLedger(file);
    assert.equal(r.valid, false);
    assert.equal(r.truncated_tail, true);
    assert.equal(r.total, 10);
    assert.equal(r.verified, 9);
    assert.equal(r.broken_index, 9);
    assert.match(r.error, /^Last record is incomplete: .* at line 10: the line is not valid JSON\.$/);
    const s = ev.getEvidenceStats(file, 50);
    assert.equal(s.valid, false);
    assert.equal(s.total, 10);
    assert.equal(s.error, r.error);
    assert.equal(s.recent.length, 9);
    // The same cut with a newline after it is a tamper report.
    fs.writeFileSync(file, text.slice(0, text.length - 60) + '\n');
    const r2 = ev.verifyEvidenceLedger(file);
    assert.equal(r2.truncated_tail, undefined);
    assert.match(r2.error, /^Malformed JSON at line 10: /);
  });
}

test('verify, stats and export open the log once each', (t) => {
  const { file } = ledger(t, 15);
  const realOpen = fs.openSync;
  const realRead = fs.readFileSync;
  let opens = 0;
  t.mock.method(fs, 'openSync', function (p, ...rest) { if (p === file) opens++; return realOpen.call(this, p, ...rest); });
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    assert.notEqual(p, file, 'the log is never read in one piece');
    return realRead.call(this, p, ...rest);
  });
  assert.equal(ev.verifyEvidenceLedger(file).valid, true);
  assert.equal(opens, 1, 'verify');
  opens = 0;
  assert.equal(ev.getEvidenceStats(file, 50).valid, true);
  assert.equal(opens, 1, 'stats');
  opens = 0;
  assert.equal(ev.exportEvidenceLedger(file, 'jsonl').valid, true);
  assert.equal(opens, 1, 'export');
});

test('a log that cannot be read is invalid, with the reason', (t) => {
  const dir = tempDir(t, 'zn-stream-read-dir-');
  const asDir = path.join(dir, 'evidence.jsonl');
  fs.mkdirSync(asDir);
  const v = ev.verifyEvidenceLedger(asDir);
  assert.equal(v.valid, false);
  assert.equal(v.total, 0);
  assert.match(v.error, /^Cannot read the evidence log: /);
  const s = ev.getEvidenceStats(asDir, 50);
  assert.equal(s.valid, false);
  assert.equal(s.error, v.error);
});

// ---- opt-in memory test ------------------------------------------------------------------------

const SLOW = process.env.ZN_SLOW_TESTS === '1';
const HAS_TIME = process.platform === 'linux' && fs.existsSync('/usr/bin/time');

// Writes a valid hash-chained log of about `bytes` bytes without holding it in memory.
function writeBigLedger(file, bytes) {
  const fd = fs.openSync(file, 'w');
  let prev = ev.GENESIS_HASH;
  let size = 0;
  let i = 0;
  let batch = [];
  const pad = 'x'.repeat(600);
  const flush = () => { fs.writeSync(fd, batch.join('')); batch = []; };
  while (size < bytes) {
    const base = {
      id: `ev_${(1700000000000 + i).toString(16)}_${i.toString(16).padStart(8, '0')}`,
      timestamp: '2026-11-18T10:00:00.000Z',
      agent_environment: 'synthetic',
      phase: 'tool-call',
      tool_name: `tool${i % 7}`,
      payload_sha256: crypto.createHash('sha256').update(String(i)).digest('hex'),
      payload_preview: `payload ${i}`,
      verdict: i % 3 === 0 ? 'block' : (i % 11 === 0 ? 'shadow' : 'allow'),
      rule: i % 3 === 0 ? `RULE_${i % 5}` : null,
      reason: pad,
      confidence: 1,
      latency_us: i % 1000,
      engine: 'synthetic',
      prev_hash: prev,
    };
    const hash = crypto.createHash('sha256').update(prev + ':' + JSON.stringify(base)).digest('hex');
    const line = JSON.stringify({ ...base, record_hash: hash }) + '\n';
    batch.push(line);
    size += line.length;
    prev = hash;
    i++;
    if (batch.length >= 1000) flush();
  }
  flush();
  fs.closeSync(fd);
  return i;
}

function peakRssMb(home, args) {
  const timeFile = path.join(home, 'time.txt');
  const env = { ...process.env, ZN_HOME: path.join(home, '.zn'), ZN_STATS: 'off', NO_COLOR: '1' };
  const outFd = fs.openSync(path.join(home, 'out.txt'), 'w');
  const r = spawnSync('/usr/bin/time', ['-v', '-o', timeFile, process.execPath, CLI, 'evidence', ...args], { env, stdio: ['ignore', outFd, 'pipe'] });
  fs.closeSync(outFd);
  const m = /Maximum resident set size \(kbytes\): (\d+)/.exec(fs.readFileSync(timeFile, 'utf8'));
  assert.ok(m, 'time -v reported the peak');
  return { status: r.status, mb: Number(m[1]) / 1024, stderr: String(r.stderr) };
}

test('memory: verify, stats and export of a ~1 GB log stay under 200 MB', { skip: !SLOW || !HAS_TIME, timeout: 900000 }, (t) => {
  const home = tempDir(t, 'zn-stream-big-', process.env.ZN_SLOW_DIR || os.tmpdir());
  fs.mkdirSync(path.join(home, '.zn'));
  const mb = Number(process.env.ZN_SLOW_LEDGER_MB || 1024);
  const records = writeBigLedger(path.join(home, '.zn', 'evidence.jsonl'), mb * 1024 * 1024);
  const limit = Number(process.env.ZN_SLOW_LIMIT_MB || 200);
  for (const [name, args, wantOut] of [
    ['verify', ['--verify'], /ALL SHA-256 HASHES VERIFIED/],
    ['stats', [], new RegExp(`Total Events  : ${records}\\b`)],
    ['export jsonl', ['--export'], /^\{"id":"ev_/],
    ['export csv', ['--export', '--format', 'csv'], /^timestamp,verdict/],
  ]) {
    const r = peakRssMb(home, args);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(fs.readFileSync(path.join(home, 'out.txt'), 'utf8').slice(0, 4000), wantOut, name);
    t.diagnostic(`${name}: peak ${r.mb.toFixed(0)} MB`);
    assert.ok(r.mb < limit, `${name} used ${r.mb.toFixed(0)} MB, limit ${limit}`);
  }
});
