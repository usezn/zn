'use strict';

/**
 * Has the user approved zn's Codex hooks in `/hooks`?
 *
 * Codex runs a hook that is not managed only after the user reviews it. The doc (learn.chatgpt.com/docs/hooks,
 * "Review and trust hooks") says only that "Codex records trust against the hook's current hash, so new or changed
 * hooks are marked for review and skipped until trusted". It does not say where. The Codex source
 * (github.com/openai/codex, codex-rs/hooks/src/engine/discovery.rs and config/src/hook_config.rs) keeps it in the
 * user's config.toml:
 *
 *   [hooks.state."<hooks file>:<event>:<group>:<hook>"]
 *   trusted_hash = "sha256:<hex>"
 *
 * `trusted_hash` must equal the hash of the hook as Codex reads it now: the SHA-256 of the JSON of
 * {event_name, matcher, hooks: [the one hook]} with the keys sorted and the timeout always present (600 when unset).
 * `commandWindows` is not part of it: Codex drops it from the hashed hook, and on Windows it hashes it as the command.
 * A missing entry is "untrusted"; a different hash is "modified". Both are skipped until reviewed.
 * Checked against Codex 0.163.0 (its own hashes for the hooks zn installs are pinned in test/codex_trust_hash.test.js):
 * a Codex that hashes differently makes zn report "changed since you approved them", which is the safe side,
 * and never a protection that is not there.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isOurs } = require('./agents/config-file');

const DEFAULT_CONTEXT_LIMIT = 2500;

function snake(event) {
  return event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** The hash Codex records when the user trusts this hook ("sha256:<hex>"). */
function hookHash(event, group, hook, platform = process.platform) {
  const command = platform === 'win32' && typeof hook.commandWindows === 'string' ? hook.commandWindows : hook.command;
  const handler = { type: 'command', command };
  const t = Number(hook.timeout);
  handler.timeout = Number.isInteger(t) ? Math.max(1, t) : 600;
  handler.async = hook.async === true || hook.async === 'true';
  if (typeof hook.statusMessage === 'string') handler.statusMessage = hook.statusMessage;
  if (Number.isInteger(hook.additionalContextLimit) && hook.additionalContextLimit !== DEFAULT_CONTEXT_LIMIT) handler.additionalContextLimit = hook.additionalContextLimit;
  const identity = { event_name: snake(event), hooks: [handler] };
  if (typeof group.matcher === 'string') identity.matcher = group.matcher;
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(sortKeys(identity))).digest('hex');
}

function samePath(a, b) {
  const x = path.resolve(String(a));
  const y = path.resolve(String(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * codexTrust({codexHome, hooksFile}) -> {status, event}
 *   status 'trusted'   every zn hook in hooksFile has a trusted_hash equal to its current hash
 *          'untrusted' at least one has no trusted_hash (Codex has not been asked yet, or the user has not approved)
 *          'modified'  at least one has a trusted_hash for a different definition
 *          'unknown'   a file could not be read, so zn cannot tell
 *   event: the first zn hook that is not trusted.
 */
function codexTrust({ codexHome, hooksFile }) {
  let tree;
  try { tree = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); } catch (_) { return { status: 'unknown' }; }
  const hooks = tree && typeof tree.hooks === 'object' && tree.hooks ? tree.hooks : null;
  if (!hooks) return { status: 'unknown' };
  let state = {};
  const configFile = path.join(codexHome, 'config.toml');
  let text = null;
  try { text = fs.readFileSync(configFile, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') return { status: 'unknown' }; }
  if (text !== null) {
    try {
      const data = require('./audit/parse').parseToml(text).data;
      state = (data && data.hooks && typeof data.hooks.state === 'object' && data.hooks.state) || {};
    } catch (_) { return { status: 'unknown' }; }
  }
  const recorded = (event, gi, hi) => {
    const suffix = ':' + snake(event) + ':' + gi + ':' + hi;
    for (const [key, st] of Object.entries(state)) {
      if (key.endsWith(suffix) && samePath(key.slice(0, -suffix.length), hooksFile) && st && typeof st === 'object') return st;
    }
    return null;
  };
  let first = null;
  let seen = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      if (!group || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((hook, hi) => {
        if (!hook || typeof hook.command !== 'string' || !isOurs(hook.command, 'codex')) return;
        seen++;
        const st = recorded(event, gi, hi);
        const want = hookHash(event, group, hook);
        const status = !st || typeof st.trusted_hash !== 'string' ? 'untrusted' : st.trusted_hash === want ? 'trusted' : 'modified';
        if (status !== 'trusted' && (!first || (first.status === 'modified' && status === 'untrusted'))) first = { status, event };
      });
    });
  }
  if (!seen) return { status: 'unknown' };
  return first || { status: 'trusted' };
}

module.exports = { codexTrust, hookHash };
