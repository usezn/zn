'use strict';
/*
 * A whole number written with a fraction (5.0 for 5) is the same value in the ledger: a line that
 * spells latency_us or confidence that way verifies, as the Python package's verifier does too.
 * A changed value, or a boolean in place of 1, still fails. Ledgers live in temporary folders.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers/tmp');
const { logEvidence, verifyEvidenceLedger } = require('../lib/evidence');

function ledger(t, n = 1) {
  const file = path.join(tempDir(t, 'zn-numspell-'), 'e.jsonl');
  for (let i = 0; i < n; i++) {
    assert.ok(logEvidence({ tool_name: 't' + i, latency_us: 5, confidence: 1 }, file, { noStats: true }));
  }
  return file;
}

function respell(file, field, from, to) {
  const pattern = `"${field}":${from},`;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = lines.map((line) => (line.includes(pattern) ? line.replace(pattern, `"${field}":${to},`) : line));
  fs.writeFileSync(file, out.join('\n'));
}

test('latency_us written as 5.0 verifies', (t) => {
  const file = ledger(t);
  respell(file, 'latency_us', '5', '5.0');
  assert.ok(fs.readFileSync(file, 'utf8').includes('"latency_us":5.0,'));
  assert.equal(verifyEvidenceLedger(file).valid, true);
});

test('confidence written as 1.0 verifies', (t) => {
  const file = ledger(t);
  respell(file, 'confidence', '1', '1.0');
  assert.equal(verifyEvidenceLedger(file).valid, true);
});

test('respelled numbers verify across a chain of three records', (t) => {
  const file = ledger(t, 3);
  const text = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace('"latency_us":5,', '"latency_us":5.0,')).join('\n');
  fs.writeFileSync(file, text);
  const result = verifyEvidenceLedger(file);
  assert.equal(result.valid, true);
  assert.equal(result.total, 3);
});

test('a changed latency value still fails', (t) => {
  const file = ledger(t);
  respell(file, 'latency_us', '5', '6.0');
  const result = verifyEvidenceLedger(file);
  assert.equal(result.valid, false);
  assert.match(result.error, /hash mismatch/);
});

test('a fractional latency still fails', (t) => {
  const file = ledger(t);
  respell(file, 'latency_us', '5', '5.5');
  assert.equal(verifyEvidenceLedger(file).valid, false);
});

test('a boolean confidence is not taken for 1', (t) => {
  const file = ledger(t);
  respell(file, 'confidence', '1', 'true');
  assert.equal(verifyEvidenceLedger(file).valid, false);
});
