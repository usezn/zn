'use strict';
// zn team status-report stop: when the last report cannot even be prepared (the vault fails once, right after the person
// confirms), the report is still turned off and the answer says the final report was not sent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-cov56-sr-stop-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');

let cloud;
test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });
test.beforeEach(() => {
  cloud.setOrgActive(true);
  cloud.requests.length = 0;
  fs.rmSync(process.env.ZN_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZN_HOME, { recursive: true });
});

function machine() {
  const secrets = { auditKey: 'ab'.repeat(32), secrets: {} };
  const flags = { failNextLoad: false };
  const state = {
    opts: { home: process.env.ZN_HOME },
    paths: { auditFile: path.join(process.env.ZN_HOME, 'audit.jsonl') },
    loadSecrets: async () => {
      if (flags.failNextLoad) { flags.failNextLoad = false; throw new Error('vault busy'); }
      return secrets;
    },
    saveSecrets: async () => {},
    serial: (fn) => fn(),
  };
  const o = makeTeamOps({
    state,
    fetchImpl: fetch,
    writeAudit: () => {},
    confirmOutOfBand: async (req) => {
      // The person confirms; the vault then fails to load the membership for the final report.
      if (String(req.title).startsWith('stop the status report')) flags.failNextLoad = true;
      return true;
    },
  });
  return { o, secrets, flags };
}

test('stop: a final report that cannot be prepared is not sent, and the report is still turned off', async () => {
  const m = machine();
  await m.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 20 }), api_base: cloud.base });
  cloud.requests.length = 0;
  const r = await m.o.teamStatusReport({ action: 'stop' });
  assert.strictEqual(r.on, false);
  assert.ok(r.final_report, JSON.stringify(r));
  assert.strictEqual(r.final_report.sent, false);
  assert.strictEqual(r.final_report.error, 'the final report could not be sent');
  assert.strictEqual(cloud.requests.filter((q) => q.path === '/v1/org/install/status').length, 0);
  assert.strictEqual(m.secrets.team.status_report, undefined);
});
