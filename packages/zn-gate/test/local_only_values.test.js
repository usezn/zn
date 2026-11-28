'use strict';

// ZN_LOCAL_ONLY: 1, true, yes and on (any case) keep the cloud off; an unknown value keeps it off and warns
// once. Same cases as zn-gate-py/tests/test_local_only_values.py.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../lib/client');
const envFlag = require('../lib/env-flag');

const FAKE_KEY = 'zn_test_' + 'notarealkey_0000';

function withEnv(value, fn) {
  const saved = { k: process.env.ZN_API_KEY, c: process.env.ZN_CLOUD, l: process.env.ZN_LOCAL_ONLY };
  process.env.ZN_API_KEY = FAKE_KEY;
  process.env.ZN_CLOUD = '1';
  if (value === undefined) delete process.env.ZN_LOCAL_ONLY; else process.env.ZN_LOCAL_ONLY = value;
  try { return fn(); } finally {
    for (const [name, v] of [['ZN_API_KEY', saved.k], ['ZN_CLOUD', saved.c], ['ZN_LOCAL_ONLY', saved.l]]) {
      if (v === undefined) delete process.env[name]; else process.env[name] = v;
    }
  }
}

function captureStderr(t) {
  const lines = [];
  t.mock.method(process.stderr, 'write', (s) => { lines.push(String(s)); return true; });
  return lines;
}

test('true values force local-only', () => {
  for (const v of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'On', ' 1 ']) {
    assert.equal(withEnv(v, () => client.isCloudEnabled()), false, v);
  }
});

test('off values leave the cloud on', () => {
  for (const v of [undefined, '', '0', 'false', 'no', 'off', 'OFF']) {
    assert.equal(withEnv(v, () => client.isCloudEnabled()), true, String(v));
  }
});

test('an unknown value keeps local-only on and warns once', (t) => {
  envFlag._warned.clear();
  const lines = captureStderr(t);
  assert.equal(withEnv('maybe', () => client.isCloudEnabled()), false);
  assert.equal(withEnv('maybe', () => client.isCloudEnabled()), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ZN_LOCAL_ONLY/);
});

test('known values do not warn', (t) => {
  envFlag._warned.clear();
  const lines = captureStderr(t);
  for (const v of ['1', 'true', 'no', '0', '']) withEnv(v, () => client.isCloudEnabled());
  assert.equal(lines.length, 0);
});

test('the localOnly option still wins', () => {
  assert.equal(withEnv(undefined, () => client.isCloudEnabled({ localOnly: true })), false);
});
