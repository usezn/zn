'use strict';
/*
 * `zn team status` lines about the status report, and `zn team status-report accept|stop`, against a
 * stand-in vault client (the report itself is tested in team_status_report.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-status-report-cli-'));
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

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
test.beforeEach(() => { fake = {}; fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true }); });

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

const JOINED = {
  joined: true, org: 'org_Example12345678', org_name: 'Example Org', install_id: 'inst-0001', api_base: 'https://team.example.com', revoked_at: null,
  policy: { state: 'active', version: 7, expires_at: '2099-01-01T00:00:00.000Z' },
};
const BODY = { zn_gate_version: '1.19.0', os: 'linux', policy: { version: 7, state: 'active' }, agents: [{ id: 'codex', state: 'ok' }] };

test('status says the report is off and how to accept it once', async () => {
  fake.teamInfo = async () => ({ ...JOINED, status_report: { on: false, last: null, unsupported: false } });
  const r = await capture(() => runTeamCommand(['team', 'status']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Status report: OFF\. Nothing about this machine is sent besides the policy request and the audit upload\./);
  assert.match(r.stdout, /`zn team status-report accept` \(a dialog asks you\)/);
  const j = JSON.parse((await capture(() => runTeamCommand(['team', 'status', '--json']))).stdout);
  assert.strictEqual(j.status_report.on, false);
});

test('status shows the exact last body and time, or the failure with the last success', async () => {
  const sr = { on: true, accepted_at: '2026-12-01T10:00:00.000Z', via: 'join', unsupported: false };
  fake.teamInfo = async () => ({ ...JOINED, status_report: { ...sr, last: { at: '2026-12-01T10:15:00.000Z', ok: true, body: BODY, error: null, last_ok_at: '2026-12-01T10:15:00.000Z' } } });
  let r = await capture(() => runTeamCommand(['team', 'status']));
  assert.match(r.stdout, /Status report: on \(accepted 2026-12-01T10:00:00\.000Z, when you joined\)\. Stop it with `zn team status-report stop`\./);
  assert.match(r.stdout, /Last attempt: sent 2026-12-01T10:15:00\.000Z/);
  assert.ok(r.stdout.includes('Body: ' + JSON.stringify(BODY)));
  fake.teamInfo = async () => ({ ...JOINED, status_report: { ...sr, via: 'accept', unsupported: true, last: { at: '2026-12-02T10:15:00.000Z', ok: false, body: BODY, error: 'this server does not take status reports yet (HTTP 404)', last_ok_at: null } } });
  r = await capture(() => runTeamCommand(['team', 'status']));
  assert.match(r.stdout, /Last attempt: FAILED 2026-12-02T10:15:00\.000Z: this server does not take status reports yet \(HTTP 404\) \(never succeeded\)/);
  assert.match(r.stdout, /asks again after a day/);
  assert.ok(!/when you joined/.test(r.stdout));
  fake.teamInfo = async () => ({ ...JOINED, status_report: { ...sr, last: null } });
  r = await capture(() => runTeamCommand(['team', 'status']));
  assert.match(r.stdout, /Not sent yet/);
});

test('status-report accept and stop go through the vault; other words are a usage error', async () => {
  const calls = [];
  fake.teamStatusReport = async (a) => { calls.push(a); return { on: a.action === 'accept', org: 'org_Example12345678', org_name: 'Example Org' }; };
  let r = await capture(() => runTeamCommand(['team', 'status-report', 'accept']));
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Status report is on for Example Org \(org_Example12345678\)\. It goes out with the next sync/);
  r = await capture(() => runTeamCommand(['team', 'status-report', 'stop']));
  assert.match(r.stdout, /Status report is off for Example Org/);
  fake.teamStatusReport = async () => ({ on: true, already: true, org: 'org_Example12345678', org_name: null });
  r = await capture(() => runTeamCommand(['team', 'status-report', 'accept']));
  assert.match(r.stdout, /already on for org_Example12345678/);
  r = await capture(() => runTeamCommand(['team', 'status-report']));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /usage: zn team status-report accept \| zn team status-report stop/);
  r = await capture(() => runTeamCommand(['team', 'status-report', 'maybe']));
  assert.strictEqual(r.code, 2);
  assert.deepStrictEqual(calls, [{ action: 'accept' }, { action: 'stop' }]);
});
