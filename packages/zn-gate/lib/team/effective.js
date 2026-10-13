'use strict';
/**
 * How an organization policy changes one secret's local settings on this
 * machine.
 *
 * The organization can always restrict:
 *   - `deny` blocks the secret;
 *   - `allowHosts` / `allowCommands` drop local entries the rule does not list;
 *   - `mode: proxy` is the most restrictive mode;
 *   - `injectAt` limits where secrets_http_request may put the value
 *     (the local `allowIn` list is cut down to it).
 *
 * It can open only hosts, for an agent it can identify (below), and only
 * with a first-use approval on this machine: a host the local settings do
 * not already allow stays out until the user approves it on the vault's own
 * channel (`approvals`). A stolen signing key therefore cannot send a secret
 * somewhere new without someone at this machine saying yes. Commands, modes
 * and HTTP placements are never opened by the organization: `zn run` cannot
 * tell agents apart, and the other two only matter to it.
 *
 * It can never touch the base protections (credential files, ~/.zn, agent
 * configuration): those live in the hook policy, which org rules do not
 * reach.
 *
 * Agents: rules name agents (`claude-code`, `codex`, ...). An agent id is
 * trusted only when it comes from an MCP server configuration zn wrote
 * (`secrets-mcp --agent <id>`): the agent cannot change those files. Any
 * other id (`zn run --agent`, ZN_AGENT, none) is self-reported, so for it
 * the restrictive parts of EVERY rule whose secret pattern matches apply,
 * whatever their agent list, and nothing is opened.
 *
 * With a trusted agent, rules apply in order and the first rule whose secret
 * pattern and agent list match wins.
 *
 * When the cached policy expired (offline for longer than its lifetime), the
 * strict mode keeps what restricts and withdraws what the organization had
 * opened, approved or not.
 */

const RESTRICTIVE_MODE = 'proxy';
const DEFAULT_ALLOW_IN = ['header'];

function secretMatches(pattern, name) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

const rulesOf = (policy) => ((policy && Array.isArray(policy.rules)) ? policy.rules : []);

/** First rule whose secret pattern and agent list match ({rule, index}). */
function findRule(policy, name, agent) {
  const rules = rulesOf(policy);
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!secretMatches(r.secret, name)) continue;
    const agents = r.agents || [];
    if (agents.includes('*') || (agent && agents.includes(agent))) return { rule: r, index: i };
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

const hasPort = (h) => /:\d+$/.test(String(h));
const approvalKey = (org, secret, kind, value) => [org, secret, kind, value].join('\u0000');

/* Only restrict: the parts of a rule that never widen the local settings. */
function restrictWith(meta, r) {
  if (r.mode === RESTRICTIVE_MODE) meta.mode = RESTRICTIVE_MODE;
  if (Array.isArray(r.allowHosts)) meta.allowHosts = r.allowHosts.filter((h) => !hasPort(h) && hostCovered(meta.allowHosts, h));
  if (Array.isArray(r.allowCommands)) meta.allowCommands = r.allowCommands.filter((c) => meta.allowCommands.includes(c));
  if (r.injectAt !== undefined) meta.allowIn = meta.allowIn.filter((p) => p === r.injectAt);
}

/**
 * effective(name, local, {policy, state, org, agent, agentTrusted, approvals}) ->
 *   {meta, deny, reason?, rule?, pending: [{kind, value}], org?}
 *
 * local: the secret's local settings ({mode, allowHosts, allowCommands, allowIn, ...}).
 * state: 'active' | 'expired' (anything else: the policy is ignored).
 * agentTrusted: true only for an agent id from an MCP configuration zn wrote.
 * approvals: Set or object of approvalKey() strings already approved on this machine.
 * meta: the settings to enforce; pending: openings that need an approval.
 */
function effective(name, local, opts) {
  const o = opts || {};
  const meta = Object.assign({}, local, {
    allowHosts: (local && local.allowHosts) || [],
    allowCommands: (local && local.allowCommands) || [],
    allowIn: (local && Array.isArray(local.allowIn) && local.allowIn.length) ? local.allowIn : DEFAULT_ALLOW_IN,
  });
  const out = { meta, deny: false, pending: [] };
  if (!o.policy || (o.state !== 'active' && o.state !== 'expired')) return out;
  out.org = o.org || o.policy.org;
  const agent = o.agentTrusted && o.agent ? o.agent : null;

  if (!agent) {
    // Self-reported or unknown agent: every matching rule restricts, none opens.
    const matching = rulesOf(o.policy).filter((r) => secretMatches(r.secret, name));
    if (!matching.length) return out;
    out.rule = rulesOf(o.policy).indexOf(matching[0]);
    if (matching.some((r) => r.deny === true)) {
      out.deny = true;
      out.reason = 'policy:org_deny';
      return out;
    }
    for (const r of matching) restrictWith(meta, r);
    return out;
  }

  const found = findRule(o.policy, name, agent);
  if (!found) return out;
  const r = found.rule;
  out.rule = found.index;
  if (r.deny === true) {
    out.deny = true;
    out.reason = 'policy:org_deny';
    return out;
  }

  const strict = o.state === 'expired';
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

  if (r.mode === RESTRICTIVE_MODE) meta.mode = RESTRICTIVE_MODE;
  if (Array.isArray(r.allowHosts)) {
    const localHosts = meta.allowHosts;
    // A host with a port is never matched by the broker (it compares host
    // names): such an entry only restricts and is never offered for approval.
    meta.allowHosts = r.allowHosts.filter((h) => !hasPort(h) && (hostCovered(localHosts, h) || open('host', h)));
  }
  if (Array.isArray(r.allowCommands)) meta.allowCommands = r.allowCommands.filter((c) => meta.allowCommands.includes(c));
  if (r.injectAt !== undefined) meta.allowIn = meta.allowIn.filter((p) => p === r.injectAt);
  return out;
}

/**
 * The most specific pending opening that covers what is being used: an exact
 * entry before a wildcard one. {kind, value, wildcard} or null.
 */
function pickOpening(pending, kind, matches) {
  const list = (pending || []).filter((p) => p.kind === kind && matches(p.value));
  if (!list.length) return null;
  const exact = list.find((p) => !/[*]/.test(p.value));
  const best = exact || list.sort((a, b) => b.value.length - a.value.length)[0];
  return { kind, value: best.value, wildcard: /[*]/.test(best.value) };
}

/**
 * detectorsOf(state) -> [{id, pattern, type}] of the policy (also in strict
 * mode: an extra detector only redacts more).
 */
function detectorsOf(st) {
  if (!st || !st.policy || (st.state !== 'active' && st.state !== 'expired')) return [];
  return Array.isArray(st.policy.detectors) ? st.policy.detectors : [];
}

module.exports = { effective, findRule, hostCovered, approvalKey, pickOpening, detectorsOf, secretMatches };
