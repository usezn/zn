'use strict';

// verify tells a last line that was cut off apart from a hash mismatch: a cut-off last line is
// named as incomplete and explained, while a manipulated record is still reported as tamper.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { logEvidence, verifyEvidenceLedger } = require('../lib/evidence');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const INCOMPLETE = /Last record is incomplete \(the write was cut off, for example by a crash or a full disk\)/;

function tmpLedger(n = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-verify-tail-'));
  const file = path.join(dir, 'evidence.jsonl');
  for (let i = 0; i < n; i++) logEvidence({ payload: `example-${i}`, tool_name: 'bash' }, file);
  return { dir, file };
}

test('a cut-off last line is reported as incomplete, not as tamper', () => {
  const { dir, file } = tmpLedger(3);
  try {
    const data = fs.readFileSync(file);
    fs.writeFileSync(file, data.subarray(0, data.length - 40));
    const v = verifyEvidenceLedger(file);
    assert.equal(v.valid, false);
    assert.equal(v.truncated_tail, true);
    assert.equal(v.verified, 2);
    assert.equal(v.broken_index, 2);
    assert.match(v.error, INCOMPLETE);
    assert.match(v.error, /at line 3/);
    assert.doesNotMatch(v.error, /Tamper/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a manipulated record in the middle is still reported as tamper', () => {
  const { dir, file } = tmpLedger(3);
  try {
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('example-1', 'example-X'));
    const v = verifyEvidenceLedger(file);
    assert.equal(v.valid, false);
    assert.equal(v.truncated_tail, undefined);
    assert.equal(v.broken_index, 1);
    assert.match(v.error, /Tamper detected at line 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a manipulated record before a cut-off last line is reported as tamper first', () => {
  const { dir, file } = tmpLedger(3);
  try {
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('example-0', 'example-X').slice(0, -40));
    const v = verifyEvidenceLedger(file);
    assert.equal(v.valid, false);
    assert.equal(v.truncated_tail, undefined);
    assert.equal(v.broken_index, 0);
    assert.match(v.error, /Tamper detected at line 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an intact ledger verifies with no truncation flag', () => {
  const { dir, file } = tmpLedger(3);
  try {
    const v = verifyEvidenceLedger(file);
    assert.deepEqual(v, { valid: true, total: 3, verified: 3, broken_index: null, error: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence --verify prints the incomplete-record explanation and exits 1', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-verify-cli-'));
  const zn = path.join(home, '.zn');
  fs.mkdirSync(zn);
  const file = path.join(zn, 'evidence.jsonl');
  try {
    for (let i = 0; i < 3; i++) logEvidence({ payload: `example-${i}`, tool_name: 'bash' }, file);
    const data = fs.readFileSync(file);
    fs.writeFileSync(file, data.subarray(0, data.length - 40));
    const r = spawnSync(process.execPath, [CLI, 'evidence', '--verify'], {
      encoding: 'utf8',
      input: '',
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, NO_COLOR: '1', ZN_STATS: 'off', ZN_LOCAL_ONLY: 'true' }),
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /LAST RECORD INCOMPLETE \(NOT VERIFIED\)/);
    assert.doesNotMatch(r.stdout, /TAMPER DETECTED/);
    assert.match(r.stdout, /The first 2 records verified; the last line was cut off\./);
    assert.match(r.stdout, /move it aside/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A cut-off line counts only if it is the last line, the file does not end with a newline and the
// line starts like a written record. Everything else is tamper.
function tailCase(name, mutate, incomplete) {
  test(name, () => {
    const { dir, file } = tmpLedger(3);
    try {
      mutate(file);
      const v = verifyEvidenceLedger(file);
      assert.equal(v.valid, false);
      if (incomplete) {
        assert.equal(v.truncated_tail, true);
        assert.match(v.error, INCOMPLETE);
      } else {
        assert.equal(v.truncated_tail, undefined);
        assert.doesNotMatch(v.error, INCOMPLETE);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
const lastLineStart = (text) => text.slice(0, -1).lastIndexOf('\n') + 1;

tailCase('garbage line with a trailing newline is tamper', (f) => fs.appendFileSync(f, 'garbage\n'), false);
tailCase('a fake unfinished record with a trailing newline is tamper', (f) => fs.appendFileSync(f, '{"id":"ev_fake","timestamp":"20\n'), false);
tailCase('a cut-off record that still ends with a newline is tamper', (f) => {
  const t = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, t.slice(0, -41) + '\n');
}, false);
tailCase('last record edited, still valid JSON, is tamper', (f) => {
  const t = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, t.slice(0, lastLineStart(t)) + t.slice(lastLineStart(t)).replace('example-2', 'example-X'));
}, false);
tailCase('last record edited into invalid JSON (newline kept) is tamper', (f) => {
  const t = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, t.replace('example-2', 'example-2"{'));
}, false);
tailCase('non-record text without a trailing newline is tamper', (f) => fs.appendFileSync(f, 'garbage'), false);
tailCase('invalid JSON that does not start like a record, no newline, is tamper', (f) => {
  const t = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, t.slice(0, lastLineStart(t)) + '{"foo":"bar');
}, false);
tailCase('a genuine cut (prefix of a real record, no trailing newline) is incomplete', (f) => {
  const t = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, t.slice(0, -60));
}, true);
