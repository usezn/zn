'use strict';

process.env.ZN_STATS = 'off';

// The API key is sent only to https://api.usezn.com. A gateway on this machine needs ZN_API_ALLOW_LOCALHOST=1, and any
// other host or plain http is refused before a request is built. Fake keys and hosts only; no request leaves the process.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');

const client = require('../lib/client');

const FAKE_KEY = 'zn_' + 'f'.repeat(48);
const VARS = ['ZN_API_URL', 'ZN_API_KEY', 'ZN_CLOUD', 'ZN_LOCAL_ONLY', 'ZN_API_ALLOW_LOCALHOST', 'ZN_HOME'];

test('the official API host over https is accepted', () => {
  for (const u of ['https://api.usezn.com/v30/analyze', 'https://api.usezn.com/prod/analyze', 'https://API.usezn.com/v30/analyze',
    'https://api.usezn.com:443/v30/analyze']) {
    assert.equal(client.endpointRefusal(u, {}), null, u);
  }
});

test('plain http, another host, a look-alike host, a port, credentials or a bad URL are refused', () => {
  for (const u of ['http://api.usezn.com/v30/analyze', 'https://collector.example.invalid/x', 'https://api.usezn.com.example.invalid/x',
    'https://evil.example.test/api.usezn.com', 'https://api.usezn.com:8443/v30/analyze', 'https://user:pw@api.usezn.com/v30/analyze',
    'http://192.0.2.10/v30/analyze', 'ftp://api.usezn.com/x', 'not a url', '']) {
    const why = client.endpointRefusal(u, { ZN_API_ALLOW_LOCALHOST: '1' });
    assert.equal(typeof why, 'string', u);
    assert.ok(why.length > 0, u);
  }
});

test('a gateway on this machine needs ZN_API_ALLOW_LOCALHOST=1', () => {
  for (const u of ['http://localhost:8080/v30/analyze', 'http://127.0.0.1:9/x', 'https://127.0.0.1/x', 'http://[::1]:8080/x']) {
    assert.match(client.endpointRefusal(u, {}), /ZN_API_ALLOW_LOCALHOST=1/, u);
    assert.match(client.endpointRefusal(u, { ZN_API_ALLOW_LOCALHOST: 'true' }), /ZN_API_ALLOW_LOCALHOST=1/, u);
    assert.equal(client.endpointRefusal(u, { ZN_API_ALLOW_LOCALHOST: '1' }), null, u);
  }
});

function noNetwork(t) {
  const calls = [];
  const real = { http: http.request, https: https.request };
  const stub = (proto) => (...args) => { calls.push(proto); throw new Error('no request expected'); };
  http.request = stub('http');
  https.request = stub('https');
  const saved = {};
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
  const errWrite = process.stderr.write;
  const stderr = [];
  process.stderr.write = (s) => { stderr.push(String(s)); return true; };
  t.after(() => {
    http.request = real.http; https.request = real.https;
    process.stderr.write = errWrite;
    for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
  });
  return { calls, stderr };
}

test('analyze() with ZN_API_KEY, ZN_CLOUD=1 and a ZN_API_URL to another host sends nothing and says why', async (t) => {
  const { calls, stderr } = noNetwork(t);
  process.env.ZN_API_KEY = FAKE_KEY;
  process.env.ZN_CLOUD = '1';
  process.env.ZN_API_URL = 'http://collector.example.invalid/analyze';
  const r = await client.analyze('What is the weather today?', {});
  assert.deepEqual(calls, []);
  assert.equal(r.fallback, true);
  assert.equal(r.mode, 'oss-local');
  assert.match(r.cloud_error, /only sent to https:\/\/api\.usezn\.com/);
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
  assert.ok(stderr.some((l) => /Cloud check not used/.test(l) && /ZN_API_URL/.test(l)), stderr.join(''));
});

test('analyze() with an apiUrl on this machine and no switch sends nothing', async (t) => {
  const { calls } = noNetwork(t);
  process.env.ZN_CLOUD = '1';
  const r = await client.analyze('What is the weather today?', { apiKey: FAKE_KEY, apiUrl: 'http://127.0.0.1:9/v30/analyze' });
  assert.deepEqual(calls, []);
  assert.match(r.cloud_error, /ZN_API_ALLOW_LOCALHOST=1/);
});
