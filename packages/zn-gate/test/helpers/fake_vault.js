'use strict';
/**
 * In-memory VaultClient for tests, shaped like lib/vault/client.js in the
 * contract (all methods async). Holds only fake values from
 * test/fixtures/fake_secrets.js. Not used by production code.
 */

function variants(value) {
  const buf = Buffer.from(String(value), 'utf8');
  return [String(value), buf.toString('base64'), buf.toString('hex'), encodeURIComponent(String(value))];
}

function createFakeVault(opts = {}) {
  const secrets = new Map(); // name -> {value, meta}
  const tokens = new Map(); // project -> {byKey: Map(type\0value -> token), byToken: Map(token -> value), counters: Map}
  const auditLog = [];
  const approvals = [];

  function proj(project) {
    if (!tokens.has(project)) tokens.set(project, { byKey: new Map(), byToken: new Map(), counters: new Map() });
    return tokens.get(project);
  }

  const vault = {
    auditLog,
    async mapToken(project, type, value) {
      const p = proj(project);
      const T = String(type).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      const key = T + '\u0000' + value;
      if (!p.byKey.has(key)) {
        const n = (p.counters.get(T) || 0) + 1;
        p.counters.set(T, n);
        const token = '__ZN_' + T + '_' + n + '__';
        p.byKey.set(key, token);
        p.byToken.set(token, value);
      }
      return p.byKey.get(key);
    },
    async resolve(project, token) {
      const m = /^__ZN_(.+)__$/.exec(String(token));
      if (!m) return null;
      if (secrets.has(m[1])) return secrets.get(m[1]).value;
      const p = proj(project);
      return p.byToken.has(token) ? p.byToken.get(token) : null;
    },
    async setSecret(name, value, meta = {}) {
      secrets.set(name, { value: String(value), meta: { ...meta } });
    },
    async listSecrets() {
      return [...secrets.entries()].map(([name, s]) => ({
        name,
        mode: s.meta.mode || 'proxy',
        allowHosts: s.meta.allowHosts || [],
        allowCommands: s.meta.allowCommands || [],
        source: s.meta.source || 'local',
        lastUsed: null,
      }));
    },
    async removeSecret(name) {
      secrets.delete(name);
    },
    async exactValues() {
      return [...secrets.entries()].map(([name, s]) => ({ name, type: name, values: variants(s.value) }));
    },
    async audit(event) {
      auditLog.push({ ...event });
    },
    // Synchronous view for the fake engine's pure scan().
    _exactSync() {
      return [...secrets.entries()].map(([name, s]) => ({ name, value: s.value }));
    },
  };
  if (opts.withApprovals) {
    vault.isApproved = async (s, c) => approvals.some((a) => a.s === s && a.c === c);
    vault.recordApproval = async (s, c) => { approvals.push({ s, c }); };
  }
  return vault;
}

module.exports = { createFakeVault };
