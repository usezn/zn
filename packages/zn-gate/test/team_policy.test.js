'use strict';
/*
 * Organization policy on the machine: signature, pinned key, expiry, clock
 * skew, rollback, cache and strict mode; and how a rule changes a secret's
 * local settings (restrict freely, open only with a local approval).
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const { tempDir } = require('./helpers/tmp');
const policy = require('../lib/team/policy');
const { effective, approvalKey, hostCovered } = require('../lib/team/effective');

const DAY = 86400000;
const NOW = Date.parse('2026-10-13T10:00:00Z');

function orgKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const key = der.subarray(der.length - 32).toString('base64url');
  return { privateKey, pin: { alg: 'Ed25519', kid: policy.kidOf(key), key } };
}

function sign(p, k) {
  const sig = crypto.sign(null, Buffer.from(policy.canonicalJson(p), 'utf8'), k.privateKey).toString('base64url');
  return { policy: p, signature: { alg: 'Ed25519', kid: k.pin.kid, sig } };
}

function body(over) {
  const day = Math.floor(NOW / DAY) * DAY;
  return Object.assign({
    org: 'org_TestOrg12345678', version: 3,
    issued_at: new Date(day).toISOString(), expires_at: new Date(day + 7 * DAY).toISOString(),
    rules: [{ secret: 'PROD_*', agents: ['claude-code', 'codex'], mode: 'proxy', allowHosts: ['api.stripe.com'] }],
  }, over || {});
}

function setup(t) {
  const home = tempDir(t, 'zn-team-policy-');
  const k = orgKey();
  policy.writeTeam({ org: 'org_TestOrg12345678', api_base: 'https://api.usezn.com', install_id: crypto.randomUUID(), policy_public_key: k.pin }, { home });
  return { home, k };
}

test('canonical JSON sorts keys recursively and refuses floats', () => {
  assert.strictEqual(policy.canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 'x' }], c: true } }), '{"a":{"c":true,"d":[2,{"y":"x","z":1}]},"b":1}');
  assert.throws(() => policy.canonicalJson({ a: 1.5 }));
});

test('a correctly signed policy verifies with the pinned key', () => {
  const k = orgKey();
  const r = policy.verifyEnvelope(sign(body(), k), k.pin, { now: NOW, org: 'org_TestOrg12345678' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.policy.version, 3);
});

test('tampering, another key, a wrong kid or another org is refused', () => {
  const k = orgKey();
  const other = orgKey();
  const env = sign(body(), k);
  const edited = JSON.parse(JSON.stringify(env));
  edited.policy.rules[0].allowHosts.push('evil.example.net');
  assert.strictEqual(policy.verifyEnvelope(edited, k.pin, { now: NOW }).error, 'bad signature');
  assert.strictEqual(policy.verifyEnvelope(sign(body(), other), k.pin, { now: NOW }).error, 'unknown key id');
  const forged = sign(body(), other);
  forged.signature.kid = k.pin.kid;
  assert.strictEqual(policy.verifyEnvelope(forged, k.pin, { now: NOW }).error, 'bad signature');
  assert.match(policy.verifyEnvelope(env, k.pin, { now: NOW, org: 'org_Another12345678' }).error, /another organization/);
  assert.strictEqual(policy.verifyEnvelope(env, { alg: 'Ed25519', kid: '0000000000000000', key: k.pin.key }, { now: NOW }).error, 'no valid pinned key');
});

test('extra fields, bad patterns and long lifetimes are refused before the signature', () => {
  const k = orgKey();
  for (const over of [
    { extra: 1 },
    { rules: [{ secret: 'lower', agents: ['codex'] }] },
    { rules: [{ secret: 'A', agents: ['codex'], allowHosts: ['https://x.com'] }] },
    { rules: [{ secret: 'A', agents: ['codex'], value: 'x' }] },
    { rules: [{ secret: 'A', agents: [] }] },
    { expires_at: new Date(NOW + 30 * DAY).toISOString() },
    { detectors: [{ id: 'a', pattern: 'abcd', type: 'X' }, { id: 'a', pattern: 'efgh', type: 'Y' }] },
  ]) {
    const r = policy.verifyEnvelope(sign(body(over), k), k.pin, { now: NOW });
    assert.strictEqual(r.ok, false, JSON.stringify(over));
    assert.match(r.error, /^invalid/);
  }
});

test('expiry and clock skew: five minutes of tolerance on both dates', () => {
  const k = orgKey();
  const p = body();
  const exp = Date.parse(p.expires_at);
  const env = sign(p, k);
  assert.strictEqual(policy.verifyEnvelope(env, k.pin, { now: exp + 4 * 60000 }).ok, true);
  assert.strictEqual(policy.verifyEnvelope(env, k.pin, { now: exp + 6 * 60000 }).error, 'policy expired');
  const r = policy.verifyEnvelope(env, k.pin, { now: exp + 6 * 60000, allowExpired: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expired, true);
  const iss = Date.parse(p.issued_at);
  assert.strictEqual(policy.verifyEnvelope(env, k.pin, { now: iss - 4 * 60000 }).ok, true);
  assert.strictEqual(policy.verifyEnvelope(env, k.pin, { now: iss - 6 * 60000 }).error, 'policy issued in the future');
});

test('the cache accepts newer versions, refuses rollbacks and keeps the last good one', (t) => {
  const { home, k } = setup(t);
  assert.strictEqual(policy.state({ home, now: NOW }).state, 'none');
  assert.strictEqual(policy.accept(sign(body({ version: 3 }), k), 'W/"e3"', { home, now: NOW }).ok, true);
  assert.strictEqual(policy.state({ home, now: NOW }).version, 3);
  const back = policy.accept(sign(body({ version: 2 }), k), 'W/"e2"', { home, now: NOW });
  assert.strictEqual(back.error, 'policy version rollback');
  const bad = policy.accept(sign(body({ version: 9 }), orgKey()), null, { home, now: NOW });
  assert.strictEqual(bad.ok, false);
  const st = policy.state({ home, now: NOW });
  assert.strictEqual(st.state, 'active');
  assert.strictEqual(st.version, 3);
  assert.strictEqual(st.etag, 'W/"e3"');
  assert.strictEqual(policy.accept(sign(body({ version: 4 }), k), null, { home, now: NOW }).ok, true);
  assert.strictEqual(policy.state({ home, now: NOW }).version, 4);
});

test('the cache goes to strict mode when it expires and is ignored if edited', (t) => {
  const { home, k } = setup(t);
  policy.accept(sign(body(), k), null, { home, now: NOW });
  assert.strictEqual(policy.state({ home, now: NOW + 8 * DAY }).state, 'expired');
  const file = policy.paths({ home }).policyFile;
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  c.envelope.policy.rules = [];
  fs.writeFileSync(file, JSON.stringify(c));
  const st = policy.state({ home, now: NOW });
  assert.strictEqual(st.state, 'invalid');
  assert.strictEqual(st.policy, null);
});

/* ------------------------------------------------------------------ */
/* Effective settings (D1)                                             */
/* ------------------------------------------------------------------ */

const ORG = 'org_TestOrg12345678';
const LOCAL = { mode: 'env', allowHosts: ['api.stripe.com', 'files.stripe.com'], allowCommands: ['stripe'] };
const pol = (rules) => ({ org: ORG, version: 1, rules });

test('deny blocks the secret for the agents of the rule, and for an unknown agent', () => {
  const p = pol([{ secret: 'PROD_*', agents: ['codex'], deny: true }]);
  assert.strictEqual(effective('PROD_DB', LOCAL, { policy: p, state: 'active', agent: 'codex' }).deny, true);
  assert.strictEqual(effective('PROD_DB', LOCAL, { policy: p, state: 'active', agent: null }).deny, true);
  assert.strictEqual(effective('PROD_DB', LOCAL, { policy: p, state: 'active', agent: 'claude-code' }).deny, false);
  assert.strictEqual(effective('DEV_DB', LOCAL, { policy: p, state: 'active', agent: 'codex' }).deny, false);
  assert.strictEqual(effective('PROD_DB', LOCAL, { policy: p, state: 'expired', agent: 'codex' }).deny, true);
});

test('first matching rule wins', () => {
  const p = pol([
    { secret: 'PROD_DB', agents: ['*'], allowHosts: ['api.stripe.com'] },
    { secret: 'PROD_*', agents: ['*'], deny: true },
  ]);
  const r = effective('PROD_DB', LOCAL, { policy: p, state: 'active', agent: 'codex' });
  assert.strictEqual(r.deny, false);
  assert.deepStrictEqual(r.meta.allowHosts, ['api.stripe.com']);
});

test('restricting applies at once: fewer hosts, fewer commands, proxy mode, header placement', () => {
  const p = pol([{ secret: '*', agents: ['*'], allowHosts: ['api.stripe.com'], allowCommands: [], mode: 'proxy', injectAt: 'header' }]);
  const r = effective('STRIPE_KEY', Object.assign({}, LOCAL, { injectAt: 'query' }), { policy: p, state: 'active', agent: 'claude-code' });
  assert.deepStrictEqual(r.meta.allowHosts, ['api.stripe.com']);
  assert.deepStrictEqual(r.meta.allowCommands, []);
  assert.strictEqual(r.meta.mode, 'proxy');
  assert.strictEqual(r.meta.injectAt, 'header');
  assert.deepStrictEqual(r.pending, []);
});

test('opening needs a local approval; approved openings apply; strict mode withdraws them', () => {
  const p = pol([{ secret: 'STRIPE_KEY', agents: ['claude-code'], allowHosts: ['api.stripe.com', 'evil.example.net'], allowCommands: ['stripe', 'python3'], mode: 'file', injectAt: 'body' }]);
  const r = effective('STRIPE_KEY', LOCAL, { policy: p, state: 'active', agent: 'claude-code' });
  assert.deepStrictEqual(r.meta.allowHosts, ['api.stripe.com']);
  assert.deepStrictEqual(r.meta.allowCommands, ['stripe']);
  assert.strictEqual(r.meta.mode, 'env');
  assert.strictEqual(r.meta.injectAt, undefined);
  assert.deepStrictEqual(r.pending, [
    { kind: 'mode', value: 'file' }, { kind: 'host', value: 'evil.example.net' },
    { kind: 'command', value: 'python3' }, { kind: 'injectAt', value: 'body' },
  ]);
  const approvals = new Set([approvalKey(ORG, 'STRIPE_KEY', 'host', 'evil.example.net'), approvalKey(ORG, 'STRIPE_KEY', 'command', 'python3')]);
  const a = effective('STRIPE_KEY', LOCAL, { policy: p, state: 'active', agent: 'claude-code', approvals });
  assert.deepStrictEqual(a.meta.allowHosts, ['api.stripe.com', 'evil.example.net']);
  assert.deepStrictEqual(a.meta.allowCommands, ['stripe', 'python3']);
  const s = effective('STRIPE_KEY', LOCAL, { policy: p, state: 'expired', agent: 'claude-code', approvals });
  assert.deepStrictEqual(s.meta.allowHosts, ['api.stripe.com']);
  assert.deepStrictEqual(s.meta.allowCommands, ['stripe']);
  assert.deepStrictEqual(s.pending, []);
  // An approval for another organization does not count.
  const other = new Set([approvalKey('org_Other123456789', 'STRIPE_KEY', 'host', 'evil.example.net')]);
  assert.deepStrictEqual(effective('STRIPE_KEY', LOCAL, { policy: p, state: 'active', agent: 'claude-code', approvals: other }).meta.allowHosts, ['api.stripe.com']);
});

test('a rule for named agents never opens anything for an unknown agent', () => {
  const p = pol([{ secret: '*', agents: ['claude-code'], allowHosts: ['evil.example.net'] }]);
  const r = effective('STRIPE_KEY', LOCAL, { policy: p, state: 'active', agent: null });
  assert.deepStrictEqual(r.meta.allowHosts, LOCAL.allowHosts);
  assert.deepStrictEqual(r.pending, []);
});

test('no policy, an invalid cache or no state leaves local settings alone', () => {
  const p = pol([{ secret: '*', agents: ['*'], deny: true }]);
  for (const state of ['none', 'invalid', undefined]) {
    const r = effective('X', LOCAL, { policy: p, state, agent: 'codex' });
    assert.strictEqual(r.deny, false);
    assert.deepStrictEqual(r.meta.allowHosts, LOCAL.allowHosts);
  }
});

test('local wildcards cover org hosts; org wildcards need an equal or broader local one', () => {
  assert.strictEqual(hostCovered(['*.stripe.com'], 'api.stripe.com'), true);
  assert.strictEqual(hostCovered(['*.stripe.com'], 'stripe.com'), false);
  assert.strictEqual(hostCovered(['*.stripe.com'], '*.api.stripe.com'), true);
  assert.strictEqual(hostCovered(['api.stripe.com'], '*.stripe.com'), false);
  assert.strictEqual(hostCovered(['*.com'], '*.stripe.com'), true);
  assert.strictEqual(hostCovered([], 'a.b'), false);
});
