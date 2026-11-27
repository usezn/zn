'use strict';
// evidence pack: the folder for auditors (evidence pack --out). Date range edges, refusals, a tampered
// log, manifest hashes, the payload preview, the control map wording, and the bytes of the records.
// Temporary folders and invented values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const PACK_FILES = ['records.jsonl', 'chain.json', 'summary.json', 'controls.md', 'README.txt'];
const GENESIS = '0'.repeat(64);
const DISCLAIMER = 'zn-gate does not make a system compliant, and this pack is not an attestation.';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Writes a ledger with the given timestamps. Each spec is the record's own fields; the chain is built
// here so the verifier accepts it (logEvidence always stamps the current time, which is not enough).
function buildLedger(file, specs) {
  let prev = GENESIS;
  const lines = [];
  specs.forEach((spec, i) => {
    const base = { id: `ev_test_${i}`, ...spec, prev_hash: prev };
    const hash = crypto.createHash('sha256').update(prev + ':' + JSON.stringify(base)).digest('hex');
    lines.push(JSON.stringify({ ...base, record_hash: hash }));
    prev = hash;
  });
  fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
  return lines;
}

const rec = (timestamp, extra = {}) => ({
  timestamp,
  agent_environment: 'agent-a',
  phase: 'tool-call',
  tool_name: 'shell',
  payload_sha256: '0'.repeat(64),
  payload_preview: 'preview text for ' + timestamp,
  verdict: 'allow',
  rule: null,
  reason: null,
  confidence: 1,
  latency_us: 3,
  engine: 'e',
  ...extra,
});

function setup(t, specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-pack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const log = path.join(home, 'evidence.jsonl');
  const lines = buildLedger(log, specs);
  return { dir, home, log, lines, out: path.join(dir, 'pack') };
}

function run(home, args) {
  return spawnSync(process.execPath, [CLI, 'evidence', ...args], {
    env: { ...process.env, ZN_HOME: home }, encoding: 'utf8', timeout: 60000,
  });
}

function readPack(out) {
  const files = {};
  for (const f of [...PACK_FILES, 'manifest.json']) files[f] = fs.readFileSync(path.join(out, f));
  return files;
}

const SPECS = [
  rec('2026-11-01T10:00:00.000Z', { verdict: 'allow', rule: null }),
  rec('2026-11-02T00:00:00.000Z', { verdict: 'deny', rule: 'R-SHELL-1', agent_environment: 'agent-b' }),
  rec('2026-11-03T23:59:59.999Z', { verdict: 'ask', rule: 'R-NET-2' }),
  rec('2026-11-04T00:00:00.000Z', { verdict: 'allow' }),
  rec('not a time', { verdict: 'deny', rule: 'R-UNDATED' }),
];

test('range: inclusive UTC days, undated records counted and left out of a range', (t) => {
  const s = setup(t, SPECS);
  const res = run(s.home, ['pack', '--out', s.out, '--since', '2026-11-02', '--until', '2026-11-03']);
  assert.equal(res.status, 0, res.stderr);
  const files = readPack(s.out);
  const lines = files['records.jsonl'].toString('utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const summary = JSON.parse(files['summary.json']);
  assert.deepEqual(summary.period, { since: '2026-11-02', until: '2026-11-03' });
  assert.equal(summary.records, 2);
  assert.equal(summary.undated, 1);
  assert.equal(summary.undated_included, false);
  assert.deepEqual(summary.verdicts, { ask: 1, deny: 1 });
  assert.deepEqual(summary.rules, { 'R-NET-2': 1, 'R-SHELL-1': 1 });
  assert.deepEqual(summary.agents, { 'agent-a': 1, 'agent-b': 1 });
  assert.equal(summary.first_timestamp, '2026-11-02T00:00:00.000Z');
  assert.equal(summary.last_timestamp, '2026-11-03T23:59:59.999Z');
  const chain = JSON.parse(files['chain.json']);
  assert.equal(chain.range_records, 2);
  assert.equal(chain.range_first.chain_index, 1);
  assert.equal(chain.range_last.chain_index, 2);
  assert.equal(chain.range_first.record_hash, JSON.parse(s.lines[1]).record_hash);
});

test('range: a single day gives that day only, and no range keeps undated records', (t) => {
  const s = setup(t, SPECS);
  assert.equal(run(s.home, ['pack', '--out', path.join(s.dir, 'day'), '--since', '2026-11-04', '--until', '2026-11-04']).status, 0);
  const day = JSON.parse(readPack(path.join(s.dir, 'day'))['summary.json']);
  assert.equal(day.records, 1);
  const all = run(s.home, ['pack', '--out', s.out]);
  assert.equal(all.status, 0, all.stderr);
  const summary = JSON.parse(readPack(s.out)['summary.json']);
  assert.equal(summary.records, 5);
  assert.equal(summary.undated, 1);
  assert.equal(summary.undated_included, true);
  assert.equal(summary.period.since, null);
  assert.equal(summary.period.until, null);
});

test('refused: a folder that is not empty, a file in its place, a bad date, since after until', (t) => {
  const s = setup(t, SPECS);
  fs.mkdirSync(s.out);
  fs.writeFileSync(path.join(s.out, 'keep.txt'), 'mine');
  const busy = run(s.home, ['pack', '--out', s.out]);
  assert.equal(busy.status, 2);
  assert.equal(busy.stderr.trim().split('\n').length, 1);
  assert.equal(fs.readFileSync(path.join(s.out, 'keep.txt'), 'utf8'), 'mine');
  assert.deepEqual(fs.readdirSync(s.out), ['keep.txt']);

  const asFile = path.join(s.dir, 'plain');
  fs.writeFileSync(asFile, 'x');
  assert.equal(run(s.home, ['pack', '--out', asFile]).status, 2);

  assert.equal(run(s.home, ['pack', '--out', path.join(s.dir, 'b1'), '--since', '2026-02-30']).status, 2);
  assert.equal(run(s.home, ['pack', '--out', path.join(s.dir, 'b2'), '--until', '2026-1-1']).status, 2);
  const inverted = run(s.home, ['pack', '--out', path.join(s.dir, 'b3'), '--since', '2026-11-05', '--until', '2026-11-01']);
  assert.equal(inverted.status, 2);
  assert.equal(fs.existsSync(path.join(s.dir, 'b3')), false);

  assert.equal(run(s.home, ['pack', '--out', path.join(s.dir, 'b4'), '--format', 'csv']).status, 2);
  assert.equal(run(s.home, ['pack']).status, 2);
});

test('tampered log: exit 1, the pack is still written, chain.json says so', (t) => {
  const s = setup(t, SPECS);
  const lines = fs.readFileSync(s.log, 'utf8').split('\n');
  lines[1] = lines[1].replace('R-SHELL-1', 'R-EDITED');
  fs.writeFileSync(s.log, lines.join('\n'));
  const res = run(s.home, ['pack', '--out', s.out]);
  assert.equal(res.status, 1);
  const chain = JSON.parse(readPack(s.out)['chain.json']);
  assert.equal(chain.verified, false);
  assert.equal(chain.break_index, 1);
  assert.match(chain.error, /Tamper detected|hash mismatch/);
  assert.ok(fs.existsSync(path.join(s.out, 'manifest.json')));
});

test('chain.json covers the whole log, even when the range is empty', (t) => {
  const s = setup(t, SPECS);
  assert.equal(run(s.home, ['pack', '--out', s.out, '--since', '2030-01-01']).status, 0);
  const chain = JSON.parse(readPack(s.out)['chain.json']);
  assert.equal(chain.records, 5);
  assert.equal(chain.verified, true);
  assert.equal(chain.range_records, 0);
  assert.equal(chain.range_first, null);
  assert.equal(chain.tip_record_hash, JSON.parse(s.lines[4]).record_hash);
});

test('manifest: every file hash and size matches, and manifest.json is written last', (t) => {
  const s = setup(t, SPECS);
  assert.equal(run(s.home, ['pack', '--out', s.out]).status, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(s.out, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.files), PACK_FILES);
  for (const f of PACK_FILES) {
    const buf = fs.readFileSync(path.join(s.out, f));
    assert.equal(manifest.files[f].sha256, sha256(buf), f);
    assert.equal(manifest.files[f].bytes, buf.length, f);
  }
  assert.match(manifest.generator, /^zn-gate /);
  assert.match(manifest.pack_time_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('payload_preview is left out by default and kept with --include-preview', (t) => {
  const s = setup(t, SPECS);
  assert.equal(run(s.home, ['pack', '--out', s.out]).status, 0);
  const plain = readPack(s.out)['records.jsonl'].toString('utf8');
  assert.equal(plain.includes('payload_preview'), false);
  assert.equal(plain.includes('preview text'), false);
  assert.equal(plain.trim().split('\n').length, 5);

  const withPreview = path.join(s.dir, 'with-preview');
  assert.equal(run(s.home, ['pack', '--out', withPreview, '--include-preview']).status, 0);
  const kept = fs.readFileSync(path.join(withPreview, 'records.jsonl'), 'utf8');
  assert.equal(kept, s.lines.join('\n') + '\n');
});

test('records with a preview are the log lines byte for byte with --include-preview', (t) => {
  const s = setup(t, SPECS);
  const out = path.join(s.dir, 'bytes');
  assert.equal(run(s.home, ['pack', '--out', out, '--include-preview', '--since', '2026-11-02', '--until', '2026-11-03']).status, 0);
  const kept = fs.readFileSync(path.join(out, 'records.jsonl'), 'utf8');
  assert.equal(kept, s.lines.slice(1, 3).join('\n') + '\n');
});

test('controls.md: the disclaimer is there, and no other compliance wording', (t) => {
  const s = setup(t, SPECS);
  assert.equal(run(s.home, ['pack', '--out', s.out]).status, 0);
  const text = fs.readFileSync(path.join(s.out, 'controls.md'), 'utf8');
  assert.ok(text.includes(DISCLAIMER));
  const rest = text.split(DISCLAIMER).join('');
  assert.equal(/compliant|compliance|certif|attest|SOC 2 ready/i.test(rest.replace(/this pack is not an attestation/gi, '')), false);
  for (const c of ['CC6.1', 'CC6.6', 'CC7.2', 'CC8.1']) assert.ok(text.includes(c), c);
});

test('an empty log gives an empty pack that verifies', (t) => {
  const s = setup(t, []);
  assert.equal(run(s.home, ['pack', '--out', s.out]).status, 0);
  const chain = JSON.parse(readPack(s.out)['chain.json']);
  assert.equal(chain.records, 0);
  assert.equal(chain.verified, true);
  assert.equal(readPack(s.out)['records.jsonl'].length, 0);
});

test('ocsf: records.ocsf.jsonl holds the same events as the ocsf export, no preview by default', (t) => {
  const s = setup(t, SPECS);
  const out = path.join(s.dir, 'ocsf');
  const res = run(s.home, ['pack', '--out', out, '--format', 'ocsf']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ['README.txt', 'chain.json', 'controls.md', 'manifest.json', 'records.ocsf.jsonl', 'summary.json']);
  const packed = fs.readFileSync(path.join(out, 'records.ocsf.jsonl'), 'utf8');
  const exported = run(s.home, ['--export', '--format', 'ocsf']);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(packed, exported.stdout);
  const first = JSON.parse(packed.split('\n')[0]);
  assert.equal(first.class_uid, 2004);
  assert.equal(first.unmapped.zn_chain_verified, true);
  assert.equal(packed.includes('payload_preview'), false);
  assert.equal(packed.includes('preview text'), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const body = fs.readFileSync(path.join(out, 'records.ocsf.jsonl'));
  assert.equal(manifest.files['records.ocsf.jsonl'].sha256, sha256(body));
});

test('ocsf with --include-preview and a range matches the export with the same preview option', (t) => {
  const s = setup(t, SPECS);
  const out = path.join(s.dir, 'ocsf-range');
  const res = run(s.home, ['pack', '--out', out, '--format', 'ocsf', '--include-preview', '--since', '2026-11-02', '--until', '2026-11-03']);
  assert.equal(res.status, 0, res.stderr);
  const packed = fs.readFileSync(path.join(out, 'records.ocsf.jsonl'), 'utf8');
  const exported = run(s.home, ['--export', '--format', 'ocsf', '--include-preview']);
  const wanted = exported.stdout.split('\n').slice(1, 3).join('\n') + '\n';
  assert.equal(packed, wanted);
  assert.ok(packed.includes('preview text for 2026-11-02'));
});

test('ocsf: a record after the break is not verified', (t) => {
  const s = setup(t, SPECS);
  const lines = fs.readFileSync(s.log, 'utf8').split('\n');
  lines[1] = lines[1].replace('R-SHELL-1', 'R-EDITED');
  fs.writeFileSync(s.log, lines.join('\n'));
  const out = path.join(s.dir, 'ocsf-tampered');
  assert.equal(run(s.home, ['pack', '--out', out, '--format', 'ocsf']).status, 1);
  const events = fs.readFileSync(path.join(out, 'records.ocsf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].unmapped.zn_chain_verified, true);
  for (const e of events.slice(1)) assert.equal(e.unmapped.zn_chain_verified, false);
});

test('refused: an unknown format names jsonl and ocsf', (t) => {
  const s = setup(t, SPECS);
  const res = run(s.home, ['pack', '--out', path.join(s.dir, 'x'), '--format', 'timesketch']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /jsonl or ocsf/);
});

test('controls.md: names the verdicts the log holds (allow and block), not deny or ask', (t) => {
  const s = setup(t, SPECS);
  assert.equal(run(s.home, ['pack', '--out', s.out]).status, 0);
  const text = fs.readFileSync(path.join(s.out, 'controls.md'), 'utf8');
  assert.ok(text.includes('The verdict is "allow" or "block".'));
  assert.equal(/"deny"|"ask"|deny and ask/.test(text), false);
});
