'use strict';

// longInputMode() and usesStoredKey() with no options, an empty object, each
// documented value and an unknown value: the default applies. Fake keys and a
// temporary ZN_HOME; nothing touches the network or a real keychain.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { longInputMode, usesStoredKey } = require('../lib/client');

const ENV_NAMES = ['ZN_LONG_INPUT', 'ZN_HOME', 'ZN_CLOUD', 'ZN_API_KEY'];
const freshKey = () => 'zn_' + crypto.randomBytes(24).toString('hex');

function withEnv(t, env) {
  const saved = {};
  for (const n of ENV_NAMES) { saved[n] = process.env[n]; delete process.env[n]; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-defaults-'));
  process.env.ZN_HOME = home;
  Object.assign(process.env, env);
  t.after(() => {
    for (const n of ENV_NAMES) {
      if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
}

function writeMarker() {
  const cloud = { store: 'keychain', connectedAt: '2026-01-01T00:00:00.000Z', last4: 'abcd' };
  fs.writeFileSync(path.join(process.env.ZN_HOME, 'config.json'), JSON.stringify({ cloud }));
}

test('longInputMode defaults to windows with no options or an empty object', (t) => {
  withEnv(t, {});
  assert.equal(longInputMode(), 'windows');
  assert.equal(longInputMode({}), 'windows');
  assert.equal(longInputMode({ longInput: undefined }), 'windows');
});

test('longInputMode accepts each documented off value, in any case and with spaces', (t) => {
  withEnv(t, {});
  for (const v of ['off', 'none', 'truncate', '0', 'false', 'no', 'OFF', ' No ', 'Truncate']) {
    assert.equal(longInputMode({ longInput: v }), 'off', v);
  }
});

test('longInputMode: windows and unknown values give windows', (t) => {
  withEnv(t, {});
  for (const v of ['windows', 'WINDOWS', 'on', 'yes', '1', 'true', 'banana', '']) {
    assert.equal(longInputMode({ longInput: v }), 'windows', JSON.stringify(v));
  }
});

test('longInputMode reads ZN_LONG_INPUT when the option is missing, and the option wins', (t) => {
  withEnv(t, { ZN_LONG_INPUT: 'off' });
  assert.equal(longInputMode(), 'off');
  assert.equal(longInputMode({}), 'off');
  assert.equal(longInputMode({ longInput: 'windows' }), 'windows');
  process.env.ZN_LONG_INPUT = 'banana';
  assert.equal(longInputMode({}), 'windows');
  assert.equal(longInputMode({ longInput: 'off' }), 'off');
});

test('usesStoredKey is false with no options or an empty object when nothing is connected', (t) => {
  withEnv(t, {});
  assert.equal(usesStoredKey(), false);
  assert.equal(usesStoredKey({}), false);
  assert.equal(usesStoredKey({ apiKey: freshKey() }), false);
  assert.equal(usesStoredKey({ apiKey: 'not-a-key', unknownOption: true }), false);
});

test('usesStoredKey is true with no options or an empty object when connected', (t) => {
  withEnv(t, {});
  writeMarker();
  assert.equal(usesStoredKey(), true);
  assert.equal(usesStoredKey({}), true);
  assert.equal(usesStoredKey({ unknownOption: 'x' }), true);
  // A key without ZN_CLOUD=1 is not an explicit opt-in, so the stored key stays in use.
  assert.equal(usesStoredKey({ apiKey: freshKey() }), true);
  assert.equal(usesStoredKey({ apiKey: 'not-a-key' }), true);
});

test('usesStoredKey is false when a usable key and ZN_CLOUD=1 are given, from options or the environment', (t) => {
  withEnv(t, { ZN_CLOUD: '1' });
  writeMarker();
  assert.equal(usesStoredKey({}), true);
  assert.equal(usesStoredKey({ apiKey: freshKey() }), false);
  assert.equal(usesStoredKey({ apiKey: 'not-a-key' }), true);
  process.env.ZN_API_KEY = freshKey();
  assert.equal(usesStoredKey(), false);
  assert.equal(usesStoredKey({}), false);
});
