'use strict';
/**
 * zn-gate mcp with the zn Team admin tools, against the mock API
 * (test/fixtures/team_api_mock.js):
 *   - protocol: version negotiation, annotations, team tools hidden without
 *     a token or with ZN_LOCAL_ONLY, filtered by scopes, elicitation round
 *     trip over the JSON-RPC session;
 *   - the full write flow: prepare -> confirm on each channel (elicitation,
 *     dialog with a fake GUI, dashboard link) -> execute; replay, expiry,
 *     another token, dashboard-class changes that never execute here;
 *   - the token and the confirmation nonce never appear in any output.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { createMcpServer, TOOLS: LOCAL_TOOLS, negotiateProtocolVersion } = require('../lib/mcp');
const { createAdminClient } = require('../lib/team/admin/client');
const { createTeamApiMock } = require('./fixtures/team_api_mock');
const { tempDir } = require('./helpers/tmp');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

/** A fake MCP client driving createMcpServer in process. */
function session(t, { env, gui, elicitation, onElicit, protocolVersion, exportDir }) {
  const out = [];
  let server = null;
  const client = { out, elicitations: [] };
  const write = (msg) => {
    out.push(JSON.stringify(msg));
    if (msg.method === 'elicitation/create') {
      client.elicitations.push(msg);
      Promise.resolve(onElicit ? onElicit(msg) : { action: 'cancel' }).then((answer) => {
        if (answer === undefined) return; // never answer
        const reply = answer && answer.error ? { jsonrpc: '2.0', id: msg.id, error: answer.error } : { jsonrpc: '2.0', id: msg.id, result: answer };
        out.push(JSON.stringify(reply));
        server.handleMessage(reply);
      });
    }
  };
  server = createMcpServer({}, {
    write,
    env,
    teamOptions: { gui: gui || { available: () => false, confirm: async () => false }, exportDir, home: env.ZN_HOME },
  });
  let id = 0;
  client.server = server;
  client.request = async (method, params) => {
    const msg = { jsonrpc: '2.0', id: ++id, method, params };
    out.push(JSON.stringify(msg));
    const res = await server.handleMessage(msg);
    out.push(JSON.stringify(res));
    return res;
  };
  client.init = () => client.request('initialize', {
    protocolVersion: protocolVersion || '2025-11-25',
    capabilities: elicitation === undefined ? { elicitation: { form: {} } } : elicitation,
    clientInfo: { name: 'claude-code', version: '2.1.240' },
  });
  client.call = async (name, args) => {
    const r = await client.request('tools/call', { name, arguments: args || {} });
    return r.result;
  };
  client.names = async () => (await client.request('tools/list', {})).result.tools.map((x) => x.name);
  t.after(() => server.close());
  return client;
}

async function withMock(t, o) {
  const mock = createTeamApiMock(o);
  const url = await mock.start();
  t.after(() => mock.stop());
  return { mock, url };
}

function envFor(t, url, tokenValue, extra) {
  const home = tempDir(t, 'zn-team-mcp-');
  return Object.assign({ ZN_HOME: home, ZN_TEAM_API_URL: url, ZN_TEAM_DEV: '1', ZN_ORG_TOKEN: tokenValue }, extra || {});
}

function assertNoSecrets(client, mock, extra) {
  const all = client.out.join('\n') + (extra || '');
  for (const [key, tok] of Object.entries(mock.tokens)) {
    assert.ok(!all.includes(tok), 'token ' + key + ' leaked');
    assert.ok(!all.includes(tok.slice(19)), 'token secret ' + key + ' leaked');
  }
  for (const c of mock.state.requests) {
    if (c.body && typeof c.body.nonce === 'string') assert.ok(!all.includes(c.body.nonce), 'nonce leaked');
  }
}

const memberRemove = { user_id: 'bob@acme.example', note: 'offboarding' };

/* ------------------------------ protocol ------------------------------ */

test('version negotiation: known versions echoed, others get the latest', () => {
  for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) assert.equal(negotiateProtocolVersion(v), v);
  assert.equal(negotiateProtocolVersion('2026-07-28'), '2025-11-25');
  assert.equal(negotiateProtocolVersion(undefined), '2025-11-25');
});

test('server/discover answers -32601 so 2026-era clients fall back to initialize', async (t) => {
  const c = session(t, { env: { ZN_HOME: tempDir(t, 'zn-') } });
  const r = await c.request('server/discover', {});
  assert.equal(r.error.code, -32601);
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
});

test('no token: only the four local tools, all annotated', async (t) => {
  const c = session(t, { env: { ZN_HOME: tempDir(t, 'zn-') } });
  await c.init();
  const res = await c.request('tools/list', {});
  const tools = res.result.tools;
  assert.deepEqual(tools.map((x) => x.name), ['analyze_prompt', 'check_tool_call', 'check_tool_result', 'zn_status']);
  for (const tool of tools) {
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    assert.ok(tool.title);
  }
  const call = await c.request('tools/call', { name: 'team_whoami', arguments: {} });
  assert.equal(call.error.code, -32601);
  const st = JSON.parse((await c.call('zn_status')).content[0].text);
  assert.match(st.team.admin_tools, /^off/);
});

test('ZN_LOCAL_ONLY=true hides the team tools even with a token', async (t) => {
  const { mock, url } = await withMock(t);
  const c = session(t, { env: envFor(t, url, mock.tokens.admin, { ZN_LOCAL_ONLY: 'true' }) });
  await c.init();
  assert.ok(!(await c.names()).some((n) => n.startsWith('team_')));
  assert.equal(mock.state.requests.length, 0, 'nothing reaches the network');
});

test('with a token: tools listed by scope, annotations present, whoami without the token', async (t) => {
  const { mock, url } = await withMock(t);
  const c = session(t, { env: envFor(t, url, mock.tokens.admin) });
  await c.init();
  const list = (await c.request('tools/list', {})).result.tools;
  const team = list.filter((x) => x.name.startsWith('team_'));
  assert.equal(team.length, 18);
  for (const tool of team) {
    assert.ok(tool.annotations && typeof tool.annotations.destructiveHint === 'boolean', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const who = await c.call('team_whoami');
  assert.equal(who.isError, undefined);
  assert.equal(who.structuredContent.org.name, 'Acme');
  assert.equal(who.structuredContent.token.prefix, mock.tokens.admin.slice(0, 18));
  assert.deepEqual(who.structuredContent.confirm_channels, ['elicitation', 'dashboard']);
  assert.match(who.structuredContent.warnings[0], /ZN_ORG_TOKEN/);
  assert.equal(JSON.parse(who.content[0].text).org.id, mock.org.id, 'text block mirrors structuredContent');
  // The client header names zn-gate and the MCP client, never the token.
  assert.match(mock.state.requests[0].client, /^zn-gate\/\S+ \(claude-code\/2\.1\.240\)$/);
  assertNoSecrets(c, mock);
});

test('a read-only token only lists what its scopes allow; other calls are refused locally', async (t) => {
  const { mock, url } = await withMock(t);
  const c = session(t, { env: envFor(t, url, mock.tokens.reader) });
  await c.init();
  const names = (await c.names()).filter((n) => n.startsWith('team_')).sort();
  assert.deepEqual(names, ['team_change_status', 'team_changes_list', 'team_installs_list', 'team_org_get', 'team_policy_get', 'team_whoami']);
  const before = mock.state.requests.length;
  const r = await c.call('team_member_remove', memberRemove);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error, 'insufficient_scope');
  assert.equal(mock.state.requests.filter((x) => x.method === 'POST').length, 0);
  assert.ok(mock.state.requests.length >= before);
});

test('whoami failure: only team_whoami is listed and it reports the error', async (t) => {
  const { mock, url } = await withMock(t);
  mock.revoke('admin');
  const c = session(t, { env: envFor(t, url, mock.tokens.admin) });
  await c.init();
  const names = (await c.names()).filter((n) => n.startsWith('team_'));
  assert.deepEqual(names, ['team_whoami']);
  const who = await c.call('team_whoami');
  assert.equal(who.isError, true);
  assert.equal(who.structuredContent.error, 'token_revoked');
  assert.match(who.structuredContent.message, /zn team admin login/);
  assertNoSecrets(c, mock);
});

test('reads: org, members, installs, policy with rule hashes, audit, activity, changes', async (t) => {
  const { mock, url } = await withMock(t);
  const c = session(t, { env: envFor(t, url, mock.tokens.admin) });
  await c.init();
  assert.equal((await c.call('team_org_get')).structuredContent.seats, 10);
  const members = (await c.call('team_members_list')).structuredContent;
  assert.equal(members.members.length, 3);
  assert.equal(members.invitations.length, 1);
  assert.equal((await c.call('team_installs_list')).structuredContent.installs.length, 1);
  assert.equal((await c.call('team_installs_list', { include_revoked: true })).structuredContent.installs.length, 2);
  const pol = (await c.call('team_policy_get')).structuredContent;
  assert.equal(pol.version, 7);
  assert.equal(pol.rules_with_hash[0].rule_hash, mock.ruleHash(mock.state.policy.rules[0]));
  assert.deepEqual(Object.keys(pol.public_key).sort(), ['alg', 'kid']);
  assert.equal((await c.call('team_audit_query', { since: '24h', limit: 10 })).structuredContent.events.length, 1);
  assert.equal((await c.call('team_audit_summary', { days: 7 })).structuredContent.days, 7);
  assert.equal((await c.call('team_activity_list', { actor_type: 'token' })).structuredContent.events.length, 1);
  assert.deepEqual((await c.call('team_changes_list')).structuredContent.changes, []);
  const bad = await c.call('team_audit_query', { since: 'yesterday' });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error, 'invalid_arguments');
  assert.ok(mock.state.requests.every((r) => r.query.indexOf('org_id') === -1));
  assertNoSecrets(c, mock);
});

test('audit export: written to a private file, checksum verified, contents not returned', async (t) => {
  const { mock, url } = await withMock(t);
  const dir = tempDir(t, 'zn-exports-');
  const c = session(t, { env: envFor(t, url, mock.tokens.admin), exportDir: dir });
  await c.init();
  const r = (await c.call('team_audit_export', { format: 'csv', since: '7d' })).structuredContent;
  assert.equal(path.dirname(r.path), dir);
  assert.match(path.basename(r.path), /^zn-audit-org_7Kq2xYAcme-\d{8}T\d{6}Z\.csv$/);
  assert.equal(fs.readFileSync(r.path, 'utf8'), mock.state.exportBody);
  if (process.platform !== 'win32') assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
  assert.equal(r.rows, 1);
  assert.ok(!c.out.join('\n').includes('STRIPE_KEY,allow'), 'export contents stay out of the conversation');
  mock.state.exportSha = 'f'.repeat(64);
  const bad = await c.call('team_audit_export', { format: 'csv' });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error, 'checksum_mismatch');
  assert.equal(fs.readdirSync(dir).length, 1);
});

/* ------------------------------ write flow ------------------------------ */

test('elicitation channel: prepare -> elicitation/create over JSON-RPC -> accept -> applied', async (t) => {
  const { mock, url } = await withMock(t);
  const c = session(t, { env: envFor(t, url, mock.tokens.admin), onElicit: () => ({ action: 'accept', content: { confirm: true } }) });
  await c.init();
  const r = await c.call('team_member_remove', memberRemove);
  const o = r.structuredContent;
  assert.equal(o.status, 'applied', JSON.stringify(o));
  assert.equal(o.confirm_via, 'elicitation');
  assert.equal(o.class, 'confirm');
  assert.match(o.digest8, /^[0-9a-f]{8}$/);
  assert.ok(!mock.state.members.some((m) => m.user_id === 'bob@acme.example'));
  // The elicitation went through the JSON-RPC session with the zn-gate text.
  assert.equal(c.elicitations.length, 1);
  const e = c.elicitations[0];
  assert.match(e.id, /^zn-\d+$/);
  assert.equal(e.params.mode, 'form');
  assert.match(e.params.message, /^zn Team · Acme \(org_7Kq2xYAcme\)\n/);
  assert.match(e.params.message, /Remove member bob@acme\.example from Acme/);
  assert.match(e.params.message, new RegExp('digest ' + o.digest8));
  assert.match(e.params.message, /Note from the agent \(unverified\): offboarding\nOnly approve if you asked your agent for this change\.$/);
  const confirmReq = mock.state.requests.find((x) => /\/confirm$/.test(x.path));
  assert.equal(confirmReq.body.via, 'elicitation');
  assertNoSecrets(c, mock);
});

test('elicitation: decline and cancel cancel the change on the server; timeout counts as cancel', async (t) => {
  for (const answer of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirm: false } }]) {
    const { mock, url } = await withMock(t);
    const c = session(t, { env: envFor(t, url, mock.tokens.admin), onElicit: () => answer });
    await c.init();
    const o = (await c.call('team_member_remove', memberRemove)).structuredContent;
    assert.equal(o.status, 'declined', JSON.stringify(answer));
    assert.equal(mock.state.changes.get(o.change_id).status, 'cancelled');
    assert.equal(mock.state.applied.length, 0);
    assert.ok(mock.state.members.some((m) => m.user_id === 'bob@acme.example'));
  }
  // Timeout: the client never answers. Shorten the wait through sendRequest.
  const { mock, url } = await withMock(t);
  const c = session(t, { env: envFor(t, url, mock.tokens.admin), onElicit: () => undefined });
  await c.init();
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 120000 ? 50 : ms, ...rest);
  let o;
  try {
    o = (await c.call('team_member_remove', memberRemove)).structuredContent;
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.equal(o.status, 'declined');
  assert.ok(c.out.some((l) => l.includes('notifications/cancelled')));
  assert.equal(mock.state.applied.length, 0);
});

test('dialog channel (fake GUI): client without elicitation -> native dialog -> applied; "No" declines', async (t) => {
  const { mock, url } = await withMock(t);
  const seen = [];
  const gui = { available: () => true, confirm: async (req) => { seen.push(req); return true; } };
  const c = session(t, { env: envFor(t, url, mock.tokens.admin), gui });
  // No elicitation capability at all:
  await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex', version: '0.50.0' } });
  const o = (await c.call('team_install_revoke', { install_id: '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f' })).structuredContent;
  assert.equal(o.status, 'applied', JSON.stringify(o));
  assert.equal(o.confirm_via, 'dialog');
  assert.equal(c.elicitations.length, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].title, 'zn Team change');
  assert.equal(seen[0].footer, 'Only approve if you asked your agent for this change.');
  assert.ok(seen[0].warnings.some((w) => /digest [0-9a-f]{8}/.test(w)));

  const no = { available: () => true, confirm: async () => false };
  const c2 = session(t, { env: envFor(t, url, mock.tokens.admin), gui: no });
  await c2.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex', version: '0.50.0' } });
  const o2 = (await c2.call('team_member_remove', memberRemove)).structuredContent;
  assert.equal(o2.status, 'declined');
  assert.equal(o2.confirm_via, 'dialog');
  assert.ok(mock.state.members.some((m) => m.user_id === 'bob@acme.example'));
  assertNoSecrets(c, mock);
});

test('dashboard fallback: no elicitation and no dialog -> approval link, nothing executed', async (t) => {
  const { mock, url } = await withMock(t);
  const c = session(t, { env: envFor(t, url, mock.tokens.admin) });
  await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '1' } });
  const o = (await c.call('team_member_remove', memberRemove)).structuredContent;
  assert.equal(o.status, 'pending_approval');
  assert.equal(o.approve_url, 'https://usezn.com/team/approvals?change=' + o.change_id);
  assert.match(o.message, /No confirmation channel/);
  assert.equal(mock.state.changes.get(o.change_id).status, 'pending');
  assert.equal(mock.state.requests.filter((x) => /\/confirm$/.test(x.path)).length, 0);
  assertNoSecrets(c, mock);
});

test('ZN_TEAM_CONFIRM=dashboard forces the link even when elicitation and a dialog exist', async (t) => {
  const { mock, url } = await withMock(t);
  const gui = { available: () => true, confirm: async () => true };
  const c = session(t, { env: envFor(t, url, mock.tokens.admin, { ZN_TEAM_CONFIRM: 'dashboard' }), gui, onElicit: () => ({ action: 'accept', content: { confirm: true } }) });
  await c.init();
  const o = (await c.call('team_member_remove', memberRemove)).structuredContent;
  assert.equal(o.status, 'pending_approval');
  assert.equal(c.elicitations.length, 0);
  assert.equal(mock.state.applied.length, 0);
});

test('dashboard-class changes return the approval link and never execute, whatever the client answers', async (t) => {
  const { mock, url } = await withMock(t);
  const gui = { calls: 0, available: () => true, async confirm() { this.calls++; return true; } };
  const c = session(t, { env: envFor(t, url, mock.tokens.admin), gui, onElicit: () => ({ action: 'accept', content: { confirm: true } }) });
  await c.init();
  const rule0 = mock.ruleHash(mock.state.policy.rules[0]);
  const cases = [
    ['team_member_invite', { email: 'eve@acme.example', role: 'admin' }],
    ['team_member_set_role', { user_id: 'bob@acme.example', role: 'admin' }],
    ['team_policy_propose', { base_version: 7, ops: [{ op: 'add_allow_hosts', index: 0, rule_hash: rule0, hosts: ['evil.example'] }] }],
    ['team_policy_propose', { base_version: 7, ops: [{ op: 'add_deny_rule', secret: 'PROD_*', agents: ['cursor'] }, { op: 'remove_rule', index: 1, rule_hash: mock.ruleHash(mock.state.policy.rules[1]) }] }],
    // Removing the last allowed host stays in the dashboard until [] means "none" everywhere.
    ['team_policy_propose', { base_version: 7, ops: [{ op: 'remove_allow_hosts', index: 0, rule_hash: rule0, hosts: ['api.stripe.com', 'api.example.com'] }] }],
  ];
  for (const [name, args] of cases) {
    const o = (await c.call(name, args)).structuredContent;
    assert.equal(o.status, 'pending_approval', name + ' ' + JSON.stringify(o));
    assert.equal(o.class, 'dashboard');
    assert.match(o.approve_url, /^https:\/\/usezn\.com\/team\/approvals\?change=chg_/);
    assert.match(o.message, /Opening permissions can only be approved in the dashboard/);
  }
  assert.equal(c.elicitations.length, 0, 'no elicitation for dashboard changes');
  assert.equal(gui.calls, 0, 'no dialog for dashboard changes');
  assert.equal(mock.state.requests.filter((x) => /\/(confirm|approve)$/.test(x.path)).length, 0);
  assert.equal(mock.state.applied.length, 0);
  assert.equal(mock.state.policy_version, 7);
  // A token can never approve: the approve route needs a dashboard session.
  const id = [...mock.state.changes.keys()][0];
  const api = createAdminClient({ token: mock.tokens.admin, apiBase: url, version: 't' });
  await assert.rejects(api.confirmChange(id, { nonce: 'x'.repeat(32), via: 'dialog' }), (e) => e.status === 403);
  assertNoSecrets(c, mock);
});

test('tightening policy change: confirmed on the client and applied as v+1', async (t) => {
  const { mock, url } = await withMock(t);
  const c = session(t, { env: envFor(t, url, mock.tokens.admin), onElicit: () => ({ action: 'accept', content: { confirm: true } }) });
  await c.init();
  const rule0 = mock.ruleHash(mock.state.policy.rules[0]);
  const o = (await c.call('team_policy_propose', { base_version: 7, ops: [
    { op: 'add_deny_rule', secret: 'PROD_*', agents: ['cursor'], reason: 'no prod keys in cursor' },
    { op: 'remove_allow_hosts', index: 0, rule_hash: rule0, hosts: ['api.example.com'] },
  ], note: 'tighten' })).structuredContent;
  assert.equal(o.status, 'applied', JSON.stringify(o));
  assert.equal(o.new_version, 8);
  assert.equal(mock.state.policy_version, 8);
});

test('invite as member: applied with the accept link', async (t) => {
  const { mock, url } = await withMock(t);
  const gui = { available: () => true, confirm: async () => true };
  const c = session(t, { env: envFor(t, url, mock.tokens.admin), gui });
  await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  const o = (await c.call('team_member_invite', { email: 'Dave2@Acme.example' })).structuredContent;
  assert.equal(o.status, 'applied');
  assert.match(o.accept_url, /^https:\/\/usezn\.com\/team\?invite=/);
  const created = mock.state.requests.find((x) => x.method === 'POST' && x.path === '/v1/org/changes');
  assert.deepEqual(created.body, { kind: 'member.invite', params: { email: 'dave2@acme.example', role: 'member' } });
});

test('replay rejected: a used nonce cannot confirm again; another token cannot confirm', async (t) => {
  const { mock, url } = await withMock(t);
  const api = createAdminClient({ token: mock.tokens.admin, apiBase: url, version: 't' });
  const other = createAdminClient({ token: mock.tokens.other, apiBase: url, version: 't' });
  const created = await api.createChange({ kind: 'member.remove', params: { user_id: 'bob@acme.example' } });
  assert.equal(created.confirm.mode, 'client');
  await assert.rejects(other.confirmChange(created.change.id, { nonce: created.confirm.nonce, via: 'dialog' }), (e) => e.status === 403);
  const ok = await api.confirmChange(created.change.id, { nonce: created.confirm.nonce, via: 'dialog' });
  assert.equal(ok.change.status, 'applied');
  await assert.rejects(api.confirmChange(created.change.id, { nonce: created.confirm.nonce, via: 'dialog' }), (e) => e.status === 409);
  assert.equal(mock.state.applied.length, 1);
});

test('expired rejected: a confirmation after 10 minutes is refused and nothing changes', async (t) => {
  const { mock, url } = await withMock(t);
  // The person takes 11 minutes to answer the dialog.
  const gui = { available: () => true, confirm: async () => { mock.advance(11 * 60 * 1000); return true; } };
  const c = session(t, { env: envFor(t, url, mock.tokens.admin), gui });
  await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  const r = await c.call('team_member_remove', memberRemove);
  const o = r.structuredContent;
  assert.equal(o.status, 'expired', JSON.stringify(o));
  assert.equal(o.error, 'confirm_expired');
  assert.match(o.message, /not confirmed in time/);
  assert.equal(o.approve_url, 'https://usezn.com/team/approvals?change=' + o.change_id, 'still approvable in the dashboard');
  assert.equal(mock.state.changes.get(o.change_id).status, 'pending');
  assert.ok(mock.state.members.some((m) => m.user_id === 'bob@acme.example'));
  assert.equal(mock.state.applied.length, 0);

  // After 72 h the change itself expired: no dashboard link either.
  const late = { available: () => true, confirm: async () => { mock.advance(73 * 3600 * 1000); return true; } };
  const c2 = session(t, { env: envFor(t, url, mock.tokens.admin), gui: late });
  await c2.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  const o2 = (await c2.call('team_member_remove', memberRemove)).structuredContent;
  assert.equal(o2.status, 'expired');
  assert.equal(o2.approve_url, undefined);
  assert.equal(mock.state.applied.length, 0);
});

test('stale policy: confirmed but not applied when the policy moved on', async (t) => {
  const { mock, url } = await withMock(t);
  const gui = { available: () => true, confirm: async () => { mock.state.policy_version = 9; return true; } };
  const c = session(t, { env: envFor(t, url, mock.tokens.admin), gui });
  await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  const r = await c.call('team_policy_propose', { base_version: 7, ops: [{ op: 'enable_redaction', pii: true }] });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.status, 'failed');
  assert.equal(r.structuredContent.error, 'stale_policy');
});

test('agent_write_mode: off refuses, dashboard turns every change into an approval link', async (t) => {
  let { mock, url } = await withMock(t, { agentWriteMode: 'off' });
  let c = session(t, { env: envFor(t, url, mock.tokens.admin), onElicit: () => ({ action: 'accept', content: { confirm: true } }) });
  await c.init();
  let r = await c.call('team_member_remove', memberRemove);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error, 'agent_writes_off');

  ({ mock, url } = await withMock(t, { agentWriteMode: 'dashboard' }));
  c = session(t, { env: envFor(t, url, mock.tokens.admin), onElicit: () => ({ action: 'accept', content: { confirm: true } }) });
  await c.init();
  r = await c.call('team_member_remove', memberRemove);
  assert.equal(r.structuredContent.status, 'pending_approval');
  assert.equal(c.elicitations.length, 0);
});

test('team_change_status and team_change_cancel', async (t) => {
  const { mock, url } = await withMock(t);
  const c = session(t, { env: envFor(t, url, mock.tokens.admin) });
  await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '1' } });
  const o = (await c.call('team_member_remove', memberRemove)).structuredContent;
  const st = (await c.call('team_change_status', { change_id: o.change_id })).structuredContent;
  assert.equal(st.change.status, 'pending');
  assert.equal((await c.call('team_changes_list')).structuredContent.changes.length, 1);
  const cancel = (await c.call('team_change_cancel', { change_id: o.change_id })).structuredContent;
  assert.equal(cancel.cancelled, o.change_id);
  assert.equal(mock.state.changes.get(o.change_id).status, 'cancelled');
});

/* ------------------------------ the real process ------------------------------ */

function rpc(child) {
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  return (msg) => new Promise((resolve) => { waiting.set(msg.id, resolve); child.stdin.write(JSON.stringify(msg) + '\n'); });
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
}

test('(e2e) zn-gate mcp process: team tools over stdio, approval link, token never on stdout or stderr', async (t) => {
  const { mock, url } = await withMock(t);
  const home = tempDir(t, 'zn-team-e2e-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ZN_TEAM_API_URL: url, ZN_TEAM_DEV: '1', ZN_ORG_TOKEN: mock.tokens.admin, ZN_TEAM_CONFIRM: 'dashboard', DEBUG: '1', ZN_VERBOSE: '1' };
  delete env.ZN_LOCAL_ONLY;
  const child = spawn(process.execPath, [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const call = rpc(child);
  try {
    const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'claude-code', version: '2.1.240' } } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.ok(list.result.tools.some((x) => x.name === 'team_policy_propose'));
    const r = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'team_member_remove', arguments: memberRemove } });
    assert.equal(r.result.structuredContent.status, 'pending_approval');
    const st = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'zn_status', arguments: {} } });
    const status = JSON.parse(st.result.content[0].text);
    assert.equal(status.team.admin_tools, 'on');
    assert.equal(status.team.token_source, 'ZN_ORG_TOKEN');
  } finally {
    await stop(child);
  }
  for (const tok of Object.values(mock.tokens)) {
    assert.ok(!stdout.includes(tok.slice(19)), 'token on stdout');
    assert.ok(!stderr.includes(tok.slice(19)), 'token on stderr');
  }
});

test('(e2e) zn team admin login refuses the token as an argument and agent environments', async (t) => {
  const home = tempDir(t, 'zn-team-login-');
  const run = (args, extra) => new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ...extra };
    const child = spawn(process.execPath, [CLI, 'team', 'admin'].concat(args), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.stdin.end();
    child.on('exit', (code) => resolve({ code, out }));
  });
  const { newToken } = require('./fixtures/team_api_mock');
  const tok = newToken();
  let r = await run(['login', tok]);
  assert.equal(r.code, 2);
  assert.match(r.out, /never passed as an argument/);
  assert.ok(!r.out.includes(tok.slice(19)), 'the refused token is not echoed');
  r = await run(['login'], { CLAUDECODE: '1' });
  assert.equal(r.code, 3);
  assert.match(r.out, /not by an AI agent/);
  r = await run(['login'], {});
  assert.notEqual(r.code, 0, 'no TTY: refused');
  r = await run(['status'], {});
  assert.equal(r.code, 0);
  assert.match(r.out, /no org token on this machine/);
  assert.ok(!fs.existsSync(path.join(home, '.zn', 'team-admin.json')));
});

test('local tools still work next to the team tools', async (t) => {
  const c = session(t, { env: { ZN_HOME: tempDir(t, 'zn-') } });
  await c.init();
  const r = await c.call('check_tool_result', { tool_name: 'read_file', content: 'hello' });
  assert.equal(JSON.parse(r.content[0].text).safe_to_ingest, true);
  assert.equal(LOCAL_TOOLS.length, 4);
});
