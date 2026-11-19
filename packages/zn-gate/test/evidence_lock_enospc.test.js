'use strict';

// A full disk while a breaker writes its token into the `<log>.lock.break` mutex must not leave
// an empty mutex behind: the next attempt to break a stale lock has to work at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logEvidence } = require('../lib/evidence');

test('ENOSPC on the break mutex token removes the mutex and the next break works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-enospc-'));
  try {
    const file = path.join(dir, 'evidence.jsonl');
    const lock = `${file}.lock`;
    const mutex = `${lock}.break`;

    // A stale lock (owner gone, mtime an hour old) that a writer must break.
    fs.writeFileSync(lock, '999999:deadbeef');
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(lock, old, old);

    // The first writeSync of the attempt is the token write into the break mutex.
    const realWriteSync = fs.writeSync;
    let failures = 1;
    fs.writeSync = function (...args) {
      if (failures > 0) {
        failures -= 1;
        const err = new Error('ENOSPC: no space left on device, write');
        err.code = 'ENOSPC';
        err.errno = -28;
        throw err;
      }
      return realWriteSync.apply(this, args);
    };
    let first;
    try {
      first = logEvidence({ payload: 'example', tool_name: 'bash', verdict: 'ALLOW' }, file);
    } finally {
      fs.writeSync = realWriteSync;
    }

    assert.equal(first, null, 'the write is skipped with a disk error');
    assert.equal(failures, 0);
    assert.equal(fs.existsSync(mutex), false, 'no empty break mutex is left behind');
    assert.equal(fs.existsSync(lock), true, 'the stale lock is not touched when the break fails');

    // Space is back: the same stale lock is broken at once and the record is written.
    const second = logEvidence({ payload: 'example', tool_name: 'bash', verdict: 'ALLOW' }, file);
    assert.notEqual(second, null);
    assert.equal(fs.existsSync(mutex), false);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
