'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logEvidence, getEvidenceStats, exportEvidenceLedger } = require('../lib/evidence');

const GENESIS = '0'.repeat(64);
const CSV_HEADER = 'timestamp,verdict,phase,tool_name,agent_environment,rule,reason,payload_sha256,record_hash,prev_hash,latency_us';

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-stats-'));
  try { return fn(path.join(dir, 'evidence.jsonl'), dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function fill(file, n) {
  const verdicts = ['allow', 'block', 'shadow'];
  const records = [];
  for (let i = 0; i < n; i++) {
    records.push(logEvidence({
      agent: 'example-agent', phase: 'tool-call', tool_name: `tool${i % 2}`,
      payload: `fake payload ${i}`, verdict: verdicts[i % 3],
      rule: verdicts[i % 3] === 'block' ? 'EXAMPLE_RULE' : null,
    }, file));
  }
  return records;
}

for (const kind of ['missing', 'empty']) {
  test(`empty ledger (${kind} file): stats are all zero`, () => withDir((file) => {
    if (kind === 'empty') fs.writeFileSync(file, '');
    const s = getEvidenceStats(file);
    assert.equal(s.total, 0);
    assert.equal(s.blocks, 0);
    assert.equal(s.allows, 0);
    assert.equal(s.shadows, 0);
    assert.equal(s.valid, true);
    assert.deepEqual(s.recent, []);
    assert.deepEqual(s.top_rules, {});
    assert.deepEqual(s.top_tools, {});
  }));

  test(`empty ledger (${kind} file): export has no records`, () => withDir((file) => {
    if (kind === 'empty') fs.writeFileSync(file, '');
    const j = exportEvidenceLedger(file, 'jsonl');
    assert.equal(j.total, 0);
    assert.equal(j.valid, true);
    assert.equal(j.tip_hash, GENESIS);
    assert.equal(j.content.trim(), '');
    const c = exportEvidenceLedger(file, 'csv');
    assert.equal(c.total, 0);
    assert.equal(c.valid, true);
    assert.equal(c.tip_hash, GENESIS);
    assert.equal(c.content.trim(), CSV_HEADER);
  }));
}

test('one entry: stats count it and first and last record are the same', () => withDir((file) => {
  const rec = logEvidence({ tool_name: 'solo', payload: 'x', verdict: 'block', rule: 'EXAMPLE_RULE' }, file);
  const s = getEvidenceStats(file);
  assert.equal(s.total, 1);
  assert.equal(s.blocks, 1);
  assert.equal(s.allows, 0);
  assert.equal(s.shadows, 0);
  assert.deepEqual(s.top_rules, { EXAMPLE_RULE: 1 });
  assert.equal(s.recent.length, 1);
  assert.equal(s.recent[0].timestamp, rec.timestamp);

  const j = exportEvidenceLedger(file, 'jsonl');
  assert.equal(j.total, 1);
  assert.equal(j.tip_hash, rec.record_hash);
  assert.equal(j.content.split('\n').filter(Boolean).length, 1);
  assert.ok(j.content.endsWith('\n'));
  const c = exportEvidenceLedger(file, 'csv');
  assert.equal(c.content.split('\n').filter(Boolean).length, 2);
}));

test('500 entries: counts per decision, first and last time, export layout', () => withDir((file) => {
  const records = fill(file, 500);
  const s = getEvidenceStats(file, 1000);
  assert.equal(s.total, 500);
  assert.equal(s.allows + s.blocks + s.shadows, 500);
  assert.equal(s.allows, 167);
  assert.equal(s.blocks, 167);
  assert.equal(s.shadows, 166);
  assert.equal(s.allowed, s.allows);
  assert.equal(s.blocked, s.blocks);
  assert.equal(s.valid, true);
  assert.deepEqual(s.top_rules, { EXAMPLE_RULE: 167 });
  assert.deepEqual(s.top_tools, { tool0: 250, tool1: 250 });
  // recent is newest first
  assert.equal(s.recent.length, 500);
  assert.equal(s.recent[0].timestamp, records[499].timestamp);
  assert.equal(s.recent[499].timestamp, records[0].timestamp);
  assert.ok(records[0].timestamp <= records[499].timestamp);
  // default limit is 50, an explicit limit is honoured
  assert.equal(getEvidenceStats(file).recent.length, 50);
  assert.equal(getEvidenceStats(file, 3).recent.length, 3);

  const j = exportEvidenceLedger(file, 'jsonl');
  assert.equal(j.total, 500);
  assert.equal(j.valid, true);
  assert.equal(j.tip_hash, records[499].record_hash);
  const lines = j.content.split('\n');
  assert.equal(lines.length, 501);
  assert.equal(lines[500], '');
  assert.equal(JSON.parse(lines[0]).record_hash, records[0].record_hash);
  assert.equal(JSON.parse(lines[0]).prev_hash, GENESIS);
  assert.equal(JSON.parse(lines[499]).record_hash, records[499].record_hash);
  assert.equal(j.content, fs.readFileSync(file, 'utf8'));

  const c = exportEvidenceLedger(file, 'csv');
  assert.equal(c.total, 500);
  assert.equal(c.tip_hash, records[499].record_hash);
  const rows = c.content.split('\n');
  assert.equal(rows[0], CSV_HEADER);
  assert.equal(rows.length, 502);
  assert.equal(rows[501], '');
  assert.ok(rows[1].startsWith(`"${records[0].timestamp}","allow"`));
  assert.ok(rows[500].startsWith(`"${records[499].timestamp}","`));
}));
