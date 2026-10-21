'use strict';
/*
 * Input validation of the zn cloud client: base URL and endpoint checks, the join response and the
 * shape of the signed policy, including hostile answers. Uses a stub fetch, no network.
 * Values are fictitious; keys are random and generated at run time.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { checkBase, createApi, TeamApiError } = require('../lib/team/api');

const b64u = (n) => crypto.randomBytes(n).toString('base64url');
const hex = (n) => crypto.randomBytes(n).toString('hex');
const ORG = 'org_AbCd1234Efgh';
const TOKEN = `zni_${crypto.randomUUID()}_${'A'.repeat(32)}`;

function goodJoin(base = 'https://api.example.test') {
  return {
    org: ORG,
    org_name: 'Example Org',
    install_token: TOKEN,
    policy_url: `${base}/v1/org/policy`,
    audit_url: `${base}/v1/audit/ingest`,
    telemetry_url: `${base}/v1/telemetry`,
    policy_public_key: { alg: 'Ed25519', kid: hex(8), key: b64u(32) },
  };
}

function goodPolicy(overrides = {}) {
  return {
    policy: {
      org: ORG,
      version: 1,
      issued_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
      rules: [],
      ...overrides,
    },
    signature: { alg: 'Ed25519', kid: hex(8), sig: b64u(64) },
  };
}

/** An api whose fetch answers with `body` (object -> JSON, string -> raw text). */
function apiAnswering(body, { status = 200, base = 'https://api.example.test', token = TOKEN } = {}) {
  const fetchImpl = async () => new Response(body === '' ? null : (typeof body === 'string' ? body : JSON.stringify(body)), { status });
  return createApi({ base, token, fetchImpl, userAgent: 'zn-gate/test' });
}

const isBad = (err) => err instanceof TeamApiError && err.code === 'ZN_TEAM_BAD_RESPONSE';
const joinWith = (data, opts) => apiAnswering(data, opts).join({ join_token: 'x' });
const policyWith = (data, opts) => apiAnswering(data, opts).getPolicy();

/* ---------------------------------------------------------------- checkBase */

test('checkBase: scheme and host case, default ports and IPv4 trailing dot are normalized', () => {
  assert.strictEqual(checkBase('http://127.0.0.1.'), 'http://127.0.0.1');
  assert.strictEqual(checkBase('HTTP://LOCALHOST:3000'), 'http://localhost:3000');
  assert.strictEqual(checkBase('HTTPS://API.EXAMPLE.TEST'), 'https://api.example.test');
  assert.strictEqual(checkBase('https://api.example.test:443'), 'https://api.example.test');
  assert.strictEqual(checkBase('http://[::1]'), 'http://[::1]');
  assert.strictEqual(checkBase('http://127.0.0.1:80'), 'http://127.0.0.1');
});

test('checkBase: http is refused for look-alike and non-loopback hosts', () => {
  const bad = [
    'http://localhost.example.test',
    'http://localhost.invalid',
    'http://notlocalhost',
    'http://127.0.0.1.example.test',
    'http://localhost.',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:7f00:1]',
    'http://[::]',
    'http://0.0.0.0',
    'http://192.0.2.10',
    'http://203.0.113.7:8080',
    'http://[2001:db8::1]',
    'http://localhost.example.test:80',
  ];
  for (const input of bad) {
    assert.throws(() => checkBase(input), (err) => err.code === 'ZN_USAGE', input);
  }
});

test('checkBase: userinfo, backslash and encoding tricks never get http to a non-loopback host', () => {
  const bad = [
    'http://localhost@example.test',
    'http://localhost:80@example.test',
    'http://localhost:pw@example.test',
    'https://localhost@example.test',
    'http://example.test\\@localhost',
    'http://localhost\\.example.test',
    'http://localhost%00.example.test',
    'file:///etc/passwd',
    'data:text/plain,hi',
    'ws://localhost',
    'wss://example.test',
    '//example.test',
    'example.test',
  ];
  for (const input of bad) {
    let out;
    try {
      out = checkBase(input);
    } catch (err) {
      assert.strictEqual(err.code, 'ZN_USAGE', input);
      continue;
    }
    // Whatever the URL parser makes of it, the result is an https origin or loopback http, no userinfo.
    const u = new URL(out);
    assert.ok(u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname), `${input} -> ${out}`);
    assert.ok(!out.includes('@'), `${input} -> ${out}`);
  }
});

test('checkBase: a path, query or fragment is refused', () => {
  for (const input of ['https://example.test/x', 'https://example.test//', 'http://localhost/v1', 'https://example.test/?', 'https://example.test/#', 'https://example.test/a?b#c']) {
    assert.throws(() => checkBase(input), (err) => err.code === 'ZN_USAGE', input);
  }
});

test('checkBase: non-string inputs and very long strings are refused', () => {
  for (const input of [undefined, null, 0, {}, [], ['https://example.test'], true, () => 'https://example.test', { toString: () => 'https://example.test' }]) {
    assert.throws(() => checkBase(input), (err) => err.code === 'ZN_USAGE', String(typeof input));
  }
  assert.throws(() => checkBase(`https://example.test/${'a'.repeat(100000)}`), (err) => err.code === 'ZN_USAGE');
});

test('createApi: base is validated', () => {
  assert.throws(() => createApi({ base: 'http://example.test' }), (err) => err.code === 'ZN_USAGE');
  assert.throws(() => createApi({ base: 'http://localhost@example.test' }), (err) => err.code === 'ZN_USAGE');
  assert.throws(() => createApi({}), (err) => err.code === 'ZN_USAGE');
  assert.strictEqual(createApi({ base: 'http://LOCALHOST:9' }).base, 'http://localhost:9');
});

/* ------------------------------------------------------ checkEndpoint (join) */

test('join endpoints: https on any host is accepted with the exact path', async () => {
  const data = goodJoin();
  assert.deepStrictEqual(await joinWith(data), data);
});

test('join endpoints: http endpoints need a loopback http base', async () => {
  const d = goodJoin('http://localhost:8787');
  await assert.rejects(joinWith(d), isBad);
  const loop = await joinWith(d, { base: 'http://localhost:8787' });
  assert.strictEqual(loop.policy_url, 'http://localhost:8787/v1/org/policy');
  for (const host of ['127.0.0.1', '[::1]']) {
    assert.ok(await joinWith(goodJoin(`http://${host}:1`), { base: `http://${host}:1` }));
  }
});

test('join endpoints: a loopback http base does not allow http endpoints on other hosts', async () => {
  const bad = [
    'http://localhost.example.test',
    'http://example.test',
    'http://localhost@example.test',
    'http://192.0.2.1',
    'http://[::ffff:127.0.0.1]',
    'http://localhost.',
  ];
  for (const host of bad) {
    const d = goodJoin();
    d.policy_url = `${host}/v1/org/policy`;
    await assert.rejects(joinWith(d, { base: 'http://localhost:8787' }), isBad, host);
    const d2 = goodJoin();
    d2.audit_url = `${host}/v1/audit/ingest`;
    await assert.rejects(joinWith(d2, { base: 'http://localhost:8787' }), isBad, host);
  }
});

test('join endpoints: userinfo, query, fragment, wrong path and other schemes are refused', async () => {
  const urls = [
    'https://user@api.example.test/v1/org/policy',
    'https://user:pw@api.example.test/v1/org/policy',
    'https://api.example.test/v1/org/policy?x=1',
    'https://api.example.test/v1/org/policy#frag',
    'https://api.example.test/v1/org/policy/',
    'https://api.example.test/v1/org/policy/extra',
    'https://api.example.test/v1/org/Policy',
    'https://api.example.test/v1/audit/ingest',
    'https://api.example.test/',
    'https://api.example.test',
    'ftp://api.example.test/v1/org/policy',
    'javascript:alert(1)//v1/org/policy',
    'file:///v1/org/policy',
    '/v1/org/policy',
    'v1/org/policy',
    '',
  ];
  for (const url of urls) {
    const d = goodJoin();
    d.policy_url = url;
    await assert.rejects(joinWith(d), isBad, url);
  }
});

test('join endpoints: the host is not tied to the base host (requests always use the base)', async () => {
  // The client never sends a request to a URL from the answer: it keeps using its own base.
  // The check demands https and the exact path, so another https host is accepted.
  const d = goodJoin('https://other.example.test');
  assert.deepStrictEqual(await joinWith(d, { base: 'https://api.example.test' }), d);
});

test('join endpoints: audit and telemetry follow the same rules; telemetry is optional', async () => {
  for (const field of ['audit_url', 'telemetry_url']) {
    for (const bad of [123, null, {}, [], 'http://api.example.test/x', 'https://api.example.test/v1/org/policy']) {
      const d = goodJoin();
      d[field] = bad;
      await assert.rejects(joinWith(d), isBad, `${field}=${JSON.stringify(bad)}`);
    }
  }
  const d = goodJoin();
  delete d.telemetry_url;
  assert.ok(await joinWith(d));
  const d2 = goodJoin();
  delete d2.audit_url;
  await assert.rejects(joinWith(d2), isBad);
  const d3 = goodJoin();
  delete d3.policy_url;
  await assert.rejects(joinWith(d3), isBad);
});

/* ------------------------------------------------------ validateJoinResponse */

test('join response: org id, org name and install token formats', async () => {
  const mutate = (fn) => {
    const d = goodJoin();
    fn(d);
    return d;
  };
  const bad = [
    mutate((d) => { delete d.org; }),
    mutate((d) => { d.org = 42; }),
    mutate((d) => { d.org = 'org_short'; }),
    mutate((d) => { d.org = `org_${'a'.repeat(33)}`; }),
    mutate((d) => { d.org = 'ORG_AbCd1234Efgh'; }),
    mutate((d) => { d.org = `${ORG}\n`; }),
    mutate((d) => { d.org = `${ORG}/../x`; }),
    mutate((d) => { d.org_name = ''; }),
    mutate((d) => { d.org_name = 'x'.repeat(101); }),
    mutate((d) => { d.org_name = 7; }),
    mutate((d) => { d.org_name = null; }),
    mutate((d) => { delete d.install_token; }),
    mutate((d) => { d.install_token = 'zni_nope'; }),
    mutate((d) => { d.install_token = `${TOKEN}x`; }),
    mutate((d) => { d.install_token = `${TOKEN}\n`; }),
    mutate((d) => { d.install_token = TOKEN.toUpperCase(); }),
    mutate((d) => { d.install_token = ['a']; }),
    mutate((d) => { d.install_token = 'zni_'.padEnd(200000, 'a'); }),
  ];
  for (const d of bad) await assert.rejects(joinWith(d), isBad, JSON.stringify(d).slice(0, 120));
  for (const fn of [
    (d) => { d.org_name = 'x'.repeat(100); },
    (d) => { d.org_name = 'x'; },
    (d) => { delete d.org_name; },
    (d) => { d.org = `org_${'a'.repeat(32)}`; },
    (d) => { d.org = `org_${'a'.repeat(8)}`; },
  ]) {
    assert.ok(await joinWith(mutate(fn)));
  }
});

test('join response: policy public key must be exactly {alg, kid, key} in the expected formats', async () => {
  const withKey = (key) => ({ ...goodJoin(), policy_public_key: key });
  const kid = hex(8);
  const key = b64u(32);
  const bad = [
    undefined,
    null,
    'string',
    [],
    [{ alg: 'Ed25519', kid, key }],
    {},
    { alg: 'Ed25519', kid },
    { alg: 'Ed25519', key },
    { kid, key },
    { alg: 'Ed25519', kid, key, extra: 1 },
    { alg: 'Ed25519', kid, other: key },
    { alg: 'ed25519', kid, key },
    { alg: 'RS256', kid, key },
    { alg: 'none', kid, key },
    // An upper-case hex letter makes the kid invalid; a random kid can be all digits, so one is put in.
    { alg: 'Ed25519', kid: 'A' + kid.slice(1).toUpperCase(), key },
    { alg: 'Ed25519', kid: hex(7), key },
    { alg: 'Ed25519', kid: hex(9), key },
    { alg: 'Ed25519', kid: 5, key },
    { alg: 'Ed25519', kid, key: b64u(31) },
    { alg: 'Ed25519', kid, key: b64u(33) },
    { alg: 'Ed25519', kid, key: `${key}=` },
    { alg: 'Ed25519', kid, key: key.replace(/.$/, '+') },
    { alg: 'Ed25519', kid, key: 12 },
    { alg: 'Ed25519', kid, key: 'A'.repeat(100000) },
  ];
  for (const k of bad) await assert.rejects(joinWith(withKey(k)), isBad, JSON.stringify(k));
  assert.ok(await joinWith(withKey({ alg: 'Ed25519', kid, key })));
});

test('join response: unknown top-level fields are refused', async () => {
  for (const extra of [{ admin: true }, { policy_public_keys: [] }, { org_id: ORG }, { '': 1 }, { constructor: {} }, { toString: 'x' }]) {
    await assert.rejects(joinWith({ ...goodJoin(), ...extra }), isBad, JSON.stringify(extra));
  }
});

test('join response: prototype-pollution keys are refused and pollute nothing', async () => {
  const good = JSON.stringify(goodJoin());
  await assert.rejects(joinWith(good.replace('{', '{"__proto__":{"polluted":"yes"},')), isBad);
  await assert.rejects(joinWith(good.replace('{', '{"constructor":{"prototype":{"polluted":"yes"}},')), isBad);
  await assert.rejects(joinWith(good.replace('"alg"', '"__proto__":{"polluted":"yes"},"alg"')), isBad);
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(Object.prototype.polluted, undefined);
});

test('join response: wrong container types and bad statuses', async () => {
  for (const body of ['[]', '"text"', '42', 'true', 'null', '', 'not json', '{"org":']) {
    await assert.rejects(joinWith(body), isBad, body);
  }
  const data = goodJoin();
  assert.ok(await joinWith(data, { status: 201 }));
  await assert.rejects(joinWith(data, { status: 202 }), (e) => e.code === 'ZN_TEAM_HTTP' && e.status === 202);
  await assert.rejects(joinWith(data, { status: 500 }), (e) => e.code === 'ZN_TEAM_HTTP' && e.status === 500);
});

test('join response: a huge string in a field is refused without crashing', async () => {
  const d = goodJoin();
  d.org_name = 'x'.repeat(500000);
  await assert.rejects(joinWith(d), isBad);
  const d2 = goodJoin();
  d2.policy_url = `https://api.example.test/${'a'.repeat(500000)}`;
  await assert.rejects(joinWith(d2), isBad);
});

test('join error body: the server error text is capped and the token is scrubbed', async () => {
  const body = { error: `denied ${TOKEN} ${'x'.repeat(5000)}` };
  await assert.rejects(joinWith(body, { status: 403 }), (err) => {
    assert.strictEqual(err.code, 'ZN_TEAM_HTTP');
    assert.ok(!err.message.includes(TOKEN));
    assert.ok(err.message.length < 400);
    return true;
  });
});

/* ------------------------------------------------------------ isSignedPolicy */

test('signed policy: a well-formed answer is returned as is', async () => {
  const p = goodPolicy();
  const r = await policyWith(p);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, p);
});

test('signed policy: shape errors in the envelope are refused', async () => {
  const p = goodPolicy();
  const bad = [
    [],
    {},
    { policy: p.policy },
    { signature: p.signature },
    { policy: p.policy, signature: p.signature, extra: 1 },
    { policy: null, signature: p.signature },
    { policy: [], signature: p.signature },
    { policy: 'x', signature: p.signature },
    { policy: p.policy, signature: null },
    { policy: p.policy, signature: 'abc' },
    { policy: p.policy, signature: [] },
    { policy: p.policy, signature: p.signature.sig },
  ];
  for (const b of bad) await assert.rejects(policyWith(b), isBad, JSON.stringify(b).slice(0, 100));
  for (const raw of ['[]', 'null', '"x"', '12', 'not json']) {
    await assert.rejects(policyWith(raw), isBad, raw);
  }
});

test('signed policy: org, version, timestamps and rules types are checked', async () => {
  const bad = [
    { org: undefined },
    { org: 5 },
    { org: 'org_short' },
    { org: `${ORG}\n` },
    { org: ORG.toUpperCase() },
    { version: undefined },
    { version: 0 },
    { version: -1 },
    { version: 1.5 },
    { version: '1' },
    { version: null },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { issued_at: undefined },
    { issued_at: 1700000000 },
    { issued_at: null },
    { expires_at: undefined },
    { expires_at: {} },
    { rules: undefined },
    { rules: {} },
    { rules: 'x' },
    { rules: null },
  ];
  for (const o of bad) {
    const p = goodPolicy();
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) delete p.policy[k];
      else p.policy[k] = v;
    }
    await assert.rejects(policyWith(p), isBad, JSON.stringify(o));
  }
  assert.ok(await policyWith(goodPolicy({ version: Number.MAX_SAFE_INTEGER })));
});

test('signed policy: the signature object must have exactly alg, kid and sig in format', async () => {
  const kid = hex(8);
  const sig = b64u(64);
  const bad = [
    {},
    { alg: 'Ed25519', kid },
    { alg: 'Ed25519', sig },
    { kid, sig },
    { alg: 'Ed25519', kid, sig, extra: 1 },
    { alg: 'ed25519', kid, sig },
    { alg: 'none', kid, sig },
    { alg: 'Ed25519', kid, sig: '' },
    { alg: 'Ed25519', kid, sig: b64u(63) },
    { alg: 'Ed25519', kid, sig: b64u(65) },
    { alg: 'Ed25519', kid, sig: `${sig}=` },
    { alg: 'Ed25519', kid, sig: sig.replace(/.$/, '/') },
    { alg: 'Ed25519', kid, sig: Buffer.alloc(64).toString('hex') },
    { alg: 'Ed25519', kid, sig: null },
    { alg: 'Ed25519', kid, sig: [sig] },
    { alg: 'Ed25519', kid: 'XYZ', sig },
    { alg: 'Ed25519', kid: kid.toUpperCase(), sig },
    { alg: 'Ed25519', kid: hex(16), sig },
    { alg: 'Ed25519', kid, sig: 'A'.repeat(200000) },
  ];
  for (const s of bad) {
    const p = goodPolicy();
    p.signature = s;
    await assert.rejects(policyWith(p), isBad, JSON.stringify(s).slice(0, 100));
  }
});

test('signed policy: prototype-pollution keys at the envelope are refused and pollute nothing', async () => {
  const good = JSON.stringify(goodPolicy());
  await assert.rejects(policyWith(good.replace('{', '{"__proto__":{"polluted":"yes"},')), isBad);
  await assert.rejects(policyWith(good.replace('{', '{"constructor":{"prototype":{"polluted":"yes"}},')), isBad);
  await assert.rejects(policyWith(good.replace('"alg"', '"__proto__":{"polluted":"yes"},"alg"')), isBad);
  assert.strictEqual({}.polluted, undefined);
  // Inside the policy object the shape check is open (the signature covers those fields); it must still not pollute.
  const r = await policyWith(good.replace('"rules"', '"__proto__":{"polluted":"yes"},"rules"'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(r.body.policy.polluted, undefined);
});

test('signed policy: a big rules array is accepted and an oversized body is refused', async () => {
  const p = goodPolicy();
  p.policy.rules = Array.from({ length: 5000 }, (_, i) => ({ id: `r${i}`, note: 'x'.repeat(20) }));
  assert.ok(await policyWith(p));
  const big = goodPolicy();
  big.policy.rules = ['x'.repeat(1024 * 1024 + 1)];
  await assert.rejects(policyWith(big), isBad);
});

test('signed policy: the client only checks shape; org, expiry and signature are judged by the verifier', async () => {
  // Shape-only by design: a policy for another org, an expired one or a forged signature still pass
  // this layer. The policy verifier is what refuses them (see team_policy.test.js).
  const other = goodPolicy({ org: 'org_ZzZz9999Yyyy' });
  assert.strictEqual((await policyWith(other)).body.policy.org, 'org_ZzZz9999Yyyy');
  assert.strictEqual((await policyWith(goodPolicy({ expires_at: '2000-01-01T00:00:00.000Z' }))).status, 200);
  const forged = goodPolicy();
  forged.signature.sig = 'A'.repeat(86);
  assert.strictEqual((await policyWith(forged)).status, 200);
});

test('getPolicy: sends the feature header and token, keeps the ETag, maps other statuses', async () => {
  const p = goodPolicy();
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify(p), { status: 200, headers: { etag: '"v1"' } });
  };
  const api = createApi({ base: 'https://api.example.test', token: TOKEN, fetchImpl });
  assert.strictEqual((await api.getPolicy()).etag, '"v1"');
  assert.strictEqual(seen.url, 'https://api.example.test/v1/org/policy');
  assert.strictEqual(seen.init.headers['X-ZN-Policy-Features'], 'warn');
  assert.strictEqual(seen.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(seen.init.redirect, 'error');
  assert.strictEqual((await policyWith('', { status: 404 })).status, 404);
  assert.strictEqual((await policyWith('', { status: 304 })).status, 304);
  await assert.rejects(policyWith('', { status: 200 }), isBad);
  await assert.rejects(policyWith('{}', { status: 401 }), (e) => e.code === 'ZN_TEAM_HTTP' && e.status === 401);
  const noToken = createApi({ base: 'https://api.example.test', fetchImpl: async () => new Response('{}') });
  await assert.rejects(noToken.getPolicy(), (e) => e.code === 'ZN_USAGE');
});
