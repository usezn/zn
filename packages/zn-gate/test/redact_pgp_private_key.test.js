'use strict';
// An OpenPGP private key ("-----BEGIN PGP PRIVATE KEY BLOCK-----") is redacted like a PEM key:
// in redactSecrets, in the evidence ledger preview and in `zn-gate scan`. The key is invented and
// assembled at runtime.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const rules = require('../lib/rules');
const { logEvidence } = require('../lib/evidence');

const BEGIN = '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----';
const END = '-----END PGP ' + 'PRIVATE KEY BLOCK-----';
const LINE1 = 'lQOYBGZNTESTFAKE' + 'x'.repeat(20) + 'EXAMPLEONLY';
const LINE2 = 'ZNTESTFAKEpgp' + 'q'.repeat(8);
const KEY = BEGIN + '\n\n' + LINE1 + '\n' + LINE2 + '\n=abcd\n' + END;
const PIECES = [LINE1.slice(0, 16), LINE2, '=abcd'];

test('redactSecrets replaces a PGP private key block', () => {
  const out = rules.redactSecrets('key:\n' + KEY + '\ndone\n').sanitized;
  assert.ok(out.includes('[REDACTED_PRIVATE_KEY]'), out);
  for (const p of PIECES) assert.ok(!out.includes(p), p);
  assert.ok(out.endsWith('\ndone\n'));
});

test('the evidence ledger preview does not show a PGP private key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-pgp-'));
  try {
    const file = path.join(dir, 'evidence.jsonl');
    logEvidence({ payload: KEY, tool_name: 'bash' }, file);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());
    assert.ok(rec.payload_preview.includes('[REDACTED_PRIVATE_KEY]'), rec.payload_preview);
    for (const p of PIECES) assert.ok(!rec.payload_preview.includes(p), p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, payload] of [
  ['cut short (no END line)', BEGIN + '\n\n' + LINE1 + '\n' + LINE2 + '\n'],
  ['longer than the redacted part of the preview', BEGIN + '\n\n' + (LINE1 + '\n').repeat(2000) + LINE2 + '\n' + END],
]) {
  test('the evidence ledger preview does not show a PGP private key ' + name, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-pgp-'));
    try {
      const file = path.join(dir, 'evidence.jsonl');
      logEvidence({ payload: 'key: ' + payload, tool_name: 'bash' }, file);
      const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());
      assert.ok(rec.payload_preview.includes('[REDACTED_PRIVATE_KEY]'), rec.payload_preview);
      for (const p of PIECES) assert.ok(!rec.payload_preview.includes(p), p);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('zn-gate scan reports a PGP private key once and does not print it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-scan-pgp-'));
  try {
    fs.writeFileSync(path.join(dir, 'key.md'), 'x = 1\n' + KEY + '\n');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.js'), 'scan', dir], {
      encoding: 'utf8', env: { ...process.env, ZN_LOCAL_ONLY: 'true' },
    });
    assert.strictEqual(r.status, 1, r.stdout);
    assert.strictEqual(r.stdout.split('\n').filter((l) => l.includes('secret:private_key')).length, 1, r.stdout);
    for (const p of PIECES) assert.ok(!r.stdout.includes(p), p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
