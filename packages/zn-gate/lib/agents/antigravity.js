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
 * Not documented (re-read 2026-10-20: the hooks page gives no exit-code or failure semantics, only the timeout):
 * what happens when a hook crashes, times out or cannot start; whether an organization can turn hooks off. So a
 * user install goes through the launcher of lib/agents/launcher.js, which answers a deny JSON itself when the
 * Node.js is gone (the one block Antigravity documents), and nothing is claimed for a timeout. PostToolUse can only return {}, so zn cannot rewrite or redact tool output here.
 */

const fs = require('fs');
const { fileURLToPath } = require('url');
const os = require('os');
const path = require('path');
const cfg = require('./config-file');
const launcher = require('./launcher');

const id = 'antigravity';
const HOOK_NAME = 'zn-gate';
const HOOK_TIMEOUT_S = 15;
const MATCHER = '*';

const SHELL_TOOLS = new Set(['run_command']);
const READ_TOOLS = new Set(['view_file', 'list_dir', 'find_by_name']);
const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const COMMAND_KEYS = ['CommandLine', 'commandLine', 'command_line', 'command', 'Command'];
const PATH_KEY_RE = /path|file|target|uri|dir|source|destination/i;
const NOT_PATH_KEY_RE = /content|text|instruction|description|query|pattern|code|chunk|summary|title/i;
const MAX_PATH_LEN = 4096;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function firstString(obj, keys) {
  for (const k of keys) if (typeof obj[k] === 'string' && obj[k]) return obj[k];
  return undefined;
}

/**
 * Every string argument whose key looks like a file or folder (content-like keys are skipped), three levels of
 * objects and arrays deep. A key called url counts only when its value is a file: URI. A file: URI that cannot
 * be turned into a path sets `bad`, so the call is refused instead of passed.
 */
function pathsOf(args) {
  const out = [];
  let bad = false;
  const add = (k, v) => {
    if (typeof v !== 'string' || !v) return;
    if (/^file:/i.test(v)) {
      try { out.push(fileURLToPath(v)); } catch (_) { bad = true; }
      return;
    }
    if (/url/i.test(k) && !PATH_KEY_RE.test(k)) return;
    if (v.length > MAX_PATH_LEN || /[\r\n]/.test(v)) return;
    out.push(v);
  };
  const keyOk = (k) => (PATH_KEY_RE.test(k) || /url/i.test(k)) && !NOT_PATH_KEY_RE.test(k);
  const walk = (obj, depth) => {
    for (const [k, v] of Object.entries(obj)) {
      if (keyOk(k)) {
        if (Array.isArray(v)) v.forEach((x) => add(k, x)); else add(k, v);
      }
      if (depth < 3) {
        if (isObj(v)) walk(v, depth + 1);
        else if (Array.isArray(v)) v.forEach((x) => { if (isObj(x)) walk(x, depth + 1); });
      }
    }
  };
  walk(args, 0);
  return { paths: out, bad };
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
  if (mcp) {
    const mp = pathsOf(args);
    const e = { ...ev, tool: 'mcp', mcp: { server: mcp[1], tool: mcp[2] }, input: { args, paths: mp.paths, texts: [] } };
    if (mp.bad) e.unreadable = 'zn: could not read a file address in this call, so zn cannot check it.';
    return e;
  }
  const cmd = firstString(args, COMMAND_KEYS);
  if (SHELL_TOOLS.has(toolName) || (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName) && cmd !== undefined)) {
    const e = { ...ev, tool: 'bash', input: { command: cmd || '', texts: [] } };
    if (cmd === undefined) e.unreadable = 'zn: could not read the command of this call, so zn cannot check it.';
    return e;
  }
  const { paths, bad } = pathsOf(args);
  const input = { path: paths[0], paths, texts: [] };
  const searchDir = toolName === 'grep_search' ? (paths[0] ? path.resolve(cwd, paths[0]) : cwd) : null;
  const kind = toolName === 'view_file' ? 'read' : toolName === 'grep_search' ? 'grep' : WRITE_TOOLS.has(toolName) ? 'write' : null;
  if (kind) {
    const e = { ...ev, tool: kind, input: searchDir ? { ...input, scanDir: searchDir } : input };
    if (bad) e.unreadable = 'zn: could not read a file address in this call, so zn cannot check it.';
    else if ((kind === 'read' || kind === 'write') && !paths.length) e.unreadable = 'zn: could not read the file this call uses, so zn cannot check it. Name the file explicitly.';
    return e;
  }
  // Any other tool that names a file (a viewer, a reader, a future tool) gets the read and write checks on
  // every path in it. list_dir and find_by_name show names only, and tools with no path get no opinion.
  if (!READ_TOOLS.has(toolName) && (paths.length || bad)) {
    const e = { ...ev, tool: 'fileaccess', input };
    if (bad) e.unreadable = 'zn: could not read a file address in this call, so zn cannot check it.';
    return e;
  }
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
  if (ev.unreadable) return out('deny', ev.unreadable);
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

/**
 * The hook command. A user install goes through zn's launcher (lib/agents/launcher.js): a Node.js that has gone
 * away makes the launcher answer a deny with the repair step, where a command that cannot start would block with
 * no text from zn (or not at all). A project install or a command given by the caller keeps the plain command.
 */
function commandFor(opts = {}) {
  const platform = opts.platform || process.platform;
  if (opts.command || (opts.scope || 'user') === 'project') return cfg.hookCommand(id, opts);
  const node = opts.nodePath || process.execPath;
  const runner = opts.runnerPath || cfg.runnerPath();
  if (platform === 'win32') {
    const script = launcher.windowsScript(id, 'PreToolUse', node, runner);
    return script ? launcher.windowsScriptCommand(script) : cfg.hookCommandWindows(id, { ...opts, encodedCommand: true });
  }
  // Antigravity splits the command on spaces and ignores quotes: a launcher path with a space or a quote cannot be used.
  if (/[\s'"\\]/.test(launcher.launcherFile(id, opts))) return cfg.hookCommand(id, opts);
  return launcher.launcherCommand(launcher.writeLauncher(id, node, runner, opts), 'PreToolUse', platform);
}

function install(opts = {}) {
  const file = hooksFile(opts);
  const data = cfg.readJson(file);
  const report = { settings: file, backup: cfg.backup(file), warnings: [] };
  if (report.backup && (opts.scope || 'user') === 'project') report.warnings.push('The backup ' + report.backup + ' sits inside the project: do not commit it.');
  stripOurs(data);
  // Antigravity splits the hook command on spaces and ignores quotes, so on
  // Windows a quoted path such as C:/Program Files/... breaks the -Command form
  // and every tool call is blocked. -EncodedCommand has no space inside its
  // argument.
  const command = commandFor(opts);
  // After the strip, a hook still called zn-gate is someone else's: zn never touches it (not even its enabled flag).
  let name = HOOK_NAME;
  while (data[name] !== undefined) name += '-zn';
  data[name] = { enabled: true, PreToolUse: [{ matcher: MATCHER, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }] };
  cfg.writeJson(file, data);
  report.warnings.push('Antigravity support is experimental. zn checks tool calls before they run (PreToolUse): it blocks reads and writes of secret files and shell commands that handle secrets.');
  if ((opts.scope || 'user') === 'project' && !opts.command) report.warnings.push('The project hook runs `zn` from your PATH (zn hook antigravity): every teammate who opens this project in Antigravity needs zn-gate installed, otherwise the hook cannot start and Antigravity may let the call through (a project install has no launcher).');
  report.warnings.push('Antigravity hooks cannot rewrite or redact what a tool returns, so a value printed by a command or a file the agent is allowed to read reaches the model. Keep secrets in the vault.');
  report.warnings.push('Antigravity does not document what happens when a hook fails or times out, so zn cannot promise that such a call is blocked. If the Node.js zn was installed with goes away, the launcher script answers a deny that says how to repair it; run `zn-gate check` to see that the hook works.');
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
  // The launcher of a user install (see commandFor) is no longer referenced.
  if ((opts.scope || 'user') !== 'project') {
    try { fs.unlinkSync(launcher.launcherFile(id, opts)); } catch (_) { /* none */ }
  }
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
  HOOK_TIMEOUT_S,
  detect,
  install,
  uninstall,
  normalize,
  respond,
  capabilities: { ask: 'all', rewriteInput: false, rewriteOutput: false },
  HOOK_NAME,
  hooksFile,
};
