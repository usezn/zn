'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  logEvidence, getLastHash, verifyEvidenceLedger, getEvidenceStats, exportEvidenceLedger,
  recoveryHint, EvidenceLedgerError, EVIDENCE_FILE, GENESIS_HASH,
} = require('../lib/evidence');

function tmpLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-exports-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'evidence.jsonl');
}

function write(file, i, verdict = 'allow', extra = {}) {
  return logEvidence({
    agent: 'test-agent', phase: 'tool-call', tool_name: `tool${i}`, payload: `payload ${i}`,
    verdict, latency_us: 1, engine: 'test', ...extra,
  }, file, { noStats: true });
}

test('exported constants: genesis hash is 64 zeros and the default file is evidence.jsonl', () => {
  assert.equal(GENESIS_HASH, '0'.repeat(64));
  assert.equal(path.basename(EVIDENCE_FILE), 'evidence.jsonl');
  assert.ok(new EvidenceLedgerError('x') instanceof Error);
});

test('getLastHash: genesis for a missing or empty file, last record hash otherwise', (t) => {
  const file = tmpLedger(t);
  assert.equal(getLastHash(file), GENESIS_HASH);
  fs.writeFileSync(file, '');
  assert.equal(getLastHash(file), GENESIS_HASH);
  const r1 = write(file, 1);
  assert.equal(getLastHash(file), r1.record_hash);
  const r2 = write(file, 2);
  assert.equal(r2.prev_hash, r1.record_hash);
  assert.equal(getLastHash(file), r2.record_hash);
});

test('getLastHash: a damaged last line throws EvidenceLedgerError instead of restarting', (t) => {
  const file = tmpLedger(t);
  write(file, 1);
  fs.appendFileSync(file, '{not json\n');
  assert.throws(() => getLastHash(file), EvidenceLedgerError);
  fs.writeFileSync(file, '{"a":1}\n');
  assert.throws(() => getLastHash(file), /record_hash/);
});

test('log round trip: records keep their order and verify', (t) => {
  const file = tmpLedger(t);
  const recs = [1, 2, 3].map((i) => write(file, i));
  const onDisk = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(onDisk.map((r) => r.record_hash), recs.map((r) => r.record_hash));
  assert.deepEqual(onDisk.map((r) => r.tool_name), ['tool1', 'tool2', 'tool3']);
  assert.deepEqual(verifyEvidenceLedger(file), { valid: true, total: 3, verified: 3, broken_index: null, error: null });
});

test('getEvidenceStats: counts by verdict, top rules and tools, newest first', (t) => {
  const file = tmpLedger(t);
  write(file, 1, 'allow');
  write(file, 2, 'block', { rule: 'RULE_A' });
  write(file, 3, 'block', { rule: 'RULE_A' });
  write(file, 4, 'shadow');
  const s = getEvidenceStats(file);
  assert.equal(s.total, 4);
  assert.equal(s.blocked, 2);
  assert.equal(s.blocks, 2);
  assert.equal(s.allowed, 1);
  assert.equal(s.shadows, 1);
  assert.equal(s.valid, true);
  assert.deepEqual(s.top_rules, { RULE_A: 2 });
  assert.equal(s.top_tools.tool3, 1);
  assert.deepEqual(s.recent.map((r) => r.tool_name), ['tool4', 'tool3', 'tool2', 'tool1']);
});

test('getEvidenceStats: limit as second argument; missing file is empty and valid', (t) => {
  const file = tmpLedger(t);
  assert.deepEqual(getEvidenceStats(file), {
    total: 0, blocks: 0, blocked: 0, allows: 0, allowed: 0, shadows: 0, valid: true,
    top_rules: {}, top_tools: {}, recent: [],
  });
  for (let i = 1; i <= 5; i++) write(file, i);
  const s = getEvidenceStats(file, 2);
  assert.equal(s.total, 5);
  assert.deepEqual(s.recent.map((r) => r.tool_name), ['tool5', 'tool4']);
});

test('getEvidenceStats: a tampered log is reported as not valid', (t) => {
  const file = tmpLedger(t);
  write(file, 1);
  write(file, 2);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('tool1', 'toolX'));
  const s = getEvidenceStats(file);
  assert.equal(s.valid, false);
  assert.match(s.error, /Tamper detected at line 1/);
});

test('exportEvidenceLedger: jsonl keeps the file content, tip hash is the last record', (t) => {
  const file = tmpLedger(t);
  write(file, 1);
  const r2 = write(file, 2);
  const out = exportEvidenceLedger(file);
  assert.equal(out.format, 'jsonl');
  assert.equal(out.content, fs.readFileSync(file, 'utf8'));
  assert.equal(out.tip_hash, r2.record_hash);
  assert.equal(out.total, 2);
  assert.equal(out.valid, true);
});

test('exportEvidenceLedger: csv has a header, one row per record, and doubles quotes', (t) => {
  const file = tmpLedger(t);
  write(file, 1, 'block', { reason: 'said "no"', rule: 'RULE_A' });
  const out = exportEvidenceLedger(file, 'CSV');
  assert.equal(out.format, 'csv');
  const rows = out.content.trim().split('\n');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].startsWith('timestamp,verdict,phase,tool_name'));
  assert.ok(rows[1].includes('"said ""no"""'));
  assert.ok(rows[1].includes('"RULE_A"'));
});

test('exportEvidenceLedger: unknown format falls back to jsonl; missing file gives an empty valid export', (t) => {
  const file = tmpLedger(t);
  const empty = exportEvidenceLedger(file, 'xml');
  assert.deepEqual(empty, { content: '', format: 'jsonl', valid: true, tip_hash: GENESIS_HASH, total: 0 });
  const csv = exportEvidenceLedger(file, 'csv');
  assert.equal(csv.total, 0);
  assert.equal(csv.content.split('\n').length, 2);
  assert.ok(csv.content.startsWith('timestamp,verdict,'));
});

test('damaged file: verify, stats and export say so, and the hint names the file', (t) => {
  const file = tmpLedger(t);
  write(file, 1);
  fs.appendFileSync(file, 'garbage\n');
  const v = verifyEvidenceLedger(file);
  assert.equal(v.valid, false);
  assert.equal(v.broken_index, 1);
  assert.equal(v.verified, 1);
  assert.equal(getEvidenceStats(file).valid, false);
  assert.equal(exportEvidenceLedger(file).valid, false);
  assert.ok(recoveryHint(file).includes(file));
});
