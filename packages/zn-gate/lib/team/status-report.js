'use strict';
/**
 * The status report a machine in a zn Team organization sends after each sync.
 *
 * What it holds, and nothing else: the zn-gate version, the OS family, the
 * version and state of the organization policy held here, and, for each agent
 * zn has hooks for, whether those hooks are ok, stale or broken. Never a path,
 * a host name, a user name, an environment value, a secret name or a command.
 *
 * buildStatusBody() makes the body from closed vocabularies and clamps it;
 * isAllowedBody() is the check every body passes before it is sent, and what
 * the tests hold the body to.
 */

const AGENT_IDS = ['claude-code', 'codex', 'cursor', 'opencode', 'antigravity', 'copilot', 'gemini', 'zcode'];
const AGENT_STATES = ['ok', 'stale', 'broken'];
const POLICY_STATES = ['active', 'expired', 'refused', 'none'];
const OS_NAMES = ['linux', 'darwin', 'win32', 'other'];
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
const MAX_POLICY_VERSION = 1000000000;
const BODY_KEYS = ['zn_gate_version', 'os', 'policy', 'agents'];

/* The daemon's policy state word -> the word of the report. */
const POLICY_STATE_OF = { active: 'active', expired: 'expired', invalid: 'refused', none: 'none' };

const SEVERITY = { ok: 0, stale: 1, broken: 2 };

/**
 * agentsFrom(listHooks result) -> [{id, state}]: one entry per known agent that has zn hooks in a user-level hooks
 * file (the worst state among its hooks wins), in the fixed order of AGENT_IDS. Project files are left out: they
 * depend on the folder the vault daemon happened to start in, not on this machine.
 */
function agentsFrom(listed) {
  const worst = new Map();
  const list = listed && Array.isArray(listed.agents) ? listed.agents : [];
  for (const a of list) {
    if (!a || !AGENT_IDS.includes(a.id)) continue;
    for (const f of Array.isArray(a.files) ? a.files : []) {
      if (!f || f.scope !== 'user') continue;
      for (const r of Array.isArray(f.rows) ? f.rows : []) {
        const s = String(r && r.status).toLowerCase();
        if (!(s in SEVERITY)) continue;
        if (!worst.has(a.id) || SEVERITY[s] > SEVERITY[worst.get(a.id)]) worst.set(a.id, s);
      }
    }
  }
  return AGENT_IDS.filter((id) => worst.has(id)).map((id) => ({ id, state: worst.get(id) }));
}

/**
 * buildStatusBody({version, os, policyState, policyVersion, hooks}) -> body, or null when the zn-gate version is
 * not a plain version number (nothing is sent then).
 */
function buildStatusBody(input) {
  const i = input && typeof input === 'object' ? input : {};
  if (typeof i.version !== 'string' || !VERSION_RE.test(i.version)) return null;
  const pv = Number.isSafeInteger(i.policyVersion) && i.policyVersion >= 0 && i.policyVersion <= MAX_POLICY_VERSION ? i.policyVersion : 0;
  const state = POLICY_STATE_OF[i.policyState] || 'none';
  return {
    zn_gate_version: i.version,
    os: OS_NAMES.includes(i.os) ? i.os : 'other',
    policy: { version: pv, state },
    agents: agentsFrom(i.hooks),
  };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => k in o);

/** true only for a body of exactly the shape above: the keys, the closed words and the lengths. */
function isAllowedBody(body) {
  if (!isObject(body) || !onlyKeys(body, BODY_KEYS)) return false;
  if (typeof body.zn_gate_version !== 'string' || !VERSION_RE.test(body.zn_gate_version)) return false;
  if (!OS_NAMES.includes(body.os)) return false;
  const p = body.policy;
  if (!isObject(p) || !onlyKeys(p, ['version', 'state'])) return false;
  if (!Number.isSafeInteger(p.version) || p.version < 0 || p.version > MAX_POLICY_VERSION || !POLICY_STATES.includes(p.state)) return false;
  if (!Array.isArray(body.agents) || body.agents.length > AGENT_IDS.length) return false;
  const seen = new Set();
  for (const a of body.agents) {
    if (!isObject(a) || !onlyKeys(a, ['id', 'state']) || !AGENT_IDS.includes(a.id) || !AGENT_STATES.includes(a.state) || seen.has(a.id)) return false;
    seen.add(a.id);
  }
  return true;
}

module.exports = { buildStatusBody, isAllowedBody, agentsFrom, AGENT_IDS, AGENT_STATES, POLICY_STATES, OS_NAMES };
