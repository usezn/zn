'use strict';

// Every HTTPS request that carries the key verifies the certificate on its own
// (NODE_TLS_REJECT_UNAUTHORIZED=0 cannot switch it off), and a saved key is not
// sent at all while that variable is set. Fake keys, stubbed HTTPS, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const cloudKey = require('../lib/cloud-key');
const client = require('../lib/client');
const connectCli = require('../lib/connect-cli');

const freshKey = () => 'zn_' + crypto.randomBytes(24).toString('hex');

async function setup(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-tls-'));
  process.env.ZN_HOME = home;
  const https = require('https');
  const real = https.request;
  const seen = [];
  https.request = (u, o, cb) => {
    const opts = (typeof u === 'string' || u instanceof URL) ? o : u;
    seen.push({ reject: opts.rejectUnauthorized, auth: String((opts.headers || {}).Authorization || '') });
    const req = new EventEmitter();
    req.write = () => {}; req.destroy = () => {};
    req.end = () => setImmediate(() => req.emit('error', new Error('stubbed')));
    return req;
  };
  let mem = null;
  const deps = { native: { name: 'fake', slot: {}, impl: { store: (k) => { mem = k; }, load: () => mem, remove: () => { mem = null; return true; } } }, vault: { isUnlocked: async () => false } };
  try {
    const key = freshKey();
    cloudKey._use(deps);
    await cloudKey.saveKey(key, deps);
    await fn({ key, seen, deps });
  } finally {
    https.request = real;
    cloudKey._use(null);
    for (const v of ['ZN_HOME', 'ZN_API_KEY', 'ZN_CLOUD', 'NODE_TLS_REJECT_UNAUTHORIZED']) delete process.env[v];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('analyze() sets rejectUnauthorized: true for a saved key and for an explicit key', async () => {
  await setup(async ({ key, seen }) => {
    await client.analyze('What is the weather today?', {});
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reject, true);
    assert.equal(seen[0].auth, 'Bearer ' + key);
    process.env.ZN_CLOUD = '1';
    await client.analyze('What is the weather today?', { apiKey: freshKey() });
    assert.equal(seen[1].reject, true);
  });
});

test('a saved key is not sent while NODE_TLS_REJECT_UNAUTHORIZED=0, and the reason is one clear line', async () => {
  await setup(async ({ seen }) => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const r = await client.analyze('What is the weather today?', {});
    assert.equal(seen.length, 0);
    assert.equal(r.mode, 'oss-local');
    assert.equal(r.fallback, true);
    assert.match(r.cloud_error, /NODE_TLS_REJECT_UNAUTHORIZED is set in this terminal, so zn-gate will not send the saved key/);
    assert.ok(!r.cloud_error.includes('\n'));
  });
});

test('connect and disconnect requests verify the certificate and are not made under NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
  await setup(async ({ key, seen }) => {
    const https = require('https');
    const a = await connectCli.request(https, 'GET', connectCli.VERIFY_PATH, key);
    assert.ok(a.error);
    assert.equal(seen.at(-1).reject, true);
    const n = seen.length;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const c = await connectCli.request(https, 'GET', connectCli.VERIFY_PATH, key);
    assert.match(c.error, /NODE_TLS_REJECT_UNAUTHORIZED is set/);
    assert.equal(seen.length, n, 'no request was made');
  });
});

test('no other code sends an Authorization header without verifying the certificate', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const client = fs.readFileSync(path.join(lib, 'client.js'), 'utf8');
  assert.match(client, /rejectUnauthorized: true/);
  const cc = fs.readFileSync(path.join(lib, 'connect-cli.js'), 'utf8');
  assert.match(cc, /rejectUnauthorized: true/);
});
