'use strict';
/*
 * The status report through a real vault daemon: the client call reaches the operation, the acceptance dialog is
 * asked on the daemon's own channel, and `teamInfo` shows what was sent.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-team-status-daemon-'));
process.env.ZN_HOME = path.join(HOME, '.zn');
process.env.ZN_KEYCHAIN_BACKEND = 'passphrase';

const keychain = require('../lib/vault/keychain');
const daemon = require('../lib/vault/daemon');
const { createClient } = require('../lib/vault/client');
const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { isAllowedBody } = require('../lib/team/status-report');

const confirmations = [];
let answer = true;
const confirm = async (req) => { confirmations.push(req); return answer; };
let srv = null;
let cloud = null;
let vault = null;

test.before(async () => {
  const created = await keychain.initIdentity({ passphrase: 'correct horse battery staple', workFactor: 10 });
  srv = await daemon.serve({ identity: created.identity, ttlMs: 600000, idleMs: 600000, confirm, teamSyncMs: 0 });
  vault = createClient({});
  cloud = await startFakeTeamServer();
});

test.after(async () => {
  if (vault) vault.close();
  if (srv) await srv.close();
  if (cloud) await cloud.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('join turns the report on, the daemon sends it, stop and accept go through the client', async () => {
  cloud.publishPolicy({ rules: [] });
  await vault.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 5 }), api_base: cloud.base, agent: 'claude-code' });
  const dialog = confirmations.filter((c) => c.kind === 'team').pop();
  assert.ok(dialog.fields.some(([k, v]) => k === 'Status' && /No paths, no names/.test(v)));
  await vault.teamSync({});
  const inst = [...cloud.state.installs.values()][0];
  assert.ok(isAllowedBody(inst.status));
  let info = await vault.teamInfo();
  assert.strictEqual(info.status_report.on, true);
  assert.deepStrictEqual(info.status_report.last.body, inst.status);

  assert.strictEqual((await vault.teamStatusReport({ action: 'stop' })).on, false);
  await vault.teamSync({});
  assert.strictEqual(inst.statusReports, 1);

  answer = false;
  await assert.rejects(vault.teamStatusReport({ action: 'accept' }), /declined/);
  answer = true;
  assert.strictEqual((await vault.teamStatusReport({ action: 'accept' })).on, true);
  assert.match(confirmations.filter((c) => c.kind === 'team').pop().title, /^send a status report to organization /);
  await vault.teamSync({});
  assert.strictEqual(inst.statusReports, 2);
  info = await vault.teamInfo();
  assert.strictEqual(info.status_report.via, 'accept');
});
