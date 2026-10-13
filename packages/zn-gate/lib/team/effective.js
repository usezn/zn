'use strict';
/**
 * How an organization policy changes one secret's local settings on this
 * machine.
 *
 * The organization can always restrict:
 *   - `deny` blocks the secret for the agents of the rule;
 *   - `allowHosts` / `allowCommands` drop local entries the rule does not list;
 *   - `mode: proxy` and `injectAt: header` are the most restrictive values.
 *
 * It can only open with a first-use approval on this machine: a host, a
 * command, a mode or an HTTP placement the local settings do not already
 * allow stays out until the user approves it on the vault's own channel
 * (`approvals` below). A stolen signing key therefore cannot turn zn-gate
 * into a way to send secrets somewhere new without someone at this machine
 * saying yes.
 *
 * It can never touch the base protections (credential files, ~/.zn, agent
 * configuration): those live in the hook policy, which org rules do not
 * reach.
 *
 * When the cached policy expired (offline for longer than its lifetime), the
 * strict mode keeps what restricts and withdraws what the organization had
 * opened, approved or not.
 *
 * Rules apply in order; the first rule whose secret pattern and agent list
 * match wins. A rule for named agents still blocks when the agent is
 * unknown, but never opens anything for it.
 */

const RESTRICTIVE_MODE = 'proxy';
const DEFAULT_INJECT_AT = 'header';

function secretMatches(pattern, name) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/** First matching rule and whether it names this agent ({rule, index, forAgent}). */
function findRule(policy, name, agent) {
  const rules = (policy && Array.isArray(policy.rules)) ? policy.rules : [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!secretMatches(r.secret, name)) continue;
    const agents = r.agents || [];
    const forAgent = agents.includes('*') || (agent ? agents.includes(agent) : false);
    // Unknown agent: a deny rule for any agent still applies (fail closed).
    if (forAgent || (!agent && r.deny === true)) return { rule: r, index: i, forAgent };
  }
  return null;
}

/* Does the local host list already cover `host`? Wildcards: "*.example.com"
 * covers sub.example.com and a.b.example.com, not example.com itself. */
function hostCovered(list, host) {
  const h = String(host).toLowerCase();
  for (const raw of list || []) {
    const e = String(raw).toLowerCase();
    if (e === h) return true;
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // ".example.com"
      if (h.startsWith('*.') ? h.slice(1).endsWith(suffix) : h.endsWith(suffix)) return true;
    }
  }
  return false;
}

const approvalKey = (org, secret, kind, value) => [org, secret, kind, value].join('\u0000');

/**
 * effective(name, local, {policy, state, org, agent, approvals}) ->
 *   {meta, deny, reason?, rule?, pending: [{kind, value}], org?}
 *
 * local: the secret's local settings ({mode, allowHosts, allowCommands, injectAt, ...}).
 * state: 'active' | 'expired' (anything else: the policy is ignored).
 * approvals: Set or object of approvalKey() strings already approved on this machine.
 * meta: the settings to enforce; pending: openings that need an approval.
 */
function effective(name, local, opts) {
  const o = opts || {};
  const meta = Object.assign({}, local, {
    allowHosts: (local && local.allowHosts) || [],
    allowCommands: (local && local.allowCommands) || [],
  });
  const out = { meta, deny: false, pending: [] };
  if (!o.policy || (o.state !== 'active' && o.state !== 'expired')) return out;
  const strict = o.state === 'expired';
  const found = findRule(o.policy, name, o.agent || null);
  if (!found) return out;
  const r = found.rule;
  out.rule = found.index;
  out.org = o.org || o.policy.org;
  if (r.deny === true) {
    out.deny = true;
    out.reason = 'policy:org_deny';
    return out;
  }
  if (!found.forAgent) return out;

  const approved = (kind, value) => {
    if (strict) return false;
    const k = approvalKey(out.org, name, kind, value);
    const a = o.approvals;
    return Boolean(a && (a instanceof Set ? a.has(k) : Object.prototype.hasOwnProperty.call(a, k)));
  };
  const open = (kind, value) => {
    if (approved(kind, value)) return true;
    if (!strict) out.pending.push({ kind, value });
    return false;
  };

  if (r.mode !== undefined && r.mode !== meta.mode) {
    if (r.mode === RESTRICTIVE_MODE || open('mode', r.mode)) meta.mode = r.mode;
  }
  if (Array.isArray(r.allowHosts)) {
    const localHosts = meta.allowHosts;
    meta.allowHosts = r.allowHosts.filter((h) => hostCovered(localHosts, h) || open('host', h));
  }
  if (Array.isArray(r.allowCommands)) {
    const localCmds = meta.allowCommands;
    meta.allowCommands = r.allowCommands.filter((c) => localCmds.includes(c) || open('command', c));
  }
  if (r.injectAt !== undefined && r.injectAt !== (meta.injectAt || DEFAULT_INJECT_AT)) {
    if (r.injectAt === DEFAULT_INJECT_AT || open('injectAt', r.injectAt)) meta.injectAt = r.injectAt;
  }
  return out;
}

/**
 * detectorsOf(state) -> [{id, pattern, type}] of the policy (also in strict
 * mode: an extra detector only redacts more).
 */
function detectorsOf(st) {
  if (!st || !st.policy || (st.state !== 'active' && st.state !== 'expired')) return [];
  return Array.isArray(st.policy.detectors) ? st.policy.detectors : [];
}

/** redactionOf(state) -> {pii: bool}. Only switches things on. */
function redactionOf(st) {
  if (!st || !st.policy || (st.state !== 'active' && st.state !== 'expired')) return { pii: false };
  const r = st.policy.redaction || {};
  return { pii: r.pii === true };
}

module.exports = { effective, findRule, hostCovered, approvalKey, detectorsOf, redactionOf, secretMatches };
