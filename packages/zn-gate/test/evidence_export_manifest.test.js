'use strict';
// evidence --export --manifest and --include-preview: the manifest next to an export, the opt-in
// payload preview for the Timesketch formats, and the refusals. Temporary folders and invented values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { logEvidence } = require('../lib/evidence');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const MANIFEST_KEYS = [
  'format', 'source', 'records', 'first_timestamp', 'last_timestamp', 'chain_verified',
  'chain_break_index', 'tip_record_hash', 'export_sha256', 'generator',
];

function setup(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const log = path.join(home, 'evidence.jsonl');
  for (const r of records) logEvidence(r, log, { noStats: true });
  return { dir, home, log };
}

function run(home, args) {
  return spawnSync(process.execPath, [CLI, 'evidence', '--export', ...args], {
    env: { ...process.env, ZN_HOME: home }, encoding: 'utf8', timeout: 60000,
  });
}

const RECORDS = [
  { agent: 'agent-a', phase: 'tool-call', tool_name: 'shell', verdict: 'allow', engine: 'e', latency_us: 7, payload: 'first preview text' },
  { agent: 'agent-a', phase: 'tool-call', tool_name: 'shell', verdict: 'deny', rule: 'zn_state', engine: 'e', latency_us: 7 },
];

test('manifest: refused without --output, with one line and exit 2', (t) => {
  const { home } = setup(t, RECORDS);
  const r = run(home, ['--format', 'timesketch', '--manifest']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), 'zn-gate: --manifest needs --output FILE.');
});

test('include-preview: refused for jsonl and csv, with one line and exit 2', (t) => {
  const { home } = setup(t, RECORDS);
  for (const fmt of ['jsonl', 'csv']) {
    const r = run(home, ['--format', fmt, '--include-preview']);
    assert.equal(r.status, 2, fmt);
    assert.equal(r.stderr.trim(), 'zn-gate: --include-preview works only with --format timesketch, timesketch-csv or ocsf.');
    assert.equal(r.stdout, '');
  }
});

test('manifest: keys in order, values match the export file', (t) => {
  const { dir, home, log } = setup(t, RECORDS);
  const out = path.join(dir, 'out.jsonl');
  const r = run(home, ['--format', 'timesketch', '--output', out, '--manifest']);
  assert.equal(r.status, 0, r.stderr);
  const raw = fs.readFileSync(`${out}.manifest.json`, 'utf8');
  assert.ok(raw.endsWith('\n') && !raw.endsWith('\n\n'));
  const m = JSON.parse(raw);
  assert.deepEqual(Object.keys(m), MANIFEST_KEYS);
  assert.equal(m.format, 'timesketch');
  assert.equal(m.source, 'evidence.jsonl');
  assert.equal(m.records, 2);
  assert.equal(m.chain_verified, true);
  assert.equal(m.chain_break_index, null);
  const lastRecord = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  assert.equal(m.tip_record_hash, lastRecord.record_hash);
  assert.equal(m.export_sha256, crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'));
  assert.ok(m.generator.startsWith('zn-gate '));
  assert.ok(!raw.includes(home), 'the manifest never holds a full path');
});

test('manifest: a tampered log is named by its first break, and the export exits 1', (t) => {
  const { dir, home, log } = setup(t, [...RECORDS, { agent: 'a', phase: 'p', tool_name: 'third', verdict: 'allow', engine: 'e' }]);
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  lines[1] = lines[1].replace('"verdict":"deny"', '"verdict":"allow"');
  fs.writeFileSync(log, lines.join('\n'));
  const out = path.join(dir, 'out.csv');
  const r = run(home, ['--format', 'csv', '--output', out, '--manifest']);
  assert.equal(r.status, 1);
  const m = JSON.parse(fs.readFileSync(`${out}.manifest.json`, 'utf8'));
  assert.equal(m.chain_verified, false);
  assert.equal(m.chain_break_index, 1);
  assert.equal(m.tip_record_hash, JSON.parse(lines[0]).record_hash);
});

test('include-preview: zn_payload_preview is the last field before zn_chain_index, and only when asked', (t) => {
  const { home } = setup(t, RECORDS);
  const plain = run(home, ['--format', 'timesketch']).stdout;
  assert.ok(!plain.includes('zn_payload_preview'));
  const lines = run(home, ['--format', 'timesketch', '--include-preview']).stdout.trim().split('\n');
  const first = JSON.parse(lines[0]);
  const keys = Object.keys(first);
  assert.equal(keys[keys.indexOf('zn_chain_index') - 1], 'zn_payload_preview');
  assert.equal(first.zn_payload_preview, 'first preview text');
  assert.ok(!('zn_payload_preview' in JSON.parse(lines[1])));
  const header = run(home, ['--format', 'timesketch-csv', '--include-preview']).stdout.split('\n')[0].split(',');
  assert.deepEqual(header.slice(-3), ['zn_payload_preview', 'zn_chain_index', 'zn_chain_verified']);
});
