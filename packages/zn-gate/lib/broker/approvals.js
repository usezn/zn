'use strict';

/**
 * First-use approvals for (secret, command) pairs used by `zn run`.
 *
 * Preferred store: the vault daemon, through the optional client methods
 * isApproved(secret, command) / recordApproval(secret, command). They are
 * not part of the frozen contract yet; until the vault exposes them we fall
 * back to ~/.zn/approvals.json (names and command prefixes only, never
 * values). That file is writable by any process running as the user, so it
 * is a convenience record, not a security boundary: an agent with an
 * unrestricted shell could forge it. The PreToolUse hook denies agent access
 * to ~/.zn as a guardrail. Moving approvals into the daemon is required
 * before the beta.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultZnHome() {
  return path.join(os.homedir(), '.zn');
}

function fileStore(znHome) {
  const file = path.join(znHome || defaultZnHome(), 'approvals.json');
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data.approvals) ? data.approvals : [];
    } catch (_) {
      return [];
    }
  }
  return {
    kind: 'file',
    async isApproved(secret, command) {
      return load().some((a) => a.secret === secret && a.command === command);
    },
    async recordApproval(secret, command) {
      const list = load().filter((a) => !(a.secret === secret && a.command === command));
      list.push({ secret, command, ts: new Date().toISOString() });
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ approvals: list }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

function approvalStore({ vault, znHome } = {}) {
  if (vault && typeof vault.isApproved === 'function' && typeof vault.recordApproval === 'function') {
    return {
      kind: 'vault',
      isApproved: (s, c) => vault.isApproved(s, c),
      recordApproval: (s, c) => vault.recordApproval(s, c),
    };
  }
  return fileStore(znHome);
}

module.exports = { approvalStore, defaultZnHome };
