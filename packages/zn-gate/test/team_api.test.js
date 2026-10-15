'use strict';
/* Client for the zn cloud team endpoints, tested against the local fake server. */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { checkBase, createApi, TeamApiError } = require('../lib/team/api');
const { startFakeTeamServer, canonicalJson, makeAuditChain, SPKI_PREFIX } = require('./helpers/fake_team_server');

const INSTALL_TOKEN_RE = /^zni_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9]{32}$/;
const auditKeyHex = () => crypto.randomBytes(32).toString('hex');
const installId = () => crypto.randomUUID();

async function startServer(t, opts) {
  const srv = await startFakeTeamServer(opts);
  t.after(() => srv.close());
  return srv;
}

/** A joined installation: { installId, auditKey, token, api } */
async function joinInstall(t, srv, { id = installId(), key = auditKeyHex() } = {}) {
  const joinToken = srv.createJoinToken({ maxUses: 20 });
  const api = createApi({ base: srv.base, userAgent: 'zn-gate/test' });
  const joined = await api.join({ join_token: joinToken, install_id: id, audit_key: key, agent: 'claude-code', os: 'linux', zn_gate_version: '1.5.0' });
  return { installId: id, auditKey: key, token: joined.install_token, joined, api: createApi({ base: srv.base, token: joined.install_token, userAgent: 'zn-gate/test' }) };
}

/** Starts a raw http server with a custom handler; closed when the test ends. */
async function rawServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

/* ---------------------------------------------------------------- checkBase */

test('checkBase accepts https origins and loopback http, and normalizes them', () => {
  const cases = [
    ['https://usezn.com', 'https://usezn.com'],
    ['https://usezn.com/', 'https://usezn.com'],
    ['https://api.usezn.com:8443/', 'https://api.usezn.com:8443'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['http://localhost', 'http://localhost'],
    ['http://[::1]:8080/', 'http://[::1]:8080'],
  ];
  for (const [input, want] of cases) assert.strictEqual(checkBase(input), want, input);
});

test('checkBase rejects everything else with ZN_USAGE', () => {
  const bad = [
    'http://usezn.com',
    'http://10.0.0.5:8080',
    'ftp://usezn.com',
    'javascript:alert(1)',
    'https://user:secret@usezn.com',
    'https://user@usezn.com',
    'https://usezn.com/v1',
    'https://usezn.com?x=1',
    'https://usezn.com?',
    'https://usezn.com#frag',
    'not a url',
    'https://',
    '',
    42,
    null,
  ];
  for (const input of bad) {
    assert.throws(() => checkBase(input), (err) => err.code === 'ZN_USAGE', String(input));
  }
});

/* -------------------------------------------------------------------- join */

test('preview: organization and inviter for a valid token, without using it up', async (t) => {
  const srv = await startFakeTeamServer();
  t.after(() => srv.close());
  const api = createApi({ base: srv.base, userAgent: 'zn-gate/test' });
  const tok = srv.createJoinToken({ maxUses: 1 });
  const p = await api.preview(tok);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.org_name, 'Fake Org');
  assert.strictEqual(p.invited_by, 'Dana Admin');
  assert.ok(!Number.isNaN(Date.parse(p.expires_at)));
  await api.join({ join_token: tok, install_id: installId(), audit_key: auditKeyHex(), agent: 'claude-code', os: 'linux', zn_gate_version: '1.5.0' });
  assert.deepStrictEqual(await api.preview(tok), { ok: false, reason: 'invalid' }, 'used up by the join, not by the preview');
  const body = srv.requests.find((r) => r.path === '/v1/org/join-preview');
  assert.ok(body && !body.authorized, 'no credential header; the token travels in the body');
});

test('preview: no subscription, older server and malformed answers', async (t) => {
  const srv = await startFakeTeamServer();
  t.after(() => srv.close());
  const api = createApi({ base: srv.base, userAgent: 'zn-gate/test' });
  srv.setOrgActive(false);
  assert.deepStrictEqual(await api.preview(srv.createJoinToken()), { ok: false, reason: 'no_subscription' });
  srv.setOrgActive(true);
  srv.state.previewEnabled = false;
  assert.deepStrictEqual(await api.preview(srv.createJoinToken()), { ok: false, reason: 'unavailable', detail: 'HTTP 404' });
  const bad = createApi({ base: srv.base, userAgent: 'zn-gate/test', fetchImpl: async () => new Response(JSON.stringify({ org_name: '', invited_by: 3, expires_at: 'x' }), { status: 200 }) });
  assert.deepStrictEqual(await bad.preview('znj_' + 'A'.repeat(40)), { ok: false, reason: 'unavailable', detail: 'malformed preview' });
  const down = createApi({ base: srv.base, userAgent: 'zn-gate/test', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.strictEqual((await down.preview('znj_' + 'A'.repeat(40))).reason, 'unavailable');
});

test('join registers an installation and returns a validated response', async (t) => {
  const srv = await startServer(t);
  const joinToken = srv.createJoinToken({ maxUses: 2 });
  const api = createApi({ base: srv.base, userAgent: 'zn-gate/test' });
  const id = installId();
  const res = await api.join({ join_token: joinToken, install_id: id, audit_key: auditKeyHex() });

  assert.strictEqual(res.org, srv.state.orgId);
  assert.match(res.install_token, INSTALL_TOKEN_RE);
  assert.strictEqual(res.policy_url, `${srv.base}/v1/org/policy`);
  assert.strictEqual(res.audit_url, `${srv.base}/v1/audit/ingest`);
  assert.deepStrictEqual(res.policy_public_key, { alg: 'Ed25519', kid: srv.state.kid, key: srv.state.publicKeyB64u });

  const req = srv.requests.find((r) => r.path === '/v1/org/join');
  assert.strictEqual(req.method, 'POST');
  assert.strictEqual(req.authorized, false);
  assert.strictEqual(req.headers.authorization, undefined);
  assert.strictEqual(req.headers['user-agent'], 'zn-gate/test');
  assert.match(req.headers['content-type'], /^application\/json/);
});

test('join rejects a malformed response from the server', async (t) => {
  const good = {
    org: 'org_ABCDEFGH12345678',
    install_token: 'zni_6f1c2a3e-1234-4abc-8def-0123456789ab_' + 'a'.repeat(32),
    policy_url: 'https://usezn.com/v1/org/policy',
    audit_url: 'https://usezn.com/v1/audit/ingest',
    policy_public_key: { alg: 'Ed25519', kid: '0123456789abcdef', key: 'A'.repeat(43) },
  };
  const variants = {
    'bad org id': (b) => ({ ...b, org: 'org_x' }),
    'bad install token': (b) => ({ ...b, install_token: 'zni_nope' }),
    'policy url on another path': (b) => ({ ...b, policy_url: 'https://usezn.com/v1/other' }),
    'audit url over plain http': (b) => ({ ...b, audit_url: 'http://usezn.com/v1/audit/ingest' }),
    'short public key': (b) => ({ ...b, policy_public_key: { ...b.policy_public_key, key: 'A'.repeat(42) } }),
    'wrong algorithm': (b) => ({ ...b, policy_public_key: { ...b.policy_public_key, alg: 'RS256' } }),
    'unknown field': (b) => ({ ...b, extra: 1 }),
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const api = createApi({
      base: 'https://usezn.com',
      fetchImpl: async () => new Response(JSON.stringify(mutate(good)), { status: 201, headers: { 'content-type': 'application/json' } }),
    });
    await assert.rejects(
      api.join({ join_token: 'znj_' + 'a'.repeat(40), install_id: installId(), audit_key: auditKeyHex() }),
      (err) => err instanceof TeamApiError && err.code === 'ZN_TEAM_BAD_RESPONSE',
      name,
    );
  }
  // The same shape with a valid body passes.
  const ok = createApi({
    base: 'https://usezn.com',
    fetchImpl: async () => new Response(JSON.stringify(good), { status: 201, headers: { 'content-type': 'application/json' } }),
  });
  const res = await ok.join({ join_token: 'znj_' + 'a'.repeat(40), install_id: installId(), audit_key: auditKeyHex() });
  assert.strictEqual(res.org, good.org);
});

test('join with a used-up token is refused with 403', async (t) => {
  const srv = await startServer(t);
  const joinToken = srv.createJoinToken({ maxUses: 1 });
  const api = createApi({ base: srv.base });
  await api.join({ join_token: joinToken, install_id: installId(), audit_key: auditKeyHex() });
  await assert.rejects(
    api.join({ join_token: joinToken, install_id: installId(), audit_key: auditKeyHex() }),
    (err) => err instanceof TeamApiError && err.code === 'ZN_TEAM_HTTP' && err.status === 403 && typeof err.body.error === 'string',
  );
});

test('join on an inactive organization is refused with 402', async (t) => {
  const srv = await startServer(t);
  const joinToken = srv.createJoinToken();
  srv.setOrgActive(false);
  const api = createApi({ base: srv.base });
  await assert.rejects(
    api.join({ join_token: joinToken, install_id: installId(), audit_key: auditKeyHex() }),
    (err) => err.code === 'ZN_TEAM_HTTP' && err.status === 402,
  );
});

test('joining again with a different audit key is refused with 409', async (t) => {
  const srv = await startServer(t);
  const api = createApi({ base: srv.base });
  const id = installId();
  await api.join({ join_token: srv.createJoinToken(), install_id: id, audit_key: auditKeyHex() });
  await assert.rejects(
    api.join({ join_token: srv.createJoinToken(), install_id: id, audit_key: auditKeyHex() }),
    (err) => err.code === 'ZN_TEAM_HTTP' && err.status === 409,
  );
});

test('joining again with the same audit key rotates the install token', async (t) => {
  const srv = await startServer(t);
  const api = createApi({ base: srv.base });
  const id = installId();
  const key = auditKeyHex();
  const first = await api.join({ join_token: srv.createJoinToken(), install_id: id, audit_key: key });
  const second = await api.join({ join_token: srv.createJoinToken(), install_id: id, audit_key: key });
  assert.notStrictEqual(first.install_token, second.install_token);
  await assert.rejects(createApi({ base: srv.base, token: first.install_token }).getPolicy(), (err) => err.status === 401);
  await createApi({ base: srv.base, token: second.install_token }).getPolicy().catch((err) => assert.fail(err));
});

/* -------------------------------------------------------------- getPolicy */

test('getPolicy returns 404 before a policy is published, then 200, 304 and 401 after revoke', async (t) => {
  const srv = await startServer(t);
  const inst = await joinInstall(t, srv);

  assert.deepStrictEqual(await inst.api.getPolicy(), { status: 404 });

  srv.publishPolicy({ rules: [{ secret: 'STRIPE_KEY', agents: ['claude-code'], deny: true }] });
  const first = await inst.api.getPolicy();
  assert.strictEqual(first.status, 200);
  assert.match(first.etag, /^W\/"org_[A-Za-z0-9]{16}:1:\d{8}:w"$/);
  assert.strictEqual(first.body.policy.version, 1);
  assert.strictEqual(first.body.policy.org, srv.state.orgId);
  assert.strictEqual(first.body.signature.kid, srv.state.kid);

  const again = await inst.api.getPolicy({ etag: first.etag });
  assert.strictEqual(again.status, 304);
  assert.strictEqual(again.etag, first.etag);

  const authReq = srv.requests.filter((r) => r.path === '/v1/org/policy').pop();
  assert.strictEqual(authReq.authorized, true);
  assert.strictEqual(authReq.headers.authorization, undefined);
  assert.strictEqual(authReq.headers['if-none-match'], first.etag);
  // The client says it understands warn rules, so the server may send them.
  assert.strictEqual(authReq.headers['x-zn-policy-features'], 'warn');
  assert.ok(srv.requests.filter((r) => r.path === '/v1/org/policy').every((r) => r.headers['x-zn-policy-features'] === 'warn'));

  srv.revokeInstall(inst.installId);
  await assert.rejects(inst.api.getPolicy(), (err) => err instanceof TeamApiError && err.status === 401 && err.code === 'ZN_TEAM_HTTP');
});

test('a client that does not declare warn gets warn rules without the warn field', async (t) => {
  const srv = await startServer(t);
  const inst = await joinInstall(t, srv);
  srv.publishPolicy({ rules: [{ secret: 'STAGING_*', agents: ['*'], warn: true, allowHosts: ['api.example.com'], reason: 'Needs review' }] });
  const declared = await inst.api.getPolicy();
  assert.strictEqual(declared.body.policy.rules[0].warn, true);
  // An older client: same request without the features header.
  const old = createApi({ base: srv.base, token: inst.token, userAgent: 'zn-gate/1.7.1',
    fetchImpl: (url, init) => { const h = { ...init.headers }; delete h['X-ZN-Policy-Features']; return fetch(url, { ...init, headers: h }); } });
  const r = await old.getPolicy();
  assert.deepStrictEqual(r.body.policy.rules, [{ secret: 'STAGING_*', agents: ['*'], allowHosts: ['api.example.com'], reason: 'Needs review' }]);
  assert.notStrictEqual(r.etag, declared.etag);
});

test('the signed policy verifies with node:crypto and the raw public key', async (t) => {
  const srv = await startServer(t);
  const inst = await joinInstall(t, srv);
  srv.publishPolicy({ rules: [{ secret: 'DB_*', agents: ['*'], allowHosts: ['*.example.com'] }] });
  const { body } = await inst.api.getPolicy();

  const raw = Buffer.from(inst.joined.policy_public_key.key, 'base64url');
  assert.strictEqual(raw.length, 32);
  const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  const sig = Buffer.from(body.signature.sig, 'base64url');
  assert.ok(crypto.verify(null, Buffer.from(canonicalJson(body.policy), 'utf8'), pub, sig));

  // Any change to the signed content breaks the signature.
  const tampered = { ...body.policy, version: body.policy.version + 1 };
  assert.ok(!crypto.verify(null, Buffer.from(canonicalJson(tampered), 'utf8'), pub, sig));

  // Validity is seven days from the start of the day.
  const days = (Date.parse(body.policy.expires_at) - Date.parse(body.policy.issued_at)) / 86400000;
  assert.strictEqual(days, 7);
});

/* ----------------------------------------------------------------- ingest */

test('ingest accepts a batch, trims an overlapping resend and refuses a gap with the expected head', async (t) => {
  const srv = await startServer(t);
  const inst = await joinInstall(t, srv);
  const chain = makeAuditChain({ key: inst.auditKey, count: 5 });

  const first = await inst.api.ingest({ install_id: inst.installId, events: chain.slice(0, 3) });
  assert.deepStrictEqual(first, { status: 200, body: { accepted: 3, head: { seq: 3 } } });

  const duplicate = await inst.api.ingest({ install_id: inst.installId, events: chain.slice(0, 3) });
  assert.strictEqual(duplicate.body.duplicate, true);
  assert.strictEqual(duplicate.body.accepted, 0);

  const overlap = await inst.api.ingest({ install_id: inst.installId, events: chain });
  assert.deepStrictEqual(overlap.body, { accepted: 2, head: { seq: 5 } });

  // Skips seq 6 and 7: refused with the head the client must continue from.
  const gapChain = makeAuditChain({ key: inst.auditKey, count: 2, startSeq: 7, prev: chain[4].mac });
  await assert.rejects(
    inst.api.ingest({ install_id: inst.installId, events: gapChain }),
    (err) => err.code === 'ZN_TEAM_HTTP' && err.status === 409
      && err.body.expected.seq === 6 && err.body.expected.prev === chain[4].mac,
  );

  // Continuing from the reported head is accepted.
  const next = makeAuditChain({ key: inst.auditKey, count: 2, startSeq: 6, prev: chain[4].mac });
  const ok = await inst.api.ingest({ install_id: inst.installId, events: next });
  assert.deepStrictEqual(ok.body, { accepted: 2, head: { seq: 7 } });
  assert.strictEqual(srv.state.installs.get(inst.installId).events.length, 7);
});

test('ingest refuses a batch whose MAC does not verify with 422', async (t) => {
  const srv = await startServer(t);
  const inst = await joinInstall(t, srv);
  const events = makeAuditChain({ key: inst.auditKey, count: 3 });
  events[1].reason = 'tampered';
  await assert.rejects(
    inst.api.ingest({ install_id: inst.installId, events }),
    (err) => err instanceof TeamApiError && err.status === 422 && err.code === 'ZN_TEAM_HTTP',
  );
  // Nothing was stored, so a correct batch still starts the chain.
  const good = await inst.api.ingest({ install_id: inst.installId, events: makeAuditChain({ key: inst.auditKey, count: 3 }) });
  assert.strictEqual(good.body.accepted, 3);
});

/* ------------------------------------------------------ transport failures */

test('a server that never answers gives ZN_TEAM_TIMEOUT', async (t) => {
  const base = await rawServer(t, () => {});
  const api = createApi({ base, timeoutMs: 200, token: 'zni_6f1c2a3e-1234-4abc-8def-0123456789ab_' + 'b'.repeat(32) });
  const started = Date.now();
  await assert.rejects(api.getPolicy(), (err) => err instanceof TeamApiError && err.code === 'ZN_TEAM_TIMEOUT' && err.status === 0);
  assert.ok(Date.now() - started < 5000);
});

test('an oversized response body gives ZN_TEAM_BAD_RESPONSE', async (t) => {
  const base = await rawServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ org: 'org_' + 'a'.repeat(20), pad: 'x'.repeat(1024 * 1024 + 100) }));
  });
  const api = createApi({ base, userAgent: 'zn-gate/test' });
  await assert.rejects(
    api.join({ join_token: 'znj_' + 'a'.repeat(40), install_id: installId(), audit_key: auditKeyHex() }),
    (err) => err instanceof TeamApiError && err.code === 'ZN_TEAM_BAD_RESPONSE',
  );
});

test('redirects are not followed and count as a network error', async (t) => {
  const base = await rawServer(t, (req, res) => {
    res.writeHead(302, { Location: 'http://127.0.0.1:9/elsewhere' });
    res.end();
  });
  const api = createApi({ base });
  await assert.rejects(
    api.join({ join_token: 'znj_' + 'a'.repeat(40), install_id: installId(), audit_key: auditKeyHex() }),
    (err) => err instanceof TeamApiError && err.code === 'ZN_TEAM_NETWORK',
  );
});

test('a refused connection gives ZN_TEAM_NETWORK', async () => {
  const srv = await startFakeTeamServer();
  const base = srv.base;
  await srv.close();
  const api = createApi({ base, token: 'zni_6f1c2a3e-1234-4abc-8def-0123456789ab_' + 'c'.repeat(32) });
  await assert.rejects(api.getPolicy(), (err) => err instanceof TeamApiError && err.code === 'ZN_TEAM_NETWORK' && err.status === 0);
});

test('the install token never appears in error messages or bodies', async (t) => {
  const srv = await startServer(t);
  const inst = await joinInstall(t, srv);
  srv.revokeInstall(inst.installId);
  const token = inst.token;

  const errors = [];
  await inst.api.getPolicy().catch((err) => errors.push(err));
  await inst.api.ingest({ install_id: inst.installId, events: makeAuditChain({ key: inst.auditKey, count: 1 }) }).catch((err) => errors.push(err));
  await createApi({ base: 'http://127.0.0.1:9', token }).getPolicy().catch((err) => errors.push(err));

  assert.strictEqual(errors.length, 3);
  for (const err of errors) {
    assert.ok(err instanceof TeamApiError);
    assert.ok(!err.message.includes(token), 'message');
    assert.ok(!String(err.stack).includes(token), 'stack');
    assert.ok(!JSON.stringify(err.body || {}).includes(token), 'body');
  }
});
