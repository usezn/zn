'use strict';
/*
 * Error cases of the evidence log readers: an unreadable log, and a last line that
 * cannot be trusted. getLastHash must throw instead of falling back to the genesis hash.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { getLastHash, verifyEvidenceLedger, EvidenceLedgerError } = require('../lib/evidence');

const skipWin = process.platform === 'win32' ? 'reading a directory fails with a different code' : false;

function expectLedgerError(fn, message) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof EvidenceLedgerError);
    assert.strictEqual(e.message, message);
    return true;
  });
}

function logWith(t, bytes) {
  const file = path.join(tempDir(t, 'zn-evidence-errors-'), 'evidence.jsonl');
  fs.writeFileSync(file, bytes);
  return file;
}

test('getLastHash throws when the log cannot be read', { skip: skipWin }, (t) => {
  const dir = tempDir(t, 'zn-evidence-errors-');
  expectLedgerError(() => getLastHash(dir), 'Cannot read the evidence log: EISDIR');
});

test('verifyEvidenceLedger reports a log that cannot be read', { skip: skipWin }, (t) => {
  const dir = tempDir(t, 'zn-evidence-errors-');
  const result = verifyEvidenceLedger(dir);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'Cannot read the evidence log: EISDIR');
});

test('getLastHash throws on invalid UTF-8 in the last line', (t) => {
  const file = logWith(t, Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
  expectLedgerError(() => getLastHash(file), 'Invalid UTF-8 bytes in the last line: the log was corrupted or modified.');
});

test('getLastHash throws on malformed JSON in the last line', (t) => {
  const file = logWith(t, '{"record_hash": \n');
  assert.throws(() => getLastHash(file), (e) => {
    assert.ok(e instanceof EvidenceLedgerError);
    assert.match(e.message, /^Malformed JSON in the last line: /);
    return true;
  });
});

test('getLastHash throws when the last record has no valid record_hash', (t) => {
  const msg = 'The last record has no valid record_hash.';
  expectLedgerError(() => getLastHash(logWith(t, '{"record_hash":"abc"}\n')), msg);
  expectLedgerError(() => getLastHash(logWith(t, '{"other":1}\n')), msg);
  expectLedgerError(() => getLastHash(logWith(t, '[1,2]\n')), msg);
});
