'use strict';
// usableApiKey, looksLikeZnKey, last4, readMarker and forgetMarker with fake keys and a temporary HOME.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cloudKey = require('../lib/cloud-key');

const KEY = 'zn_example_key_0123456789abcdef';

async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-key-shapes-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ZN_HOME: process.env.ZN_HOME };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ZN_HOME;
  try {
    await fn(path.join(home, '.zn', 'config.json'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const writeConfig = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('usableApiKey accepts a valid shape and trims spaces around it', () => {
  assert.equal(cloudKey.usableApiKey(KEY), KEY);
  assert.equal(cloudKey.usableApiKey(`  ${KEY}\n`), KEY);
});

test('usableApiKey returns null for empty, blank, short, placeholder and non-string values', () => {
  for (const v of ['', '   ', 'zn_short', '${user_config.api_key}', '%ZN_API_KEY%', 'zn_key with space 0123456789', null, undefined, 42, {}]) {
    assert.equal(cloudKey.usableApiKey(v), null, String(v));
  }
});

test('looksLikeZnKey needs the zn_ prefix', () => {
  assert.equal(cloudKey.looksLikeZnKey(KEY), true);
  assert.equal(cloudKey.looksLikeZnKey(`  ${KEY}  `), true);
  assert.equal(cloudKey.looksLikeZnKey('sk_example_key_0123456789abcdef'), false);
  assert.equal(cloudKey.looksLikeZnKey('ZN_example_key_0123456789abcdef'), false);
  assert.equal(cloudKey.looksLikeZnKey(''), false);
  assert.equal(cloudKey.looksLikeZnKey('   '), false);
  assert.equal(cloudKey.looksLikeZnKey(undefined), false);
});

test('last4 gives the last four characters of a long enough string only', () => {
  assert.equal(cloudKey.last4(KEY), 'cdef');
  assert.equal(cloudKey.last4('12345678'), '5678');
  assert.equal(cloudKey.last4('1234567'), null);
  assert.equal(cloudKey.last4(''), null);
  assert.equal(cloudKey.last4(null), null);
  assert.equal(cloudKey.last4(12345678), null);
});

test('last4 does not trim: spaces around the value are part of the last characters', () => {
  assert.equal(cloudKey.last4(`${KEY}  `), 'ef  ');
});

test('readMarker is null without a file, with a damaged file and with an empty file', async () => {
  await withTempHome(async (file) => {
    assert.equal(cloudKey.readMarker(), null);
    writeConfig(file, '{not json');
    assert.equal(cloudKey.readMarker(), null);
    writeConfig(file, '');
    assert.equal(cloudKey.readMarker(), null);
    writeConfig(file, 'null');
    assert.equal(cloudKey.readMarker(), null);
    writeConfig(file, JSON.stringify({ cloud: 'keychain' }));
    assert.equal(cloudKey.readMarker(), null);
    writeConfig(file, JSON.stringify({ cloud: { store: 'plainfile' } }));
    assert.equal(cloudKey.readMarker(), null);
  });
});

test('readMarker returns the marker fields and never a key', async () => {
  await withTempHome(async (file) => {
    writeConfig(file, JSON.stringify({ cloud: { store: 'keychain', connectedAt: '2026-01-01T00:00:00.000Z', last4: 'cdef', key: KEY } }));
    assert.deepEqual(cloudKey.readMarker(), { store: 'keychain', connectedAt: '2026-01-01T00:00:00.000Z', last4: 'cdef' });
  });
});

test('forgetMarker removes only the cloud setting and keeps the rest of the file', async () => {
  await withTempHome(async (file) => {
    writeConfig(file, JSON.stringify({ other: 1, cloud: { store: 'vault', last4: 'cdef' } }));
    cloudKey.forgetMarker();
    assert.equal(cloudKey.readMarker(), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { other: 1 });
  });
});

test('forgetMarker with no file or no marker does not create or change anything', async () => {
  await withTempHome(async (file) => {
    cloudKey.forgetMarker();
    assert.equal(fs.existsSync(file), false);
    writeConfig(file, '{"other":1}');
    cloudKey.forgetMarker();
    assert.equal(fs.readFileSync(file, 'utf8'), '{"other":1}');
  });
});

test('forgetMarker leaves a damaged file alone', async () => {
  await withTempHome(async (file) => {
    writeConfig(file, '{not json');
    cloudKey.forgetMarker();
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
  });
});
