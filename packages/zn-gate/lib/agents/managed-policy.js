'use strict';

/**
 * Read-only check of the Claude Code settings that can stop zn's hooks or its
 * "secrets" MCP server from running. Claude Code gives no sign when an
 * organization policy drops a user hook or MCP server, so zn says it.
 *
 * Verified against (read 2026-10-15):
 *  https://code.claude.com/docs/en/managed-settings  (file locations)
 *  https://code.claude.com/docs/en/settings-reference (disableAllHooks, allowManagedHooksOnly)
 *  https://code.claude.com/docs/en/managed-mcp       (managed-mcp.json, allow/deny lists)
 *
 * Only files are read. Policy delivered through MDM or the Windows registry
 * is not seen here; `claude doctor` shows where Claude Code loaded it from.
 */

const fs = require('fs');
const path = require('path');

const MCP_SERVER_NAME = 'secrets';
// Our hook command (same test as the adapter's OUR_COMMAND_RE).
const OUR_COMMAND_RE = /(\bhook claude-code|hooks[\\/]runner\.js["']? claude-code)\s*$/;
const ASK_ADMIN = 'Claude Code does not show this. Ask your administrator to add zn to the managed settings.';

function managedDir(platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/* {file, data} | {file, error} | null when the file does not exist. */
function readSource(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    return { file, error: err.code || err.message };
  }
  try {
    const data = text.trim() ? JSON.parse(text) : {};
    return data && typeof data === 'object' && !Array.isArray(data) ? { file, data } : { file, error: 'not a JSON object' };
  } catch (err) {
    return { file, error: 'invalid JSON' };
  }
}

/* managed-settings.json and the managed-settings.d/*.json drop-ins. */
function managedSources(dir) {
  const out = [];
  const main = readSource(path.join(dir, 'managed-settings.json'));
  if (main) out.push(main);
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'managed-settings.d')); } catch (_) { /* none */ }
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const s = readSource(path.join(dir, 'managed-settings.d', name));
    if (s) out.push(s);
  }
  return out;
}

function hasOurHook(data) {
  const hooks = data && data.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  for (const groups of Object.values(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g && Array.isArray(g.hooks) ? g.hooks : []) {
        if (h && typeof h.command === 'string' && OUR_COMMAND_RE.test(h.command)) return true;
      }
    }
  }
  return false;
}

/* An allow/deny list entry that names our server. */
function namesSecrets(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.serverName === MCP_SERVER_NAME) return true;
  return Array.isArray(entry.serverCommand) && entry.serverCommand.some((a) => String(a) === 'secrets-mcp');
}

function list(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * claudeCodePolicyWarnings(opts) -> [string]
 * opts: {platform, managedDir, userSettings: [file], mcp: bool}
 *  userSettings: the user's own settings files to check (disableAllHooks,
 *  MCP allow and deny lists), e.g. ~/.claude/settings.json.
 */
function claudeCodePolicyWarnings(opts = {}) {
  const dir = opts.managedDir || managedDir(opts.platform || process.platform);
  const checkMcp = opts.mcp !== false;
  const warnings = [];
  const managed = managedSources(dir);
  for (const s of managed.filter((x) => x.error)) {
    warnings.push('could not read the Claude Code managed settings ' + s.file + ' (' + s.error + '), so zn cannot tell whether they turn off its hooks.');
  }
  const ok = managed.filter((x) => x.data);
  const where = (s) => 'Your organization\'s Claude Code policy (' + s.file + ')';

  const off = ok.find((s) => s.data.disableAllHooks === true);
  if (off) {
    warnings.push(where(off) + ' turns off all hooks (disableAllHooks), so zn\'s hooks do not run. ' + ASK_ADMIN);
  } else {
    const only = ok.find((s) => s.data.allowManagedHooksOnly === true);
    if (only && !ok.some((s) => hasOurHook(s.data))) {
      warnings.push(where(only) + ' runs only the hooks in its managed settings (allowManagedHooksOnly), so the zn hooks you install do not run. ' + ASK_ADMIN);
    }
  }

  const users = [];
  for (const file of opts.userSettings || []) {
    const s = readSource(file);
    if (s && s.data) users.push(s);
  }
  if (!off) {
    const userOff = users.find((s) => s.data.disableAllHooks === true);
    if (userOff) warnings.push(userOff.file + ' sets disableAllHooks, so no hooks you install run, zn\'s included. Remove that setting to turn them on.');
  }

  if (checkMcp) {
    const mcpFile = path.join(dir, 'managed-mcp.json');
    const m = readSource(mcpFile);
    if (m && m.error) {
      warnings.push('could not read ' + mcpFile + ' (' + m.error + '), so zn cannot tell whether it allows the "secrets" MCP server.');
    } else if (m) {
      const servers = m.data.mcpServers && typeof m.data.mcpServers === 'object' ? m.data.mcpServers : {};
      if (!JSON.stringify(servers[MCP_SERVER_NAME] || '').includes('secrets-mcp')) {
        warnings.push('Your organization\'s Claude Code policy (' + mcpFile + ') loads only the MCP servers it lists, and "secrets" is not one of them, so the server does not start. ' + ASK_ADMIN);
      }
    }
    const denied = [...ok, ...users].find((s) => list(s.data.deniedMcpServers).some(namesSecrets));
    if (denied) {
      const who = ok.includes(denied) ? where(denied) : denied.file;
      warnings.push(who + ' blocks the "secrets" MCP server (deniedMcpServers), so it does not start.');
    } else {
      const onlyMcp = ok.find((s) => s.data.allowManagedMcpServersOnly === true);
      const managedAllow = ok.filter((s) => Array.isArray(s.data.allowedMcpServers));
      const allowed = (srcs) => srcs.some((s) => list(s.data.allowedMcpServers).some(namesSecrets));
      if (onlyMcp && !allowed(ok)) {
        warnings.push(where(onlyMcp) + ' allows only the MCP servers on its list (allowManagedMcpServersOnly), and "secrets" is not on it, so the server does not start. ' + ASK_ADMIN);
      } else if (!onlyMcp && managedAllow.length && !allowed(ok) && !allowed(users)) {
        warnings.push(where(managedAllow[0]) + ' has an MCP allowlist (allowedMcpServers) without "secrets", so the server does not start. Add {"serverName": "secrets"} to allowedMcpServers in your settings, or ask your administrator.');
      }
    }
  }
  return warnings;
}

module.exports = { claudeCodePolicyWarnings, managedDir };
