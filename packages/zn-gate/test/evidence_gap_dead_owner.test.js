'use strict';
// A writer that died holding the ledger lock is broken at once (same machine, pid gone); a live owner is still
// waited for. A write dropped because the lock stayed busy is counted, and the next write says so in the log.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const ev = require('../lib/evidence');
const runner = require('../lib/hooks/runner');

const EVENT = { agent: 'a', tool_name: 't', verdict: 'block', rule: 'R', payload: 'x', phase: 'p' };

function ledgerIn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-gap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'evidence.jsonl');
}

function hostTag() {
  return crypto.createHash('sha256').update(os.hostname().toLowerCase()).digest('hex').slice(0, 8);
}

// The pid of a process that has already exited.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

function tokenOf(pid, host = hostTag()) {
  return `${pid}:${crypto.randomBytes(8).toString('hex')}:${host}`;
}

function quiet(t) {
  const real = process.stderr.write;
  process.stderr.write = () => true;
  t.after(() => { process.stderr.write = real; });
}

test('a lock whose owner process is gone is broken at once', (t) => {
  quiet(t);
  const ledger = ledgerIn(t);
  fs.writeFileSync(ledger + '.lock', tokenOf(deadPid()));
  const started = Date.now();
  const rec = ev.logEvidence(EVENT, ledger, { lockWaitMs: 5000, noStats: true });
  assert.ok(rec && rec.record_hash, 'the record was written');
  assert.ok(Date.now() - started < 1500, 'no wait for the 10 s stale window');
  assert.equal(fs.existsSync(ledger + '.lock'), false);
  assert.equal(fs.existsSync(ledger + '.lock.break'), false);
  assert.equal(ev.verifyEvidenceLedger(ledger).valid, true);
});

test('a lock whose owner is alive is still waited for, and the event is counted as dropped', async (t) => {
  quiet(t);
  const ledger = ledgerIn(t);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  fs.writeFileSync(ledger + '.lock', tokenOf(child.pid));
  const rec = ev.logEvidence(EVENT, ledger, { lockWaitMs: 200, noStats: true });
  assert.equal(rec, null);
  assert.equal(fs.existsSync(ledger), false, 'nothing was written');
  assert.ok(fs.existsSync(ledger + '.lock'), 'the live owner keeps its lock');
});

test('doubt keeps the wait: EPERM, another machine, another token format, the own pid', (t) => {
  const ledger = ledgerIn(t);
  const lock = ledger + '.lock';
  const dead = deadPid();
  fs.writeFileSync(lock, tokenOf(dead));
  assert.ok(ev._deadOwnerToken(lock), 'control: this one is dead');
  const kill = t.mock.method(process, 'kill', () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; });
  assert.equal(ev._deadOwnerToken(lock), null, 'EPERM means alive but not ours');
  kill.mock.restore();
  fs.writeFileSync(lock, tokenOf(dead, '0'.repeat(8) === hostTag() ? 'f'.repeat(8) : '0'.repeat(8)));
  assert.equal(ev._deadOwnerToken(lock), null, 'a pid of another machine means nothing here');
  fs.writeFileSync(lock, `${dead}:abc`);
  assert.equal(ev._deadOwnerToken(lock), null, 'an older token has no machine part');
  fs.writeFileSync(lock, tokenOf(process.pid));
  assert.equal(ev._deadOwnerToken(lock), null);
  fs.writeFileSync(lock, '');
  assert.equal(ev._deadOwnerToken(lock), null);
});

test('dropped writes are counted without content and the next write adds a gap record that verify shows', (t) => {
  quiet(t);
  const ledger = ledgerIn(t);
  ev.logEvidence(EVENT, ledger, { noStats: true });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  fs.writeFileSync(ledger + '.lock', tokenOf(child.pid));
  for (let i = 0; i < 3; i++) assert.equal(ev.logEvidence({ ...EVENT, payload: 'secret-looking text ' + i }, ledger, { lockWaitMs: 20, noStats: true }), null);
  const counter = fs.readFileSync(ledger + '.dropped', 'utf8');
  assert.equal(counter, 'xxx', 'only a count, never content');
  if (process.platform !== 'win32') assert.equal(fs.statSync(ledger + '.dropped').mode & 0o777, 0o600);
  // The log is still valid, and verify already says that events were dropped.
  const before = ev.verifyEvidenceLedger(ledger);
  assert.equal(before.valid, true);
  assert.deepEqual(before.gaps, { markers: 0, events: 0, pending: 3 });
  child.kill();
  fs.unlinkSync(ledger + '.lock');
  const rec = ev.logEvidence({ ...EVENT, payload: 'after' }, ledger, { noStats: true });
  assert.ok(rec);
  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[1].rule, 'evidence-gap');
  assert.equal(lines[1].reason, '3 events were not recorded (log busy)');
  assert.equal(lines[2].prev_hash, lines[1].record_hash, 'the gap record is part of the chain');
  assert.equal(fs.existsSync(ledger + '.dropped'), false);
  const after = ev.verifyEvidenceLedger(ledger);
  assert.equal(after.valid, true);
  assert.deepEqual(after.gaps, { markers: 1, events: 3, pending: 0 });
  // A ledger without gaps reports none.
  const clean = ledgerIn(t);
  ev.logEvidence(EVENT, clean, { noStats: true });
  assert.equal(ev.verifyEvidenceLedger(clean).gaps, undefined);
});

test('one dropped event reads as one event', (t) => {
  const ledger = ledgerIn(t);
  ev.noteDropped(ledger, 1);
  assert.ok(ev.logEvidence(EVENT, ledger, { noStats: true }));
  const first = JSON.parse(fs.readFileSync(ledger, 'utf8').split('\n')[0]);
  assert.equal(first.reason, '1 event was not recorded (log busy)');
  assert.deepEqual(ev.verifyEvidenceLedger(ledger).gaps, { markers: 1, events: 1, pending: 0 });
});

test('a write that fails after the counter was taken gives the count back', (t) => {
  quiet(t);
  const ledger = ledgerIn(t);
  ev.noteDropped(ledger, 4);
  const rec = ev.logEvidence(EVENT, ledger, {
    noStats: true,
    _beforeAppend() { throw new Error('simulated failure'); },
  });
  assert.equal(rec, null);
  assert.equal(fs.readFileSync(ledger + '.dropped', 'utf8'), 'xxxx');
  assert.deepEqual(fs.readdirSync(path.dirname(ledger)).filter((n) => n.includes('.taking-')), []);
  assert.ok(ev.logEvidence(EVENT, ledger, { noStats: true }));
  assert.deepEqual(ev.verifyEvidenceLedger(ledger).gaps, { markers: 1, events: 4, pending: 0 });
});

test('the hook waits up to 2 s for the lock, less when its time is nearly used up', (t) => {
  assert.equal(runner.evidenceWaitMs('claude-code'), 2000);
  // Close to the supervisor deadline (hook timeout minus 4 s, 15 s for Claude Code): nothing left to wait with.
  t.mock.method(process, 'uptime', () => 10.5);
  assert.equal(runner.evidenceWaitMs('claude-code'), 0);
  t.mock.method(process, 'uptime', () => 9.5);
  assert.equal(runner.evidenceWaitMs('claude-code'), 500);
});
