'use strict';

// A saved key is not sent while the environment could weaken the TLS check
// (extra certificate authorities, code preloaded into Node). A key given with
// --key or ZN_API_KEY is the person's own choice and is not held back.
// Fake keys, stubbed HTTPS, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const cloudKey = require('../lib/cloud-key');
const client = require('../lib/client');

const freshKey = () => 'zn_' + crypto.randomBytes(24).toString('hex');
const ENV = ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'NODE_OPTIONS'];

test('tlsRefusal names the reason, in one line, for each risky setting', () => {
  assert.equal(cloudKey.tlsRefusal({}), null);
  assert.equal(cloudKey.tlsRefusal({ NODE_OPTIONS: '--max-old-space-size=512' }), null);
  assert.match(cloudKey.tlsRefusal({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /NODE_TLS_REJECT_UNAUTHORIZED is set/);
  assert.match(cloudKey.tlsRefusal({ NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }), /NODE_EXTRA_CA_CERTS is set/);
  assert.match(cloudKey.tlsRefusal({ SSL_CERT_FILE: '/tmp/ca.pem' }), /SSL_CERT_FILE is set/);
  for (const o of ['--require ./x.js', '-r ./x.js', '--import ./x.mjs', '--use-openssl-ca', '--max-old-space-size=512 --require=./x.js', '--import=./x.mjs']) {
    assert.match(cloudKey.tlsRefusal({ NODE_OPTIONS: o }), /NODE_OPTIONS/, o);
  }
  for (const v of [{ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { NODE_EXTRA_CA_CERTS: 'x' }, { NODE_OPTIONS: '-r x' }]) {
    assert.ok(!cloudKey.tlsRefusal(v).includes('\n'));
  }
});

async function setup(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-tlsenv-'));
  process.env.ZN_HOME = home;
  const https = require('https');
  const real = https.request;
  let requests = 0;
  https.request = () => {
    requests++;
    const req = new EventEmitter();
    req.write = () => {}; req.destroy = () => {};
    req.end = () => setImmediate(() => req.emit('error', new Error('stubbed')));
    return req;
  };
  let mem = null;
  const deps = { native: { name: 'fake', slot: {}, impl: { store: (k) => { mem = k; }, load: () => mem, remove: () => { mem = null; return true; } } }, vault: { isUnlocked: async () => false } };
  try {
    cloudKey._use(deps);
    await cloudKey.saveKey(freshKey(), deps);
    await fn(() => requests);
  } finally {
    https.request = real;
    cloudKey._use(null);
    for (const v of ENV.concat(['ZN_HOME', 'ZN_CLOUD'])) delete process.env[v];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a saved key is not sent under these settings, and analyze() says why', async () => {
  for (const [name, value] of [['NODE_EXTRA_CA_CERTS', '/tmp/ca.pem'], ['SSL_CERT_FILE', '/tmp/ca.pem'], ['NODE_OPTIONS', '--require ./x.js'], ['NODE_OPTIONS', '--use-openssl-ca'], ['NODE_TLS_REJECT_UNAUTHORIZED', '0']]) {
    await setup(async (count) => {
      process.env[name] = value;
      const r = await client.analyze('What is the weather today?', {});
      assert.equal(count(), 0, name + ' ' + value);
      assert.equal(r.mode, 'oss-local');
      assert.equal(r.fallback, true);
      assert.match(r.cloud_error, /will not send the saved key/);
    });
  }
});

test('a saved key is sent when none of them is set', async () => {
  await setup(async (count) => {
    await client.analyze('What is the weather today?', {});
    assert.equal(count(), 1);
  });
});

test('a key given with --key is the person\'s choice and is not held back', async () => {
  await setup(async (count) => {
    process.env.ZN_CLOUD = '1';
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/ca.pem';
    await client.analyze('What is the weather today?', { apiKey: freshKey() });
    assert.equal(count(), 1);
  });
});
