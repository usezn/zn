'use strict';

// The tip anchor: evidence.tip next to the log, written after each append, checked by verify.
// Fake values only; every test uses its own folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const ev = require('../lib/evidence');

const { logEvidence, verifyEvidenceLedger, acceptEvidenceTip, readTip, tipPathOf, getEvidenceStats, exportEvidenceLedger } = ev;
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const EVIDENCE_JS = path.join(__dirname, '..', 'lib', 'evidence.js');
const PY_SRC = path.join(__dirname, '..', '..', 'zn-gate-py', 'src');

function dir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-tip-'));
}
function append(file, n, label = 'e') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = logEvidence({ agent: 'test-agent', tool_name: 'bash', payload: `${label}-${i}`, verdict: 'allow' }, file);
    assert.ok(r, 'append must succeed');
    out.push(r);
  }
  return out;
}
function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}
function cutLast(file, n) {
  const l = lines(file);
  fs.writeFileSync(file, l.slice(0, l.length - n).join('\n') + '\n');
}
function setup(n) {
  const d = dir();
  const file = path.join(d, 'evidence.jsonl');
  const recs = append(file, n);
  return { d, file, recs, tipFile: path.join(d, 'evidence.tip') };
}
function cli(home, args, extraEnv = {}) {
  const env = { ...process.env, ZN_HOME: home, ZN_STATS: 'off', NO_COLOR: '1', ...extraEnv };
  for (const k of ['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CURSOR_AGENT', 'OPENCODE', 'ZN_AGENT']) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

test('every append moves the tip: count and hash of the last record', () => {
  const { file, recs, tipFile } = setup(3);
  assert.equal(tipPathOf(file), tipFile);
  const tip = JSON.parse(fs.readFileSync(tipFile, 'utf8'));
  assert.equal(tip.v, 1);
  assert.equal(tip.count, 3);
  assert.equal(tip.tip_hash, recs[2].record_hash);
  assert.match(tip.ts, /^\d{4}-\d\d-\d\dT/);
  append(file, 1, 'more');
  assert.equal(readTip(file).count, 4);
  const v = verifyEvidenceLedger(file);
  assert.equal(v.valid, true);
  assert.equal(v.anchored, true);
  assert.equal(v.truncated, false);
  assert.equal(v.tip.count, 4);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-')), [], 'no temporary tip file is left');
});

test('removing the last record is reported as truncated, with the exact message', () => {
  const { file } = setup(5);
  cutLast(file, 1);
  const v = verifyEvidenceLedger(file);
  assert.equal(v.valid, false);
  assert.equal(v.truncated, true);
  assert.equal(v.total, 4);
  assert.equal(v.error, 'LOG TRUNCATED: 4 records found, the last tip expects at least 5');
  assert.equal(v.tip.count, 5);
});

test('removing many records is reported as truncated', () => {
  const { file } = setup(8);
  cutLast(file, 6);
  const v = verifyEvidenceLedger(file);
  assert.equal(v.truncated, true);
  assert.equal(v.error, 'LOG TRUNCATED: 2 records found, the last tip expects at least 8');
});

test('a missing log with a tip is truncated; a missing log without a tip is fine', () => {
  const { file } = setup(2);
  fs.unlinkSync(file);
  const v = verifyEvidenceLedger(file);
  assert.equal(v.valid, false);
  assert.equal(v.truncated, true);
  assert.equal(v.total, 0);
  const stats = getEvidenceStats(file);
  assert.equal(stats.valid, false);
  assert.equal(stats.truncated, true);
  const exp = exportEvidenceLedger(file, 'jsonl');
  assert.equal(exp.valid, false);
  assert.equal(exp.truncated, true);

  const clean = path.join(dir(), 'evidence.jsonl');
  const ok = verifyEvidenceLedger(clean);
  assert.equal(ok.valid, true);
  assert.equal(ok.anchored, false);
  assert.equal(ok.tip, null);
});

test('with no tip the log verifies and says it is not anchored', () => {
  const { file, tipFile } = setup(3);
  fs.unlinkSync(tipFile);
  cutLast(file, 1);
  const v = verifyEvidenceLedger(file);
  assert.equal(v.valid, true);
  assert.equal(v.anchored, false);
  assert.equal(v.truncated, false);
  assert.equal(fs.existsSync(tipFile), false, 'verify never creates the tip');
});

test('a tip that is edited to point past the end is truncated; a changed hash is rewritten', () => {
  const { file, tipFile } = setup(4);
  const tip = JSON.parse(fs.readFileSync(tipFile, 'utf8'));
  fs.writeFileSync(tipFile, JSON.stringify({ ...tip, count: 9 }));
  assert.equal(verifyEvidenceLedger(file).truncated, true);
  fs.writeFileSync(tipFile, JSON.stringify({ ...tip, tip_hash: 'a'.repeat(64) }));
  const v = verifyEvidenceLedger(file);
  assert.equal(v.valid, false);
  assert.equal(v.rewritten, true);
  assert.equal(v.truncated, false);
  assert.equal(v.error, 'LOG REWRITTEN: record 4 differs from the tip');
});

test('replacing the log by another valid chain of the same length is reported as rewritten', () => {
  const a = setup(4);
  const other = path.join(dir(), 'evidence.jsonl');
  append(other, 4, 'other');
  assert.equal(verifyEvidenceLedger(other).valid, true);
  fs.copyFileSync(other, a.file);
  const v = verifyEvidenceLedger(a.file);
  assert.equal(v.valid, false);
  assert.equal(v.rewritten, true);
});

test('records after the tip are fine, as long as the tip is still where it was', () => {
  const { file, tipFile, recs } = setup(5);
  fs.writeFileSync(tipFile, JSON.stringify({ v: 1, count: 3, tip_hash: recs[2].record_hash, ts: new Date().toISOString() }));
  const v = verifyEvidenceLedger(file);
  assert.equal(v.valid, true);
  assert.equal(v.anchored, true);
  assert.equal(v.total, 5);
});

test('a malformed tip file counts as no tip', () => {
  const { file, tipFile } = setup(2);
  for (const bad of ['', 'not json', '{"v":1}', '{"v":2,"count":1,"tip_hash":"' + 'a'.repeat(64) + '"}', '{"v":1,"count":-1,"tip_hash":"' + 'a'.repeat(64) + '"}']) {
    fs.writeFileSync(tipFile, bad);
    const v = verifyEvidenceLedger(file);
    assert.equal(v.valid, true);
    assert.equal(v.anchored, false);
  }
});

test('migration: a log without a tip is anchored once by the next append', () => {
  const { file, tipFile } = setup(3);
  fs.unlinkSync(tipFile);
  assert.equal(readTip(file), null);
  append(file, 1, 'after');
  const tip = readTip(file);
  assert.equal(tip.count, 4);
  assert.equal(verifyEvidenceLedger(file).anchored, true);
});

test('crash lag: a tip one record behind verifies, and the next append catches it up', () => {
  const { file, tipFile, recs } = setup(4);
  fs.writeFileSync(tipFile, JSON.stringify({ v: 1, count: 3, tip_hash: recs[2].record_hash, ts: new Date().toISOString() }));
  assert.equal(verifyEvidenceLedger(file).valid, true);
  append(file, 1, 'next');
  const tip = readTip(file);
  assert.equal(tip.count, 5);
  assert.equal(tip.tip_hash, JSON.parse(lines(file).pop()).record_hash);
});

test('a gap left by an older writer (no tip updates) is recovered from the tail window', () => {
  const { file, tipFile } = setup(2);
  const old = fs.readFileSync(tipFile, 'utf8');
  append(file, 4, 'gap');
  fs.writeFileSync(tipFile, old);
  assert.equal(readTip(file).count, 2);
  assert.equal(verifyEvidenceLedger(file).valid, true);
  append(file, 1, 'new');
  assert.equal(readTip(file).count, 7);
  assert.equal(verifyEvidenceLedger(file).valid, true);
});

test('a diverged tip is not moved by a writer, which keeps appending', () => {
  const { file, tipFile } = setup(5);
  const before = fs.readFileSync(tipFile, 'utf8');
  cutLast(file, 2);
  const r = logEvidence({ agent: 'a', tool_name: 'bash', payload: 'x', verdict: 'allow' }, file);
  assert.ok(r, 'a truncated log keeps being written');
  assert.equal(lines(file).length, 4);
  assert.equal(fs.readFileSync(tipFile, 'utf8'), before, 'the tip stays where it was');
  assert.equal(verifyEvidenceLedger(file).truncated, true);
});

test('writers on a truncated log warn at most once in the 5 minute window', () => {
  const { file } = setup(4);
  cutLast(file, 2);
  const script = `
const { logEvidence } = require(process.argv[1]);
for (let i = 0; i < 4; i++) logEvidence({ agent: 'a', tool_name: 'bash', payload: 'p' + i, verdict: 'allow' }, process.argv[2]);
`;
  const r = spawnSync(process.execPath, ['-e', script, EVIDENCE_JS, file], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const warnings = r.stderr.split('\n').filter((l) => l.includes('does not match its last tip'));
  assert.equal(warnings.length, 1, r.stderr);
  assert.equal(lines(file).length, 2 + 4);
});

test('a tip that cannot be written never fails the append', () => {
  const d = dir();
  const file = path.join(d, 'evidence.jsonl');
  fs.mkdirSync(path.join(d, 'evidence.tip'));
  fs.writeFileSync(path.join(d, 'evidence.tip', 'keep'), 'x');
  const script = `
const { logEvidence } = require(process.argv[1]);
const r = logEvidence({ agent: 'a', tool_name: 'bash', payload: 'p', verdict: 'allow' }, process.argv[2]);
process.exit(r ? 0 : 3);
`;
  const r = spawnSync(process.execPath, ['-e', script, EVIDENCE_JS, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(file).length, 1);
  assert.match(r.stderr, /cannot update the evidence tip/);
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes('.tmp-')), []);
});

const PER = 60;
const WRITER = `
const { logEvidence } = require(process.argv[1]);
const [file, id, n] = [process.argv[2], process.argv[3], Number(process.argv[4])];
for (let i = 0; i < n; i++) {
  if (!logEvidence({ agent: 'a', tool_name: 'bash', payload: id + i, verdict: 'allow' }, file)) process.exit(3);
}
`;
function runWriter(id, file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', WRITER, EVIDENCE_JS, file, id, String(PER)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, err }));
  });
}

test('two writer processes keep tip == last record', async () => {
  const d = dir();
  const file = path.join(d, 'evidence.jsonl');
  const res = await Promise.all([runWriter('a', file), runWriter('b', file)]);
  for (const r of res) assert.equal(r.code, 0, r.err);
  const tip = readTip(file);
  assert.equal(tip.count, 2 * PER);
  assert.equal(tip.tip_hash, JSON.parse(lines(file).pop()).record_hash);
  const v = verifyEvidenceLedger(file);
  assert.equal(v.valid, true);
  assert.equal(v.anchored, true);
});

const PY = spawnSync('python3', ['--version']);
const pyTest = PY.status === 0 ? test : test.skip;

function py(code, file) {
  return spawnSync('python3', ['-c', code, file], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: PY_SRC, ZN_STATS: 'off', ZN_HOME: path.dirname(file) } });
}

pyTest('Node writes, Python verifies; Python writes, Node verifies, on one log', () => {
  const d = dir();
  const file = path.join(d, 'evidence.jsonl');
  append(file, 2, 'node');
  const w = py('import sys\nfrom zn_gate.evidence import log_evidence\nfor i in range(2):\n    assert log_evidence({"agent":"py","tool_name":"bash","payload":"p%d" % i}, sys.argv[1])\n', file);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(readTip(file).count, 4, 'Node reads the tip Python wrote');
  assert.equal(verifyEvidenceLedger(file).anchored, true);
  append(file, 1, 'node2');
  const v = py('import sys, json\nfrom zn_gate.evidence import verify_evidence_ledger\nr = verify_evidence_ledger(sys.argv[1])\nprint(json.dumps(r))\n', file);
  assert.equal(v.status, 0, v.stderr);
  const r = JSON.parse(v.stdout);
  assert.equal(r.valid, true);
  assert.equal(r.anchored, true);
  assert.equal(r.tip.count, 5);
  cutLast(file, 1);
  const t = JSON.parse(py('import sys, json\nfrom zn_gate.evidence import verify_evidence_ledger\nprint(json.dumps(verify_evidence_ledger(sys.argv[1])))\n', file).stdout);
  assert.equal(t.truncated, true);
  assert.equal(t.error, verifyEvidenceLedger(file).error, 'both packages give the same message');
});

test('evidence --verify: truncated and rewritten exit 1 with the messages, anchored and unanchored exit 0', () => {
  const { d, file, tipFile } = setup(5);
  let r = cli(d, ['evidence', '--verify']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /HASH CHAIN VERIFIED, no truncation found against the last tip/);
  assert.doesNotMatch(r.stdout, /IMMUTABLE/);

  const tip = fs.readFileSync(tipFile, 'utf8');
  fs.unlinkSync(tipFile);
  r = cli(d, ['evidence', '--verify']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Not anchored yet: removal of the last records cannot be detected until the next event\./);
  fs.writeFileSync(tipFile, tip);

  cutLast(file, 1);
  r = cli(d, ['evidence', '--verify']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LOG TRUNCATED: 4 records found, the last tip expects at least 5/);
  assert.match(r.stdout, /Keep a copy of both files\. To accept the log as it is now, run `zn-gate evidence --accept` in your own terminal\./);

  fs.writeFileSync(tipFile, JSON.stringify({ ...JSON.parse(tip), count: 2, tip_hash: 'b'.repeat(64) }));
  r = cli(d, ['evidence', '--verify']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LOG REWRITTEN: record 2 differs from the tip/);
});

test('evidence --export of a truncated log says so on stderr', () => {
  const { d, file } = setup(3);
  cutLast(file, 1);
  const r = cli(d, ['evidence', '--export']);
  assert.match(r.stderr, /Evidence log problem: LOG TRUNCATED/);
  assert.equal(exportEvidenceLedger(file).truncated, true);
  assert.equal(getEvidenceStats(file).truncated, true);
});

test('evidence --accept refuses without a person at a terminal and changes nothing', () => {
  const { d, file, tipFile } = setup(4);
  cutLast(file, 1);
  const before = fs.readFileSync(tipFile, 'utf8');
  const r = cli(d, ['evidence', '--accept']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /evidence --accept (needs an interactive terminal|must be run by you)/);
  assert.equal(fs.readFileSync(tipFile, 'utf8'), before);
  assert.equal(verifyEvidenceLedger(file).truncated, true);
  assert.throws(() => acceptEvidenceTip(file, { stdin: { isTTY: false }, env: {}, ancestry: () => null }), /interactive terminal/);
  assert.throws(() => acceptEvidenceTip(file, { stdin: { isTTY: true }, env: { CLAUDECODE: '1' } }), /not by an AI agent/);
  assert.equal(fs.readFileSync(tipFile, 'utf8'), before);
});

test('accepting re-anchors to the current end and keeps the old tip as previous', () => {
  const { file, tipFile } = setup(5);
  const old = readTip(file);
  cutLast(file, 2);
  const done = acceptEvidenceTip(file, { human: true });
  assert.equal(done.count, 3);
  const tip = readTip(file);
  assert.equal(tip.count, 3);
  assert.deepEqual({ count: tip.previous.count, tip_hash: tip.previous.tip_hash }, { count: 5, tip_hash: old.tip_hash });
  const v = verifyEvidenceLedger(file);
  assert.equal(v.valid, true);
  assert.equal(v.tip.previous.count, 5);
  // The next append keeps the previous tip visible.
  append(file, 1, 'again');
  assert.equal(readTip(file).previous.count, 5);
  assert.ok(fs.existsSync(tipFile));
});

test('an empty or archived log is accepted at zero, and a damaged chain is not accepted', () => {
  const { file } = setup(3);
  fs.unlinkSync(file);
  const done = acceptEvidenceTip(file, { human: true });
  assert.equal(done.count, 0);
  assert.equal(verifyEvidenceLedger(file).valid, true);
  append(file, 1, 'fresh');
  assert.equal(readTip(file).count, 1);

  const bad = setup(3);
  const l = lines(bad.file);
  l[1] = l[1].replace('"verdict":"allow"', '"verdict":"block"');
  fs.writeFileSync(bad.file, l.join('\n') + '\n');
  assert.throws(() => acceptEvidenceTip(bad.file, { human: true }), /cannot be accepted/);
});
