'use strict';
/*
 * `zn team status --rules` (lib/team/rules-view.js, lib/team/cli.js): the
 * active signed policy in plain words, read only from the verified local copy.
 * All organizations, hosts and keys here are made up.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-rules-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

// The vault is locked in these tests: every client call fails, so the output can only come from the local copy.
const clientModule = require('../lib/vault/client');
let clientCalls = 0;
clientModule.createClient = () => new Proxy({}, {
  get(target, prop) {
    if (prop === 'close') return () => {};
    return () => { clientCalls++; throw Object.assign(new Error('locked'), { code: 'ZN_LOCKED' }); };
  },
});

const policy = require('../lib/team/policy');
const { runTeamCommand } = require('../lib/team/cli');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => { clientCalls = 0; fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true }); });

async function capture(fn) {
  const o = process.stdout.write;
  let stdout = '';
  process.stdout.write = (s) => { stdout += s; return true; };
  try { const code = await fn(); return { code, stdout }; } finally { process.stdout.write = o; }
}

const DAY = 86400000;
const ORG = 'org_Example12345678';

function newKey() {
  const k = crypto.generateKeyPairSync('ed25519');
  const raw = k.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { priv: k.privateKey, pin: { alg: 'Ed25519', kid: policy.kidOf(raw), key: raw } };
}

function setup(over, opts) {
  const { badSig = false, otherKey = false, noCache = false } = opts || {};
  const k = newKey();
  const now = Date.now();
  const p = Object.assign({
    org: ORG, version: 7, issued_at: new Date(now - DAY).toISOString(), expires_at: new Date(now + 3 * DAY).toISOString(),
    rules: [
      { secret: 'PROD_*', agents: ['*'], deny: true, reason: 'Production keys stay with CI' },
      { secret: 'STAGING_KEY', agents: ['claude-code', 'codex'], mode: 'proxy', allowHosts: ['api.example.com'], injectAt: 'header' },
      { secret: 'DEMO_TOKEN', agents: ['*'], warn: true },
    ],
  }, over || {});
  policy.writeTeam({ org: ORG, org_name: 'Example Org', api_base: 'https://team.example.com', install_id: 'inst-0001', policy_public_key: otherKey ? newKey().pin : k.pin });
  if (!noCache) {
    let sig = crypto.sign(null, Buffer.from(policy.canonicalJson(p), 'utf8'), k.priv).toString('base64url');
    if (badSig) sig = Buffer.alloc(64, 1).toString('base64url');
    policy.writeCache({ policy: p, signature: { alg: 'Ed25519', kid: k.pin.kid, sig } }, null);
  }
  return { pin: k.pin, p };
}

test('valid policy: version, key id, expiry and every rule in words', async () => {
  const { pin, p } = setup();
  const r = await capture(() => runTeamCommand(['team', 'status', '--rules']));
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('Rules (verified policy, version 7, signed with key ' + pin.kid + ', valid until ' + p.expires_at + '):'));
  assert.match(r.stdout, /1\. blocks use of secrets named PROD_\* \(all agents\)\. Reason: Production keys stay with CI/);
  assert.match(r.stdout, /2\. restricts use of secrets named STAGING_KEY \(agents: claude-code, codex\); mode proxy; hosts allowed: api\.example\.com; value only in the header/);
  assert.match(r.stdout, /3\. allows, with a warning and an audit record, use of secrets named DEMO_TOKEN \(all agents\)/);
  assert.ok(clientCalls > 0, 'the vault was asked and was locked, so the rules came from the local copy');
});

test('without --rules the output has no rules section', async () => {
  setup();
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.ok(!/Rules/.test(r.stdout));
  assert.ok(!/PROD_/.test(r.stdout));
});

test('expired policy: says so and prints none of its rules', async () => {
  const now = Date.now();
  setup({ issued_at: new Date(now - 9 * DAY).toISOString(), expires_at: new Date(now - 2 * DAY).toISOString() });
  const r = await capture(() => runTeamCommand(['team', 'status', '--rules']));
  assert.match(r.stdout, /Rules: The saved policy \(version 7\) expired on .*not active and no rules are shown/);
  assert.ok(!/PROD_\*|STAGING_KEY|DEMO_TOKEN/.test(r.stdout));
});

test('bad signature or another pinned key: says it does not verify and prints no rules', async () => {
  for (const opt of [{ badSig: true }, { otherKey: true }]) {
    setup(null, opt);
    const r = await capture(() => runTeamCommand(['team', 'status', '--rules']));
    assert.match(r.stdout, /Rules: The saved policy does not verify \(.*\), so no rules are shown from it/);
    assert.ok(!/PROD_\*|STAGING_KEY|DEMO_TOKEN/.test(r.stdout));
    const j = await capture(() => runTeamCommand(['team', 'status', '--rules', '--json']));
    const v = JSON.parse(j.stdout).rules;
    assert.deepStrictEqual([v.shown, v.state], [false, 'invalid']);
    assert.strictEqual(v.rules, undefined);
  }
});

test('not joined: no organization, no rules', async () => {
  let r = await capture(() => runTeamCommand(['team', 'status', '--rules']));
  assert.match(r.stdout, /Not in a zn organization\./);
  assert.match(r.stdout, /Rules: none, because this machine has not joined an organization\./);
  r = await capture(() => runTeamCommand(['team', 'status', '--rules', '--json']));
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.joined, false);
  assert.deepStrictEqual([j.rules.shown, j.rules.state], [false, 'none']);
});

test('joined but no policy received yet', async () => {
  setup(null, { noCache: true });
  const r = await capture(() => runTeamCommand(['team', 'status', '--rules']));
  assert.match(r.stdout, /Rules: No organization policy has been received yet, so there are no rules to show\. Run `zn team sync`\./);
});

test('empty rules list is stated, not hidden', async () => {
  setup({ rules: [] });
  const r = await capture(() => runTeamCommand(['team', 'status', '--rules']));
  assert.match(r.stdout, /This policy has no rules: it restricts nothing on its own\./);
});

test('--json: stable shape, names only, hidden characters removed, detector patterns not printed', async () => {
  const { pin } = setup({
    rules: [{ secret: 'PROD_*', agents: ['*'], deny: true, reason: 'No​ prod' }],
    detectors: [{ id: 'internal_token', pattern: 'zz_[a-z]{20}', type: 'INTERNAL_TOKEN' }],
    redaction: { pii: true },
  });
  const r = await capture(() => runTeamCommand(['team', 'status', '--rules', '--json']));
  const v = JSON.parse(r.stdout).rules;
  assert.strictEqual(v.shown, true);
  assert.strictEqual(v.state, 'active');
  assert.strictEqual(v.version, 7);
  assert.strictEqual(v.key_id, pin.kid);
  assert.ok(v.expires_at && v.issued_at);
  assert.deepStrictEqual(Object.keys(v.rules[0]).sort(), ['action', 'agents', 'allow_commands', 'allow_hosts', 'inject_at', 'mode', 'reason', 'secret', 'text']);
  assert.strictEqual(v.rules[0].action, 'block');
  assert.strictEqual(v.rules[0].reason, 'No prod');
  assert.deepStrictEqual(v.detectors, [{ id: 'internal_token', type: 'INTERNAL_TOKEN' }]);
  assert.deepStrictEqual(v.redaction, { pii: true });
  assert.ok(!r.stdout.includes('zz_[a-z]'));
  const plain = JSON.parse((await capture(() => runTeamCommand(['team', 'status', '--json']))).stdout);
  assert.ok(!('rules' in plain));
});
