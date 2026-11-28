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
  { agent: 'agent-a', phase: 'tool-call', tool_name: 'shell', verdict: 'block', rule: 'zn_state', engine: 'e', latency_us: 7 },
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
  lines[1] = lines[1].replace('"verdict":"block"', '"verdict":"allow"');
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

const FORMULA_RECORDS = [
  { agent: 'agent-a', phase: 'tool-call', tool_name: '=HYPERLINK("http://example.invalid")', verdict: 'allow', engine: 'e', latency_us: 7 },
  { agent: '@agent', phase: 'tool-call', tool_name: '-2+3', verdict: 'block', rule: '+rule', engine: 'e', latency_us: 7 },
  { agent: 'agent-a', phase: 'tool-call', tool_name: 'plain', verdict: 'allow', engine: 'e', latency_us: 7 },
];

test('csv and timesketch-csv: a cell that starts with = + - or @ gets a single quote', (t) => {
  const { home } = setup(t, FORMULA_RECORDS);
  const csv = run(home, ['--format', 'csv']).stdout.split('\n');
  assert.ok(csv[1].includes(`"'=HYPERLINK(""http://example.invalid"")"`), csv[1]);
  assert.ok(csv[2].includes(`"'-2+3"`) && csv[2].includes(`"'+rule"`), csv[2]);
  assert.ok(csv[3].includes('"plain"') && !csv[3].includes(`"'`), csv[3]);
  const ts = run(home, ['--format', 'timesketch-csv']).stdout;
  assert.ok(ts.includes(`"'=HYPERLINK(""http://example.invalid"")`), ts);
  for (const line of ts.split('\n').slice(1)) {
    for (const cell of line.match(/"(?:[^"]|"")*"/g) || []) assert.ok(!/^"[=+\-@\t\r]/.test(cell), cell);
  }
  // a tab at the start is guarded too
  const { home: home2 } = setup(t, [{ agent: 'a', phase: 'p', tool_name: '\tcmd', verdict: 'allow', engine: 'e' }]);
  assert.ok(run(home2, ['--format', 'csv']).stdout.includes(`"'\tcmd"`));
});

test('manifest: refuses an existing manifest path, writes nothing, exit 2', (t) => {
  const { dir, home } = setup(t, RECORDS);
  const out = path.join(dir, 'out.jsonl');
  fs.writeFileSync(`${out}.manifest.json`, 'keep me');
  const r = run(home, ['--output', out, '--manifest']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /manifest\.json already exists or is a link; --manifest does not overwrite it/);
  assert.equal(fs.readFileSync(`${out}.manifest.json`, 'utf8'), 'keep me');
  assert.equal(fs.existsSync(out), false, 'the export is not written either');
});

test('manifest: refuses a symlink (a dangling one too) and does not write through it', { skip: process.platform === 'win32' }, (t) => {
  const { dir, home } = setup(t, RECORDS);
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'keep me');
  const out = path.join(dir, 'out.jsonl');
  fs.symlinkSync(victim, `${out}.manifest.json`);
  let r = run(home, ['--output', out, '--manifest']);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
  fs.unlinkSync(`${out}.manifest.json`);
  const target = path.join(dir, 'not-there.txt');
  fs.symlinkSync(target, `${out}.manifest.json`);
  r = run(home, ['--output', out, '--manifest']);
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(target), false);
});

test('manifest: describes the log as the export saw it, not as it is when the manifest is written', (t) => {
  const { home, log, dir } = setup(t, RECORDS);
  const before = fs.readFileSync(log, 'utf8').trim().split('\n');
  // Preloaded into the CLI: appends a record to the log right before the export file is hashed.
  const hook = path.join(dir, 'append-hook.js');
  fs.writeFileSync(hook, `
const lib = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib', 'evidence_export'))});
const real = lib.sha256File;
lib.sha256File = (p) => { require('fs').appendFileSync(${JSON.stringify(log)}, '{"id":"late","timestamp":"2026-11-27T00:00:00.000Z"}\\n'); return real(p); };
`);
  const out = path.join(dir, 'out.jsonl');
  const r = spawnSync(process.execPath, ['--require', hook, CLI, 'evidence', '--export', '--output', out, '--manifest'], {
    env: { ...process.env, ZN_HOME: home }, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  const manifest = JSON.parse(fs.readFileSync(`${out}.manifest.json`, 'utf8'));
  assert.equal(manifest.records, 2);
  assert.equal(manifest.chain_verified, true);
  assert.equal(manifest.tip_record_hash, JSON.parse(before[before.length - 1]).record_hash);
});
