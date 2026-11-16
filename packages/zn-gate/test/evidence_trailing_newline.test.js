'use strict';

// A ledger whose last record has no final newline (an editor, a cut-off write) must not get
// the next record glued onto that line: the next record starts its own line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logEvidence, verifyEvidenceLedger } = require('../lib/evidence');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-nl-'));
  return { dir, file: path.join(dir, 'evidence.jsonl') };
}

function event(n) {
  return { payload: `example-${n}`, tool_name: 'bash' };
}

test('a record appended to a ledger without a final newline starts its own line', () => {
  const { dir, file } = tmpFile();
  try {
    logEvidence(event(0), file);
    logEvidence(event(1), file);
    const data = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, data.replace(/\n$/, ''));
    const rec = logEvidence(event(2), file);
    assert.ok(rec, 'the write must succeed');
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    assert.equal(lines.length, 4, 'three records, each on its own line, plus the final newline');
    assert.equal(lines[3], '');
    assert.equal(JSON.parse(lines[2]).record_hash, rec.record_hash);
    assert.equal(verifyEvidenceLedger(file).valid, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a normal ledger gets no extra empty line', () => {
  const { dir, file } = tmpFile();
  try {
    logEvidence(event(0), file);
    logEvidence(event(1), file);
    logEvidence(event(2), file);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('\n\n'), false);
    assert.equal(text.split('\n').length, 4);
    assert.equal(verifyEvidenceLedger(file).valid, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty ledger gets exactly one record line, as before', () => {
  const { dir, file } = tmpFile();
  try {
    fs.writeFileSync(file, '');
    assert.ok(logEvidence(event(0), file));
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.split('\n').length, 2);
    assert.equal(text.startsWith('{'), true);
    assert.equal(verifyEvidenceLedger(file).valid, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing ledger is created with one record line, as before', () => {
  const { dir, file } = tmpFile();
  try {
    assert.ok(logEvidence(event(0), file));
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 2);
    assert.equal(verifyEvidenceLedger(file).valid, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a ledger already joined into one line is still reported, and the writer keeps failing closed', () => {
  const { dir, file } = tmpFile();
  try {
    logEvidence(event(0), file);
    logEvidence(event(1), file);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    // The damage the old writer left behind: two records on one line.
    fs.writeFileSync(file, lines[0] + lines[1] + '\n');
    const v = verifyEvidenceLedger(file);
    assert.equal(v.valid, false);
    assert.match(v.error, /Malformed JSON|line 1/);
    assert.equal(logEvidence(event(2), file), null);
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 2, 'nothing was appended');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
