'use strict';
/*
 * `zn team ...` and `zn vault log export --otlp` (lib/team/cli.js) against a
 * stand-in vault client: usage errors, every policy state in the status
 * output, sync outcomes and exit codes, a locked vault, and the OTLP export.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-cli-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

// cli.js takes createClient when it loads: replace it first.
const clientModule = require('../lib/vault/client');
let fake = {};
let closed = 0;
clientModule.createClient = () => new Proxy({}, {
  get(target, prop) {
    if (prop === 'close') return () => { closed++; };
    if (typeof fake[prop] === 'function') return fake[prop];
    return () => { throw Object.assign(new Error('unexpected call ' + String(prop)), { code: 'ZN_TEST' }); };
  },
});

const { CODES } = require('../lib/errors');
const policy = require('../lib/team/policy');
const store = require('../lib/vault/store');
const { runTeamCommand, runLogExport } = require('../lib/team/cli');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => {
  fake = {};
  closed = 0;
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
});

/** Runs fn with stdout and stderr captured. */
async function capture(fn) {
  const o = process.stdout.write;
  const e = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = (s) => { stdout += s; return true; };
  process.stderr.write = (s) => { stderr += s; return true; };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

const crypto = require('crypto');
const rawKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const PIN = { alg: 'Ed25519', kid: policy.kidOf(rawKey), key: rawKey };
const JOINED = { joined: true, org: 'org_Example12345678', org_name: 'Example Org', install_id: 'inst-0001', api_base: 'https://team.example.com', revoked_at: null };

test('join without a token, or with a flag in its place, prints the usage and exits 2', async () => {
  for (const args of [['team', 'join'], ['team', 'join', '--api', 'https://team.example.com']]) {
    const r = await capture(() => runTeamCommand(args));
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /^usage: zn team join <token>/);
  }
});

test('an unknown subcommand prints the usage and exits 2', async () => {
  const r = await capture(() => runTeamCommand(['team', 'frobnicate']));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /usage: zn team join/);
});

test('join passes the options through and reports the policy that came with it', async () => {
  let joinArgs = null;
  fake.teamJoin = async (a) => { joinArgs = a; return { org: 'org_Example12345678', org_name: 'Example Org', install_id: 'inst-0001' }; };
  fake.teamSync = async () => ({ policy: { status: 'updated', version: 4 } });
  const r = await capture(() => runTeamCommand(['team', 'join', 'znj_' + 'a'.repeat(32), '--api', 'https://team.example.com', '--agent', 'codex']));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(joinArgs, { join_token: 'znj_' + 'a'.repeat(32), api_base: 'https://team.example.com', agent: 'codex' });
  assert.match(r.stdout, /Joined Example Org \(org_Example12345678\)\. Installation inst-0001\./);
  assert.match(r.stdout, /Policy: version 4\./);
  assert.ok(closed >= 2, 'every client is closed');
});

test('join to an organization without a name shows the id, and a policy that is not new shows its status', async () => {
  fake.teamJoin = async () => ({ org: 'org_Example12345678', install_id: 'inst-0002' });
  fake.teamSync = async () => ({ policy: { status: 'none' } });
  const r = await capture(() => runTeamCommand(['team', 'join', 'znj_' + 'b'.repeat(32)]));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /^Joined org_Example12345678\. Installation inst-0002\./);
  assert.match(r.stdout, /Policy: none\./);
});

test('join succeeds even when the first policy download fails (offline)', async () => {
  fake.teamJoin = async () => ({ org: 'org_Example12345678', install_id: 'inst-0003' });
  fake.teamSync = async () => { throw new Error('could not reach team.example.invalid'); };
  const r = await capture(() => runTeamCommand(['team', 'join', 'znj_' + 'c'.repeat(32)]));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Policy: not downloaded yet \(could not reach team\.example\.invalid\); zn retries while the vault is unlocked\./);
});

test('a failed join exits 1 and names the reason; a locked vault adds the unlock hint', async () => {
  fake.teamJoin = async () => { throw new Error('join failed (HTTP 403)'); };
  let r = await capture(() => runTeamCommand(['team', 'join', 'znj_' + 'd'.repeat(32)]));
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] join failed (HTTP 403)\n');
  fake.teamJoin = async () => { throw Object.assign(new Error('vault is locked'), { code: CODES.LOCKED }); };
  r = await capture(() => runTeamCommand(['team', 'join', 'znj_' + 'd'.repeat(32)]));
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /^\[zn\] vault is locked; run `(zn|npx -y zn-gate@[\d.]+) unlock`\n$/);
  // A message that already says how to unlock is not given the hint a second time.
  fake.teamJoin = async () => { throw Object.assign(new Error('vault is locked; run `zn unlock`'), { code: CODES.LOCKED }); };
  r = await capture(() => runTeamCommand(['team', 'join', 'znj_' + 'd'.repeat(32)]));
  assert.strictEqual(r.stderr, '[zn] vault is locked; run `zn unlock`\n');
});

test('a thrown value that is not an Error is still reported', async () => {
  fake.teamLeave = async () => { throw 'plain failure'; };
  const r = await capture(() => runTeamCommand(['team', 'leave']));
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] plain failure\n');
});

test('status on a machine that never joined says how to join; --json is machine readable', async () => {
  fake.teamInfo = async () => { throw Object.assign(new Error('locked'), { code: CODES.LOCKED }); };
  let r = await capture(() => runTeamCommand(['team', 'status']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /^Not in a zn organization\. Join with: zn team join <token>/);
  r = await capture(() => runTeamCommand(['team']));
  assert.strictEqual(r.code, 0, 'no subcommand means status');
  r = await capture(() => runTeamCommand(['team', 'status', '--json']));
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.joined, false);
  assert.strictEqual(j.vault, 'locked');
  assert.strictEqual(j.org, null);
  assert.strictEqual(j.policy, null);
});

test('status with the vault unlocked shows organization, policy and pending uploads', async () => {
  fake.teamInfo = async () => ({ ...JOINED, policy: { state: 'active', version: 7, expires_at: '2099-01-01T00:00:00.000Z' } });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
  fs.writeFileSync(policy.paths().uploadState, JSON.stringify({ last_upload: '2026-10-01T10:00:00.000Z', last_status: 'ok' }));
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Organization: Example Org \(org_Example12345678\)/);
  assert.match(r.stdout, /Installation: inst-0001 via https:\/\/team\.example\.com/);
  assert.match(r.stdout, /Policy:       version 7, valid until 2099-01-01T00:00:00\.000Z\n/);
  assert.match(r.stdout, /Audit upload: 0 records pending, last upload 2026-10-01T10:00:00\.000Z \(ok\)/);
  assert.ok(!/vault is locked/.test(r.stdout));
});

test('status shows an expired policy as strict mode and a removed machine with its date', async () => {
  fake.teamInfo = async () => ({
    ...JOINED, org_name: null, revoked_at: '2026-10-02T08:00:00.000Z',
    policy: { state: 'expired', version: 2, expires_at: '2026-09-01T00:00:00.000Z' },
  });
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.match(r.stdout, /Organization: org_Example12345678\n/);
  assert.match(r.stdout, /REMOVED FROM ORG on 2026-10-02T08:00:00\.000Z/);
  assert.match(r.stdout, /EXPIRED: strict mode \(only restrictions apply\)/);
});

test('status describes a policy that is missing or does not verify', async () => {
  fake.teamInfo = async () => ({ ...JOINED, policy: { state: 'none' } });
  let r = await capture(() => runTeamCommand(['team', 'status']));
  assert.match(r.stdout, /Policy:       none received yet/);
  fake.teamInfo = async () => ({ ...JOINED, policy: { state: 'invalid', error: 'bad signature' } });
  r = await capture(() => runTeamCommand(['team', 'status']));
  assert.match(r.stdout, /cached copy does not verify \(bad signature\); run `zn team sync`/);
  fake.teamInfo = async () => ({ ...JOINED, policy: { state: 'invalid' } });
  r = await capture(() => runTeamCommand(['team', 'status']));
  assert.match(r.stdout, /cached copy does not verify \(invalid\)/);
  fake.teamInfo = async () => ({ ...JOINED, policy: null });
  r = await capture(() => runTeamCommand(['team', 'status']));
  assert.match(r.stdout, /Policy:       none received yet/);
});

test('status with a locked vault reads the copies on disk and says the vault is locked', async () => {
  fake.teamInfo = async () => { throw Object.assign(new Error('locked'), { code: CODES.LOCKED }); };
  policy.writeTeam({ org: 'org_Example12345678', org_name: 'Example Org', api_base: 'https://team.example.com', install_id: 'inst-0004', policy_public_key: PIN });
  fs.writeFileSync(policy.paths().uploadState, 'not json');
  let r = await capture(() => runTeamCommand(['team', 'status']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Organization: Example Org \(org_Example12345678\)/);
  assert.match(r.stdout, /Policy:       none received yet/);
  assert.match(r.stdout, /The vault is locked: policy downloads and uploads resume after `zn unlock`\./);
  r = await capture(() => runTeamCommand(['team', 'status', '--json']));
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.joined, true);
  assert.strictEqual(j.vault, 'locked');
  assert.strictEqual(j.install_id, 'inst-0004');
  assert.strictEqual(j.policy.state, 'none');
  assert.strictEqual(j.upload.last_upload, null);
});

test('status survives an unreadable audit log', async () => {
  fake.teamInfo = async () => ({ ...JOINED, policy: { state: 'none' } });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
  // A directory where the audit log should be.
  fs.mkdirSync(store.paths().auditFile);
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Audit upload: /);
});

test('sync reports the policy and the upload, and rejection or revocation exit 1', async () => {
  fake.teamSync = async () => ({ policy: { status: 'updated', version: 5 }, upload: { status: 'ok', uploaded: 12, pending: 3 } });
  let r = await capture(() => runTeamCommand(['team', 'sync']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Policy: updated \(version 5\)\nAudit upload: ok, 12 sent, 3 pending/);
  fake.teamSync = async () => ({ policy: { status: 'current', version: 5 }, upload: { status: 'nothing', pending: -1 } });
  r = await capture(() => runTeamCommand(['team', 'sync']));
  assert.match(r.stdout, /Policy: current \(version 5\)\nAudit upload: nothing, 0 sent, 0 pending/);
  fake.teamSync = async () => ({ policy: { status: 'offline', error: 'ZN_TEAM_NETWORK' }, upload: { status: 'offline', uploaded: 0, pending: 2 } });
  r = await capture(() => runTeamCommand(['team', 'sync']));
  assert.strictEqual(r.code, 0, 'offline is not a failure');
  assert.match(r.stdout, /Policy: offline: ZN_TEAM_NETWORK/);
  fake.teamSync = async () => ({ policy: { status: 'rejected', error: 'policy version rollback' } });
  r = await capture(() => runTeamCommand(['team', 'sync']));
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /Policy: rejected: policy version rollback/);
  assert.ok(!/Audit upload/.test(r.stdout));
  fake.teamSync = async () => ({ policy: { status: 'revoked' } });
  r = await capture(() => runTeamCommand(['team', 'sync']));
  assert.strictEqual(r.code, 1);
  fake.teamSync = async () => ({});
  r = await capture(() => runTeamCommand(['team', 'sync']));
  assert.strictEqual(r.code, 0);
});

test('sync with a locked vault exits 1 with the unlock hint', async () => {
  fake.teamSync = async () => { throw Object.assign(new Error('the vault is not running'), { code: CODES.LOCKED }); };
  const r = await capture(() => runTeamCommand(['team', 'sync']));
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /^\[zn\] the vault is not running; run `(zn|npx -y zn-gate@[\d.]+) unlock`\n$/);
});

test('leave says what happened', async () => {
  fake.teamLeave = async () => ({ left: 'org_Example12345678' });
  let r = await capture(() => runTeamCommand(['team', 'leave']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /^Left org_Example12345678\. The organization policy no longer applies on this machine\./);
  fake.teamLeave = async () => ({ left: null });
  r = await capture(() => runTeamCommand(['team', 'leave']));
  assert.strictEqual(r.stdout, 'Not in an organization.\n');
});

test('log export needs --otlp', async () => {
  const r = await capture(() => runLogExport(['--since', '1d']));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /^usage: zn vault log export --otlp/);
});

function writeAudit(lines) {
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
  fs.writeFileSync(store.paths().auditFile, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}

const rec = (seq, ts) => ({ v: 1, seq, ts, secret: 'EXAMPLE_KEY', mode: 'env', agent: 'codex', tool: 'Bash', argv0: 'node', host: 'api.example.com', decision: 'allow', reason: 'policy', prev: '0'.repeat(64), mac: 'f'.repeat(64) });

test('log export writes OTLP lines to stdout, filtered by --since; no log at all is empty output', async () => {
  let r = await capture(() => runLogExport(['--otlp']));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  writeAudit([rec(1, '2020-01-01T00:00:00.000Z'), 'not json', rec(2, new Date().toISOString())]);
  r = await capture(() => runLogExport(['--otlp']));
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('2020-01-01') || r.stdout.length > 0);
  const all = r.stdout.length;
  r = await capture(() => runLogExport(['--otlp', '--since', '1d']));
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.length > 0 && r.stdout.length < all, 'the old record is filtered out');
});

test('log export to a file reports the count and hash on stderr and keeps the file private', async () => {
  writeAudit([rec(1, new Date().toISOString())]);
  const out = path.join(HOME, 'export.jsonl');
  const r = await capture(() => runLogExport(['--otlp', '--out', out]));
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /^Exported 1 records to .*export\.jsonl \(OTLP\/JSON Lines, sha256 [0-9a-f]{64}\)\./);
  assert.ok(fs.readFileSync(out, 'utf8').length > 0);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(out).mode & 0o077, 0);
});

test('log export on a machine in an organization labels the records with the installation', async () => {
  policy.writeTeam({ org: 'org_Example12345678', api_base: 'https://team.example.com', install_id: '11111111-2222-4333-8444-555555555555', policy_public_key: PIN });
  writeAudit([rec(1, new Date().toISOString())]);
  const r = await capture(() => runLogExport(['--otlp']));
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('11111111-2222-4333-8444-555555555555'));
  assert.ok(r.stdout.includes('org_Example12345678'));
});

test('log export fails with exit 1 on a bad --since or an unwritable --out', async () => {
  writeAudit([rec(1, new Date().toISOString())]);
  let r = await capture(() => runLogExport(['--otlp', '--since', 'last-tuesday-ish']));
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /\[zn\] invalid since: last-tuesday-ish/);
  r = await capture(() => runLogExport(['--otlp', '--out', path.join(HOME, 'no', 'such', 'dir', 'x.jsonl')]));
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /^\[zn\] /);
});
