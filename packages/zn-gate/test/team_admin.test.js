'use strict';
/**
 * zn Team admin tools: token format, input schemas, configuration, the
 * confirmation text and chain, hooks and scrubber. All tokens are generated
 * at run time (fake).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const token = require('../lib/team/admin/token');
const { validate } = require('../lib/team/admin/schema');
const config = require('../lib/team/admin/config');
const teamConfirm = require('../lib/team/admin/confirm');
const { TOOLS } = require('../lib/team/admin/tools');
const definitions = require('../lib/team/admin/tools.json');
const policy = require('../lib/hooks/policy');
const patterns = require('../lib/scrub/patterns');
const { newToken } = require('./fixtures/team_api_mock');
const { tempDir } = require('./helpers/tmp');

/* ------------------------------ token ------------------------------ */

test('org token: shape, checksum, prefix and id', () => {
  const t = newToken();
  assert.match(t, token.TOKEN_RE);
  assert.ok(token.orgTokenCrcOk(t));
  const p = token.parseOrgToken(t);
  assert.equal(p.prefix, t.slice(0, 18));
  assert.equal(p.tokenId, 'tok_' + t.slice(6, 18));
  assert.ok(!('secret' in p));
  // A typo anywhere breaks the checksum.
  const typo = t.slice(0, 30) + (t[30] === 'a' ? 'b' : 'a') + t.slice(31);
  assert.equal(token.orgTokenCrcOk(typo), false);
  assert.equal(token.parseOrgToken(typo), null);
  assert.equal(token.parseOrgToken('zn_' + t.slice(6)), null);
  assert.equal(token.prefixOf(t), p.prefix);
});

test('org token: CRC-32 matches zlib and base62 is padded to 6', () => {
  assert.equal(token.crc32('123456789'), 0xcbf43926);
  assert.equal(token.crc32(''), 0);
  const zlib = require('zlib');
  if (typeof zlib.crc32 === 'function') {
    for (let i = 0; i < 20; i++) {
      const s = 'znorg_' + i + '_' + newToken();
      assert.equal(token.crc32(s), zlib.crc32(s));
    }
  }
  assert.equal(token.orgTokenCrc('znorg_x_y').length, 6);
});

test('maskTokens replaces anything token-shaped by its prefix', () => {
  const t = newToken();
  const out = token.maskTokens('a ' + t + ' b');
  assert.ok(!out.includes(t.slice(19)));
  assert.ok(out.includes(t.slice(0, 18) + '_[REDACTED]'));
});

test('scrubber redacts a valid znorg_ token and ignores a bad checksum', () => {
  const t = newToken();
  const text = 'ZN_ORG_TOKEN=' + t + '\n';
  const spans = patterns.findPatterns(text, {});
  const hit = spans.find((s) => s.type === 'ZN_ORG_TOKEN');
  assert.ok(hit, 'znorg_ token must be detected');
  assert.equal(text.slice(hit.start, hit.end), t);
  const bad = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
  assert.ok(!patterns.findPatterns('x ' + bad + ' y', {}).some((s) => s.type === 'ZN_ORG_TOKEN'));
});

test('scrub engine tokenizes a znorg_ token in tool output', async () => {
  const engine = require('../lib/scrub/engine');
  const t = newToken();
  const spans = engine.scan('config: ' + t, { project: 'p', agent: 'test', tool: 'read', destination: 'assistant' });
  assert.ok(spans.some((s) => s.type === 'ZN_ORG_TOKEN'));
});

/* ------------------------------ hooks ------------------------------ */

test('hooks deny team admin login/logout and reading the token from the OS store', () => {
  for (const cmd of [
    'zn team admin login', 'npx zn-gate team admin login --from-clipboard', 'zn team admin logout', 'zn team approve chg_1',
    'node /x/bin/cli.js team admin login',
  ]) {
    const d = policy.bashDenial(cmd, {});
    assert.ok(d && /zn Team org admin token/.test(d), cmd);
  }
  for (const cmd of [
    'security find-generic-password -s zn-team-admin -w',
    '/usr/bin/security find-generic-password -s zn-team-admin -a org_x -w',
    'secret-tool lookup service zn-team-admin account org_x',
    'cmdkey /list:zn-team-admin:org_x',
    'powershell -c "[Cred]::CredRead(\'zn-team-admin:org_x\')"',
  ]) {
    assert.ok(policy.teamTokenStoreRead(cmd), cmd);
    assert.match(policy.bashDenial(cmd, {}), /not readable by agents/, cmd);
  }
  // Status is fine for agents; mentioning the name alone is fine too.
  assert.equal(policy.adminCommand('zn team admin status'), null);
  assert.equal(policy.teamTokenStoreRead('grep -r zn-team-admin docs/security.md'), false);
  assert.equal(policy.teamTokenStoreRead('security find-generic-password -s other'), false);
});

/* ------------------------------ schema ------------------------------ */

const byName = (n) => TOOLS.find((t) => t.name === n);

test('input validation: defaults, unknown keys, formats, policy ops', () => {
  const invite = byName('team_member_invite').inputSchema;
  const ok = validate(invite, { email: 'dave@acme.example' });
  assert.ok(ok.ok);
  assert.equal(ok.value.role, 'member');
  assert.ok(!validate(invite, { email: 'not-an-email' }).ok);
  assert.ok(!validate(invite, { email: 'a@b.example', org_id: 'org_x' }).ok, 'no org_id input');
  assert.ok(!validate(invite, { email: 'a@b.example', note: 'line\nbreak' }).ok);

  const prop = byName('team_policy_propose').inputSchema;
  const good = validate(prop, { base_version: 7, ops: [{ op: 'add_deny_rule', secret: 'PROD_*', agents: ['cursor'] }] });
  assert.ok(good.ok, JSON.stringify(good.errors));
  assert.equal(good.value.ops[0].position, 0);
  const badOp = validate(prop, { base_version: 7, ops: [{ op: 'remove_allow_hosts', index: 0, rule_hash: 'zz', hosts: ['a.example'] }] });
  assert.ok(!badOp.ok);
  assert.match(badOp.errors.join(' '), /rule_hash/);
  assert.ok(!validate(prop, { base_version: 7, ops: [{ op: 'make_admin' }] }).ok);
  assert.ok(!validate(prop, { base_version: 7, ops: [] }).ok);
  assert.ok(validate(prop, { base_version: 7, ops: [{ op: 'replace_policy', policy: { rules: [{ secret: 'A', agents: ['*'] }] } }] }).ok);
  assert.ok(!validate(byName('team_change_status').inputSchema, { change_id: 'chg_bad' }).ok);
  assert.ok(!validate(byName('team_install_revoke').inputSchema, { install_id: 'nope' }).ok);
});

/* ------------------------------ tools.json ------------------------------ */

function walkSchemas(s, fn, at = '') {
  if (!s || typeof s !== 'object') return;
  fn(s, at);
  for (const [k, v] of Object.entries(s.properties || {})) walkSchemas(v, fn, at + '.' + k);
  if (s.items) walkSchemas(s.items, fn, at + '[]');
  for (const b of s.oneOf || []) walkSchemas(b, fn, at + '|');
}

test('tool definitions: 18 tools, titles, annotations, closed schemas, no org_id', () => {
  assert.equal(definitions.tools.length, 18);
  const names = new Set();
  for (const t of definitions.tools) {
    assert.match(t.name, /^team_[a-z_]+$/);
    assert.ok(!names.has(t.name), 'duplicate ' + t.name);
    names.add(t.name);
    assert.ok(t.title && t.description, t.name);
    assert.ok(!/[^\x20-\x7e]/.test(t.description), t.name + ' description must be plain ASCII English');
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof t.annotations[k], 'boolean', t.name + ' ' + k);
    }
    assert.equal(t.annotations.openWorldHint, false);
    assert.ok(Array.isArray(t.scopes));
    walkSchemas(t.inputSchema, (s, at) => {
      if (s.type === 'object') assert.equal(s.additionalProperties, false, t.name + at);
      assert.ok(!(s.properties && 'org_id' in s.properties), t.name + at + ' must not take org_id');
    });
  }
});

test('write tools say they cannot approve on their own; reads are read-only', () => {
  const sentence = 'A person must approve it outside the conversation; this tool cannot approve on its own. Changes that open access are approved only in the zn dashboard.';
  const writes = ['team_member_invite', 'team_invitation_revoke', 'team_member_remove', 'team_member_set_role', 'team_install_revoke', 'team_policy_propose'];
  for (const n of writes) {
    const t = byName(n);
    assert.ok(t.description.includes(sentence), n);
    assert.equal(t.annotations.readOnlyHint, false, n);
  }
  for (const t of TOOLS) {
    if (writes.includes(t.name) || t.name === 'team_change_cancel' || t.name === 'team_audit_export') continue;
    assert.equal(t.annotations.readOnlyHint, true, t.name);
  }
  // The op list of team_policy_propose covers every operation the server classifies.
  const ops = byName('team_policy_propose').inputSchema.properties.ops.items.oneOf.map((b) => b.properties.op.const).sort();
  assert.deepEqual(ops, ['add_agents_to_deny_rule', 'add_agents_to_rule', 'add_allow_commands', 'add_allow_hosts', 'add_detector', 'add_deny_rule', 'add_rule',
    'disable_redaction', 'enable_redaction', 'move_rule', 'remove_agents_from_rule', 'remove_allow_commands', 'remove_allow_hosts', 'remove_detector', 'remove_rule',
    'replace_policy', 'set_inject_at', 'set_rule_deny', 'set_rule_mode', 'set_rule_secret', 'unset_rule_deny'].sort());
});

/* ------------------------------ config ------------------------------ */

function fakeKeychain() {
  const items = new Map();
  const key = (b, w) => b + '|' + w.service + '|' + w.account;
  return {
    items,
    detectBackend: () => 'macos',
    storeItem: (b, v, w) => { items.set(key(b, w), v); },
    loadItem: (b, w) => (items.has(key(b, w)) ? items.get(key(b, w)) : null),
    removeItem: (b, w) => items.delete(key(b, w)),
  };
}

test('config: no token -> off; env token; login wins over env; local-only always off', (t) => {
  const home = tempDir(t, 'zn-team-');
  const env = {};
  assert.equal(config.tokenSource({ env, home }), null);
  const envTok = newToken();
  env.ZN_ORG_TOKEN = envTok;
  assert.equal(config.tokenSource({ env, home }), 'env');
  assert.equal(config.loadToken({ env, home }).source, 'env');
  assert.equal(config.tokenSource({ env: { ...env, ZN_LOCAL_ONLY: 'true' }, home }), null);
  assert.equal(config.loadToken({ env, home, localOnly: true }), null);

  const kc = fakeKeychain();
  const loginTok = newToken();
  const meta = config.saveToken(loginTok, { org_id: 'org_7Kq2xYAcme', org_name: 'Acme', scopes: ['org:read'], api_base: 'https://api.usezn.com' }, { env, home, keychain: kc });
  assert.equal(meta.store, 'keychain:macos');
  assert.equal(meta.prefix, loginTok.slice(0, 18));
  const metaText = fs.readFileSync(path.join(home, 'team-admin.json'), 'utf8');
  assert.ok(!metaText.includes(loginTok.slice(19)), 'metadata never holds the token');
  assert.equal(config.tokenSource({ env, home }), 'login');
  const loaded = config.loadToken({ env, home, keychain: kc });
  assert.equal(loaded.token, loginTok);
  assert.equal(loaded.source, 'keychain');
  assert.ok(config.removeToken({ env, home, keychain: kc }));
  assert.equal(kc.items.size, 0);
  assert.equal(config.tokenSource({ env, home }), 'env');
});

test('config: file store without an OS credential store, 0600', (t) => {
  const home = tempDir(t, 'zn-team-');
  const env = {};
  const kc = Object.assign(fakeKeychain(), { detectBackend: () => 'passphrase' });
  const tok = newToken();
  const meta = config.saveToken(tok, { org_id: 'org_7Kq2xYAcme', api_base: 'https://api.usezn.com' }, { env, home, keychain: kc });
  assert.equal(meta.store, 'file');
  const file = path.join(home, 'team-admin.token');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(config.loadToken({ env, home }).token, tok);
});

test('config: bad env token and bad API URLs are refused without echoing the token', () => {
  const bad = newToken().slice(0, -1) + '0';
  try {
    config.loadToken({ env: { ZN_ORG_TOKEN: bad } });
    if (token.orgTokenCrcOk(bad)) return; // 1 in 62: the changed char happened to be the right one
    assert.fail('must throw');
  } catch (err) {
    assert.equal(err.code, 'ZN_TEAM_TOKEN');
    assert.ok(!err.message.includes(bad.slice(19)));
  }
  assert.throws(() => config.apiBase({ env: { ZN_TEAM_API_URL: 'http://api.usezn.com' } }), /https:\/\/api\.usezn\.com/);
  assert.throws(() => config.apiBase({ env: { ZN_TEAM_API_URL: 'https://user:pw@api.usezn.com' } }), /https:\/\/api\.usezn\.com/);
  assert.equal(config.apiBase({ env: { ZN_TEAM_API_URL: 'http://127.0.0.1:8080/', ZN_TEAM_DEV: '1' } }), 'http://127.0.0.1:8080');
  assert.equal(config.apiBase({ env: {} }), 'https://api.usezn.com');
  assert.equal(config.apiBase({ env: { ZN_TEAM_API_URL: 'https://api.usezn.com/' } }), 'https://api.usezn.com');
});

test('config: the token only goes to allow-listed hosts (H2)', (t) => {
  // Any other https host is refused, whatever names it.
  for (const url of ['https://evil.example', 'https://api.usezn.com.evil.example', 'https://evil.example/api.usezn.com', 'https://api.usezn.com:8443',
    'https://API.usezn.com/v1', 'https://api.usezn.com?x=1', 'http://localhost:8080', 'http://127.0.0.1:9', 'http://[::1]:9', 'file:///etc/passwd', 'not a url']) {
    assert.throws(() => config.apiBase({ env: { ZN_TEAM_API_URL: url } }), (e) => e.code === 'ZN_POLICY_DENIED' && /ZN_TEAM_DEV=1/.test(e.message), url);
    assert.throws(() => config.apiBase({ env: {}, apiUrl: url }), (e) => e.code === 'ZN_POLICY_DENIED', 'login --api-url ' + url);
  }
  // Dev mode only adds local hosts.
  assert.throws(() => config.apiBase({ env: { ZN_TEAM_API_URL: 'https://evil.example', ZN_TEAM_DEV: '1' } }), /ZN_TEAM_API_URL must be/);
  assert.throws(() => config.apiBase({ env: { ZN_TEAM_API_URL: 'http://localhost:1', ZN_TEAM_DEV: 'true' } }), /ZN_TEAM_API_URL must be/, 'only ZN_TEAM_DEV=1');
  assert.equal(config.apiBase({ env: { ZN_TEAM_API_URL: 'http://localhost:3000', ZN_TEAM_DEV: '1' } }), 'http://localhost:3000');

  // Token from the login store: only the API recorded at login, the environment cannot redirect it.
  const meta = { api_base: 'https://api.usezn.com' };
  assert.equal(config.apiBase({ env: { ZN_TEAM_API_URL: 'https://evil.example' } }, meta), 'https://api.usezn.com');
  assert.equal(config.apiBase({ env: { ZN_TEAM_API_URL: 'http://127.0.0.1:1', ZN_TEAM_DEV: '1' }, apiUrl: 'https://evil.example' }, meta), 'https://api.usezn.com');
  assert.throws(() => config.apiBase({ env: {} }, { api_base: 'https://evil.example' }), /recorded at login must be/, 'a tampered metadata file is refused');
  assert.throws(() => config.apiBase({ env: {} }, { api_base: 'http://127.0.0.1:1' }), /recorded at login must be/);
  assert.equal(config.apiBase({ env: { ZN_TEAM_DEV: '1' } }, { api_base: 'http://127.0.0.1:1' }), 'http://127.0.0.1:1');
  assert.throws(() => config.apiBase({ env: {} }, {}), /login again|admin login/);

  // End to end through loadToken: the stored token's metadata wins over the environment.
  const home = tempDir(t, 'zn-team-');
  const kc = fakeKeychain();
  config.saveToken(newToken(), { org_id: 'org_7Kq2xYAcme', api_base: 'https://api.usezn.com' }, { env: {}, home, keychain: kc });
  const env = { ZN_TEAM_API_URL: 'https://evil.example' };
  const loaded = config.loadToken({ env, home, keychain: kc });
  assert.equal(loaded.source, 'keychain');
  assert.equal(config.apiBase({ env, home }, loaded.meta), 'https://api.usezn.com');

  // Dashboard links.
  assert.equal(config.dashboardBase({ env: {} }), 'https://usezn.com');
  assert.throws(() => config.dashboardBase({ env: { ZN_TEAM_DASHBOARD_URL: 'https://usezn.com.evil.example' } }), /ZN_TEAM_DASHBOARD_URL must be https:\/\/usezn\.com/);
  assert.throws(() => config.dashboardBase({ env: { ZN_TEAM_DASHBOARD_URL: 'http://localhost:3000' } }), /ZN_TEAM_DEV=1/);
  assert.equal(config.dashboardBase({ env: { ZN_TEAM_DASHBOARD_URL: 'http://localhost:3000', ZN_TEAM_DEV: '1' } }), 'http://localhost:3000');
  assert.ok(config.isDashboardUrl('https://usezn.com/team/approvals?change=chg_x', { env: {} }));
  for (const u of ['https://evil.example/team/approvals?change=chg_x', 'https://usezn.com.evil.example/team', 'http://usezn.com/team', 'https://user@usezn.com/team', 'javascript:alert(1)']) {
    assert.equal(config.isDashboardUrl(u, { env: {} }), false, u);
  }
});

/* ------------------------------ confirmation ------------------------------ */

const CHANGE = {
  id: 'chg_0k3x9a2bQ7mN4pR8sT1v', kind: 'member.remove', class: 'confirm', digest8: '3f9a1c2e',
  summary: ['Remove member bob@acme.example from Acme'],
  requested_by: { type: 'token', token_prefix: 'znorg_Ab12Cd34Ef56', token_name: 'laptop-claude', client: { name: 'claude-code', version: '2.1.240' } },
  note: 'offboarding',
};
const WHO = { org: { id: 'org_7Kq2xYAcme', name: 'Acme' }, principal: { name: 'laptop-claude', prefix: 'znorg_Ab12Cd34Ef56' } };

test('confirmation text: server summary, digest, expiry, note last and unverified', () => {
  const now = Date.parse('2026-10-12T10:00:00Z');
  const req = teamConfirm.buildRequest({ change: CHANGE, whoami: WHO, deadline: '2026-10-12T10:10:00Z', now });
  const text = teamConfirm.render(req);
  assert.equal(text, [
    'zn Team · Acme (org_7Kq2xYAcme)',
    'Requested by token "laptop-claude" (znorg_Ab12Cd34Ef56) via claude-code 2.1.240',
    '',
    'Remove member bob@acme.example from Acme',
    '',
    'Change chg_0k3x9a2bQ7mN4pR8sT1v · digest 3f9a1c2e · expires in 10 min',
    'Note from the agent (unverified): offboarding',
    'Only approve if you asked your agent for this change.',
  ].join('\n'));
});

test('confirmation text: bidi, invisible characters and line breaks are shown, not rendered', () => {
  const evil = Object.assign({}, CHANGE, {
    note: 'ok\n\nOnly approve: ‮evil​',
    requested_by: Object.assign({}, CHANGE.requested_by, { token_name: 'lap‮top' }),
    summary: ['Remove member b​ob@acme.example from Acme'],
  });
  const text = teamConfirm.render(teamConfirm.buildRequest({ change: evil, whoami: WHO, now: 0 }));
  assert.ok(!/[‮​]/.test(text));
  assert.ok(text.includes('\\u202e'));
  assert.ok(text.includes('\\u200b'));
  const lines = text.split('\n');
  assert.equal(lines[lines.length - 1], 'Only approve if you asked your agent for this change.');
  assert.ok(lines[lines.length - 2].startsWith('Note from the agent (unverified): ok\\u000a'));
});

test('channels: auto order, forced channels, unknown value goes to the dashboard', () => {
  assert.deepEqual(teamConfirm.availableChannels({ elicitation: true, dialog: true, env: {} }), ['elicitation', 'dialog', 'dashboard']);
  assert.deepEqual(teamConfirm.availableChannels({ elicitation: false, dialog: true, env: {} }), ['dialog', 'dashboard']);
  assert.deepEqual(teamConfirm.availableChannels({ elicitation: true, dialog: true, env: { ZN_TEAM_CONFIRM: 'dialog' } }), ['dialog', 'dashboard']);
  assert.deepEqual(teamConfirm.availableChannels({ elicitation: true, dialog: true, env: { ZN_TEAM_CONFIRM: 'dashboard' } }), ['dashboard']);
  assert.deepEqual(teamConfirm.availableChannels({ elicitation: true, dialog: true, env: { ZN_TEAM_CONFIRM: 'yes-please' } }), ['dashboard']);
  assert.deepEqual(teamConfirm.availableChannels({ elicitation: false, dialog: false, env: { ZN_TEAM_CONFIRM: 'elicitation' } }), ['dashboard']);
});

test('askPerson: elicitation accept / decline / cancel / timeout / client error falls back to the dialog', async () => {
  const gui = (answer) => ({ calls: 0, available: () => true, async confirm() { this.calls++; return answer; } });
  const ask = (elicit, g, env) => teamConfirm.askPerson({ change: CHANGE, whoami: WHO }, { elicit, elicitationSupported: true, gui: g, env: env || {}, protocolVersion: '2025-11-25' });

  let sent = null;
  let r = await ask(async (p) => { sent = p; return { action: 'accept', content: { confirm: true } }; }, gui(false));
  assert.deepEqual(r, { decision: 'approved', via: 'elicitation' });
  assert.equal(sent.mode, 'form');
  assert.deepEqual(sent.requestedSchema, teamConfirm.REQUESTED_SCHEMA);
  assert.match(sent.message, /Only approve if you asked your agent/);

  r = await ask(async () => ({ action: 'accept', content: { confirm: false } }), gui(true));
  assert.equal(r.decision, 'declined');
  r = await ask(async () => ({ action: 'decline' }), gui(true));
  assert.equal(r.decision, 'declined');
  r = await ask(async () => ({ action: 'cancel' }), gui(true));
  assert.equal(r.decision, 'declined');
  r = await ask(async () => { const e = new Error('t'); e.code = 'ZN_TIMEOUT'; throw e; }, gui(true));
  assert.equal(r.decision, 'declined');

  const g = gui(true);
  r = await ask(async () => { const e = new Error('Method not found'); e.code = 'ZN_CLIENT_ERROR'; throw e; }, g);
  assert.deepEqual(r, { decision: 'approved', via: 'dialog' });
  assert.equal(g.calls, 1);
});

test('askPerson: dialog says no / no channel at all / dialog without a desktop', async () => {
  const no = { available: () => true, confirm: async () => false };
  let r = await teamConfirm.askPerson({ change: CHANGE, whoami: WHO }, { gui: no, env: {} });
  assert.deepEqual(r, { decision: 'declined', via: 'dialog' });
  r = await teamConfirm.askPerson({ change: CHANGE, whoami: WHO }, { gui: { available: () => false, confirm: async () => true }, env: {} });
  assert.equal(r.decision, 'unavailable');
  const headless = { available: () => true, confirm: async () => { const e = new Error('no channel'); e.noChannel = true; throw e; } };
  r = await teamConfirm.askPerson({ change: CHANGE, whoami: WHO }, { gui: headless, env: {} });
  assert.equal(r.decision, 'unavailable');
});

test('the default dialog never receives ZN_ORG_TOKEN', () => {
  const vault = require('../lib/vault/confirm');
  const orig = vault.guiChannel;
  let seen = null;
  vault.guiChannel = (o) => { seen = o.env; return { confirm: async () => false }; };
  try {
    const g = teamConfirm.defaultGui({ ZN_ORG_TOKEN: newToken(), DISPLAY: ':0' });
    g.confirm({ title: 'x', message: 'y' });
    assert.ok(seen && !('ZN_ORG_TOKEN' in seen));
    assert.equal(seen.DISPLAY, ':0');
  } finally {
    vault.guiChannel = orig;
  }
});

/* ------------------------------ zn team admin login ------------------------------ */

function sink() {
  const s = { text: '', write(x) { s.text += x; return true; } };
  return s;
}

test('zn team admin login: hidden prompt, whoami check, OS store; status and logout never print the token', async (t) => {
  const cli = require('../lib/team/admin/cli');
  const home = tempDir(t, 'zn-team-login-');
  const kc = fakeKeychain();
  const tok = newToken();
  const out = sink();
  const err = sink();
  let sentToken = null;
  const io = {
    stdin: { isTTY: true }, stdout: out, stderr: err, env: {}, home, keychain: kc,
    readHidden: async () => tok + '\n',
    createClient: (o) => { sentToken = o.token; return { whoami: async () => ({ org: { id: 'org_7Kq2xYAcme', name: 'Acme' }, principal: { scopes: ['org:read', 'members:read'], expires_at: '2026-11-11T00:00:00Z' } }) }; },
  };
  assert.equal(await cli.main(['login'], io), 0, err.text);
  assert.equal(sentToken, tok);
  assert.equal(kc.items.size, 1);
  assert.match(out.text, /Stored the org admin token znorg_/);
  const meta = config.readAdminMeta({ home });
  assert.equal(meta.org_id, 'org_7Kq2xYAcme');
  assert.deepEqual(meta.scopes, ['org:read', 'members:read']);
  assert.equal(await cli.main(['status'], io), 0);
  assert.match(out.text, /org_7Kq2xYAcme/);
  assert.equal(await cli.main(['logout'], io), 0);
  assert.equal(kc.items.size, 0);
  assert.equal(config.readAdminMeta({ home }), null);
  assert.ok(!(out.text + err.text).includes(tok.slice(19)), 'the token is never printed');

  // A rejected token is not stored.
  const bad = Object.assign({}, io, { createClient: () => ({ whoami: async () => { const e = new Error('Invalid or expired token'); e.code = 'invalid_token'; throw e; } }) });
  assert.equal(await cli.main(['login'], bad), 1);
  assert.equal(kc.items.size, 0);
  // Not a token at all.
  assert.equal(await cli.main(['login'], Object.assign({}, io, { readHidden: async () => 'hello' })), 1);
  // Agents and pipes are refused before anything is read.
  let asked = false;
  const agent = Object.assign({}, io, { env: { CODEX_SANDBOX: 'seatbelt' }, readHidden: async () => { asked = true; return tok; } });
  assert.equal(await cli.main(['login'], agent), 3);
  assert.equal(await cli.main(['login'], Object.assign({}, io, { stdin: { isTTY: false }, readHidden: async () => { asked = true; return tok; } })), 3);
  assert.equal(asked, false);
});

test('M1: in-client confirmation only when the whole summary fits', async () => {
  const lines = (n, len) => Array.from({ length: n }, (_, i) => ('line ' + i + ' ').padEnd(len || 10, 'x'));
  assert.equal(teamConfirm.summaryFits({ ...CHANGE, summary: lines(20) }), true);
  assert.equal(teamConfirm.summaryFits({ ...CHANGE, summary: lines(21) }), false);
  assert.equal(teamConfirm.summaryFits({ ...CHANGE, summary: lines(1, 300) }), true);
  assert.equal(teamConfirm.summaryFits({ ...CHANGE, summary: lines(1, 301) }), false);
  // Invisible characters are shown as \uXXXX (6 characters each): counted after escaping.
  assert.equal(teamConfirm.summaryFits({ ...CHANGE, summary: ['a'.repeat(290) + '​​'] }), false);
  assert.equal(teamConfirm.summaryFits({ ...CHANGE, summary: [{ toString: () => 'x' }] }), false);
  let shown = 0;
  const gui = { available: () => true, confirm: async () => { shown++; return true; } };
  const elicit = async () => { shown++; return { action: 'accept', content: { confirm: true } }; };
  for (const summary of [lines(21), lines(2, 400)]) {
    const r = await teamConfirm.askPerson({ change: { ...CHANGE, summary }, whoami: WHO }, { elicit, elicitationSupported: true, gui, env: {} });
    assert.deepEqual(r, { decision: 'unavailable', via: null, detail: 'summary_too_long' });
  }
  assert.equal(shown, 0, 'neither the elicitation nor the dialog was shown');
  const ok = await teamConfirm.askPerson({ change: { ...CHANGE, summary: lines(20) }, whoami: WHO }, { gui, env: {} });
  assert.equal(ok.decision, 'approved');
});
