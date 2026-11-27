'use strict';
// evidence --export --format ocsf: one OCSF Detection Finding (class 2004) per record, the zn_ fields
// under unmapped, the preview only on request, a record with no valid time kept with time 0, and exit
// code 1 when the chain does not verify. Temporary folders and invented values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { logEvidence } = require('../lib/evidence');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const TOP_KEYS = [
  'activity_id', 'category_uid', 'category_name', 'class_uid', 'class_name', 'type_uid',
  'action_id', 'disposition_id', 'severity_id', 'time', 'message', 'finding_info', 'metadata',
  'cloud', 'osint', 'unmapped',
];

function setup(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-ocsf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const log = path.join(home, 'evidence.jsonl');
  for (const r of records) logEvidence(r, log, { noStats: true });
  return { dir, home, log };
}

function run(home, args) {
  return spawnSync(process.execPath, [CLI, 'evidence', '--export', '--format', 'ocsf', ...args], {
    env: { ...process.env, ZN_HOME: home }, encoding: 'utf8', timeout: 60000,
  });
}

const RECORDS = [
  { agent: 'agent-a', phase: 'tool-call', tool_name: 'shell', verdict: 'allow', engine: 'e', latency_us: 7, payload: 'first preview text' },
  { agent: 'agent-a', phase: 'tool-call', tool_name: 'shell', verdict: 'block', rule: 'zn_state', engine: 'e', latency_us: 7 },
];

test('ocsf: Detection Finding fields in order, verdict mapped, zn_ fields under unmapped', (t) => {
  const { home } = setup(t, RECORDS);
  const r = run(home, []);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  const first = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(first), TOP_KEYS);
  assert.equal(first.class_uid, 2004);
  assert.equal(first.category_uid, 2);
  assert.equal(first.type_uid, 200401);
  assert.equal(first.activity_id, 1);
  assert.deepEqual([first.action_id, first.disposition_id, first.severity_id], [1, 1, 1]);
  assert.equal(first.metadata.version, '1.7.0');
  assert.equal(first.metadata.product.name, 'zn-gate');
  assert.equal(first.metadata.product.vendor_name, 'zn');
  assert.deepEqual(first.cloud, { provider: 'local' });
  assert.deepEqual(first.osint, []);
  assert.equal(first.message, 'allow shell by agent-a');
  assert.equal(first.finding_info.title, first.message);
  assert.equal(first.unmapped.zn_chain_verified, true);
  assert.equal(first.unmapped.zn_chain_index, 0);
  assert.ok(!('zn_payload_preview' in first.unmapped));
  assert.ok(!lines[0].includes('payload_preview'));
  const second = JSON.parse(lines[1]);
  assert.deepEqual([second.action_id, second.disposition_id, second.severity_id], [2, 2, 3]);
  assert.equal(second.message, 'block shell by agent-a (rule zn_state)');
  assert.equal(second.unmapped.zn_rule, 'zn_state');
});

test('ocsf: the preview is added only with --include-preview, before zn_chain_index', (t) => {
  const { home } = setup(t, RECORDS);
  const plain = JSON.parse(run(home, []).stdout.split('\n')[0]);
  assert.ok(!('zn_payload_preview' in plain.unmapped));
  const withPreview = JSON.parse(run(home, ['--include-preview']).stdout.split('\n')[0]);
  const keys = Object.keys(withPreview.unmapped);
  assert.equal(keys[keys.indexOf('zn_chain_index') - 1], 'zn_payload_preview');
  assert.equal(withPreview.unmapped.zn_payload_preview, 'first preview text');
});

test('ocsf: a record with no valid time is kept with time 0 and zn_time_unmapped', (t) => {
  const { home, log } = setup(t, [RECORDS[0]]);
  const rec = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  rec.timestamp = '2026-02-30T00:00:00Z';
  fs.writeFileSync(log, JSON.stringify(rec) + '\n');
  const r = run(home, []);
  assert.equal(r.status, 1); // the edit broke the chain, so the export exits 1 as it must
  const event = JSON.parse(r.stdout.trim());
  assert.equal(event.time, 0);
  assert.equal(event.unmapped.zn_time_unmapped, true);
  assert.equal(event.unmapped.zn_timestamp, '2026-02-30T00:00:00Z');
});

test('ocsf: a tampered log exits 1 and the manifest names the break', (t) => {
  const { dir, home, log } = setup(t, [...RECORDS, { agent: 'a', phase: 'p', tool_name: 'third', verdict: 'allow', engine: 'e' }]);
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  lines[1] = lines[1].replace('"verdict":"block"', '"verdict":"allow"');
  fs.writeFileSync(log, lines.join('\n'));
  const out = path.join(dir, 'out.ocsf');
  const r = run(home, ['--output', out, '--manifest']);
  assert.equal(r.status, 1);
  const m = JSON.parse(fs.readFileSync(`${out}.manifest.json`, 'utf8'));
  assert.equal(m.format, 'ocsf');
  assert.equal(m.chain_verified, false);
  assert.equal(m.chain_break_index, 1);
});
