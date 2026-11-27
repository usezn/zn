'use strict';
// The cloud client sends an explicit API key only over https (plain http only to this machine). A refused endpoint
// makes no request at all and the local rules decide, as in the Python package.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const { analyze, _checkEndpoint: checkEndpoint } = require('../lib/client');

const KEY = 'zn_test_' + 'a1b2c3d4e5f6a7b8c9d0e1f2';
const TEXT = 'The quarterly report lists the shipping dates for each warehouse.';

function withCloud(t) {
  const saved = {};
  for (const [k, v] of Object.entries({ ZN_CLOUD: '1', ZN_LOCAL_ONLY: undefined, ZN_API_URL: undefined })) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

// Replaces http.request and https.request with a counter that never opens a socket.
function stubRequests(t) {
  const calls = [];
  const fake = (label) => (...args) => {
    calls.push({ label, url: String(args[0] && args[0].href ? args[0].href : args[0]) });
    throw new Error('network blocked by the test');
  };
  const origHttp = http.request;
  const origHttps = https.request;
  http.request = fake('http');
  https.request = fake('https');
  t.after(() => { http.request = origHttp; https.request = origHttps; });
  return calls;
}

const REFUSED = [
  'http://example.test/v30/analyze',
  'http://example.com:8080/v30/analyze',
  'http://localhost.example.test/v30/analyze',
  'http://127.0.0.1.example.test/v30/analyze',
  'http://localhost@evil.test/v30/analyze',
  'http://localhost:80@evil.test/v30/analyze',
  'http://user:pass@evil.test/v30/analyze',
  'http://evil.test#@localhost/v30/analyze',
  'http://evil.test' + String.fromCharCode(92) + '@localhost/v30/analyze',
  'http://notlocalhost/v30/analyze',
  'http://127.0.0.1.evil.test/v30/analyze',
  'http://128.0.0.1/v30/analyze',
  'http://[::2]/v30/analyze',
  'http://0.0.0.0/v30/analyze',
  'ftp://localhost/v30/analyze',
  'file:///etc/passwd',
  'not a url',
  '',
];

for (const url of REFUSED) {
  test('an explicit key is not sent to ' + JSON.stringify(url) + ': no request, local rules decide', async (t) => {
    withCloud(t);
    const calls = stubRequests(t);
    const r = await analyze(TEXT, { apiKey: KEY, apiUrl: url || 'http://' });
    assert.deepEqual(calls, []);
    assert.equal(r.mode, 'oss-local');
    assert.equal(r.fallback, true);
    assert.match(r.cloud_error, /must be an https URL/);
  });
}

test('the same refusal applies to ZN_API_URL', async (t) => {
  withCloud(t);
  process.env.ZN_API_URL = 'http://example.test/v30/analyze';
  const calls = stubRequests(t);
  const r = await analyze(TEXT, { apiKey: KEY });
  assert.deepEqual(calls, []);
  assert.equal(r.fallback, true);
  assert.match(r.cloud_error, /must be an https URL/);
});

const ALLOWED = [
  'http://localhost/v30/analyze',
  'http://localhost:8080/v30/analyze',
  'http://LOCALHOST:8080/v30/analyze',
  'http://127.0.0.1:9/v30/analyze',
  'http://127.1.2.3/v30/analyze',
  'http://[::1]:9/v30/analyze',
  'https://api.usezn.com/v30/analyze',
  'https://cloud.example.com/analyze',
  'HTTPS://cloud.example.com/analyze',
];

for (const url of ALLOWED) {
  test('endpoint ' + url + ' is accepted by the scheme and host check', () => {
    assert.doesNotThrow(() => checkEndpoint(url));
  });
}

for (const [url, lib] of [['http://localhost:9/a', 'http'], ['http://127.0.0.1:9/a', 'http'], ['http://[::1]:9/a', 'http'], ['https://cloud.example.com/a', 'https']]) {
  test('analyze goes on to make the request to ' + url, async (t) => {
    withCloud(t);
    const calls = stubRequests(t);
    const r = await analyze(TEXT, { apiKey: KEY, apiUrl: url });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].label, lib);
    // The stub made the request fail, which is an ordinary cloud error, not the https refusal.
    assert.doesNotMatch(r.cloud_error, /must be an https URL/);
  });
}

test('a request to a refused endpoint makes no socket even against a live plain-http server', async (t) => {
  withCloud(t);
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; req.resume(); res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  // localhost@evil.test resolves to evil.test, never to the server; the server on 127.0.0.1 is the allowed case.
  const r = await analyze(TEXT, { apiKey: KEY, apiUrl: 'http://localhost@evil.test:' + port + '/v30/analyze' });
  assert.equal(hits, 0);
  assert.equal(r.fallback, true);
});
