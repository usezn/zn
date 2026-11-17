'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { unlockedLine, lockWhenText } = require('../lib/vault/cli');

const meta = { backend: 'passphrase' };
const HOUR = 3600 * 1000;

test('lockWhenText names both the idle limit and the latest lock time', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0);
  const text = lockWhenText(30 * 60000, new Date(now + 8 * HOUR).toISOString(), now);
  assert.match(text, /^locks after 30 min idle, or at (tomorrow )?\d\d:\d\d \(in 8 h\) at the latest$/);
});

test('zn vault status explains the idle lock and the maximum session, not just "expires"', () => {
  const iso = new Date(Date.now() + 8 * HOUR).toISOString();
  const line = unlockedLine(meta, { expiresAt: iso, idleMs: 30 * 60000, features: ['resolve-policy', 'capabilities'], version: '1.14.0' });
  assert.match(line, /locks after 30 min idle, or at .* at the latest/);
  assert.doesNotMatch(line, /expires/);
  assert.match(line, /zn-gate 1\.14\.0\)$/);
});

test('an older vault that reports no idle time still gets the plain expiry', () => {
  assert.match(unlockedLine(meta, { expiresAt: 'T', features: ['resolve-policy', 'capabilities'] }), /expires T\)$/);
});

test('a session end far from now (the system clock changed) says so instead of a wrong countdown', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0);
  for (const shift of [365 * 24 * HOUR, -365 * 24 * HOUR, 25 * HOUR, -3 * HOUR]) {
    const text = lockWhenText(30 * 60000, new Date(now + shift).toISOString(), now);
    assert.match(text, /\(the system clock changed since the vault was unlocked\)/, String(shift));
    assert.doesNotMatch(text, /\(in \d+ (min|h)\)/);
  }
  assert.match(lockWhenText(30 * 60000, new Date(now + 24 * HOUR).toISOString(), now), /\(in 24 h\)/);
});
