'use strict';
/* Request shape, error answers, single attempts and timeouts of the team API client (fake fetch and raw servers only). */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApi, TeamApiError } = require('../lib/team/api');

const BASE = 'https://api.example.test';
const TOKEN = 'zni_6f1c2a3e-1234-4abc-8def-0123456789ab_' + 'd'.repeat(32);

/** A fetch stand-in that records every call and answers with `make(callIndex)`. */
function fakeFetch(make) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return make(calls.length - 1, init);
  };
  return { calls, fetchImpl };
}

const json = (status, obj, headers) => new Response(JSON.stringify(obj), { status, headers });

test('ingest: POSTs the JSON body with the token, content type and user agent', async () => {
  const { calls, fetchImpl } = fakeFetch(() => json(200, { accepted: 2 }));
  const api = createApi({ base: BASE, token: TOKEN, userAgent: 'zn-gate/9.9.9', fetchImpl });
  const body = { install_id: 'id-1', events: [{ seq: 1 }] };
  const r = await api.ingest(body);
  assert.deepStrictEqual(r, { status: 200, body: { accepted: 2 } });
  assert.strictEqual(calls.length, 1);
  const { url, init } = calls[0];
  assert.strictEqual(url, `${BASE}/v1/audit/ingest`);
  assert.strictEqual(init.method, 'POST');
  assert.strictEqual(init.redirect, 'error');
  assert.strictEqual(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(init.headers['Content-Type'], 'application/json');
  assert.strictEqual(init.headers['User-Agent'], 'zn-gate/9.9.9');
  assert.strictEqual(init.headers.Accept, 'application/json');
  assert.deepStrictEqual(JSON.parse(init.body), body);
  assert.ok(init.signal && typeof init.signal.aborted === 'boolean');
});

test('join and preview: POST to their paths without an Authorization header', async () => {
  const { calls, fetchImpl } = fakeFetch(() => json(404, { code: 'other' }));
  const api = createApi({ base: BASE, token: TOKEN, fetchImpl });
  await api.preview('znj_example').catch(() => {});
  await api.join({ join_token: 'znj_example' }).catch(() => {});
  assert.deepStrictEqual(calls.map((c) => c.url), [`${BASE}/v1/org/join-preview`, `${BASE}/v1/org/join`]);
  for (const { init } of calls) {
    assert.strictEqual(init.method, 'POST');
    assert.strictEqual(init.headers.Authorization, undefined);
    assert.strictEqual(init.headers['Content-Type'], 'application/json');
  }
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { join_token: 'znj_example' });
});

test('getPolicy: GET without a body; If-None-Match only when an etag is given', async () => {
  const { calls, fetchImpl } = fakeFetch(() => new Response('', { status: 404 }));
  const api = createApi({ base: BASE, token: TOKEN, fetchImpl });
  await api.getPolicy();
  await api.getPolicy({ etag: '"v7"' });
  assert.strictEqual(calls[0].init.method, 'GET');
  assert.strictEqual(calls[0].init.body, undefined);
  assert.strictEqual(calls[0].init.headers['Content-Type'], undefined);
  assert.strictEqual(calls[0].init.headers['If-None-Match'], undefined);
  assert.strictEqual(calls[1].init.headers['If-None-Match'], '"v7"');
});

test('getPolicy: a 304 without an ETag header keeps the one that was sent', async () => {
  const { fetchImpl } = fakeFetch(() => new Response(null, { status: 304 }));
  const api = createApi({ base: BASE, token: TOKEN, fetchImpl });
  assert.deepStrictEqual(await api.getPolicy({ etag: '"v7"' }), { status: 304, etag: '"v7"' });
  assert.deepStrictEqual(await api.getPolicy(), { status: 304, etag: undefined });
});

test('ingest: needs a token and makes no request without one', async () => {
  const { calls, fetchImpl } = fakeFetch(() => json(200, {}));
  const api = createApi({ base: BASE, fetchImpl });
  await assert.rejects(api.ingest({}), (e) => e.code === 'ZN_USAGE');
  assert.strictEqual(calls.length, 0);
});

test('ingest: error statuses carry status, a capped error text and the parsed body', async () => {
  const cases = [[400, 'bad_batch'], [401, 'revoked'], [402, 'inactive'], [409, 'chain'], [422, 'mac'], [429, 'slow down'], [500, 'oops'], [503, 'busy']];
  for (const [status, error] of cases) {
    const { fetchImpl } = fakeFetch(() => json(status, { error, expected: 3 }));
    const api = createApi({ base: BASE, token: TOKEN, fetchImpl });
    await assert.rejects(api.ingest({}), (e) => {
      assert.ok(e instanceof TeamApiError);
      assert.strictEqual(e.code, 'ZN_TEAM_HTTP');
      assert.strictEqual(e.status, status);
      assert.strictEqual(e.message, `zn cloud answered HTTP ${status}: ${error}`);
      assert.deepStrictEqual(e.body, { error, expected: 3 });
      return true;
    }, String(status));
  }
});

test('ingest: an error answer without JSON has no detail and a null body', async () => {
  for (const text of ['', '<html>down</html>']) {
    const { fetchImpl } = fakeFetch(() => new Response(text, { status: 502 }));
    const api = createApi({ base: BASE, token: TOKEN, fetchImpl });
    await assert.rejects(api.ingest({}), (e) => e.message === 'zn cloud answered HTTP 502' && e.body === null && e.status === 502);
  }
});

test('ingest: a 200 that is not a JSON object is a bad response', async () => {
  for (const text of ['', 'ok', '[1]', '"x"', '7']) {
    const { fetchImpl } = fakeFetch(() => new Response(text, { status: 200 }));
    const api = createApi({ base: BASE, token: TOKEN, fetchImpl });
    await assert.rejects(api.ingest({}), (e) => e.code === 'ZN_TEAM_BAD_RESPONSE' && e.status === 200, JSON.stringify(text));
  }
});

test('ingest: other 2xx statuses are not success', async () => {
  const { fetchImpl } = fakeFetch(() => json(202, { accepted: 1 }));
  const api = createApi({ base: BASE, token: TOKEN, fetchImpl });
  await assert.rejects(api.ingest({}), (e) => e.code === 'ZN_TEAM_HTTP' && e.status === 202);
});

test('the client never retries: every failure is exactly one request', async () => {
  for (const make of [() => json(503, { error: 'busy' }), () => json(429, {}), () => { throw new Error('socket hang up'); }]) {
    const { calls, fetchImpl } = fakeFetch(make);
    const api = createApi({ base: BASE, token: TOKEN, fetchImpl });
    await api.ingest({}).then(() => assert.fail('should reject'), () => {});
    await api.getPolicy().then(() => assert.fail('should reject'), () => {});
    assert.strictEqual(calls.length, 2);
  }
});

test('a fetch that throws becomes ZN_TEAM_NETWORK and the cause text is not leaked', async () => {
  const { fetchImpl } = fakeFetch(() => { throw new Error(`connect ECONNREFUSED Bearer ${TOKEN}`); });
  const api = createApi({ base: BASE, token: TOKEN, fetchImpl });
  await assert.rejects(api.getPolicy(), (e) => {
    assert.strictEqual(e.code, 'ZN_TEAM_NETWORK');
    assert.strictEqual(e.status, 0);
    assert.strictEqual(e.message, 'could not reach zn cloud (network error)');
    return true;
  });
});

test('timeout: the request signal is aborted and the error names the limit', async () => {
  let signal;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    signal = init.signal;
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const api = createApi({ base: BASE, token: TOKEN, timeoutMs: 50, fetchImpl });
  await assert.rejects(api.ingest({}), (e) => e.code === 'ZN_TEAM_TIMEOUT' && e.message === 'zn cloud did not answer within 50 ms' && e.status === 0);
  assert.strictEqual(signal.aborted, true);
});

test('timeout: a body that stalls after the headers also times out', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"acc');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  const api = createApi({ base: `http://127.0.0.1:${server.address().port}`, token: TOKEN, timeoutMs: 200 });
  await assert.rejects(api.ingest({}), (e) => e.code === 'ZN_TEAM_TIMEOUT');
});

test('a fast answer leaves no pending timer that is aborted later', async () => {
  let signal;
  const fetchImpl = async (url, init) => {
    signal = init.signal;
    return json(200, { accepted: 0 });
  };
  const api = createApi({ base: BASE, token: TOKEN, timeoutMs: 50, fetchImpl });
  await api.ingest({});
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.strictEqual(signal.aborted, false);
});

test('preview: network failures and timeouts are unavailable with the error code as detail', async () => {
  const down = createApi({ base: BASE, fetchImpl: async () => { throw new Error('x'); } });
  assert.deepStrictEqual(await down.preview('znj_example'), { ok: false, reason: 'unavailable', detail: 'ZN_TEAM_NETWORK' });
  const slow = createApi({ base: BASE, timeoutMs: 30, fetchImpl: (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('a')))) });
  assert.deepStrictEqual(await slow.preview('znj_example'), { ok: false, reason: 'unavailable', detail: 'ZN_TEAM_TIMEOUT' });
});

test('preview: only the documented 404 and 402 codes get a specific reason', async () => {
  const answer = async (status, body) => createApi({ base: BASE, fetchImpl: async () => json(status, body) }).preview('znj_example');
  assert.deepStrictEqual(await answer(404, { code: 'invalid_join_token' }), { ok: false, reason: 'invalid' });
  assert.deepStrictEqual(await answer(402, { code: 'no_subscription' }), { ok: false, reason: 'no_subscription' });
  assert.deepStrictEqual(await answer(404, { code: 'nope' }), { ok: false, reason: 'unavailable', detail: 'HTTP 404' });
  assert.deepStrictEqual(await answer(402, { code: 'invalid_join_token' }), { ok: false, reason: 'unavailable', detail: 'HTTP 402' });
  assert.deepStrictEqual(await answer(429, {}), { ok: false, reason: 'unavailable', detail: 'HTTP 429' });
  assert.deepStrictEqual(await answer(500, 'text'), { ok: false, reason: 'unavailable', detail: 'HTTP 500' });
});

test('preview: an oversized answer is unavailable with the bad-response code', async () => {
  const big = 'x'.repeat(1024 * 1024 + 10);
  const api = createApi({ base: BASE, fetchImpl: async () => new Response(big, { status: 200 }) });
  assert.deepStrictEqual(await api.preview('znj_example'), { ok: false, reason: 'unavailable', detail: 'ZN_TEAM_BAD_RESPONSE' });
});

test('a body of exactly the size limit is read; one byte more is refused', async () => {
  const exact = JSON.stringify({ pad: '' }).length;
  const fill = (n) => JSON.stringify({ pad: 'x'.repeat(n - exact) });
  const at = fill(1024 * 1024);
  assert.strictEqual(at.length, 1024 * 1024);
  const ok = createApi({ base: BASE, token: TOKEN, fetchImpl: async () => new Response(at, { status: 200 }) });
  assert.strictEqual((await ok.ingest({})).status, 200);
  const over = createApi({ base: BASE, token: TOKEN, fetchImpl: async () => new Response(fill(1024 * 1024 + 1), { status: 200 }) });
  await assert.rejects(over.ingest({}), (e) => e.code === 'ZN_TEAM_BAD_RESPONSE');
});

test('createApi: option checks for timeout, fetch and user agent', () => {
  for (const timeoutMs of [0, -1, 1.5, '10', NaN]) {
    assert.throws(() => createApi({ base: BASE, timeoutMs }), (e) => e.code === 'ZN_USAGE', String(timeoutMs));
  }
  assert.throws(() => createApi({ base: BASE, fetchImpl: 'nope' }), (e) => e.code === 'ZN_USAGE');
  for (const userAgent of ['', 5]) {
    assert.throws(() => createApi({ base: BASE, userAgent }), (e) => e.code === 'ZN_USAGE');
  }
  assert.strictEqual(createApi({ base: 'https://API.Example.test/' }).base, 'https://api.example.test');
});
