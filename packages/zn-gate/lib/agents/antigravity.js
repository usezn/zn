'use strict';

/**
 * Google Antigravity adapter (App, CLI and IDE). Experimental.
 *
 * Hook format (read 2026-10-18):
 *  - https://antigravity.google/docs/hooks
 *  - https://antigravity.google/docs/permissions (CLI rules; zn does not edit them)
 *  - https://antigravity.google/docs/mcp
 *
 *  Files: <project>/.agents/hooks.json (project) and ~/.gemini/config/hooks.json (user).
 *    { "<name>": { "enabled": true,
 *                  "PreToolUse": [ { "matcher": "<regex on the tool name>",
 *                                    "hooks": [ { "type": "command", "command": "...", "timeout": <seconds, default 30> } ] } ] } }
 *  Each top-level key is one named hook; zn writes its own under "zn-gate" and leaves the others alone.
 *
 *  stdin (camelCase): conversationId, workspacePaths, transcriptPath, artifactDirectoryPath, modelName;
 *    for PreToolUse also toolCall {name, args} and stepIdx. The event name is not part of stdin.
 *  stdout of PreToolUse: {decision: allow | auto_approve | deny | ask | force_ask | deny_unless_prior_grant,
 *    reason, overwrite, permissionOverrides}. "allow" means "proceed, deferring to the next hook or the
 *    default policy", so it is the way to say "no opinion" (never auto_approve).
 *
 * Tools named in the docs: run_command (shell), view_file, write_to_file, replace_file_content,
 * multi_replace_file_content, list_dir, find_by_name, grep_search, search_web, read_url_content,
 * and agent-management tools. The argument names are NOT documented (only that run_command takes a command
 * line), so this adapter finds the command by its likely names and finds file paths by key name
 * (anything called path, file, target, uri or dir), skipping keys that hold content. How an MCP tool is
 * named is not documented either: names that start with "mcp" are treated as MCP calls.
 * A tool zn cannot classify gets "allow" (no opinion).
 *
 * Not documented, so not relied on: what happens when a hook crashes or times out; whether an organization
 * can turn hooks off. PostToolUse can only return {}, so zn cannot rewrite or redact tool output here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config-file');

const id = 'antigravity';
const HOOK_NAME = 'zn-gate';
const HOOK_TIMEOUT_S = 15;
const MATCHER = '*';

const SHELL_TOOLS = new Set(['run_command']);
const READ_TOOLS = new Set(['view_file', 'list_dir', 'find_by_name']);
const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const COMMAND_KEYS = ['CommandLine', 'commandLine', 'command_line', 'command', 'Command'];
const PATH_KEY_RE = /path|file|target|uri|dir/i;
const NOT_PATH_KEY_RE = /content|text|instruction|description|query|pattern|code|chunk|summary|title|name$/i;
const MAX_PATH_LEN = 4096;

function firstString(obj, keys) {
  for (const k of keys) if (typeof obj[k] === 'string' && obj[k]) return obj[k];
  return undefined;
}

/** Every string argument whose key looks like a file or folder (content-like keys are skipped). */
function pathsOf(args) {
  const out = [];
  const add = (v) => {
    if (typeof v !== 'string' || !v || v.length > MAX_PATH_LEN || /[\r\n]/.test(v)) return;
    out.push(v.replace(/^file:\/\/(?=\/|[A-Za-z]:)/, ''));
  };
  for (const [k, v] of Object.entries(args)) {
    if (!PATH_KEY_RE.test(k) || NOT_PATH_KEY_RE.test(k)) continue;
    if (Array.isArray(v)) v.forEach(add); else add(v);
  }
  return out;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const wp = Array.isArray(raw.workspacePaths) && typeof raw.workspacePaths[0] === 'string' ? raw.workspacePaths[0] : null;
  const call = raw.toolCall && typeof raw.toolCall === 'object' ? raw.toolCall : null;
  const args = call && call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
  const cwd = (typeof args.Cwd === 'string' && args.Cwd) || (typeof args.cwd === 'string' && args.cwd) || wp || process.cwd();
  const base = { cwd, sessionId: raw.conversationId || null, raw };
  // The event name is not in Antigravity's stdin; if a caller adds one, anything but PreToolUse is ignored.
  const named = raw.hookEventName || raw.hook_event_name;
  if (!call || (named && named !== 'PreToolUse')) return { ...base, event: null };
  const toolName = String(call.name || '');
  const ev = { ...base, event: 'pre_tool', toolName, rawArgs: args };

  const mcp = /^mcp[_.\-:/]+(.+?)[_.\-:/]+(.+)$/i.exec(toolName);
  if (mcp) return { ...ev, tool: 'mcp', mcp: { server: mcp[1], tool: mcp[2] }, input: { args, texts: [] } };
  const cmd = firstString(args, COMMAND_KEYS);
  if (SHELL_TOOLS.has(toolName) || (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName) && cmd !== undefined)) {
    return { ...ev, tool: 'bash', input: { command: cmd || '', texts: [] } };
  }
  const paths = pathsOf(args);
  if (toolName === 'view_file') return { ...ev, tool: 'read', input: { path: paths[0], paths, texts: [] } };
  if (toolName === 'grep_search') return { ...ev, tool: 'grep', input: { path: paths[0], paths, texts: [] } };
  if (WRITE_TOOLS.has(toolName)) return { ...ev, tool: 'write', input: { path: paths[0], paths, texts: [] } };
  // list_dir and find_by_name show names only; every other tool gets no opinion.
  return { ...ev, tool: toolName || 'unknown', input: { texts: [] } };
}

function out(decision, reason) {
  const o = { decision };
  if (reason) o.reason = reason;
  return o;
}

function respond(d) {
  const ev = d && d.event;
  if (!ev) return null;
  if (!ev.event) return {}; // any event that is not PreToolUse: Antigravity expects an object
  if (d.decision === 'deny') return out('deny', d.message || 'Blocked by zn');
  if (d.updatedInput && d.kind === 'wrap') {
    const msg = 'zn: this command uses a stored secret. Run it through zn instead, exactly like this: zn run -- ' + ev.input.command +
      '  (zn puts the value only into that process, if the user allowed this command for the secret).';
    return out('deny', msg);
  }
  // A rewritten command or text is not applied (zn would need "overwrite" together with a decision that skips
  // the user's cached approvals): the user is asked about the original instead.
  if (d.decision === 'ask' || d.updatedInput) return out('force_ask', d.message || 'zn asks for confirmation');
  return out('allow'); // "allow" here defers to the default policy; zn never auto-approves
}

/* ------------------------ install / uninstall ---------------------- */

function hooksFile(opts = {}) {
  if ((opts.scope || 'user') === 'project') return path.join(path.resolve(opts.projectDir || process.cwd()), '.agents', 'hooks.json');
  return path.join(opts.home || os.homedir(), '.gemini', 'config', 'hooks.json');
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Removes zn's handlers from every named hook; returns true when something was removed. */
function stripOurs(data) {
  let changed = false;
  for (const name of Object.keys(data)) {
    const entry = data[name];
    if (!isObj(entry)) continue;
    const before = changed;
    changed = false;
    for (const event of Object.keys(entry)) {
      const groups = entry[event];
      if (!Array.isArray(groups)) continue;
      const kept = [];
      for (const g of groups) {
        if (isObj(g) && Array.isArray(g.hooks)) {
          const hs = g.hooks.filter((h) => !(isObj(h) && cfg.isOurs(h.command, id)));
          if (hs.length !== g.hooks.length) changed = true;
          if (hs.length) kept.push({ ...g, hooks: hs });
        } else if (isObj(g) && cfg.isOurs(g.command, id)) {
          changed = true; // a handler placed directly in the event list
        } else {
          kept.push(g);
        }
      }
      if (kept.length) entry[event] = kept; else delete entry[event];
    }
    // An entry that only held zn's handlers goes away; one with other events or settings stays.
    if (changed && Object.keys(entry).every((k) => k === 'enabled')) delete data[name];
    changed = changed || before;
  }
  return changed;
}

function install(opts = {}) {
  const file = hooksFile(opts);
  const data = cfg.readJson(file);
  const report = { settings: file, backup: cfg.backup(file), warnings: [] };
  stripOurs(data);
  const command = !opts.command && (opts.platform || process.platform) === 'win32' && (opts.scope || 'user') !== 'project'
    ? cfg.hookCommandWindows(id, opts)
    : cfg.hookCommand(id, opts);
  const name = isObj(data[HOOK_NAME]) || data[HOOK_NAME] === undefined ? HOOK_NAME : HOOK_NAME + '-zn';
  const entry = isObj(data[name]) ? data[name] : {};
  entry.enabled = true;
  entry.PreToolUse = (Array.isArray(entry.PreToolUse) ? entry.PreToolUse : []).concat([
    { matcher: MATCHER, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] },
  ]);
  data[name] = entry;
  cfg.writeJson(file, data);
  report.warnings.push('Antigravity support is experimental. zn checks tool calls before they run (PreToolUse): it blocks reads and writes of secret files and shell commands that handle secrets.');
  report.warnings.push('Antigravity hooks cannot rewrite or redact what a tool returns, so a value printed by a command or a file the agent is allowed to read reaches the model. Keep secrets in the vault.');
  report.warnings.push('Antigravity does not document what happens when a hook fails or times out, so zn cannot promise that such a call is blocked.');
  return report;
}

function uninstall(opts = {}) {
  const file = hooksFile(opts);
  const report = { settings: file, backup: null, removed: 0, warnings: [] };
  if (!fs.existsSync(file)) return report;
  const data = cfg.readJson(file);
  const before = JSON.stringify(data);
  if (!stripOurs(data) || JSON.stringify(data) === before) return report;
  report.backup = cfg.backup(file);
  report.removed = 1;
  if (Object.keys(data).length === 0) fs.unlinkSync(file);
  else cfg.writeJson(file, data);
  return report;
}

function detect(opts = {}) {
  const home = opts.home || os.homedir();
  return fs.existsSync(path.join(home, '.gemini', 'antigravity')) ||
    fs.existsSync(path.join(home, '.gemini', 'antigravity-cli')) ||
    fs.existsSync(path.join(home, '.gemini', 'config'));
}

module.exports = {
  id,
  detect,
  install,
  uninstall,
  normalize,
  respond,
  capabilities: { ask: 'all', rewriteInput: false, rewriteOutput: false },
  HOOK_NAME,
  hooksFile,
};
