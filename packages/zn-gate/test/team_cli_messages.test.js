'use strict';
/*
 * The `zn team` messages a user can hit by mistake or by bad luck, each in plain words with its next step and exact
 * command: no token, a token the server refuses, no network, a join before the admin published a policy, a removed
 * installation, an inactive organization, and commands that do not exist. Technical causes (HTTP status, internal
 * codes) stay out of the main text; a `details:` line shows only with ZN_VERBOSE=1. Failures keep a non-zero exit.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-msgs-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const clientModule = require('../lib/vault/client');
let fake = {};
clientModule.createClient = () => new Proxy({}, {
  get(target, prop) {
    if (prop === 'close') return () => {};
    if (typeof fake[prop] === 'function') return fake[prop];
    return () => { throw Object.assign(new Error('unexpected call ' + String(prop)), { code: 'ZN_TEST' }); };
  },
});
const { runTeamCommand } = require('../lib/team/cli');

const TOKEN = 'znj_' + 'A'.repeat(40);
const ENV = { ZN_TEAM_JOIN_TOKEN: TOKEN };
const JOINED = { joined: true, org: 'org_Example12345678', org_name: 'Example Org', install_id: 'inst-0001', api_base: 'https://team.example.com', revoked_at: null };

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => {
  delete process.env.ZN_VERBOSE;
  fake = {};
});

async function capture(fn) {
  const o = process.stdout.write; const e = process.stderr.write;
  let stdout = ''; let stderr = '';
  process.stdout.write = (s) => { stdout += s; return true; };
  process.stderr.write = (s) => { stderr += s; return true; };
  try { const code = await fn(); return { code, stdout, stderr }; } finally { process.stdout.write = o; process.stderr.write = e; }
}

const run = (args, io) => capture(() => runTeamCommand(args, io || { env: {} }));

test('join without a token says what is missing and where it comes from, not the usage line', async () => {
  const r = await run(['team', 'join'], { env: {} });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /^\[zn\] No join token given\. Your organization admin sends you a token that starts with znj_\. Run: zn team join <token>/);
  assert.ok(!/usage:/.test(r.stderr));
  assert.strictEqual(r.stderr.trim().split('\n').length, 1);
});

test('a token the server refuses: plain next step, no HTTP code unless ZN_VERBOSE=1', async () => {
  fake.teamJoin = async () => {
    throw new Error('This join token is expired, already used or not valid, so this machine was not connected. Ask your organization admin for a new invitation, then run: zn team join <new token>\ndetails: HTTP 403: This join token is invalid, expired or used up');
  };
  let r = await run(['team', 'join'], { env: ENV });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] This join token is expired, already used or not valid, so this machine was not connected. Ask your organization admin for a new invitation, then run: zn team join <new token>\n');
  assert.ok(!/HTTP|403/.test(r.stderr));
  process.env.ZN_VERBOSE = '1';
  r = await run(['team', 'join'], { env: ENV });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /\n\[zn\] details: HTTP 403: /);
});

test('join with no network: cause and next step, no internal code unless ZN_VERBOSE=1', async () => {
  fake.teamJoin = async () => {
    throw new Error('Could not reach the zn server, so this machine was not connected. Check your internet connection and run the same command again: zn team join <token>\ndetails: ZN_TEAM_NETWORK');
  };
  const r = await run(['team', 'join'], { env: ENV });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] Could not reach the zn server, so this machine was not connected. Check your internet connection and run the same command again: zn team join <token>\n');
  assert.ok(!/ZN_TEAM_NETWORK/.test(r.stderr));
});

test('join before the admin published a policy exits 1 (the join stays pending) with an expected-state message', async () => {
  fake.teamJoin = async () => ({ org: 'org_Example12345678', org_name: 'Example Org', install_id: 'inst-0002' });
  fake.teamSync = async () => ({ policy: { status: 'none' } });
  const r = await run(['team', 'join'], { env: ENV });
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /^Joined Example Org \(org_Example12345678\)\. Installation inst-0002\.\n$/);
  assert.match(r.stderr, /^\[zn\] Your admin has not published a policy yet, so no restrictions apply for now\. This is expected: zn checks again by itself; to check now run: zn team sync\n$/);
  assert.ok(!/not finished/.test(r.stderr));
});

test('a removed installation is told to leave or rejoin, never to retry a sync', async () => {
  fake.teamInfo = async () => ({ ...JOINED, revoked_at: '2026-10-29T10:00:00.000Z', policy: { state: 'none' },
    last_sync: { at: '2026-10-29T11:00:00.000Z', ok: false, last_ok_at: null, problems: ['this machine was removed from the organization'] } });
  let r = await run(['team', 'status']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /An admin removed this machine from the organization, so it no longer gets the policy\. To disconnect it run: zn team leave\. To join again, ask your admin for a new token and run: zn team join <token>/);
  assert.match(r.stdout, /Last sync:    FAILED 2026-10-29T11:00:00\.000Z: this machine was removed from the organization \(never succeeded\)\n/);
  assert.ok(!/Last sync:.*to retry/.test(r.stdout));
  fake.teamSync = async () => ({ policy: { status: 'revoked' } });
  r = await run(['team', 'sync']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] An admin removed this machine from the organization, so it no longer gets the policy. To disconnect it run: zn team leave. To join again, ask your admin for a new token and run: zn team join <token>\n');
  assert.ok(!/Policy: revoked/.test(r.stdout));
});

test('sync with no network: no internal code on stdout or stderr, next step given', async () => {
  fake.teamSync = async () => ({ policy: { status: 'offline', error: 'ZN_TEAM_NETWORK' }, upload: { status: 'offline', uploaded: 0, pending: 1 } });
  let r = await run(['team', 'sync']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] Could not reach the zn server. Nothing was changed. Check your internet connection and run again: zn team sync\n');
  assert.ok(!/ZN_TEAM_NETWORK/.test(r.stdout + r.stderr));
  process.env.ZN_VERBOSE = '1';
  r = await run(['team', 'sync']);
  assert.match(r.stderr, /\[zn\] details: ZN_TEAM_NETWORK/);
});

test('sync with an inactive organization says so and does not blame a missing policy', async () => {
  fake.teamSync = async () => ({ policy: { status: 'none' }, upload: { status: 'inactive', uploaded: 0, pending: 3 } });
  const r = await run(['team', 'sync']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.stderr, '[zn] Your organization is not active on zn right now: ask your organization admin. Nothing is lost: 3 audit records stay on this machine and are sent when it is active again. Once it is active, run: zn team sync\n');
  assert.ok(!/policy/i.test(r.stderr));
  assert.ok(!/inactive/.test(r.stdout));
});

test('`zn team login` and `zn team export` say they are not commands and point to the real ones', async () => {
  let r = await run(['team', 'login']);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.stderr, "[zn] 'zn team login' is not a zn command. To connect this machine run: zn team join <token>. To export the audit log run: zn vault log export --otlp\n");
  r = await run(['team', 'export']);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /^\[zn\] 'zn team export' is not a zn command\. To export the audit log run: zn vault log export --otlp\./);
  assert.ok(!/usage:/.test(r.stderr));
});

test('a join token typed as a subcommand is never echoed', async () => {
  const fakeToken = 'znj_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';
  const r = await run(['team', fakeToken]);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /That looks like a join token\. Run: zn team join <token>/);
  for (const text of [r.stdout, r.stderr]) {
    for (let i = 0; i + 4 <= fakeToken.length; i++) {
      const piece = fakeToken.slice(i, i + 4);
      if (piece === 'znj_' ) assert.ok(!text.includes(piece), 'token prefix leaked');
      else assert.ok(!text.includes(piece), 'token fragment leaked: ' + piece);
    }
  }
});
