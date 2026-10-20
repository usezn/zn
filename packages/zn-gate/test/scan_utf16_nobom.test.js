'use strict';
// Text saved as UTF-16 without a byte order mark is scanned; an unclear byte
// order is reported as not scanned. The key is an invented value built at runtime.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const FAKE_AWS = 'AKIA' + 'ZNTESTFAKE' + '000000';

function scan(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-scan-'));
  try {
    fs.writeFileSync(path.join(dir, name), bytes);
    const r = spawnSync(process.execPath, [CLI, 'scan', dir, '--format', 'json'], {
      encoding: 'utf8',
      env: { ...process.env, ZN_LOCAL_ONLY: 'true' },
    });
    return { status: r.status, out: r.stdout, data: JSON.parse(r.stdout) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ENV_TEXT = `AWS_ACCESS_KEY_ID=${FAKE_AWS}\n`;

test('a UTF-16LE .env without a BOM is scanned and its secret reported', () => {
  const r = scan('.env', Buffer.from(ENV_TEXT, 'utf16le'));
  assert.strictEqual(r.status, 1);
  assert.ok(r.data.threats.length >= 1);
  assert.ok(!r.out.includes(FAKE_AWS));
});

test('a UTF-16BE .env without a BOM is scanned and its secret reported', () => {
  const r = scan('.env', Buffer.from(Buffer.from(ENV_TEXT, 'utf16le')).swap16());
  assert.strictEqual(r.status, 1);
  assert.ok(r.data.threats.length >= 1);
  assert.ok(!r.out.includes(FAKE_AWS));
});

test('NULs at both parities: the file is reported as not scanned', () => {
  const r = scan('x.txt', Buffer.from('A\x00\x00B'.repeat(50), 'latin1'));
  assert.strictEqual(r.data.total_files, 0);
  assert.strictEqual(r.data.skipped[0].reason, 'unclear text encoding');
});

test('plain UTF-8 and binary files behave as before', () => {
  const u = scan('.env', Buffer.from(ENV_TEXT));
  assert.strictEqual(u.status, 1);
  assert.strictEqual(u.data.total_files, 1);
  const b = scan('data.txt', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 1016 }, (_, i) => (i % 254) + 1))]));
  assert.strictEqual(b.data.total_files, 1);
  assert.strictEqual(b.data.skipped.length, 0);
});
