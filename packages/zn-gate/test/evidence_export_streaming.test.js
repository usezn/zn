'use strict';

process.env.ZN_STATS = 'off';

// `evidence --export` reads the log in chunks: a log too large for one string still exports every
// record, a read error never ends in a "VALID" export, the chain check matches --verify, and the
// output is the same, byte for byte, as the export of earlier versions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');
const ev = require('../lib/evidence');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const PRELOAD = path.join(__dirname, 'helpers', 'export_string_limit.js');

function ledger(t, n) {
  const home = tempDir(t, 'zn-export-stream-');
  const file = path.join(home, '.zn', 'evidence.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < n; i++) {
    const r = ev.logEvidence({
      agent: 'test-agent', phase: 'tool-call', tool_name: `tool${i}`, payload: `payload ${i} é 漢 "q"`,
      verdict: i % 3 ? 'allow' : 'block', rule: i % 3 ? null : 'RULE_A', reason: `said "no", line ${i}\nnext`,
      latency_us: i, engine: 'test',
    }, file, { noStats: true });
    assert.ok(r, 'record written');
  }
  return { home, file, out: path.join(home, 'export.out') };
}

function withChunk(t, size) {
  ev._testHooks.exportChunkSize = size;
  t.after(() => { ev._testHooks.exportChunkSize = null; ev._testHooks.beforeExportRead = null; });
}

async function streamTo(file, format) {
  const sink = new PassThrough();
  const parts = [];
  sink.on('data', (d) => parts.push(d));
  const result = await ev.writeEvidenceExport(file, format, sink);
  sink.end();
  return { result, content: Buffer.concat(parts).toString('utf8') };
}

function runCli(home, args, env = {}) {
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', ZN_STATS: 'off', ...env };
  delete childEnv.ZN_HOME;
  return spawnSync(process.execPath, ['-r', PRELOAD, CLI, 'evidence', ...args], { encoding: 'utf8', env: childEnv });
}

// The export of earlier versions (one readFileSync of the whole log), kept here as the golden reference.
function referenceExport(file, format) {
  const raw = fs.readFileSync(file);
  const isWs = (b) => b === 0x20 || b === 0x09 || b === 0x0d;
  const lines = [];
  let start = 0;
  while (start <= raw.length) {
    let end = raw.indexOf(0x0a, start);
    if (end === -1) end = raw.length;
    let a = start;
    let b = end;
    while (a < b && isWs(raw[a])) a++;
    while (b > a && isWs(raw[b - 1])) b--;
    start = end + 1;
    if (b > a) lines.push(new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw.subarray(a, b)));
  }
  if (format === 'jsonl') {
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw);
    return text.endsWith('\n') ? text : text + '\n';
  }
  const headers = ['timestamp', 'verdict', 'phase', 'tool_name', 'agent_environment', 'rule', 'reason',
    'payload_sha256', 'record_hash', 'prev_hash', 'latency_us'];
  const rows = [headers.join(',')];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      rows.push(headers.map((h) => `"${(obj[h] !== undefined && obj[h] !== null ? String(obj[h]) : '').replace(/"/g, '""')}"`).join(','));
    } catch { /* skipped, as before */ }
  }
  return rows.join('\n') + '\n';
}

test('a log too large for one string exports every record, streamed in chunks', async (t) => {
  const { file } = ledger(t, 40);
  withChunk(t, 37);
  const expectedCsv = referenceExport(file, 'csv');
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === file) { const e = new Error('Cannot create a string longer than 1024 characters'); e.code = 'ERR_STRING_TOO_LONG'; throw e; }
    return realRead.call(this, p, ...rest);
  });
  const j = await streamTo(file, 'jsonl');
  assert.equal(j.result.total, 40);
  assert.equal(j.result.valid, true);
  assert.equal(j.result.verified, 40);
  assert.equal(j.content, realRead(file, 'utf8'));
  const c = await streamTo(file, 'csv');
  assert.equal(c.result.total, 40);
  assert.equal(c.content, expectedCsv);
  // The library call that returns one string reads in chunks too.
  const s = ev.exportEvidenceLedger(file, 'jsonl');
  assert.equal(s.total, 40);
  assert.equal(s.valid, true);
});

test('CLI: export of a log past the string limit writes all records in jsonl and csv', (t) => {
  const { home, file, out } = ledger(t, 30);
  assert.ok(fs.statSync(file).size > 1024);
  let r = runCli(home, ['--export', '--output', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Exported 30 audit records .*\(Integrity: VALID\)/);
  assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(file, 'utf8'));
  r = runCli(home, ['--export', '--format', 'csv', '--output', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Exported 30 audit records/);
  assert.equal(fs.readFileSync(out, 'utf8'), referenceExport(file, 'csv'));
  // To the screen as well.
  r = runCli(home, ['--export']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fs.readFileSync(file, 'utf8'));
});

test('CLI: a corrupt line in the middle exits 1 and never says VALID', (t) => {
  const { home, file, out } = ledger(t, 30);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[12] = lines[12].slice(0, 40);
  fs.writeFileSync(file, lines.join('\n'));
  const r = runCli(home, ['--export', '--output', out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /VALID\)/);
  assert.match(r.stdout, /Exported 30 audit records .*\(Integrity: TAMPERED\)/);
  assert.match(r.stderr, /Tamper detected: Malformed JSON at line 13/);
});

test('CLI: a read error stops the export with exit 1 and no success line', (t) => {
  const { home, out } = ledger(t, 30);
  for (const fmt of ['jsonl', 'csv']) {
    const r = runCli(home, ['--export', '--format', fmt, '--output', out], { ZN_TEST_EXPORT_FAIL_AT: '200' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Exported|VALID/);
    assert.match(r.stderr, /the export stopped\. Cannot read the evidence log: EIO\./);
    assert.ok(r.stderr.includes(`${out} is incomplete`), r.stderr);
  }
  const s = runCli(home, ['--export'], { ZN_TEST_EXPORT_FAIL_AT: '0' });
  assert.equal(s.status, 1);
  assert.match(s.stderr, /Cannot read the evidence log: EIO/);
});

test('the chain check of the export matches verify, including a cut-off last record', async (t) => {
  const { file } = ledger(t, 6);
  const good = fs.readFileSync(file);
  const text = good.toString('utf8');
  const cases = {
    good,
    cutNoNewline: good.subarray(0, good.length - 30),
    cutWithNewline: Buffer.concat([good.subarray(0, good.length - 30), Buffer.from('\n')]),
    garbageMid: Buffer.from(text.replace(/\n/, '\ngarbage\n')),
    badUtf8Mid: Buffer.concat([good.subarray(0, 50), Buffer.from([0xff]), good.subarray(50)]),
    editedRecord: Buffer.from(text.replace('tool3', 'toolX')),
    notObject: Buffer.from(text + '[1]\n'),
    blankAndCrlf: Buffer.from('\n  \r\n' + text.replace(/\n/g, '\r\n') + '\n\t\n'),
    empty: Buffer.alloc(0),
  };
  const fields = (o) => ({
    valid: o.valid, total: o.total, verified: o.verified, broken_index: o.broken_index, error: o.error,
    truncated_tail: o.truncated_tail === true,
  });
  for (const size of [1, 7, 4096]) {
    withChunk(t, size);
    for (const [name, bytes] of Object.entries(cases)) {
      fs.writeFileSync(file, bytes);
      const v = ev.verifyEvidenceLedger(file);
      const { result } = await streamTo(file, 'jsonl');
      assert.deepEqual(fields(result), fields(v), `${name} at chunk ${size}`);
    }
  }
  fs.writeFileSync(file, cases.cutNoNewline);
  const { result } = await streamTo(file, 'csv');
  assert.equal(result.truncated_tail, true);
  assert.equal(result.verified, 5);
});

test('jsonl and csv output is byte-identical to the earlier export', async (t) => {
  const { file } = ledger(t, 8);
  const text = fs.readFileSync(file, 'utf8');
  const variants = [
    Buffer.from(text),
    Buffer.from(text.trimEnd()),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    Buffer.from(text.replace(/\n/g, '\r\n') + '\n \n'),
    Buffer.concat([Buffer.from(text), Buffer.from([0xe6, 0xbc])]),
    Buffer.from(text + 'null\n5\n"x"\n'),
    Buffer.alloc(0),
  ];
  for (const size of [1, 3, 64, 1 << 20]) {
    withChunk(t, size);
    for (const [i, bytes] of variants.entries()) {
      fs.writeFileSync(file, bytes);
      for (const fmt of ['jsonl', 'csv']) {
        const expected = referenceExport(file, fmt);
        assert.equal((await streamTo(file, fmt)).content, expected, `variant ${i} ${fmt} chunk ${size}`);
        assert.equal(ev.exportEvidenceLedger(file, fmt).content, expected, `variant ${i} ${fmt} chunk ${size} (string)`);
      }
    }
  }
});

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('dashboard /api/export streams the log and answers 500 on a read error', async (t) => {
  const { file } = ledger(t, 25);
  withChunk(t, 40);
  const server = ev.startEvidenceUi(0, file);
  t.after(() => server.close());
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const j = await get(port, '/api/export?format=jsonl');
  assert.equal(j.status, 200);
  assert.equal(j.headers['transfer-encoding'], 'chunked');
  assert.equal(j.headers['x-evidence-integrity'], 'valid');
  assert.equal(j.headers['x-evidence-total'], '25');
  assert.equal(j.body, fs.readFileSync(file, 'utf8'));
  const c = await get(port, '/api/export?format=csv');
  assert.equal(c.status, 200);
  assert.equal(c.body, referenceExport(file, 'csv'));

  ev._testHooks.beforeExportRead = (pos) => { if (pos >= 0) { const e = new Error('i/o error'); e.code = 'EIO'; throw e; } };
  const bad = await get(port, '/api/export?format=jsonl');
  assert.equal(bad.status, 500);
  assert.match(JSON.parse(bad.body).error, /Cannot read the evidence log: EIO\. Nothing was exported\./);
});
