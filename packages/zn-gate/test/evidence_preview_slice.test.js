'use strict';
// The evidence preview redacts only the start of a large payload (it keeps 120 characters), and a
// secret in that start is still redacted. The hash still covers the whole payload.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evidence = require('../lib/evidence');

// Fake key, built in pieces.
const KEY = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

test('a secret at the start of a 1 MB payload is redacted in the preview, and the hash covers it all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-slice-'));
  try {
    const payload = 'token ' + KEY + ' ' + 'x'.repeat(1024 * 1024);
    const rec = evidence.logEvidence({ agent: 'test', payload, verdict: 'block' }, path.join(dir, 'evidence.jsonl'), { noStats: true });
    assert.ok(rec, 'record written');
    assert.ok(!rec.payload_preview.includes(KEY.slice(4)), rec.payload_preview);
    assert.match(rec.payload_preview, /REDACTED/);
    assert.ok(rec.payload_preview.length <= 120);
    assert.equal(rec.payload_sha256, crypto.createHash('sha256').update(payload).digest('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a long secret that starts in the preview is matched whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-slice-'));
  try {
    // A private key block of about 6.5 KB (as for an 8192-bit RSA key), made of fake base64 lines.
    const line = 'TUlJRXZRSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS2N3Z2dTakFnRUFBb0lCQVFDN';
    const body = Array.from({ length: 100 }, () => line).join('\n');
    const block = '-----BEGIN PRIVATE KEY-----\n' + body + '\n-----END PRIVATE KEY-----';
    const payload = 'key: ' + block + '\n' + 'y'.repeat(200 * 1024);
    const rec = evidence.logEvidence({ agent: 'test', payload, verdict: 'block' }, path.join(dir, 'evidence.jsonl'), { noStats: true });
    assert.ok(!rec.payload_preview.includes(line.slice(0, 20)), rec.payload_preview);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a private key block longer than the redacted part is cut from the preview', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-slice-'));
  try {
    // About 100 KB of fake base64 lines: the END line is past the part that is redacted.
    const line = 'TUlJRXZRSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS2N3Z2dTakFnRUFBb0lCQVFDN';
    const block = '-----BEGIN PRIVATE KEY-----\n' + Array.from({ length: 1500 }, () => line).join('\n') + '\n-----END PRIVATE KEY-----';
    const rec = evidence.logEvidence({ agent: 'test', payload: 'k: ' + block, verdict: 'block' }, path.join(dir, 'evidence.jsonl'), { noStats: true });
    assert.ok(!rec.payload_preview.includes(line.slice(0, 20)), rec.payload_preview);
    assert.equal(rec.payload_preview, 'k: [REDACTED_PRIVATE_KEY]');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
