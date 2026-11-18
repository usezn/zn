'use strict';

// The cloud check needs the person's own opt-in. A marker in ~/.zn/config.json that `connect` did not write
// (an agent can create a file by building its path at run time) must not send text anywhere, with or without
// ZN_API_KEY in the environment, and a marker that is real uses only the stored key, only for api.usezn.com.
// A stubbed HTTPS/HTTP layer records every request: nothing touches the network or a real keychain.

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
const TEXT = 'What is the weather today?';
const ENV_VARS = ['ZN_HOME', 'ZN_API_URL', 'ZN_API_KEY', 'ZN_CLOUD', 'ZN_LOCAL_ONLY'];

function memKeychain(initial) {
  let mem = initial || null;
  const impl = { store: (k) => { mem = k; }, load: () => mem, remove: () => { mem = null; return true; } };
  return { native: { name: 'fake', slot: { service: 'zn-cloud', account: 'cloud-api-key' }, impl }, vault: { isUnlocked: async () => false }, get: () => mem };
}

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-optin-'));
  process.env.ZN_HOME = home;
  const https = require('https');
  const http = require('http');
  const real = { https: https.request, http: http.request };
  const seen = [];
  const stub = (proto) => (u, o) => {
    const url = typeof u === 'string' || u instanceof URL ? new URL(String(u)) : null;
    const opts = url ? o : u;
    seen.push({ proto, host: url ? url.hostname : opts.hostname, auth: String((opts.headers || {}).Authorization || '') });
    const req = new EventEmitter();
    req.write = () => {}; req.destroy = () => {}; req.setTimeout = () => {};
    req.end = () => setImmediate(() => req.emit('error', new Error('stubbed')));
    return req;
  };
  https.request = stub('https'); http.request = stub('http');
  const errWrite = process.stderr.write;
  const notes = [];
  process.stderr.write = (s) => { notes.push(String(s)); return true; };
  try {
    await fn({ home, seen, notes });
  } finally {
    process.stderr.write = errWrite;
    https.request = real.https; http.request = real.http;
    cloudKey._use(null);
    for (const v of ENV_VARS) delete process.env[v];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const writeMarker = (home, cloud) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ cloud }));

test('a hand-written marker plus ZN_API_KEY, without ZN_CLOUD, sends nothing', async () => {
  await withHome(async ({ home, seen }) => {
    writeMarker(home, { store: 'keychain' });
    process.env.ZN_API_KEY = freshKey();
    cloudKey._use(memKeychain());
    const r = await client.analyze(TEXT, {});
    assert.equal(seen.length, 0, 'no request');
    assert.equal(r.mode, 'oss-local');
    // the same with a marker that carries a made-up last4, and with an http URL
    writeMarker(home, { store: 'keychain', last4: 'abcd' });
    process.env.ZN_API_URL = 'http://127.0.0.1:9/x';
    await client.analyze(TEXT, {});
    await client.analyze(TEXT, { apiKey: freshKey(), apiUrl: 'http://127.0.0.1:9/x' });
    assert.equal(seen.length, 0, 'still no request');
  });
});

test('a marker with a stored key that does not match its last four characters is not used', async () => {
  await withHome(async ({ home, seen }) => {
    const key = freshKey();
    cloudKey._use(memKeychain(key));
    writeMarker(home, { store: 'keychain', last4: key.slice(-4) === 'zzzz' ? 'yyyy' : 'zzzz' });
    const r = await client.analyze(TEXT, {});
    assert.equal(seen.length, 0);
    assert.equal(r.fallback, true);
    // a marker without last4 proves nothing either
    writeMarker(home, { store: 'keychain' });
    await client.analyze(TEXT, {});
    assert.equal(seen.length, 0);
  });
});

test('a marker with no stored key stays local and prints one quiet note', async () => {
  await withHome(async ({ home, seen, notes }) => {
    cloudKey._use(memKeychain());
    writeMarker(home, { store: 'keychain', last4: 'abcd' });
    const r = await client.analyze(TEXT, {});
    assert.equal(r.mode, 'oss-local');
    assert.equal(r.fallback, true);
    await client.analyze(TEXT, {});
    assert.equal(seen.length, 0);
    assert.ok(notes.length <= 1, 'at most one note');
  });
});

test('a real marker uses the stored key, over https, to api.usezn.com only, ignoring ZN_API_KEY and ZN_API_URL', async () => {
  await withHome(async ({ seen }) => {
    const key = freshKey();
    const deps = memKeychain();
    cloudKey._use(deps);
    await cloudKey.saveKey(key, deps);
    process.env.ZN_API_KEY = freshKey();
    process.env.ZN_API_URL = 'http://127.0.0.1:9/x';
    await client.analyze(TEXT, {});
    await client.analyze(TEXT, { apiKey: freshKey(), apiUrl: 'http://collector.example.invalid/x' });
    assert.equal(seen.length, 2);
    for (const s of seen) {
      assert.equal(s.proto, 'https');
      assert.equal(s.host, 'api.usezn.com');
      assert.equal(s.auth, 'Bearer ' + key, 'the stored key, never the environment key');
    }
  });
});

test('ZN_API_KEY with ZN_CLOUD=1 keeps its documented behaviour, also with a marker', async () => {
  await withHome(async ({ seen }) => {
    const deps = memKeychain();
    cloudKey._use(deps);
    await cloudKey.saveKey(freshKey(), deps);
    const own = freshKey();
    process.env.ZN_API_KEY = own;
    process.env.ZN_CLOUD = '1';
    process.env.ZN_API_URL = 'https://api.usezn.com/prod/analyze';
    await client.analyze(TEXT, {});
    assert.deepEqual(seen.map((s) => [s.proto, s.host, s.auth]), [['https', 'api.usezn.com', 'Bearer ' + own]]);
    // A URL to another host is refused before anything is sent.
    seen.length = 0;
    process.env.ZN_API_URL = 'https://collector.example.invalid/x';
    await client.analyze(TEXT, {});
    assert.equal(seen.length, 0);
  });
});

test('ZN_API_KEY alone, with no marker, does nothing', async () => {
  await withHome(async ({ seen }) => {
    process.env.ZN_API_KEY = freshKey();
    assert.equal(client.isCloudEnabled({}), false);
    await client.analyze(TEXT, {});
    assert.equal(seen.length, 0);
  });
});
