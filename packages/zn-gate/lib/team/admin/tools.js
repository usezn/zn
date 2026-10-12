'use strict';
/**
 * zn Team admin tools (team_*) for `zn-gate mcp`.
 *
 * They exist only when an org admin token is configured (see config.js) and
 * ZN_LOCAL_ONLY is not true, and only the tools the token's effective scopes
 * allow are listed. Reads call the zn Team API. Writes never change anything
 * directly: they create a pending change on the server, which decides its
 * class:
 *   dashboard  opens access or raises privileges: approved only in the zn
 *              dashboard (the tool returns the approval link);
 *   confirm    tightens or is reversible: the person confirms it here, on a
 *              channel the model cannot answer (confirm.js), and only then
 *              zn-gate sends the one-time confirmation to the server.
 *
 * The token and the one-time confirmation nonce stay in this process: they
 * are never part of a tool result, an error or a log.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const definitions = require('./tools.json');
const config = require('./config');
const { createAdminClient, TeamApiError } = require('./client');
const { validate } = require('./schema');
const teamConfirm = require('./confirm');
const { maskTokens } = require('./token');

const TOOLS = definitions.tools;
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const WHOAMI_TTL_MS = 5 * 60 * 1000;
const WHOAMI_FAIL_TTL_MS = 30 * 1000;
const LIST_TIMEOUT_MS = 3000;

const WRITE_KINDS = {
  team_member_invite: (a) => ({ kind: 'member.invite', params: { email: a.email.toLowerCase(), role: a.role } }),
  team_invitation_revoke: (a) => ({ kind: 'invitation.revoke', params: { invitation_id: a.invitation_id } }),
  team_member_remove: (a) => ({ kind: 'member.remove', params: { user_id: a.user_id.toLowerCase() } }),
  team_member_set_role: (a) => ({ kind: 'member.role', params: { user_id: a.user_id.toLowerCase(), role: a.role } }),
  team_install_revoke: (a) => ({ kind: 'install.revoke', params: { install_id: a.install_id.toLowerCase() } }),
  team_policy_propose: (a) => ({ kind: 'policy.update', params: { base_version: a.base_version, ops: a.ops } }),
};

/** MCP tool definition (what tools/list shows) of a tools.json entry. */
function mcpDefinition(t) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
}

function toolResult(data, isError) {
  // Defence in depth: nothing token-shaped leaves this module.
  const text = maskTokens(JSON.stringify(data, null, 2));
  const out = { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
  if (isError) out.isError = true;
  return out;
}

function errorResult(err, extra) {
  if (err instanceof TeamApiError) {
    const data = { error: err.code, status: err.status || undefined, message: apiErrorMessage(err) };
    if (err.scope) data.scope = err.scope;
    if (err.retryAfter) data.retry_after_seconds = err.retryAfter;
    return toolResult(Object.assign(data, extra || {}), true);
  }
  const code = err && typeof err.code === 'string' ? err.code : 'ZN_ERROR';
  return toolResult(Object.assign({ error: code, message: maskTokens(String((err && err.message) || err)) }, extra || {}), true);
}

function apiErrorMessage(err) {
  switch (err.code) {
    case 'token_expired':
    case 'token_revoked':
    case 'invalid_token':
      return 'The org admin token is no longer valid (' + err.code + '). Ask the user to create a new one in the zn dashboard and run `zn team admin login` in their own terminal.';
    case 'token_suspended':
      return 'The org admin token is suspended for a few minutes after repeated failed attempts; try again later.';
    case 'owner_required':
      return 'Only the organization owner can make this change.';
    case 'team_required':
      return 'The organization needs an active Team subscription for this.';
    case 'seats_full':
      return 'There is no free seat; the owner can add seats in the zn dashboard.';
    case 'too_many_pending':
      return 'Too many pending changes; cancel some or approve them in the zn dashboard first.';
    case 'insufficient_scope':
      return 'This org token does not have the ' + (err.scope || 'needed') + ' scope. The user can create a token with that scope in the zn dashboard.';
    case 'token_not_allowed':
      return 'This action needs a dashboard session; org tokens cannot do it.';
    case 'creator_role_changed':
      return 'The person who created this org token is no longer an owner or admin, so the token stopped working.';
    case 'agent_writes_off':
      return 'The organization does not allow changes from agents (agent write mode is off). The user can make the change in the zn dashboard.';
    case 'rate_limited':
      return 'Too many requests with this org token; try again later.';
    default:
      return err.message;
  }
}

/**
 * createTeamAdmin(opts)
 *   opts.env, opts.home, opts.localOnly, opts.apiUrl   configuration
 *   opts.version                                       zn-gate version (X-Zn-Client)
 *   opts.session()        -> {protocolVersion, clientInfo, elicitation: bool}
 *   opts.elicit(params, timeoutMs) -> Promise<{action, content}>
 *   opts.gui              {available(), confirm(req)} (default: the native dialog)
 *   opts.exportDir        where team_audit_export writes (default ~/zn-exports)
 *   opts.now              clock (tests)
 */
function createTeamAdmin(opts = {}) {
  const env = opts.env || process.env;
  const cfgOpts = { env, home: opts.home, localOnly: opts.localOnly, apiUrl: opts.apiUrl, keychain: opts.keychain };
  const session = typeof opts.session === 'function' ? opts.session : () => ({});
  const now = opts.now || (() => Date.now());
  const gui = opts.gui || teamConfirm.defaultGui(env);
  let loaded = null;        // {token, source, meta}
  let api = null;
  let who = null;           // {at, ok, value | error}

  function enabled() {
    return config.tokenSource(cfgOpts) !== null;
  }

  function apiClient() {
    if (api) return api;
    loaded = config.loadToken(cfgOpts);
    if (!loaded) { const e = new Error('no zn Team org token is configured'); e.code = 'ZN_TEAM_TOKEN'; throw e; }
    api = createAdminClient({
      token: loaded.token,
      apiBase: config.apiBase(cfgOpts, loaded.meta),
      version: opts.version,
      clientInfo: () => session().clientInfo || null,
    });
    return api;
  }

  async function whoami(fresh, timeoutMs) {
    const t = now();
    if (!fresh && who && t - who.at < (who.ok ? WHOAMI_TTL_MS : WHOAMI_FAIL_TTL_MS)) return who;
    try {
      const value = await apiClient().whoami(timeoutMs ? { timeoutMs } : undefined);
      who = { at: t, ok: true, value };
    } catch (err) {
      who = { at: t, ok: false, error: err };
    }
    return who;
  }

  function scopesOf(w) {
    const p = (w && w.principal) || {};
    return Array.isArray(p.effective_scopes) ? p.effective_scopes : Array.isArray(p.scopes) ? p.scopes : [];
  }

  function allowedBy(tool, scopes) {
    return tool.scopes.length === 0 || tool.scopes.some((s) => scopes.includes(s));
  }

  /** Tools for tools/list: none without a token; only team_whoami while whoami fails. */
  async function listTools() {
    if (!enabled()) return [];
    const w = await whoami(false, LIST_TIMEOUT_MS);
    if (!w.ok) return [mcpDefinition(BY_NAME.get('team_whoami'))];
    const scopes = scopesOf(w.value);
    return TOOLS.filter((t) => allowedBy(t, scopes)).map(mcpDefinition);
  }

  function channels() {
    const s = session();
    return teamConfirm.availableChannels({ elicitation: Boolean(s.elicitation && opts.elicit), dialog: safeAvailable(), env });
  }

  function safeAvailable() {
    try { return Boolean(gui && gui.available()); } catch (_) { return false; }
  }

  function approveUrl(changeId, confirm) {
    // The server's link is used only when it points to the zn dashboard.
    if (confirm && typeof confirm.approve_url === 'string' && config.isDashboardUrl(confirm.approve_url, cfgOpts)) return confirm.approve_url;
    return config.dashboardBase(cfgOpts) + '/team/approvals?change=' + encodeURIComponent(changeId);
  }

  function outcome(change, status, extra) {
    const c = change || {};
    const o = {
      change_id: c.id,
      kind: c.kind,
      class: c.class,
      digest8: c.digest8,
      summary: Array.isArray(c.summary) ? c.summary : [],
      status,
    };
    return Object.assign(o, extra || {});
  }

  async function propose(name, args) {
    const { kind, params } = WRITE_KINDS[name](args);
    const body = { kind, params };
    if (args.note) body.note = args.note;
    const client = apiClient();
    const created = await client.createChange(body);
    const change = created.change || {};
    const confirm = created.confirm || {};
    const id = change.id;
    const d8 = change.digest8;

    if (change.class !== 'confirm' || confirm.mode !== 'client' || typeof confirm.nonce !== 'string') {
      return toolResult(outcome(change, 'pending_approval', {
        approve_url: approveUrl(id, confirm),
        message: 'Approval needed: open the link in your browser and approve change ' + id + ' (digest ' + d8 + ') in the zn dashboard. ' +
          (change.class === 'dashboard' ? 'Opening permissions can only be approved in the dashboard.' : 'This organization approves agent changes only in the dashboard.'),
      }));
    }

    let nonce = confirm.nonce;
    const w = (await whoami(false, LIST_TIMEOUT_MS));
    const s = session();
    const answer = await teamConfirm.askPerson({ change, whoami: w.ok ? w.value : null, deadline: confirm.deadline || change.confirm_deadline || change.deadline }, {
      elicit: opts.elicit,
      elicitationSupported: Boolean(s.elicitation),
      protocolVersion: s.protocolVersion,
      gui,
      env,
      now,
    });

    if (answer.decision === 'unavailable') {
      nonce = null;
      return toolResult(outcome(change, 'pending_approval', {
        approve_url: approveUrl(id, null),
        message: 'No confirmation channel is available here (no MCP elicitation and no desktop dialog). Approve change ' + id +
          ' (digest ' + d8 + ') in the zn dashboard: open the link in your browser.',
      }));
    }
    if (answer.decision === 'declined') {
      nonce = null;
      let status = 'declined';
      try { await client.cancelChange(id); } catch (err) {
        if (err instanceof TeamApiError && /expired/.test(err.code)) status = 'expired';
      }
      return toolResult(outcome(change, status, {
        confirm_via: answer.via,
        message: status === 'expired'
          ? 'Change ' + id + ' expired before it was confirmed; nothing was changed.'
          : 'The user did not approve change ' + id + '; nothing was changed.',
      }));
    }

    let res;
    try {
      res = await client.confirmChange(id, { nonce, via: answer.via });
    } catch (err) {
      nonce = null;
      if (err instanceof TeamApiError) {
        const expired = err.status === 410 || /expired/.test(err.code);
        // confirm_expired: the 10-minute window is over but the change stays
        // pending and can still be approved in the dashboard.
        const stillPending = err.code === 'confirm_expired';
        return toolResult(outcome(change, expired ? 'expired' : 'failed', {
          confirm_via: answer.via,
          error: err.code,
          approve_url: stillPending ? approveUrl(id, null) : undefined,
          message: expired
            ? 'Change ' + id + ' was not confirmed in time (confirmations are valid for 10 minutes); nothing was changed.' +
              (stillPending ? ' It can still be approved in the zn dashboard: ' + approveUrl(id, null) : '')
            : 'Change ' + id + ' was not applied: ' + apiErrorMessage(err),
        }), !expired);
      }
      throw err;
    }
    nonce = null;
    const after = res.change || change;
    if (after.status === 'applied') {
      const extra = { confirm_via: answer.via, result: after.result || undefined, message: 'Applied: ' + ((after.summary && after.summary[0]) || after.kind) + '.' };
      if (kind === 'member.invite' && after.result && after.result.accept_url) extra.accept_url = after.result.accept_url;
      if (kind === 'policy.update' && after.result && after.result.version !== undefined) extra.new_version = after.result.version;
      return toolResult(outcome(after, 'applied', extra));
    }
    return toolResult(outcome(after, after.status === 'expired' ? 'expired' : 'failed', {
      confirm_via: answer.via,
      error: after.error || undefined,
      message: 'Change ' + id + ' was confirmed but not applied' + (after.error ? ': ' + after.error : '.'),
    }), true);
  }

  async function exportAudit(args) {
    const w = await whoami(false, LIST_TIMEOUT_MS);
    const orgId = (w.ok && w.value.org && w.value.org.id) || (loaded && loaded.meta && loaded.meta.org_id) || 'org';
    const q = { format: args.format, since: args.since, until: args.until, agent: args.agent, secret: args.secret, decision: args.decision };
    const res = await apiClient().auditExport(q);
    const expected = String(res.headers['x-content-sha256'] || '').trim().toLowerCase();
    const sha256 = crypto.createHash('sha256').update(res.body).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(expected) || expected !== sha256) {
      return toolResult({ error: 'checksum_mismatch', message: 'The export did not match the SHA-256 the server announced; nothing was written.' }, true);
    }
    const dir = opts.exportDir || env.ZN_TEAM_EXPORT_DIR || path.join(os.homedir(), 'zn-exports');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ts = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const safeOrg = String(orgId).replace(/[^A-Za-z0-9_]/g, '') || 'org';
    const file = path.join(dir, 'zn-audit-' + safeOrg + '-' + ts + '.' + (args.format === 'json' ? 'json' : 'csv'));
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeSync(fd, res.body); } finally { fs.closeSync(fd); }
    const rows = Number(res.headers['x-rows']);
    return toolResult({
      path: file,
      sha256,
      rows: Number.isFinite(rows) ? rows : null,
      truncated: String(res.headers['x-truncated'] || '') === 'true',
      message: 'Export written to ' + file + ' (only readable by this user). Its contents were not returned to the conversation.',
    });
  }

  async function read(name, args) {
    const c = apiClient();
    switch (name) {
      case 'team_org_get': {
        const r = await c.org();
        const o = r.org || {};
        return toolResult({
          id: o.id, name: o.name, plan: o.plan, subscription_status: o.subscription_status, team_active: o.team_active,
          seats: o.seats, seats_used: o.seats_used, policy_version: o.policy_version, trial_ends_at: o.trial_ends_at === undefined ? null : o.trial_ends_at,
        });
      }
      case 'team_members_list': {
        const r = await c.org();
        const out = { members: r.members || [], invitations: r.invitations || [] };
        if (r.redacted) out.redacted = r.redacted;
        return toolResult(out);
      }
      case 'team_installs_list': {
        const r = await c.installs();
        const all = Array.isArray(r.installs) ? r.installs : [];
        return toolResult({ installs: args.include_revoked ? all : all.filter((i) => !i.revoked_at) });
      }
      case 'team_policy_get': {
        const r = await c.policy();
        const rules = (r.policy && Array.isArray(r.policy.rules)) ? r.policy.rules : [];
        const withHash = Array.isArray(r.rules_with_hash) ? r.rules_with_hash
          : rules.map((rule, index) => ({ index, rule_hash: ruleHash(rule), rule }));
        const pk = r.public_key || {};
        return toolResult({
          version: r.version, policy: r.policy || null, rules_with_hash: withHash,
          public_key: { alg: pk.alg, kid: pk.kid }, history: (r.history || []).slice(0, args.history),
        });
      }
      case 'team_audit_query': {
        const r = await c.audit({ since: args.since, until: args.until, agent: args.agent, secret: args.secret, decision: args.decision, install_id: args.install_id, limit: args.limit, cursor: args.cursor });
        return toolResult({ events: r.events || [], next_cursor: r.next_cursor || undefined });
      }
      case 'team_audit_summary':
        return toolResult(await c.auditSummary({ days: args.days }));
      case 'team_activity_list': {
        const r = await c.activity({ since: args.since, until: args.until, actor_type: args.actor_type, token_id: args.token_id, action: args.action, limit: args.limit, cursor: args.cursor });
        return toolResult({ events: r.events || [], next_cursor: r.next_cursor || undefined });
      }
      case 'team_changes_list': {
        const r = await c.changes({ status: args.status, limit: args.limit });
        return toolResult({ changes: r.changes || [] });
      }
      case 'team_change_status': {
        const r = await c.change(args.change_id);
        return toolResult({ change: r.change || r });
      }
      case 'team_change_cancel': {
        const r = await c.cancelChange(args.change_id);
        return toolResult({ cancelled: r.cancelled || args.change_id });
      }
      default:
        return null;
    }
  }

  async function whoamiTool() {
    const source = (() => { try { return config.tokenSource(cfgOpts); } catch (_) { return null; } })();
    const warnings = config.tokenWarnings(source === 'env' ? 'env' : 'login');
    const w = await whoami(true);
    if (!w.ok) return errorResult(w.error, { confirm_channels: channels(), warnings });
    const v = w.value;
    const p = v.principal || {};
    if (p.expires_at && Date.parse(p.expires_at) - now() < 7 * 86400000) warnings.push('The org token expires on ' + p.expires_at + '.');
    const mode = teamConfirm.confirmMode(env);
    if (!mode.valid) warnings.push('ZN_TEAM_CONFIRM has an unknown value; confirmations go to the dashboard.');
    return toolResult({
      org: { id: v.org && v.org.id, name: v.org && v.org.name },
      token: { id: p.token_id, prefix: p.prefix, name: p.name, scopes: scopesOf(v), expires_at: p.expires_at, creator_role: p.creator_role },
      agent_write_mode: v.agent_write_mode || 'confirm',
      policy_version: v.policy_version,
      confirm_channels: channels(),
      warnings,
    });
  }

  /** tools/call for a team tool. Returns null when `name` is not one. */
  async function callTool(name, rawArgs) {
    const tool = BY_NAME.get(name);
    if (!tool) return null;
    if (!enabled()) return null;
    const v = validate(tool.inputSchema, rawArgs === undefined || rawArgs === null ? {} : rawArgs);
    if (!v.ok) return toolResult({ error: 'invalid_arguments', message: 'Invalid arguments: ' + v.errors.join('; ') }, true);
    const args = v.value;
    try {
      if (name === 'team_whoami') return await whoamiTool();
      // Refuse locally what the token's scopes do not allow (the server checks again).
      const w = await whoami(false, LIST_TIMEOUT_MS);
      if (w.ok && !allowedBy(tool, scopesOf(w.value))) {
        return toolResult({ error: 'insufficient_scope', scope: tool.scopes.join(' or '), message: 'This org token does not have the ' + tool.scopes.join(' or ') + ' scope.' }, true);
      }
      if (WRITE_KINDS[name]) return await propose(name, args);
      if (name === 'team_audit_export') return await exportAudit(args);
      return await read(name, args);
    } catch (err) {
      return errorResult(err);
    }
  }

  /** For zn_status: how the team tools are configured (never the token). */
  function status() {
    let source = null;
    try { source = config.tokenSource(cfgOpts); } catch (_) { source = null; }
    if (config.localOnly(cfgOpts)) return { admin_tools: 'off (ZN_LOCAL_ONLY=true)' };
    if (!source) return { admin_tools: 'off (no org token; run `zn team admin login`)' };
    const meta = config.readAdminMeta(cfgOpts);
    const out = { admin_tools: 'on', token_source: source === 'env' ? 'ZN_ORG_TOKEN' : (meta && meta.store === 'file' ? '~/.zn/team-admin.token' : 'OS credential store') };
    if (meta) { out.org = meta.org_id; out.token_prefix = meta.prefix; }
    const warnings = config.tokenWarnings(source === 'env' ? 'env' : 'login');
    if (warnings.length) out.warnings = warnings;
    out.leaves_machine = 'team_* tools call the zn Team API with the org token';
    return out;
  }

  return { enabled, listTools, callTool, status, channels, _whoami: whoami };
}

/** rule_hash: first 12 hex of the SHA-256 of the canonical JSON of a rule. */
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function ruleHash(rule) {
  return crypto.createHash('sha256').update(canonicalJson(rule)).digest('hex').slice(0, 12);
}

const TEAM_TOOL_NAMES = TOOLS.map((t) => t.name);

module.exports = { createTeamAdmin, TOOLS, TEAM_TOOL_NAMES, mcpDefinition, canonicalJson, ruleHash, WRITE_KINDS };
