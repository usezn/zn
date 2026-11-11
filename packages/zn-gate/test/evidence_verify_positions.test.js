'use strict';

// verifyEvidenceLedger result fields (valid, total, verified, broken_index) for a missing file,
// an unreadable path, a damaged line, a good chain, and one changed record at each position.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logEvidence, verifyEvidenceLedger } = require('../lib/evidence');

const COUNT = 5;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-positions-'));
}

function makeLedger(n = COUNT) {
  const dir = tmpDir();
  const file = path.join(dir, 'evidence.jsonl');
  for (let i = 0; i < n; i++) logEvidence({ payload: `example-${i}`, tool_name: 'bash' }, file);
  return file;
}

function changeRecord(file, index) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const rec = JSON.parse(lines[index]);
  rec.tool_name = 'changed-tool';
  lines[index] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

test('a missing file is valid and empty', () => {
  const file = path.join(tmpDir(), 'missing.jsonl');
  assert.deepEqual(verifyEvidenceLedger(file), { valid: true, total: 0, verified: 0, broken_index: null, error: null, truncated: false, rewritten: false, anchored: false, tip: null });
});

test('an unreadable path (a directory) is invalid and broken at index 0', () => {
  const res = verifyEvidenceLedger(tmpDir());
  assert.equal(res.valid, false);
  assert.equal(res.total, 0);
  assert.equal(res.verified, 0);
  assert.equal(res.broken_index, 0);
  assert.match(res.error, /Cannot read the evidence log/);
});

test('a damaged line in the middle stops verification at that line', () => {
  const file = makeLedger();
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines[2] = '{"not json';
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const res = verifyEvidenceLedger(file);
  assert.equal(res.valid, false);
  assert.equal(res.total, COUNT);
  assert.equal(res.verified, 2);
  assert.equal(res.broken_index, 2);
  assert.match(res.error, /Malformed JSON at line 3/);
});

test('a good chain verifies every record', () => {
  const res = verifyEvidenceLedger(makeLedger());
  const { truncated, rewritten, anchored, tip, ...chain } = res;
  assert.deepEqual(chain, { valid: true, total: COUNT, verified: COUNT, broken_index: null, error: null });
  assert.deepEqual({ truncated, rewritten, anchored, count: tip.count }, { truncated: false, rewritten: false, anchored: true, count: COUNT });
});

for (const [name, index] of [['first', 0], ['middle', 2], ['last', COUNT - 1]]) {
  test(`a changed record in the ${name} position is reported at its index`, () => {
    const file = makeLedger();
    changeRecord(file, index);
    const res = verifyEvidenceLedger(file);
    assert.equal(res.valid, false);
    assert.equal(res.total, COUNT);
    assert.equal(res.verified, index);
    assert.equal(res.broken_index, index);
    assert.match(res.error, new RegExp(`Tamper detected at line ${index + 1} `));
  });
}
