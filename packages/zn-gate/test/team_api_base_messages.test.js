'use strict';
/*
 * zn cloud client: messages of the base address check, the base used for requests, and the fields of
 * TeamApiError. Uses a stub fetch, no network. Values are fictitious.
 */

const test = require('node:test');
const assert = require('node:assert');
const { checkBase, createApi, TeamApiError } = require('../lib/team/api');

test('checkBase: a usage error is a plain Error with a clear message for each refusal', () => {
  const cases = [
    ['http://example.test', /must use https/],
    ['http://192.0.2.10:8080', /must use https/],
    ['https://example.test/v1', /must not contain a path/],
    ['http://127.0.0.1/v1', /must not contain a path/],
    ['https://example.test?x=1', /query or fragment/],
    ['https://example.test#top', /query or fragment/],
    ['https://user:pw@example.test', /credentials/],
    ['not a url', /not a valid URL/],
    ['', /non-empty string/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(
      () => checkBase(input),
      (err) => err instanceof Error && !(err instanceof TeamApiError) && err.code === 'ZN_USAGE' && pattern.test(err.message),
      input,
    );
  }
});

test('checkBase: a base address with a trailing slash gives the same origin as without it', () => {
  for (const base of ['https://example.test', 'https://example.test:8443', 'http://127.0.0.1:3000', 'http://127.0.0.1']) {
    assert.strictEqual(checkBase(`${base}/`), base);
    assert.strictEqual(checkBase(base), base);
  }
});

test('createApi: https and loopback http base addresses are accepted, other http is refused', () => {
  assert.strictEqual(createApi({ base: 'https://example.test/', fetchImpl: async () => null }).base, 'https://example.test');
  assert.strictEqual(createApi({ base: 'http://127.0.0.1:4000/', fetchImpl: async () => null }).base, 'http://127.0.0.1:4000');
  for (const base of ['http://example.test', 'http://198.51.100.7', 'https://example.test/api']) {
    assert.throws(() => createApi({ base, fetchImpl: async () => null }), (err) => err.code === 'ZN_USAGE', base);
  }
});

test('createApi: requests go to the normalized base without a doubled slash', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response('{}', { status: 404 });
  };
  const token = 'zni_00000000-0000-0000-0000-000000000000_' + 'A'.repeat(32);
  const api = createApi({ base: 'http://127.0.0.1:4000/', token, fetchImpl });
  await api.getPolicy();
  assert.deepStrictEqual(urls, ['http://127.0.0.1:4000/v1/org/policy']);
});

test('TeamApiError: fields and defaults', () => {
  const plain = new TeamApiError('boom', { code: 'ZN_TEAM_NETWORK' });
  assert.ok(plain instanceof Error);
  assert.strictEqual(plain.name, 'TeamApiError');
  assert.strictEqual(plain.message, 'boom');
  assert.strictEqual(plain.code, 'ZN_TEAM_NETWORK');
  assert.strictEqual(plain.status, 0);
  assert.strictEqual(plain.body, null);

  const full = new TeamApiError('nope', { code: 'ZN_TEAM_HTTP', status: 403, body: { error: 'denied' } });
  assert.strictEqual(full.status, 403);
  assert.deepStrictEqual(full.body, { error: 'denied' });

  const bare = new TeamApiError('bare');
  assert.strictEqual(bare.code, undefined);
  assert.strictEqual(bare.status, 0);
});

test('TeamApiError: an HTTP error answer carries code, status, body and message', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'denied' }), { status: 403 });
  const api = createApi({ base: 'https://example.test', fetchImpl });
  await assert.rejects(api.join({ join_token: 'x' }), (err) => {
    assert.ok(err instanceof TeamApiError);
    assert.strictEqual(err.name, 'TeamApiError');
    assert.strictEqual(err.code, 'ZN_TEAM_HTTP');
    assert.strictEqual(err.status, 403);
    assert.deepStrictEqual(err.body, { error: 'denied' });
    assert.strictEqual(err.message, 'zn cloud answered HTTP 403: denied');
    return true;
  });
});
