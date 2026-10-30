'use strict';

// isCloudEnabled() and resolveEndpoint() with options and environment variables.
// Fake key, temporary ZN_HOME (no connect marker), no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isCloudEnabled, resolveEndpoint } = require('../lib/client');

const VARS = ['ZN_API_KEY', 'ZN_CLOUD', 'ZN_LOCAL_ONLY', 'ZN_API_URL', 'ZN_STAGE', 'ZN_HOME'];
const FAKE_KEY = 'zn_' + '0'.repeat(48);

function withEnv(env, fn) {
  const saved = {};
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cloud-endpoint-'));
  process.env.ZN_HOME = home;
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const OPTED_IN = { ZN_API_KEY: FAKE_KEY, ZN_CLOUD: '1' };

test('isCloudEnabled: opted in with no local-only setting is on', () => {
  withEnv(OPTED_IN, () => assert.equal(isCloudEnabled(), true));
});

test('isCloudEnabled: a key without ZN_CLOUD=1 is off', () => {
  withEnv({ ZN_API_KEY: FAKE_KEY }, () => assert.equal(isCloudEnabled(), false));
});

test('isCloudEnabled: the localOnly option turns it off', () => {
  withEnv(OPTED_IN, () => assert.equal(isCloudEnabled({ localOnly: true }), false));
});

test('isCloudEnabled: localOnly false does not turn it off', () => {
  withEnv(OPTED_IN, () => assert.equal(isCloudEnabled({ localOnly: false }), true));
});

test('isCloudEnabled: ZN_LOCAL_ONLY=true turns it off', () => {
  withEnv({ ...OPTED_IN, ZN_LOCAL_ONLY: 'true' }, () => assert.equal(isCloudEnabled(), false));
});

test('isCloudEnabled: ZN_LOCAL_ONLY=1 is not "true" and does not turn it off', () => {
  withEnv({ ...OPTED_IN, ZN_LOCAL_ONLY: '1' }, () => assert.equal(isCloudEnabled(), true));
});

test('isCloudEnabled: ZN_LOCAL_ONLY=false does not turn it off', () => {
  withEnv({ ...OPTED_IN, ZN_LOCAL_ONLY: 'false' }, () => assert.equal(isCloudEnabled(), true));
});

test('isCloudEnabled: the localOnly option wins when ZN_LOCAL_ONLY=false', () => {
  withEnv({ ...OPTED_IN, ZN_LOCAL_ONLY: 'false' }, () => assert.equal(isCloudEnabled({ localOnly: true }), false));
});

test('resolveEndpoint: the apiUrl option beats ZN_API_URL', () => {
  withEnv({ ZN_API_URL: 'https://env.example.invalid/analyze' }, () => {
    assert.equal(resolveEndpoint({ apiUrl: 'https://opt.example.invalid/analyze' }), 'https://opt.example.invalid/analyze');
  });
});

test('resolveEndpoint: ZN_API_URL is used without the option', () => {
  withEnv({ ZN_API_URL: 'https://env.example.invalid/analyze' }, () => {
    assert.equal(resolveEndpoint({}), 'https://env.example.invalid/analyze');
  });
});

test('resolveEndpoint: the stage option beats ZN_STAGE', () => {
  withEnv({ ZN_STAGE: 'prod' }, () => {
    assert.equal(resolveEndpoint({ stage: 'v30' }), 'https://api.usezn.com/v30/analyze');
  });
  withEnv({ ZN_STAGE: 'v30' }, () => {
    assert.equal(resolveEndpoint({ stage: 'prod' }), 'https://api.usezn.com/prod/analyze');
  });
});

test('resolveEndpoint: ZN_STAGE is used without the option', () => {
  withEnv({ ZN_STAGE: 'prod' }, () => {
    assert.equal(resolveEndpoint({}), 'https://api.usezn.com/prod/analyze');
  });
});

test('resolveEndpoint: prod and an unknown stage give different addresses', () => {
  withEnv({}, () => {
    const prod = resolveEndpoint({ stage: 'prod' });
    const unknown = resolveEndpoint({ stage: 'no-such-stage' });
    assert.notEqual(prod, unknown);
    assert.equal(prod, 'https://api.usezn.com/prod/analyze');
    assert.equal(unknown, 'https://api.usezn.com/v30/analyze');
    assert.equal(resolveEndpoint({}), unknown);
  });
});
