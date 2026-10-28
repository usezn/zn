'use strict';
// A full disk while the ledger lock is created must not leave an empty lock behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logEvidence } = require('../lib/evidence');

test('a failed write of the lock token removes the lock and the next write is not delayed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, 'evidence.jsonl');
  const lock = ledger + '.lock';
  const realWrite = fs.writeSync;
  const stderr = process.stderr.write;
  let seen = '';
  process.stderr.write = (chunk) => { seen += chunk; return true; };
  const writeMock = t.mock.method(fs, 'writeSync', function (fd, ...rest) {
    const err = new Error('ENOSPC: no space left on device, write');
    err.code = 'ENOSPC';
    throw err;
  });
  try {
    assert.equal(logEvidence({ agent: 'a', tool_name: 't', verdict: 'block', rule: 'R' }, ledger, { lockWaitMs: 50 }), null);
  } finally {
    process.stderr.write = stderr;
    writeMock.mock.restore();
  }
  assert.ok(seen.includes('ENOSPC'), seen);
  assert.ok(!seen.includes('another process'), seen);
  assert.equal(fs.existsSync(lock), false, 'the empty lock file must not stay behind');
  const started = Date.now();
  const rec = logEvidence({ agent: 'a', tool_name: 't', verdict: 'block', rule: 'R' }, ledger, { lockWaitMs: 2000 });
  assert.ok(rec && rec.record_hash);
  assert.ok(Date.now() - started < 1000);
  assert.equal(typeof realWrite, 'function');
});

// The lock is removed whatever goes wrong while its token is written: a short write, or a close that fails.
for (const [name, mock] of [
  ['a short write of the lock token', (t) => t.mock.method(fs, 'writeSync', () => 3)],
  ['a close of the lock file that fails', (t) => t.mock.method(fs, 'closeSync', () => { const e = new Error('EIO: i/o error, close'); e.code = 'EIO'; throw e; })],
]) {
  test(name + ' removes the lock and the next write is not delayed', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-lock-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ledger = path.join(dir, 'evidence.jsonl');
    const stderr = process.stderr.write;
    process.stderr.write = () => true;
    const m = mock(t);
    try {
      assert.equal(logEvidence({ agent: 'a', tool_name: 't', verdict: 'block', rule: 'R' }, ledger, { lockWaitMs: 50 }), null);
    } finally {
      process.stderr.write = stderr;
      m.mock.restore();
    }
    assert.equal(fs.existsSync(ledger + '.lock'), false, 'the lock file must not stay behind');
    const started = Date.now();
    const rec = logEvidence({ agent: 'a', tool_name: 't', verdict: 'block', rule: 'R' }, ledger, { lockWaitMs: 2000 });
    assert.ok(rec && rec.record_hash);
    assert.ok(Date.now() - started < 1000);
  });
}
