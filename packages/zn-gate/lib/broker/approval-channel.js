'use strict';

/**
 * The person's own channel for the commands only they may run (`zn audit --approve`, `zn-gate pins approve`).
 *
 * At a terminal is not enough: a process an agent started inside a pseudo-terminal (setsid + script) is at a terminal too, and
 * once reparented it has no agent among its ancestors. When the vault is unlocked its daemon asks the person on its own channel
 * (its terminal or an OS dialog), which the command's terminal cannot answer. When there is no vault running the terminal check
 * stands alone: that is the limit, and the result says so.
 *
 * Returns { ok: true, via: 'vault' | 'terminal' } or { ok: false, error }.
 */
async function confirmApproval(kind, project, summary, io = {}) {
  const vault = io.vault || require('../vault/client');
  try {
    await vault.confirmApproval(kind, project, summary);
    return { ok: true, via: 'vault' };
  } catch (err) {
    if (err && err.code === 'ZN_LOCKED') return { ok: true, via: 'terminal' };
    return { ok: false, error: err };
  }
}

module.exports = { confirmApproval };
