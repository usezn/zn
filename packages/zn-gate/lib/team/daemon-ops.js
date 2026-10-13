'use strict';
/**
 * zn Team operations of the vault daemon.
 *
 * The install token and the organization's pinned public key live in the
 * encrypted vault (secrets.team), so only an unlocked daemon can fetch the
 * policy or upload the audit log, and the token never leaves this process.
 * ~/.zn/team.json is a readable copy without the token, for the hooks.
 *
 * Joining and leaving are confirmed on the daemon's own channel: an agent
 * that runs `zn team join <token>` could otherwise send this machine's audit
 * records to an organization of its choosing, and `zn team leave` would drop
 * the organization's restrictions.
 */

const crypto = require('crypto');
const policy = require('./policy');
const { effective, approvalKey } = require('./effective');
const { createApi, checkBase } = require('./api');
const { uploadPending } = require('./upload');
const { CODES, znError } = require('../errors');

const VERSION = require('../../package.json').version;
const DEFAULT_API = 'https://api.usezn.com';
const JOIN_TOKEN_RE = /^znj_[A-Za-z0-9]{32,64}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPEN_KINDS = ['host', 'command', 'mode', 'injectAt'];

const osName = () => (['linux', 'darwin', 'win32'].includes(process.platform) ? process.platform : 'other');

function makeTeamOps(ctx) {
  const { state, writeAudit, confirmOutOfBand } = ctx;
  const fetchImpl = ctx.fetchImpl;
  const files = () => policy.paths(state.opts);

  async function team() {
    const secrets = await state.loadSecrets();
    return secrets.team && typeof secrets.team === 'object' ? secrets.team : null;
  }

  /* Policy state verified with the key held in the vault, not team.json. */
  async function policyState(now) {
    const t = await team();
    if (!t) return { state: 'none', policy: null };
    return policy.state(Object.assign({}, state.opts, { team: { org: t.org, policy_public_key: t.pin }, now }));
  }

  function apiFor(t) {
    return createApi({ base: t.api_base, token: t.install_token, fetchImpl, userAgent: 'zn-gate/' + VERSION });
  }

  function mirror(t) {
    policy.writeTeam({
      org: t.org, org_name: t.org_name || null, api_base: t.api_base, install_id: t.install_id,
      policy_public_key: t.pin, joined_at: t.joined_at,
    }, state.opts);
  }

  return {
    /**
     * teamJoin({join_token, api_base, agent}) -> {org, org_name, install_id, api_base}
     * Registers this installation with the organization of the join token.
     */
    async teamJoin(args) {
      const a = args && typeof args === 'object' ? args : {};
      const joinToken = String(a.join_token || '');
      if (!JOIN_TOKEN_RE.test(joinToken)) throw znError(CODES.POLICY_DENIED, 'invalid join token (expected znj_...)');
      let base;
      try { base = checkBase(a.api_base || DEFAULT_API); } catch (err) { throw znError(CODES.POLICY_DENIED, 'invalid API address: ' + String(err.message).slice(0, 120)); }
      const agent = a.agent && AGENT_RE.test(String(a.agent)) ? String(a.agent) : undefined;
      const current = await team();
      if (current && current.api_base !== base) throw znError(CODES.POLICY_DENIED, 'this machine is already in organization ' + current.org + '; run `zn team leave` first');
      const host = new URL(base).host;
      const warnings = [];
      if (base !== DEFAULT_API) warnings.push('This is not the zn service (api.usezn.com). Only continue if your organization runs its own server at ' + host + '.');
      await confirmOutOfBand({
        kind: 'team',
        title: current ? 'reconnect this machine to organization ' + current.org + '?' : 'connect this machine to a zn organization?',
        warnings,
        fields: [
          ['Server', host],
          ['Shares', 'audit records: secret names, agents, tools, commands, hosts and decisions. Never secret values.'],
          ['Applies', "the organization's signed policy for secrets (it can restrict; anything it opens asks you first)"],
        ],
        footer: 'If you did not just run `zn team join` yourself, choose Deny.',
      }, { mode: 'set', reason: 'team_join' });

      const secrets = await state.loadSecrets();
      const installId = current ? current.install_id : crypto.randomUUID();
      const api = createApi({ base, fetchImpl, userAgent: 'zn-gate/' + VERSION });
      let res;
      try {
        res = await api.join({ join_token: joinToken, install_id: installId, audit_key: secrets.auditKey, agent, zn_gate_version: VERSION, os: osName() });
      } catch (err) {
        const why = err && err.status ? 'HTTP ' + err.status + (err.body && err.body.error ? ': ' + String(err.body.error).slice(0, 160) : '') : (err && err.code) || 'network error';
        writeAudit({ mode: 'set', decision: 'deny', reason: 'team_join_failed' });
        throw znError(CODES.POLICY_DENIED, 'join failed (' + why + ')');
      }
      if (current && res.org !== current.org) throw znError(CODES.POLICY_DENIED, 'the token is for another organization; run `zn team leave` first');
      if (!policy.checkPin(res.policy_public_key)) throw znError(CODES.POLICY_DENIED, 'the server sent an invalid organization key');
      if (current && current.pin.kid !== res.policy_public_key.kid) throw znError(CODES.POLICY_DENIED, "the organization's signing key changed; run `zn team leave` and join again to accept the new key");
      return state.serial(async () => {
        const s = await state.loadSecrets();
        s.team = {
          org: res.org, org_name: res.org_name || null, api_base: base, install_id: installId,
          install_token: res.install_token, pin: res.policy_public_key,
          joined_at: current ? current.joined_at : new Date().toISOString(), revoked_at: null,
        };
        writeAudit({ mode: 'set', decision: 'allow', reason: current ? 'team_rejoined' : 'team_joined' });
        await state.saveSecrets();
        mirror(s.team);
        return { org: res.org, org_name: res.org_name || null, install_id: installId, api_base: base };
      });
    },

    /** teamLeave() -> {left: org | null}. Confirmed: it removes the organization's restrictions. */
    async teamLeave() {
      const t = await team();
      if (!t) {
        for (const f of ['teamFile', 'policyFile', 'uploadState']) policy.removeFile(files()[f]);
        return { left: null };
      }
      await confirmOutOfBand({
        kind: 'team',
        title: 'disconnect this machine from organization ' + t.org + '?',
        warnings: ["The organization's policy stops applying here, and your administrators will see this machine stop reporting."],
        fields: [['Organization', t.org_name ? t.org_name + ' (' + t.org + ')' : t.org]],
        footer: 'If you did not just run `zn team leave` yourself, choose Deny.',
      }, { mode: 'set', reason: 'team_leave' });
      return state.serial(async () => {
        const s = await state.loadSecrets();
        delete s.team;
        delete s.orgApprovals;
        writeAudit({ mode: 'remove', decision: 'allow', reason: 'team_left' });
        await state.saveSecrets();
        for (const f of ['teamFile', 'policyFile', 'uploadState']) policy.removeFile(files()[f]);
        return { left: t.org };
      });
    },

    /** teamInfo() -> what `zn team status` shows. Never the token. */
    async teamInfo() {
      const t = await team();
      if (!t) return { joined: false };
      const st = await policyState();
      return {
        joined: true, org: t.org, org_name: t.org_name, install_id: t.install_id, api_base: t.api_base,
        joined_at: t.joined_at, revoked_at: t.revoked_at || null, kid: t.pin.kid,
        policy: { state: st.state, version: st.version || null, expires_at: st.expires_at || null, fetched_at: st.fetched_at || null, error: st.error || null },
      };
    },

    /**
     * teamSync({upload}) -> {policy: {status, version?, error?}, upload: {...}}
     * Downloads the policy (ETag) and uploads pending audit records.
     */
    async teamSync(args) {
      const a = args && typeof args === 'object' ? args : {};
      const t = await team();
      if (!t) throw znError(CODES.NOT_FOUND, 'this machine is not in an organization (zn team join <token>)');
      const api = apiFor(t);
      const out = { policy: null, upload: null };
      const cached = await policyState();
      try {
        const r = await api.getPolicy({ etag: cached.state === 'active' ? cached.etag : undefined });
        if (r.status === 304) {
          policy.touchCache(state.opts);
          out.policy = { status: 'current', version: cached.version };
        } else if (r.status === 404) {
          out.policy = { status: 'none' };
        } else {
          const acc = policy.accept(r.body, r.etag, Object.assign({}, state.opts, { team: { org: t.org, policy_public_key: t.pin } }));
          if (acc.ok) {
            out.policy = { status: 'updated', version: acc.policy.version };
            if (!cached.version || cached.version !== acc.policy.version) writeAudit({ mode: 'set', decision: 'allow', reason: 'org_policy_v' + acc.policy.version });
          } else {
            out.policy = { status: 'rejected', error: acc.error };
            writeAudit({ mode: 'set', decision: 'deny', reason: 'policy:rejected' });
          }
        }
        if (t.revoked_at) await state.serial(async () => { const s = await state.loadSecrets(); if (s.team) s.team.revoked_at = null; await state.saveSecrets(); });
      } catch (err) {
        if (err && err.status === 401) {
          out.policy = { status: 'revoked' };
          if (!t.revoked_at) await state.serial(async () => { const s = await state.loadSecrets(); if (s.team) s.team.revoked_at = new Date().toISOString(); await state.saveSecrets(); });
        } else {
          out.policy = { status: 'offline', error: (err && err.code) || 'error' };
        }
      }
      if (a.upload !== false && out.policy.status !== 'revoked') {
        const f = files();
        out.upload = await uploadPending({
          auditFile: state.paths.auditFile, stateFile: f.uploadState, lockFile: f.uploadLock,
          api, installId: t.install_id, version: VERSION,
        });
      }
      return out;
    },

    /**
     * confirmOrgOpening(secret, kind, value, agent) -> true
     * The user approves, on this machine, one thing the organization's policy
     * opens for a secret (a host, a command, a mode or an HTTP placement).
     * Only openings the current policy really asks for can be approved.
     */
    async confirmOrgOpening(secret, kind, value, agent) {
      const name = String(secret || '');
      if (!NAME_RE.test(name) || !OPEN_KINDS.includes(kind) || typeof value !== 'string' || value.length > 253) throw znError(CODES.POLICY_DENIED, 'invalid request');
      const t = await team();
      const st = await policyState();
      const secrets = await state.loadSecrets();
      const local = secrets.secrets[name];
      if (!t || !local) throw znError(CODES.NOT_FOUND, 'nothing to approve');
      const eff = effective(name, local, { policy: st.policy, state: st.state, org: t.org, agent: agent || null, approvals: secrets.orgApprovals });
      if (!eff.pending.some((p) => p.kind === kind && p.value === value)) throw znError(CODES.POLICY_DENIED, 'the organization policy does not ask for this');
      const label = { host: 'send it to host', command: 'give it to command', mode: 'switch it to mode', injectAt: 'put it in the HTTP ' }[kind];
      await confirmOutOfBand({
        kind: 'policy',
        title: 'let organization ' + t.org + ' ' + label + (kind === 'injectAt' ? value : ' ' + value) + ' for secret ' + name + '?',
        warnings: ["Your organization's policy (version " + st.version + ') allows this, but this machine never did. It applies only after you approve it here.'],
        fields: [['Secret', name], ['Change', kind + ' + ' + value], ['Organization', t.org]],
        footer: 'If you do not expect your organization to need this, choose Deny.',
      }, { secret: name, mode: 'set', reason: 'org_open' });
      return state.serial(async () => {
        const s = await state.loadSecrets();
        if (!s.orgApprovals || typeof s.orgApprovals !== 'object') s.orgApprovals = {};
        s.orgApprovals[approvalKey(t.org, name, kind, value)] = { ts: new Date().toISOString(), version: st.version };
        writeAudit({ secret: name, mode: 'set', decision: 'ask:yes', reason: 'org_open_' + kind });
        await state.saveSecrets();
        return true;
      });
    },

    /**
     * effectiveList(list, agent) -> list with the organization policy applied:
     * each entry gets the settings to enforce, `deny`, and `orgPending`.
     */
    async effectiveList(list, agent) {
      const t = await team();
      if (!t) return list;
      const st = await policyState();
      if (st.state !== 'active' && st.state !== 'expired') return list;
      const secrets = await state.loadSecrets();
      return list.map((entry) => {
        const eff = effective(entry.name, entry, { policy: st.policy, state: st.state, org: t.org, agent: agent || null, approvals: secrets.orgApprovals });
        return Object.assign({}, entry, eff.meta, {
          name: entry.name,
          deny: eff.deny,
          denyReason: eff.deny ? eff.reason : undefined,
          orgPending: eff.pending.length ? eff.pending : undefined,
          orgPolicy: { version: st.version, state: st.state },
        });
      });
    },
  };
}

module.exports = { makeTeamOps, DEFAULT_API };
