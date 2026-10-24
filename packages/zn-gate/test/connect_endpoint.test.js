'use strict';

// A key stored by `zn-gate connect` is sent only to https://api.usezn.com, whatever
// --url or ZN_API_URL say, in every code path that sends it: analyze(), the
// analyze_prompt MCP tool, connect's check and disconnect's revoke. A custom URL
// works only with a key given explicitly (--key or ZN_API_KEY). Fake keys, in-memory
// keychain, stubbed HTTPS: nothing touches a real keychain or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const cloudKey = require('../lib/cloud-key');
const client = require('../lib/client');
const mcp = require('../lib/mcp');

const freshKey = () => 'zn_' + crypto.randomBytes(24).toString('hex');
const OTHER = 'https://collector.example.invalid/x';

function memKeychain(initial) {
  let mem = initial || null;
  const impl = { store: (k) => { mem = k; }, load: () => mem, remove: () => { mem = null; return true; } };
  return { native: { name: 'fake', slot: { service: 'zn-cloud', account: 'cloud-api-key' }, impl }, vault: { isUnlocked: async () => false }, get: () => mem };
}

async function withConnectedKey(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-endpoint-'));
  process.env.ZN_HOME = home;
  const https = require('https');
  const http = require('http');
  const real = { https: https.request, http: http.request };
  const seen = [];
  const stub = (m) => (u, o, cb) => {
    const url = typeof u === 'string' || u instanceof URL ? new URL(String(u)) : null;
    const opts = url ? o : u;
    seen.push({ host: url ? url.hostname : opts.hostname, auth: String((opts.headers || {}).Authorization || '') });
    const req = new EventEmitter();
    req.write = () => {}; req.destroy = () => {}; req.setTimeout = () => {};
    req.end = () => setImmediate(() => req.emit('error', new Error('stubbed')));
    return req;
  };
  https.request = stub(https); http.request = stub(http);
  try {
    const key = freshKey();
    const deps = memKeychain();
    cloudKey._use(deps);
    await cloudKey.saveKey(key, deps);
    await fn({ key, seen, deps });
  } finally {
    https.request = real.https; http.request = real.http;
    cloudKey._use(null);
    for (const v of ['ZN_HOME', 'ZN_API_URL', 'ZN_API_KEY', 'ZN_CLOUD', 'ZN_LOCAL_ONLY']) delete process.env[v];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('resolveEndpoint: a stored key ignores --url and ZN_API_URL, an explicit key does not', () => {
  process.env.ZN_API_URL = OTHER;
  try {
    assert.equal(client.resolveEndpoint({ apiUrl: OTHER }, { stored: true }), 'https://api.usezn.com/v30/analyze');
    assert.equal(client.resolveEndpoint({}, { stored: true }), 'https://api.usezn.com/v30/analyze');
    assert.equal(client.resolveEndpoint({ stage: 'prod' }, { stored: true }), 'https://api.usezn.com/prod/analyze');
    assert.equal(client.resolveEndpoint({ apiUrl: OTHER }), OTHER);
    assert.equal(client.resolveEndpoint({}), OTHER);
  } finally { delete process.env.ZN_API_URL; }
});

test('analyze() with the stored key sends it only to api.usezn.com, even with --url or ZN_API_URL', async () => {
  await withConnectedKey(async ({ key, seen }) => {
    const r = await client.analyze('What is the weather today?', { apiUrl: OTHER });
    assert.deepEqual(seen.map((s) => s.host), ['api.usezn.com']);
    assert.equal(seen[0].auth, 'Bearer ' + key);
    assert.ok(r.fallback, 'the stub fails, so the local result is returned');
    seen.length = 0;
    process.env.ZN_API_URL = OTHER;
    await client.analyze('What is the weather today?', {});
    assert.deepEqual(seen.map((s) => s.host), ['api.usezn.com']);
  });
});

test('analyze() tells the person the custom URL was ignored for the saved key', async () => {
  await withConnectedKey(async () => {
    const https = require('https');
    https.request = (u, o, cb) => {
      const req = new EventEmitter();
      req.write = () => {}; req.destroy = () => {};
      req.end = () => setImmediate(() => {
        const res = new EventEmitter(); res.statusCode = 200;
        cb(res); res.emit('data', JSON.stringify({ verdict: 'allow', confidence: 0.1, rule: 'none' })); res.emit('end');
      });
      return req;
    };
    const r = await client.analyze('What is the weather today?', { apiUrl: OTHER });
    assert.equal(r.mode, 'hybrid-cloud');
    assert.match(r.note, /only sent to api\.usezn\.com/);
  });
});

test('a key given with --key or ZN_API_KEY (and ZN_CLOUD=1) still goes to a custom URL', async () => {
  await withConnectedKey(async ({ seen }) => {
    const explicit = freshKey();
    process.env.ZN_CLOUD = '1';
    await client.analyze('What is the weather today?', { apiKey: explicit, apiUrl: OTHER });
    assert.deepEqual(seen.map((s) => s.host), ['collector.example.invalid']);
    assert.equal(seen[0].auth, 'Bearer ' + explicit);
    seen.length = 0;
    process.env.ZN_API_KEY = explicit;
    process.env.ZN_API_URL = OTHER;
    await client.analyze('What is the weather today?', {});
    assert.deepEqual(seen.map((s) => s.host), ['collector.example.invalid']);
    assert.equal(seen[0].auth, 'Bearer ' + explicit);
  });
});

test('the analyze_prompt MCP tool sends the stored key only to api.usezn.com', async () => {
  await withConnectedKey(async ({ key, seen }) => {
    await mcp.handleRequest({ id: 1, method: 'tools/call', params: { name: 'analyze_prompt', arguments: { text: 'What is the weather today?' } } }, { apiUrl: OTHER });
    assert.deepEqual(seen.map((s) => s.host), ['api.usezn.com']);
    assert.equal(seen[0].auth, 'Bearer ' + key);
  });
});

test('status shows the fixed endpoint for the stored key', async () => {
  await withConnectedKey(async () => {
    assert.equal(client.usesStoredKey({}), true);
    // The marker alone turns the cloud on: a key given without ZN_CLOUD=1 takes no part.
    assert.equal(client.usesStoredKey({ apiKey: freshKey() }), true);
    process.env.ZN_CLOUD = '1';
    assert.equal(client.usesStoredKey({ apiKey: freshKey() }), false);
  });
});

test('deleteKey does not report success while the key is still in the keychain', async () => {
  await withConnectedKey(async ({ key }) => {
    const stuck = { native: { name: 'fake', slot: {}, impl: { store() {}, load: () => key, remove: () => false } }, vault: { isUnlocked: async () => false } };
    const r = await cloudKey.deleteKey(stuck);
    assert.equal(r.removed, false);
    assert.match(r.error.message, /still in the system keychain/);
    assert.ok(cloudKey.readMarker(), 'the marker stays so a second try works');
    const gone = { native: { name: 'fake', slot: {}, impl: { store() {}, load: () => null, remove: () => false } }, vault: { isUnlocked: async () => false } };
    assert.equal((await cloudKey.deleteKey(gone)).removed, true, 'already gone counts as removed');
  });
});

test('without a native keychain deleteKey says it could not remove the key', async () => {
  await withConnectedKey(async () => {
    const r = await cloudKey.deleteKey({ native: null, vault: { isUnlocked: async () => false } });
    assert.equal(r.removed, false);
    assert.match(r.error.message, /keychain is not available/);
  });
});
