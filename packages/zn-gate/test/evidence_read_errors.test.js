'use strict';

// Read errors of the evidence log, and a second process that holds the writer lock. The error
// texts are checked and the log is left as it was. Everything runs in a temporary folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const EVIDENCE = require.resolve('../lib/evidence');

// A fresh module copy, so the once-per-interval warnings start over for every test.
function freshEvidence() {
  delete require.cache[EVIDENCE];
  return require('../lib/evidence');
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return out;
}

// A directory at the log path cannot be read as a file (EISDIR), also when the tests run as root.
function unreadableLog(t) {
  const dir = tmpDir(t);
  const file = path.join(dir, 'evidence.jsonl');
  fs.mkdirSync(file);
  return { dir, file };
}

test('getLastHash reports an unreadable log and does not start a new chain', (t) => {
  const { file } = unreadableLog(t);
  const ev = freshEvidence();
  assert.throws(() => ev.getLastHash(file), (e) => {
    assert.ok(e instanceof ev.EvidenceLedgerError);
    assert.equal(e.message, 'Cannot read the evidence log: EISDIR');
    return true;
  });
});

test('verify reports an unreadable log as invalid with the read error', (t) => {
  const { file } = unreadableLog(t);
  const ev = freshEvidence();
  assert.deepEqual(ev.verifyEvidenceLedger(file), {
    valid: false, total: 0, verified: 0, broken_index: 0, error: 'Cannot read the evidence log: EISDIR',
  });
});

test('stats and export of an unreadable log are not valid and carry no records', (t) => {
  const { file } = unreadableLog(t);
  const ev = freshEvidence();
  const stats = ev.getEvidenceStats(file);
  assert.equal(stats.valid, false);
  assert.equal(stats.total, 0);
  assert.deepEqual(stats.recent, []);
  const exp = ev.exportEvidenceLedger(file, 'jsonl');
  assert.equal(exp.valid, false);
  assert.equal(exp.total, 0);
  assert.equal(exp.content.trim(), '');
});

test('logEvidence skips the write for an unreadable log, warns and leaves it alone', (t) => {
  const { dir, file } = unreadableLog(t);
  const ev = freshEvidence();
  let r;
  const err = captureStderr(() => { r = ev.logEvidence({ payload: 'example', tool_name: 'bash' }, file); });
  assert.equal(r, null);
  assert.match(err, /cannot write to the evidence log|is damaged/);
  assert.ok(err.includes('EISDIR'), err);
  assert.ok(fs.statSync(file).isDirectory(), 'the log path is not replaced');
  assert.deepEqual(fs.readdirSync(file), []);
  assert.deepEqual(fs.readdirSync(dir), ['evidence.jsonl'], 'no lock file is left behind');
});

// A second process that really holds the lock: it creates the lock file with its own token and
// keeps running until the test closes its input.
function holdLockInOtherProcess(lockPath) {
  const code = [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(lockPath)}, process.pid + ':otherwriter', { flag: 'wx' });`,
    "process.stdout.write('held\\n');",
    "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (c) => reject(new Error(`holder exited early: ${c}`)));
    child.stdout.once('data', () => { child.removeAllListeners('exit'); resolve(); });
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.stdin.end();
  });
  return { ready, stop, pid: child.pid };
}

test('a second process holding the writer lock makes the write skip and the log stays as it was', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'evidence.jsonl');
  const ev = freshEvidence();
  assert.ok(ev.logEvidence({ payload: 'example-0', tool_name: 'bash' }, file));
  const before = fs.readFileSync(file);

  const lock = file + '.lock';
  const holder = holdLockInOtherProcess(lock);
  t.after(() => holder.stop());
  await holder.ready;
  const token = fs.readFileSync(lock, 'utf8');

  const fresh = freshEvidence();
  let r;
  const t0 = Date.now();
  const err = captureStderr(() => { r = fresh.logEvidence({ payload: 'example-1', tool_name: 'bash' }, file, { lockWaitMs: 150 }); });
  const waited = Date.now() - t0;

  assert.equal(r, null);
  assert.ok(waited >= 100 && waited < 3000, `waited ${waited} ms`);
  assert.ok(err.includes(`cannot write to the evidence log ${file} (another process is writing to the log)`), err);
  assert.ok(err.includes('the log is left as it is'), err);
  assert.ok(fs.readFileSync(file).equals(before), 'the log is unchanged');
  assert.equal(fs.readFileSync(lock, 'utf8'), token, 'the other process keeps its lock');
  assert.equal(fresh.verifyEvidenceLedger(file).valid, true);

  await holder.stop();
  fs.unlinkSync(lock);
  const next = fresh.logEvidence({ payload: 'example-2', tool_name: 'bash' }, file);
  assert.ok(next && next.record_hash, 'writing works again once the lock is free');
  assert.equal(fresh.verifyEvidenceLedger(file).total, 2);
});

test('reading the log does not need the writer lock', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'evidence.jsonl');
  const ev = freshEvidence();
  ev.logEvidence({ payload: 'example-0', tool_name: 'bash' }, file);
  const holder = holdLockInOtherProcess(file + '.lock');
  t.after(() => holder.stop());
  await holder.ready;
  assert.equal(ev.verifyEvidenceLedger(file).valid, true);
  assert.equal(ev.getEvidenceStats(file).total, 1);
  assert.match(ev.getLastHash(file), /^[0-9a-f]{64}$/);
});
