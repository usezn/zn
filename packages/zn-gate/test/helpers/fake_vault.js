'use strict';
/**
 * In-memory VaultClient for tests, shaped like lib/vault/client.js in the
 * contract (all methods async). Holds only fake values from
 * test/fixtures/fake_secrets.js. Not used by production code.
 */

const { buildMatcher } = require('../../lib/scrub/exact');

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
    async resolve(project, token, o) {
      // withPolicy: answer like a vault daemon that applies the organization policy (none here).
      const wrap = (v) => (o && o.withPolicy === true ? { value: v, policy: 1 } : v);
      const m = /^__ZN_(.+)__$/.exec(String(token));
      if (!m) return wrap(null);
      if (secrets.has(m[1])) return wrap(secrets.get(m[1]).value);
      const p = proj(project);
      return wrap(p.byToken.has(token) ? p.byToken.get(token) : null);
    },
    async setSecret(name, value, meta = {}) {
      secrets.set(name, { value: String(value), meta: { ...meta } });
    },
    // Like the daemon: the policy changes, the value stays.
    async updateSecretMeta(name, meta = {}) {
      if (!secrets.has(name)) {
        const err = new Error('no secret named ' + name);
        err.code = 'ZN_NOT_FOUND';
        throw err;
      }
      secrets.set(name, { value: secrets.get(name).value, meta: { ...meta } });
      return true;
    },
    async listSecrets() {
      return [...secrets.entries()].map(([name, s]) => ({
        name,
        mode: s.meta.mode || 'proxy',
        allowHosts: s.meta.allowHosts || [],
        allowCommands: s.meta.allowCommands || [],
        allowIn: s.meta.allowIn || ['header'],
        source: s.meta.source || 'local',
        lastUsed: null,
      }));
    },
    async removeSecret(name) {
      secrets.delete(name);
    },
    // Like the daemon, matching happens here: positions and names come back, never values.
    async maskInfo() {
      const list = [...secrets.entries()].map(([name, s]) => ({ name, type: name, values: variants(s.value), vault: true }));
      let longest = 0;
      for (const e of list) for (const v of e.values) if (v.length > longest) longest = v.length;
      return { names: list.map((e) => e.name), longest, count: list.length };
    },
    async maskSpans(project, texts) {
      const m = buildMatcher([...secrets.entries()].map(([name, s]) => ({ name, type: name, values: variants(s.value), vault: true })));
      return texts.map((t) => m.find(t));
    },
    // Like the daemon's concrete operations (no value comes back except a backup the user asked for).
    async adoptToken(project, token, name, meta = {}) {
      const p = proj(project);
      if (!p.byToken.has(token)) {
        const err = new Error(token + ' is not known for this project');
        err.code = 'ZN_NOT_FOUND';
        throw err;
      }
      secrets.set(name, { value: p.byToken.get(token), meta: { ...meta } });
      return true;
    },
    async sameSecretValue(name, value) {
      return secrets.has(name) && secrets.get(name).value === String(value);
    },
    async readBackup(project, name) {
      const s = secrets.get(name);
      if (!s || s.meta.mode !== 'backup') {
        const err = new Error(name + ' not found');
        err.code = 'ZN_NOT_FOUND';
        throw err;
      }
      return s.value;
    },
    async audit(event) {
      auditLog.push({ ...event });
    },
    // Synchronous view for the fake engine's pure scan().
    _exactSync() {
      return [...secrets.entries()].map(([name, s]) => ({ name, value: s.value }));
    },
  };
  if (opts.confirmFile) {
    // Like the daemon's confirmFileWrite: asks opts.confirmFile, throws on no.
    vault.fileConfirmations = [];
    vault.confirmFileWrite = async (project, file, names, reason) => {
      vault.fileConfirmations.push({ project, file, names, reason });
      if (!(await opts.confirmFile({ file, names, reason }))) {
        const err = new Error('declined by the user');
        err.code = 'ZN_POLICY_DENIED';
        throw err;
      }
      return true;
    };
  }
  if (opts.withApprovals) {
    // Like the daemon: recording an approval asks the user on the vault's own
    // channel (opts.confirm, default yes) and refuses when they decline.
    const confirm = opts.confirm || (async () => true);
    vault.confirmations = 0;
    vault.calls = [];
    // (secret, command) or the client's (project, secret, command, executable).
    const args = (a) => (a.length >= 3 ? { s: a[1], c: a[2], project: a[0], executable: a[3] } : { s: a[0], c: a[1] });
    vault.isApproved = async (...a) => {
      const { s, c } = args(a);
      vault.calls.push({ op: 'isApproved', ...args(a) });
      return approvals.some((x) => x.s === s && x.c === c);
    };
    vault.recordApproval = async (...a) => {
      const { s, c } = args(a);
      vault.calls.push({ op: 'recordApproval', ...args(a) });
      vault.confirmations++;
      if (!(await confirm({ kind: 'approval', secret: s, command: c }))) {
        const err = new Error('declined by the user');
        err.code = 'ZN_POLICY_DENIED';
        throw err;
      }
      approvals.push({ s, c });
    };
  }
  return vault;
}

module.exports = { createFakeVault };
