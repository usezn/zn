'use strict';
/*
 * B-2197: the OTLP export reads the audit log in chunks and writes its output
 * piece by piece. The output is the same as before (auditToOtlpJsonLines over
 * every valid record, ordered by seq), and a read error is an error, not tampering.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tempDir } = require('./helpers/tmp');
const otel = require('../lib/team/otel');

const HEX = (c) => c.repeat(64);
function rec(seq, extra) {
  return Object.assign({ v: 1, seq, ts: '2026-10-30T10:00:' + String(seq % 60).padStart(2, '0') + '.000Z', secret: 'API_KEY', mode: 'env', agent: 'claude-code', tool: 'Bash', argv0: 'curl', host: 'example.com', decision: 'allow', prev: HEX('0'), mac: HEX('a') }, extra || {});
}
const opts = (file, more) => Object.assign({ auditFile: file, installId: '6f1c2b1e-0000-4000-8000-000000000001', orgId: 'org_example' }, more);

test('same output as the reference for a small log: invalid lines, blank lines, out of order, since', (t) => {
  const dir = tempDir(t, 'zn-otlp-');
  const file = path.join(dir, 'audit.jsonl');
  const good = [rec(3), rec(1), rec(2), rec(5), rec(4, { ts: '2020-01-01T00:00:00.000Z' })];
  const lines = [JSON.stringify(good[0]), '', 'not json', JSON.stringify(good[1]), 'null', JSON.stringify(Object.assign(rec(9), { ts: 'bad' })), JSON.stringify(good[2]), JSON.stringify(good[3]), JSON.stringify(good[4])];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const ref = otel.auditToOtlpJsonLines(good, { installId: opts(file).installId, orgId: 'org_example' });
  const r = otel.exportAuditFile(opts(file));
  assert.strictEqual(r.content, ref);
  assert.strictEqual(r.records, 5);
  assert.strictEqual(r.sha256, crypto.createHash('sha256').update(ref, 'utf8').digest('hex'));
  for (const chunk of [{ chunkSize: 1 }, { chunkSize: 11 }]) {
    assert.strictEqual(otel.exportAuditFile(opts(file, { chunk })).content, ref, JSON.stringify(chunk));
  }
  // since: the old record (2020) is left out, the others keep their order.
  const since = otel.exportAuditFile(opts(file, { since: '2025-01-01T00:00:00Z' }));
  assert.strictEqual(since.content, otel.auditToOtlpJsonLines([good[1], good[2], good[0], good[3]].sort((a, b) => a.seq - b.seq), { installId: opts(file).installId, orgId: 'org_example' }));
  assert.strictEqual(since.records, 4);
});

test('empty or missing log: empty output, sha256 of the empty string', (t) => {
  const dir = tempDir(t, 'zn-otlp-');
  const empty = crypto.createHash('sha256').update('', 'utf8').digest('hex');
  assert.deepStrictEqual(otel.exportAuditFile(opts(path.join(dir, 'missing'))), { content: '', records: 0, sha256: empty });
  fs.writeFileSync(path.join(dir, 'e'), '\n\n');
  assert.deepStrictEqual(otel.exportAuditFile(opts(path.join(dir, 'e'))), { content: '', records: 0, sha256: empty });
});

test('large log: streamed in small pieces, never read whole, one line per 500 records', (t) => {
  const dir = tempDir(t, 'zn-otlp-');
  const file = path.join(dir, 'audit.jsonl');
  const N = 120000;
  const fd = fs.openSync(file, 'w');
  let buf = [];
  for (let s = 1; s <= N; s++) { buf.push(JSON.stringify(rec(s))); if (buf.length === 5000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; } }
  fs.closeSync(fd);
  const real = fs.readFileSync;
  fs.readFileSync = function patched(p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(file)) { const e = new Error('too long'); e.code = 'ERR_STRING_TOO_LONG'; throw e; }
    return real.call(this, p, ...rest);
  };
  t.after(() => { fs.readFileSync = real; });
  const hash = crypto.createHash('sha256');
  let pieces = 0; let biggest = 0; let first = null;
  const r = otel.exportAuditStream(opts(file), (s) => { pieces++; biggest = Math.max(biggest, s.length); hash.update(s); if (!first) first = s; });
  assert.strictEqual(r.records, N);
  assert.strictEqual(pieces, N / 500);
  assert.strictEqual(r.sha256, hash.digest('hex'));
  assert.ok(biggest < 2 * 1024 * 1024, 'each piece is one line');
  const req = JSON.parse(first);
  assert.strictEqual(req.resourceLogs[0].scopeLogs[0].logRecords.length, 500);
});

test('a read error is thrown as a read error', (t) => {
  const dir = tempDir(t, 'zn-otlp-');
  const file = path.join(dir, 'audit.jsonl');
  fs.mkdirSync(file);
  assert.throws(() => otel.exportAuditFile(opts(file)), (e) => e.code === 'EISDIR');
});
