'use strict';
/*
 * Organization policy on the machine: signature, pinned key, expiry, clock
 * skew, rollback, cache and strict mode.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const { tempDir } = require('./helpers/tmp');
const policy = require('../lib/team/policy');

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

test('warn rules: accepted alone, refused with deny or as a non-boolean; old rules unchanged', () => {
  const k = orgKey();
  const ok = (rules) => policy.verifyEnvelope(sign(body({ rules }), k), k.pin, { now: NOW });
  assert.strictEqual(ok([{ secret: 'PROD_*', agents: ['*'], warn: true, reason: 'Production credentials need review' }]).ok, true);
  assert.strictEqual(ok([{ secret: 'PROD_*', agents: ['*'], warn: true, allowHosts: ['api.stripe.com'], mode: 'proxy' }]).ok, true);
  assert.strictEqual(ok([{ secret: 'PROD_*', agents: ['*'], warn: false, deny: true }]).ok, true);
  assert.strictEqual(ok([{ secret: 'PROD_*', agents: ['*'], deny: true, reason: 'No production credentials in AI agents' }]).ok, true);
  const both = ok([{ secret: 'PROD_*', agents: ['*'], deny: true, warn: true }]);
  assert.strictEqual(both.ok, false);
  assert.match(both.error, /deny and warn together/);
  const notBool = ok([{ secret: 'PROD_*', agents: ['*'], warn: 'yes' }]);
  assert.strictEqual(notBool.ok, false);
  assert.match(notBool.error, /invalid warn/);
});
