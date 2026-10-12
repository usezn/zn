'use strict';
/**
 * In-memory mock of the zn Team admin API, for the team_* tool tests.
 *
 * Implements the routes zn-gate calls with an org admin token
 * (whoami, org, installs, policy, audit, activity, changes) and the server
 * rules that matter to the client: the server computes the class of every
 * change, a one-time nonce confirms "confirm" changes for 10 minutes and
 * only from the token that proposed them, "dashboard" changes can only be
 * approved with a dashboard session (never with a token), and
 * agent_write_mode can force the dashboard or turn agent writes off.
 *
 * Every token and secret here is generated at run time: fake, never real.
 *
 *   const mock = createTeamApiMock({ ... });
 *   const url = await mock.start();   // http://127.0.0.1:<port>
 *   mock.tokens.admin                 // a valid znorg_ token
 *   mock.state                        // members, policy, changes, requests
 *   mock.advance(ms)                  // move the mock clock
 *   await mock.stop();
 */

const http = require('http');
const crypto = require('crypto');
const { makeOrgToken } = require('../../lib/team/admin/token');

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ALL_SCOPES = ['org:read', 'members:read', 'members:write', 'policy:read', 'policy:publish', 'audit:read', 'audit:export'];
const CONFIRM_MS = 10 * 60 * 1000;
const DASHBOARD_MS = 72 * 3600 * 1000;

function rand(n, chars = ALNUM) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += chars[b[i] % chars.length];
  return s;
}

function newToken() {
  return makeOrgToken(rand(12), rand(43));
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ruleHash = (rule) => sha256(canonical(rule)).slice(0, 12);

const TIGHTEN_OPS = new Set(['add_deny_rule', 'set_rule_deny', 'add_agents_to_deny_rule', 'remove_allow_hosts', 'remove_allow_commands', 'add_detector', 'enable_redaction']);

function createTeamApiMock(o = {}) {
  let clock = o.now || Date.parse('2026-10-12T10:00:00.000Z');
  const org = { id: 'org_7Kq2xYAcme', name: o.orgName || 'Acme' };
  const tokens = {};
  const byToken = new Map();
  function addToken(key, info) {
    const token = newToken();
    const tid = token.slice(6, 18);
    tokens[key] = token;
    byToken.set(token, Object.assign({ token_id: 'tok_' + tid, prefix: 'znorg_' + tid, name: key, scopes: ALL_SCOPES, creator: 'owner@acme.example', creator_role: 'owner', expires_at: '2026-11-11T10:00:00.000Z' }, info || {}));
  }
  addToken('admin', { name: 'laptop-claude', scopes: (o.scopes || ALL_SCOPES) });
  addToken('other', { name: 'ci-token' });
  addToken('reader', { name: 'read-only', scopes: ['org:read', 'policy:read'] });

  const state = {
    agent_write_mode: o.agentWriteMode || 'confirm',
    members: [
      { user_id: 'owner@acme.example', role: 'owner', joined_at: '2026-09-01T00:00:00.000Z' },
      { user_id: 'bob@acme.example', role: 'member', joined_at: '2026-09-02T00:00:00.000Z' },
      { user_id: 'carol@acme.example', role: 'admin', joined_at: '2026-09-03T00:00:00.000Z' },
    ],
    invitations: [{ id: '0123456789abcdef', email: 'dave@acme.example', role: 'member', invited_by: 'owner@acme.example', created_at: '2026-10-01T00:00:00.000Z', expires_at: '2026-10-15T00:00:00.000Z' }],
    installs: [
      { install_id: '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', agent: 'claude-code', os: 'darwin', zn_gate_version: '1.6.0', created_at: '2026-10-01T00:00:00.000Z', last_seen: '2026-10-12T09:00:00.000Z', audit_records: 12, revoked_at: null },
      { install_id: '7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f', agent: 'codex', os: 'linux', zn_gate_version: '1.6.0', created_at: '2026-10-02T00:00:00.000Z', last_seen: null, audit_records: 0, revoked_at: '2026-10-05T00:00:00.000Z' },
    ],
    policy_version: 7,
    policy: { rules: [
      { secret: 'STRIPE_*', agents: ['*'], mode: 'proxy', allowHosts: ['api.stripe.com', 'api.example.com'] },
      { secret: 'PROD_*', agents: ['cursor'], deny: true },
    ] },
    changes: new Map(),
    requests: [],
    applied: [],
    exportBody: 'ts,agent,secret,decision\n2026-10-12T09:00:00Z,claude-code,STRIPE_KEY,allow\n',
    exportSha: null,
  };

  const reply = (res, status, body, headers) => {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }, headers || {}));
    res.end(data);
  };
  const fail = (res, status, code, message, extra) => reply(res, status, Object.assign({ error: message || code, code }, extra || {}));
  const iso = (ms) => new Date(ms).toISOString();

  function summaryOf(kind, params) {
    switch (kind) {
      case 'member.invite': return ['Invite ' + params.email + ' to ' + org.name + ' as ' + params.role];
      case 'invitation.revoke': return ['Revoke invitation ' + params.invitation_id];
      case 'member.remove': return ['Remove member ' + params.user_id + ' from ' + org.name];
      case 'member.role': return ['Change the role of ' + params.user_id + ' to ' + params.role];
      case 'install.revoke': return ['Revoke install ' + params.install_id];
      case 'policy.update': return ['Policy v' + params.base_version + ' → v' + (params.base_version + 1) + ': ' + params.ops.map((x) => x.op).join(', ')];
      default: return [kind];
    }
  }

  function classOf(kind, params) {
    if (kind === 'member.invite') return params.role === 'admin' ? 'dashboard' : 'confirm';
    if (kind === 'member.role') return params.role === 'admin' ? 'dashboard' : 'confirm';
    if (kind === 'policy.update') {
      for (const op of params.ops) {
        if (!TIGHTEN_OPS.has(op.op)) return 'dashboard';
        // Until zn-gate reads [] as "none", leaving an allow list empty needs the dashboard.
        if (op.op === 'remove_allow_hosts' || op.op === 'remove_allow_commands') {
          const rule = state.policy.rules[op.index] || {};
          const list = op.op === 'remove_allow_hosts' ? rule.allowHosts : rule.allowCommands;
          const left = (list || []).filter((x) => !(op.hosts || op.commands || []).includes(x));
          if (left.length === 0) return 'dashboard';
        }
      }
      return 'confirm';
    }
    return 'confirm';
  }

  function view(c) {
    return {
      id: c.id, kind: c.kind, class: c.class, status: c.status, summary: c.summary, digest8: c.digest.slice(0, 8), params: c.params,
      base_version: c.base_version, requested_by: c.requested_by, note: c.note, created_at: iso(c.created_at), deadline: iso(c.deadline), confirm_deadline: c.confirm_deadline ? iso(c.confirm_deadline) : undefined, approver_roles: c.class === 'dashboard' ? ['owner'] : ['owner', 'admin'],
      resolved_at: c.resolved_at ? iso(c.resolved_at) : undefined, confirm_via: c.confirm_via, result: c.result, error: c.error,
    };
  }

  function lazyExpire(c) {
    if (c.status === 'pending' && clock > c.deadline) { c.status = 'expired'; c.resolved_at = clock; }
  }

  function apply(c) {
    const p = c.params;
    switch (c.kind) {
      case 'member.remove':
        state.members = state.members.filter((m) => m.user_id !== p.user_id);
        return { removed: p.user_id };
      case 'member.invite':
        state.invitations.push({ id: rand(16, '0123456789abcdef'), email: p.email, role: p.role, invited_by: 'owner@acme.example', created_at: iso(clock), expires_at: iso(clock + 14 * 86400000) });
        return { invitation: { email: p.email, role: p.role }, accept_url: 'https://usezn.com/team?invite=' + rand(32) + '.' + org.id };
      case 'policy.update':
        if (p.base_version !== state.policy_version) { const e = new Error('stale_policy'); e.code = 'stale_policy'; throw e; }
        state.policy_version += 1;
        return { version: state.policy_version };
      default:
        return { ok: true };
    }
  }

  function needScope(res, info, scope) {
    if (!info.scopes.includes(scope)) { fail(res, 403, 'insufficient_scope', 'Missing scope ' + scope, { scope }); return false; }
    return true;
  }

  async function route(req, res, body, url) {
    const auth = String(req.headers.authorization || '');
    const bearer = auth.replace(/^Bearer\s+/i, '');
    const info = byToken.get(bearer);
    state.requests.push({ method: req.method, path: url.pathname, query: url.search, client: req.headers['x-zn-client'] || null, body, authOk: Boolean(info) });
    if (!info) return fail(res, 401, 'invalid_token', 'Invalid or expired token');
    if (info.revoked) return fail(res, 401, 'token_revoked', 'Token revoked');
    const p = url.pathname;
    const m = /^\/v1\/org\/changes\/(chg_[A-Za-z0-9]+)(\/(confirm|approve|reject))?$/.exec(p);

    if (req.method === 'GET' && p === '/v1/org/whoami') {
      return reply(res, 200, { org, principal: { type: 'token', token_id: info.token_id, name: info.name, prefix: info.prefix, scopes: info.scopes, expires_at: info.expires_at, creator_role: info.creator_role }, agent_write_mode: state.agent_write_mode, policy_version: state.policy_version });
    }
    if (req.method === 'GET' && p === '/v1/org') {
      if (!needScope(res, info, 'org:read')) return;
      const full = info.scopes.includes('members:read');
      return reply(res, 200, {
        org: { id: org.id, name: org.name, plan: 'team', seats: 10, seats_used: state.members.length + state.invitations.length, subscription_status: 'active', trial_ends_at: null, team_active: true, policy_version: state.policy_version },
        role: info.creator_role, members: full ? state.members : [], invitations: full ? state.invitations : [], ...(full ? {} : { redacted: ['members'] }),
      });
    }
    if (req.method === 'GET' && p === '/v1/org/installs') {
      if (!needScope(res, info, 'org:read')) return;
      return reply(res, 200, { installs: state.installs });
    }
    if (req.method === 'GET' && p === '/v1/org/policy') {
      if (!needScope(res, info, 'policy:read')) return;
      return reply(res, 200, {
        version: state.policy_version, policy: state.policy,
        rules_with_hash: state.policy.rules.map((rule, index) => ({ index, rule_hash: ruleHash(rule), rule })),
        public_key: { alg: 'Ed25519', kid: 'k1', key: 'ignored-by-the-tool' }, history: [{ version: state.policy_version, published_by: 'owner@acme.example', published_at: '2026-10-10T00:00:00Z', rules: 2 }],
      });
    }
    if (req.method === 'GET' && p === '/v1/audit') {
      if (!needScope(res, info, 'audit:read')) return;
      return reply(res, 200, { events: [{ ts: '2026-10-12T09:00:00Z', install_id: state.installs[0].install_id, seq: 1, agent: 'claude-code', secret: 'STRIPE_KEY', decision: 'allow' }], next_cursor: null });
    }
    if (req.method === 'GET' && p === '/v1/audit/summary') {
      if (!needScope(res, info, 'audit:read')) return;
      return reply(res, 200, { days: Number(url.searchParams.get('days') || 30), total: 1, truncated: false, by_day: [{ day: '2026-10-12', allow: 1 }], by_agent: { 'claude-code': 1 }, by_decision: { allow: 1 } });
    }
    if (req.method === 'GET' && p === '/v1/audit/export') {
      if (!needScope(res, info, 'audit:export')) return;
      const sha = state.exportSha || sha256(state.exportBody);
      return reply(res, 200, state.exportBody, { 'X-Content-SHA256': sha, 'X-Rows': '1', 'X-Truncated': 'false' });
    }
    if (req.method === 'GET' && p === '/v1/org/activity') {
      if (!needScope(res, info, 'audit:read')) return;
      return reply(res, 200, { events: [{ id: 'act_1', ts: iso(clock), org: org.id, actor: { type: 'token', user: info.creator, token_id: info.token_id, token_prefix: info.prefix, via: 'agent' }, action: 'members.read', result: 'ok', status: 200 }], next_cursor: null });
    }
    if (req.method === 'GET' && p === '/v1/org/changes') {
      if (!needScope(res, info, 'org:read')) return;
      const all = [...state.changes.values()].map((c) => { lazyExpire(c); return c; });
      const st = url.searchParams.get('status') || 'pending';
      return reply(res, 200, { changes: all.filter((c) => st === 'all' || c.status === 'pending').map(view) });
    }
    if (req.method === 'POST' && p === '/v1/org/changes') {
      const kind = body && body.kind;
      const params = (body && body.params) || {};
      const scope = kind === 'policy.update' ? 'policy:publish' : 'members:write';
      if (!needScope(res, info, scope)) return;
      if (state.agent_write_mode === 'off') return fail(res, 403, 'agent_writes_off', 'Agent writes are off for this organization');
      let cls = classOf(kind, params);
      if (state.agent_write_mode === 'dashboard') cls = 'dashboard';
      const id = 'chg_' + clock.toString(36).padStart(9, '0').slice(-9) + rand(11);
      const c = {
        id, kind, params, class: cls, status: 'pending', summary: summaryOf(kind, params),
        digest: sha256(canonical({ org: org.id, kind, params, base_version: params.base_version })),
        base_version: params.base_version, note: body.note,
        requested_by: { type: 'token', token_prefix: info.prefix, token_name: info.name, user: info.creator, via: 'agent', client: { name: 'claude-code', version: '2.1.240' } },
        token_id: info.token_id, created_at: clock,
        // /confirm: 10 minutes; dashboard approval: 72 h for both classes.
        confirm_deadline: cls === 'confirm' ? clock + CONFIRM_MS : undefined,
        deadline: clock + DASHBOARD_MS,
      };
      state.changes.set(id, c);
      if (cls === 'confirm') {
        const nonce = rand(32);
        c.nonce_sha256 = sha256(nonce);
        return reply(res, 201, { change: view(c), confirm: { mode: 'client', nonce, deadline: iso(c.confirm_deadline) } });
      }
      return reply(res, 201, { change: view(c), confirm: { mode: 'dashboard', approve_url: 'https://usezn.com/team/approvals?change=' + id, deadline: iso(c.deadline) } });
    }
    if (m) {
      const c = state.changes.get(m[1]);
      if (!c) return fail(res, 404, 'change_not_found', 'Change not found');
      lazyExpire(c);
      const action = m[3];
      if (req.method === 'GET' && !action) {
        if (!needScope(res, info, 'org:read')) return;
        return reply(res, 200, { change: view(c) });
      }
      if (req.method === 'DELETE' && !action) {
        if (c.token_id !== info.token_id) return fail(res, 403, 'not_change_creator', 'Only the token that proposed the change can cancel it');
        if (c.status !== 'pending') return fail(res, 409, c.status === 'expired' ? 'change_expired' : 'not_pending', 'The change is ' + c.status);
        c.status = 'cancelled'; c.resolved_at = clock; c.nonce_sha256 = undefined;
        return reply(res, 200, { cancelled: c.id });
      }
      if (req.method === 'POST' && (action === 'approve' || action === 'reject')) {
        return fail(res, 403, 'token_not_allowed', 'This action needs a dashboard session');
      }
      if (req.method === 'POST' && action === 'confirm') {
        if (c.token_id !== info.token_id) return fail(res, 403, 'not_change_creator', 'Only the token that proposed the change can confirm it');
        if (c.class !== 'confirm') return fail(res, 403, 'dashboard_approval_required', 'This change can only be approved in the dashboard');
        if (c.status === 'expired') return fail(res, 410, 'change_expired', 'The change expired');
        if (c.status !== 'pending') return fail(res, 409, 'not_pending', 'The change is ' + c.status);
        if (clock > c.confirm_deadline) return fail(res, 410, 'confirm_expired', 'The confirmation window (10 minutes) is over; the change can still be approved in the dashboard');
        if (state.agent_write_mode === 'off') return fail(res, 403, 'agent_writes_off', 'Agent writes are off for this organization');
        const nonce = body && typeof body.nonce === 'string' ? body.nonce : '';
        if (!c.nonce_sha256 || !crypto.timingSafeEqual(Buffer.from(sha256(nonce)), Buffer.from(c.nonce_sha256))) {
          return fail(res, 403, 'bad_nonce', 'Invalid confirmation');
        }
        c.nonce_sha256 = undefined;
        c.confirm_via = body.via;
        c.resolved_at = clock;
        try {
          c.result = apply(c);
          c.status = 'applied';
          state.applied.push(c.id);
        } catch (err) {
          c.status = 'failed';
          c.error = err.code || 'apply_failed';
          if (err.code === 'stale_policy') return fail(res, 409, 'stale_policy', 'The policy changed since this change was proposed', { change: view(c) });
        }
        return reply(res, 200, { change: view(c) });
      }
    }
    return fail(res, 404, 'not_found', 'No route ' + req.method + ' ' + p);
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch (_) { return fail(res, 400, 'bad_json', 'Invalid JSON'); } }
      const url = new URL(req.url, 'http://127.0.0.1');
      Promise.resolve(route(req, res, body, url)).catch((err) => fail(res, 500, 'mock_error', String(err && err.message)));
    });
  });

  return {
    org,
    tokens,
    tokenInfo: (key) => byToken.get(tokens[key]),
    state,
    ruleHash,
    advance(ms) { clock += ms; },
    now: () => clock,
    revoke(key) { byToken.get(tokens[key]).revoked = true; },
    start() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}

module.exports = { createTeamApiMock, ALL_SCOPES, newToken };
