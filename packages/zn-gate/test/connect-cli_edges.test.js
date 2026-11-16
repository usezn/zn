'use strict';

// Edge cases for revokeKey and openBrowser in lib/connect-cli.js.
// HTTPS and the process spawner are stubbed: no network and no real browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const childProcess = require('child_process');
const { EventEmitter } = require('events');

const connectCli = require('../lib/connect-cli');

const KEY = 'zn_' + 'ab'.repeat(24);

function fakeHttps(ans) {
  const calls = [];
  return {
    calls,
    request(opts, cb) {
      calls.push(opts);
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => setImmediate(() => {
        if (ans.throwOnRequest) return;
        if (ans.error) { req.emit('error', Object.assign(new Error(ans.error), { code: ans.error })); return; }
        if (ans.timeout) { req.emit('timeout'); return; }
        const res = new EventEmitter();
        res.statusCode = ans.status;
        res.setEncoding = () => {};
        cb(res);
        if (ans.resError) { res.emit('error', new Error(ans.resError)); return; }
        res.emit('data', ans.body || '');
        res.emit('end');
      });
      return req;
    },
  };
}

async function withCleanTls(fn) {
  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try { return await fn(); } finally {
    if (saved !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
  }
}

test('revokeKey maps each status code to a state', () => withCleanTls(async () => {
  const table = [
    [200, 'revoked', null],
    [401, 'rejected', null],
    [404, 'unavailable', 'HTTP 404'],
    [400, 'unavailable', 'HTTP 400'],
    [500, 'maybe', 'HTTP 500'],
    [403, 'failed', 'HTTP 403'],
    [204, 'failed', 'HTTP 204'],
    [502, 'failed', 'HTTP 502'],
    [199, 'failed', 'HTTP 199'],
  ];
  for (const [status, state, detail] of table) {
    const r = await connectCli.revokeKey(fakeHttps({ status }), KEY);
    assert.deepEqual(r, { state, detail }, 'status ' + status);
  }
}));

test('revokeKey sends DELETE to the fixed host with the key as a bearer token', () => withCleanTls(async () => {
  const h = fakeHttps({ status: 200 });
  await connectCli.revokeKey(h, KEY);
  assert.equal(h.calls.length, 1);
  const o = h.calls[0];
  assert.equal(o.method, 'DELETE');
  assert.equal(o.hostname, connectCli.API_HOST);
  assert.equal(o.path, connectCli.REVOKE_PATH);
  assert.equal(o.port, 443);
  assert.equal(o.rejectUnauthorized, true);
  assert.equal(o.headers.Authorization, 'Bearer ' + KEY);
}));

test('revokeKey ignores the response body', () => withCleanTls(async () => {
  const r = await connectCli.revokeKey(fakeHttps({ status: 200, body: 'not json at all' }), KEY);
  assert.equal(r.state, 'revoked');
  const big = await connectCli.revokeKey(fakeHttps({ status: 401, body: 'x'.repeat(200 * 1024) }), KEY);
  assert.equal(big.state, 'rejected');
}));

test('revokeKey reports a network error as failed', () => withCleanTls(async () => {
  const r = await connectCli.revokeKey(fakeHttps({ error: 'ECONNRESET' }), KEY);
  assert.deepEqual(r, { state: 'failed', detail: 'ECONNRESET' });
}));

test('revokeKey reports a timeout as failed', () => withCleanTls(async () => {
  const r = await connectCli.revokeKey(fakeHttps({ timeout: true }), KEY);
  assert.deepEqual(r, { state: 'failed', detail: 'timed out' });
}));

test('revokeKey reports a response stream error as failed', () => withCleanTls(async () => {
  const r = await connectCli.revokeKey(fakeHttps({ status: 200, resError: 'stream broke' }), KEY);
  assert.deepEqual(r, { state: 'failed', detail: 'stream broke' });
}));

test('revokeKey removes the key from an error message', () => withCleanTls(async () => {
  const r = await connectCli.revokeKey(fakeHttps({ error: 'bad ' + KEY + ' here' }), KEY);
  assert.equal(r.state, 'failed');
  assert.ok(!r.detail.includes(KEY));
  assert.ok(r.detail.includes('[key]'));
}));

test('revokeKey turns a throwing transport into failed', () => withCleanTls(async () => {
  const h = { request() { throw new Error('boom ' + KEY); } };
  const r = await connectCli.revokeKey(h, KEY);
  assert.equal(r.state, 'failed');
  assert.ok(!r.detail.includes(KEY));
}));

test('revokeKey refuses when certificate checks are switched off', async () => {
  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const h = fakeHttps({ status: 200 });
    const r = await connectCli.revokeKey(h, KEY);
    assert.equal(r.state, 'failed');
    assert.ok(r.detail);
    assert.equal(h.calls.length, 0);
  } finally {
    if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
  }
});

test('revokeKey with an empty key still sends only a bearer header', () => withCleanTls(async () => {
  const h = fakeHttps({ status: 401 });
  const r = await connectCli.revokeKey(h, '');
  assert.equal(r.state, 'rejected');
  assert.equal(h.calls[0].headers.Authorization, 'Bearer ');
}));

// openBrowser: replace platform, spawner and file checks for the duration of one call.
function withStubs({ platform, spawn, stat }, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  const origSpawn = childProcess.spawnSync;
  const origStat = fs.statSync;
  Object.defineProperty(process, 'platform', { value: platform });
  childProcess.spawnSync = spawn;
  if (stat) fs.statSync = stat;
  try { return fn(); } finally {
    Object.defineProperty(process, 'platform', desc);
    childProcess.spawnSync = origSpawn;
    fs.statSync = origStat;
  }
}

const URL_OK = 'https://example.com/connect';

test('openBrowser on macOS runs the system opener with the url', () => {
  const seen = [];
  const ok = withStubs({ platform: 'darwin', spawn: (c, a, o) => { seen.push([c, a, o]); return { status: 0 }; } },
    () => connectCli.openBrowser(URL_OK));
  assert.equal(ok, true);
  assert.equal(seen[0][0], '/usr/bin/open');
  assert.deepEqual(seen[0][1], [URL_OK]);
  assert.equal(seen[0][2].stdio, 'ignore');
});

test('openBrowser returns false when the helper exits non-zero', () => {
  const ok = withStubs({ platform: 'darwin', spawn: () => ({ status: 1 }) }, () => connectCli.openBrowser(URL_OK));
  assert.equal(ok, false);
});

test('openBrowser returns false when the helper was killed by a signal', () => {
  const ok = withStubs({ platform: 'darwin', spawn: () => ({ status: null, signal: 'SIGTERM' }) }, () => connectCli.openBrowser(URL_OK));
  assert.equal(ok, false);
});

test('openBrowser returns false when the helper reports an error', () => {
  const ok = withStubs({ platform: 'darwin', spawn: () => ({ status: 0, error: new Error('spawn failed') }) }, () => connectCli.openBrowser(URL_OK));
  assert.equal(ok, false);
});

test('openBrowser returns false when spawning throws', () => {
  const ok = withStubs({ platform: 'darwin', spawn: () => { throw new Error('nope'); } }, () => connectCli.openBrowser(URL_OK));
  assert.equal(ok, false);
});

test('openBrowser on Linux returns false and spawns nothing when no opener exists', () => {
  let spawned = 0;
  const ok = withStubs({
    platform: 'linux',
    spawn: () => { spawned++; return { status: 0 }; },
    stat: () => { throw new Error('ENOENT'); },
  }, () => connectCli.openBrowser(URL_OK));
  assert.equal(ok, false);
  assert.equal(spawned, 0);
});

test('openBrowser on Linux ignores an opener path that is not a file', () => {
  let spawned = 0;
  const ok = withStubs({
    platform: 'linux',
    spawn: () => { spawned++; return { status: 0 }; },
    stat: () => ({ isFile: () => false }),
  }, () => connectCli.openBrowser(URL_OK));
  assert.equal(ok, false);
  assert.equal(spawned, 0);
});

test('openBrowser on Linux uses the first opener that exists, by absolute path', () => {
  const seen = [];
  const ok = withStubs({
    platform: 'linux',
    spawn: (c, a) => { seen.push([c, a]); return { status: 0 }; },
    stat: (p) => { if (p === '/bin/xdg-open') return { isFile: () => true }; throw new Error('ENOENT'); },
  }, () => connectCli.openBrowser(URL_OK));
  assert.equal(ok, true);
  assert.equal(seen[0][0], '/bin/xdg-open');
  assert.deepEqual(seen[0][1], [URL_OK]);
});

test('openBrowser passes an empty url through as one argument', () => {
  const seen = [];
  withStubs({ platform: 'darwin', spawn: (c, a) => { seen.push(a); return { status: 0 }; } }, () => connectCli.openBrowser(''));
  assert.deepEqual(seen[0], ['']);
});
