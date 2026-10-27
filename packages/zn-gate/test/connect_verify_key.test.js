'use strict';

// zn-gate connect: verifyKey maps what the server says about a key to a state. The API host is fixed in
// the module, so the test hands it an `https` stand-in that sends the request to a local fake server.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { verifyKey, VERIFY_PATH } = require('../lib/connect-cli');

const KEY = 'zn_test_' + 'x'.repeat(24);

function toLocal(port, seen) {
  return {
    request(opts, cb) {
      if (seen) seen.push({ method: opts.method, path: opts.path, auth: opts.headers && opts.headers.Authorization });
      return http.request({ ...opts, hostname: '127.0.0.1', port, timeout: 2000 }, cb);
    },
  };
}

async function fake(t, status, body) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  server.keepAliveTimeout = 1;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return server.address().port;
}

test('verifyKey: 200 means a full-access key', async (t) => {
  const seen = [];
  const port = await fake(t, 200, '{"plan":"free"}');
  assert.deepEqual(await verifyKey(toLocal(port, seen), KEY), { state: 'full', detail: null });
  assert.deepEqual(seen, [{ method: 'GET', path: VERIFY_PATH, auth: 'Bearer ' + KEY }]);
});

test('verifyKey: 401 means rejected', async (t) => {
  const port = await fake(t, 401, '{"error":"unauthorized"}');
  assert.deepEqual(await verifyKey(toLocal(port), KEY), { state: 'rejected', detail: null });
});

test('verifyKey: 403 with key_scope means an analysis-only key', async (t) => {
  const port = await fake(t, 403, '{"error":"key_scope"}');
  assert.deepEqual(await verifyKey(toLocal(port), KEY), { state: 'analyze', detail: null });
});

test('verifyKey: 403 with another error or a body that is not JSON is a failure', async (t) => {
  const other = await fake(t, 403, '{"error":"forbidden"}');
  assert.deepEqual(await verifyKey(toLocal(other), KEY), { state: 'failed', detail: 'HTTP 403' });
  const plain = await fake(t, 403, 'nope');
  assert.deepEqual(await verifyKey(toLocal(plain), KEY), { state: 'failed', detail: 'HTTP 403' });
});

test('verifyKey: any other status is a failure that names the status', async (t) => {
  const port = await fake(t, 500, '{"error":"boom"}');
  assert.deepEqual(await verifyKey(toLocal(port), KEY), { state: 'failed', detail: 'HTTP 500' });
});

test('verifyKey: a refused connection is a failure without the key in the detail', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const r = await verifyKey(toLocal(port), KEY);
  assert.equal(r.state, 'failed');
  assert.equal(typeof r.detail, 'string');
  assert.ok(r.detail.length > 0);
  assert.ok(!r.detail.includes(KEY));
});
