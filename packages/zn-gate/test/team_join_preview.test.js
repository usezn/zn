'use strict';
// zn team join: the preview in the vault dialog (lib/team/daemon-ops.js teamJoin), against the fake
// zn cloud served as https://api.usezn.com through an injected fetch. Only the zn service is previewed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-join-preview-'));
process.env.ZN_HOME = path.join(HOME, '.zn');

const { startFakeTeamServer } = require('./helpers/fake_team_server');
const { makeTeamOps } = require('../lib/team/daemon-ops');

let cloud;
test.before(async () => { cloud = await startFakeTeamServer(); });
test.after(async () => { await cloud.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

/** Daemon ops with an in-memory vault; fetch maps https://api.usezn.com to the fake server. */
function ops({ answer = true } = {}) {
  const audit = []; const dialogs = []; const secrets = { auditKey: 'ab'.repeat(32) };
  // The fake serves http://127.0.0.1; the client is told it is https://api.usezn.com, so URLs in answers are mapped back.
  const fetchImpl = async (url, init) => {
    const res = await fetch(String(url).replace('https://api.usezn.com', cloud.base), init);
    const body = (await res.text()).split(cloud.base).join('https://api.usezn.com');
    return new Response(body, { status: res.status, headers: res.headers });
  };
  const state = {
    opts: { home: process.env.ZN_HOME },
    loadSecrets: async () => secrets, saveSecrets: async () => {}, serial: (fn) => fn(),
  };
  const o = makeTeamOps({
    state, fetchImpl,
    writeAudit: (r) => audit.push(r),
    confirmOutOfBand: async (req) => { dialogs.push(req); if (!answer) { const e = new Error('declined'); e.code = 'ZN_DECLINED'; throw e; } },
  });
  return { o, audit, dialogs, secrets };
}

test('the dialog names the organization (as reported by the server) and the inviter; the preview does not use the token', async () => {
  const { o, dialogs } = ops({ answer: false });
  const token = cloud.createJoinToken({ maxUses: 1 });
  await assert.rejects(o.teamJoin({ join_token: token }), /declined/);
  assert.match(dialogs[0].title, /Fake Org/);
  assert.deepStrictEqual(dialogs[0].fields.slice(0, 2), [['Organization', 'Fake Org (as reported by api.usezn.com)'], ['Invited by', 'Dana Admin (their display name)']]);
  assert.ok(!JSON.stringify(dialogs[0]).includes(token), 'the full token is never shown');
  const ok = ops();
  const r = await ok.o.teamJoin({ join_token: token });
  assert.match(r.org, /^org_/, 'maxUses 1: the preview did not use the token');
});

test('an unusable token and an organization without a subscription stop before the dialog, with an audit record', async () => {
  const a = ops();
  await assert.rejects(a.o.teamJoin({ join_token: 'znj_' + 'Q'.repeat(40) }), /invalid, expired or used up/);
  assert.strictEqual(a.dialogs.length, 0);
  assert.deepStrictEqual(a.audit.at(-1), { mode: 'set', decision: 'deny', reason: 'team_join_failed' });
  cloud.setOrgActive(false);
  const b = ops();
  try {
    await assert.rejects(b.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 2 }) }), /no active Team subscription/);
    assert.strictEqual(b.dialogs.length, 0);
  } finally { cloud.setOrgActive(true); }
});

test('rate limit or server errors: the dialog warns and the join goes on', async () => {
  for (const status of [429, 500]) {
    cloud.state.previewStatus = status;
    const x = ops();
    try {
      const r = await x.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 2 }) });
      assert.match(r.org, /^org_/);
      assert.ok(x.dialogs[0].warnings.some((w) => w.includes('HTTP ' + status)));
    } finally { cloud.state.previewStatus = null; }
  }
});

test('names with control, zero-width or bidi characters are cleaned; an empty name is a warning', async () => {
  cloud.state.previewOrgName = 'Fa\u200bke\u202e Org\u001b[2K';
  cloud.state.orgName = 'Fa\u200bke\u202e Org\u001b[2K';
  const x = ops({ answer: false });
  try {
    await assert.rejects(x.o.teamJoin({ join_token: cloud.createJoinToken() }), /declined/);
    assert.strictEqual(x.dialogs[0].fields[0][1], 'Fake Org[2K (as reported by api.usezn.com)');
    cloud.state.previewOrgName = '\u200b\u202e';
    const y = ops({ answer: false });
    await assert.rejects(y.o.teamJoin({ join_token: cloud.createJoinToken() }), /declined/);
    assert.ok(y.dialogs[0].warnings.some((w) => /empty name/.test(w)));
    assert.ok(!y.dialogs[0].fields.some(([k]) => k === 'Organization'));
  } finally { cloud.state.previewOrgName = null; cloud.state.orgName = 'Fake Org'; }
});

test('the organization joined must be the one shown: a different name is refused and nothing is saved', async () => {
  cloud.state.previewOrgName = 'Acme Corp';
  const x = ops();
  try {
    await assert.rejects(x.o.teamJoin({ join_token: cloud.createJoinToken({ maxUses: 2 }) }), /different organization than the one you confirmed/);
    assert.deepStrictEqual(x.audit.at(-1), { mode: 'set', decision: 'deny', reason: 'team_join_failed' });
    assert.strictEqual(x.secrets.team, undefined, 'no install token stored');
  } finally { cloud.state.previewOrgName = null; }
});
