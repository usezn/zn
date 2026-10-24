'use strict';

/**
 * Zcode (z.ai) adapter.
 *
 * Sources (read 2026-10-24):
 *  - https://zcode.z.ai/en/docs/hooks and apps/zcode-cli/docs/usage/09-hooks.md in github.com/zai-org/ZCode
 *  - the source of that repository (Apache-2.0): apps/zcode-cli/packages/contracts/src/hooks (event and output
 *    schemas), packages/core/src/hooks (how a hook is run and how its answer is read), packages/adapters/src/config
 *    (the config file schema) and packages/core/src/tool/handlers (built-in tool names and arguments).
 *
 *  Config: ~/.zcode/cli/config.json (user). Hooks there only run when hooks.enabled is true (off by default):
 *    { "hooks": { "enabled": true, "events": { "<Event>": [ { "matcher": "<name list or regex>",
 *        "hooks": [ { "type": "process", "command": "<file>", "args": ["..."], "timeoutMs": <ms> } ] } ] } } }
 *  "process" runs the file with the arguments directly (no shell); "command" hands a string to the shell.
 *  The hooks, hook group and event objects are strict in Zcode's schema: a key it does not know makes it ignore the
 *  whole file, so zn writes only the keys above. Project hooks (<project>/.zcode/config.json, zcode.json) are
 *  ignored as a whole by the current version, so there is no project install here. Hooks read when a session
 *  starts: a running session does not see a change.
 *
 *  stdin (one JSON line) carries both Zcode's camelCase fields and Claude Code's snake_case aliases:
 *    session_id, cwd, hook_event_name, permission_mode, transcript_path, and for tool events tool_name,
 *    tool_input, tool_use_id (PostToolUse adds tool_response; UserPromptSubmit adds prompt).
 *  Answers (stdout JSON, exit 0), validated against a schema (a wrong shape fails the hook, which then does not block):
 *    PreToolUse         hookSpecificOutput.{hookEventName, permissionDecision allow|ask|deny, permissionDecisionReason,
 *                       updatedInput (a full replacement), additionalContext}
 *    PermissionRequest  hookSpecificOutput.{hookEventName, decision {behavior: "deny", message}}; fires only when
 *                       the user would be asked
 *    UserPromptSubmit   {continue: false, reason}; cannot rewrite the prompt
 *    PostToolUse        hookSpecificOutput.{hookEventName, additionalContext}: appended for the model; it cannot replace
 *                       the tool output
 *  Exit code 2 blocks PreToolUse, PermissionRequest and UserPromptSubmit (stderr is the reason). Any other
 *  non-zero code, a timeout, a start failure or a malformed answer is "recoverable": diagnostics only, and the
 *  tool RUNS. So a hook that cannot start blocks nothing by itself: zn's launcher (lib/agents/launcher.js) exits 2
 *  when the Node.js it was installed with is gone, and the runner has its own watchdog below the hook timeout.
 *
 * What that means here (docs/compat.md):
 *  - Reads and writes of credential files, .env with values and ~/.zn are denied, in the built-in tools and in
 *    any other tool whose arguments name a file.
 *  - Shell commands that read those files or manage the vault are denied. A command with __ZN_<NAME>__ markers is
 *    denied with the exact `zn run -- ...` command to use (zn does not rewrite the input: updatedInput is not used).
 *  - MCP calls (mcp__<server>__<tool>) are checked for secrets in their arguments before they run.
 *  - Prompts with a secret are blocked.
 *  - Output of tools cannot be rewritten: a value a command prints or a file the agent may read reaches the
 *    model. zn adds a notice (PostToolUse additionalContext) when an output holds a secret. Keep secrets in the vault.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config-file');
const launcher = require('./launcher');
const { whichSync } = require('../broker/markers');
const { shQuote, portablePath } = require('../shell-quote');

const id = 'zcode';

/* ------------------------------------------------------------------------------------------------------------------
 * Facts about Zcode, in one place. Measured on zcode-cli 0.17.0 (ZCode commit 3c5b2276, 2026-10-20) on Linux x64,
 * headless (--prompt) and in the terminal UI, with a fake model provider. Not tested: Windows, macOS, the desktop app.
 * Measured: hooks fire headless and in every permission mode (yolo included); a "process" hook is run directly with
 * no shell, a "command" hook with /bin/sh -c; exit code 2 blocks PreToolUse, PermissionRequest and UserPromptSubmit;
 * on UserPromptSubmit a permissionDecision does not block (exit 2, {decision:"block"} or {continue:false} do);
 * PermissionRequest only fires when a person would be asked (the terminal UI), and behavior "allow" there skips the
 * approval screen, so zn only ever answers deny; any other failure, a timeout or a malformed answer lets the call
 * run; hooks also fire inside subagents (so a hook must be reentrant); hooks.enabled=false turns off the hooks of
 * the user's config but not the hooks of a plugin; the environment of a hook carries CLAUDE_PROJECT_DIR and
 * CLAUDE_SESSION_ID next to ZCODE_PROJECT_DIR and ZCODE_SESSION_ID, so zn never takes the agent from the environment
 * (it comes from the launcher the hook runs: `runner.js zcode`).
 * ---------------------------------------------------------------------------------------------------------------- */
// Zcode's own default is 60000. zn's runner answers by itself 5 seconds before this (lib/hooks/runner.js).
const HOOK_TIMEOUT_S = 30;
const HOOK_TIMEOUT_MS = HOOK_TIMEOUT_S * 1000;
const HOOK_STATUS = 'zn: checking for secrets';
// Matchers: "*" (or none) matches every tool; a name list is only letters, digits, underscores and "|"; anything else is a regex.
const PRE_MATCHER = '*';
const PERMISSION_MATCHER = '*';
// Tools whose output can hold a secret: the built-in ones that print file or command text, and every MCP tool.
const POST_MATCHER = '^(Bash|Read|Grep|WebFetch)$|^mcp__.*';
const EVENTS = ['PreToolUse', 'PermissionRequest', 'UserPromptSubmit', 'PostToolUse'];
// Tool names seen at run time: Bash, Read, Write, Edit, WebFetch, mcp__<server key>__<tool> (Glob and Grep only appear when
// Bash is disallowed). ApplyPatch was not seen; the mapping stays, it is harmless.
const SHELL_TOOLS = new Set(['Bash']);
const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Write']);
const EDIT_TOOLS = new Set(['Edit']);
const PATCH_TOOLS = new Set(['ApplyPatch']); // {patch_text} in the same format as Codex's apply_patch
const GREP_TOOLS = new Set(['Grep']);
const NAMES_ONLY_TOOLS = new Set(['Glob']);
const WEBFETCH_TOOLS = new Set(['WebFetch']);
const COMMAND_KEYS = ['command'];
const FILE_KEYS = ['file_path', 'filePath', 'path'];
const MCP_TOOL_RE = /^mcp__(.+?)__(.+)$/;
// The MCP server name zn registers (and the one zn treats as its own, see znMcpServerIsOurs).
const MCP_SERVER_NAME = 'secrets';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/* ----------------------------- events ----------------------------- */

function firstString(obj, keys) {
  for (const k of keys) if (typeof obj[k] === 'string' && obj[k]) return obj[k];
  return undefined;
}

/**
 * Whether the "secrets" MCP server a call goes to is zn's own: the user's config names it, and it is zn's
 * (`secrets-mcp` run through zn-gate's bin/cli.js, `zn` or `zn-gate`). Zcode lets the user's server win over a
 * project server of the same name (docs/usage/07-mcp.md), so a project cannot stand in for it. Anything unreadable gives null.
 */
function znMcpServerIsOurs(server, opts = {}) {
  if (server !== MCP_SERVER_NAME) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(configFile(opts), 'utf8').replace(/^﻿/, ''));
  } catch (_) {
    return null;
  }
  const s = data && isObj(data.mcp) && isObj(data.mcp.servers) ? data.mcp.servers[MCP_SERVER_NAME] : undefined;
  if (!s || s.enabled === false) return null;
  return require('./claude-code').isZnSecretsServer(s) ? 'secrets' : null;
}

function normalize(raw) {
  if (!isObj(raw)) return null;
  const name = raw.hook_event_name || raw.hookEventName;
  const event = name === 'PreToolUse' || name === 'PermissionRequest' ? 'pre_tool'
    : name === 'PostToolUse' ? 'post_tool' : name === 'UserPromptSubmit' ? 'user_prompt' : null;
  const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : process.cwd();
  const base = { event, permissionRequest: name === 'PermissionRequest', hookEvent: name, cwd, sessionId: raw.session_id || raw.sessionId || null, raw };
  if (event === null) return base;
  if (event === 'user_prompt') return { ...base, tool: null, input: { prompt: typeof raw.prompt === 'string' ? raw.prompt : '' } };

  const toolName = typeof (raw.tool_name || raw.toolName) === 'string' ? String(raw.tool_name || raw.toolName) : '';
  const rawInput = raw.tool_input !== undefined ? raw.tool_input : raw.toolInput;
  const args = isObj(rawInput) ? rawInput : {};
  const ev = { ...base, toolName, rawArgs: args };
  const mcp = MCP_TOOL_RE.exec(toolName);

  if (event === 'post_tool') {
    const output = raw.tool_response !== undefined ? raw.tool_response : raw.toolResponse;
    const tool = mcp ? 'mcp' : SHELL_TOOLS.has(toolName) ? 'bash' : READ_TOOLS.has(toolName) ? 'read' : GREP_TOOLS.has(toolName) ? 'grep'
      : WEBFETCH_TOOLS.has(toolName) ? 'webfetch' : toolName.toLowerCase();
    return { ...ev, tool, mcp: mcp ? { server: mcp[1], tool: mcp[2] } : null, input: { texts: [] }, output };
  }

  const unreadable = (what) => ({ ...ev, tool: 'unreadable', input: { texts: [] }, unreadable: 'zn: could not read ' + what + ' of this call, so zn cannot check it.' });
  if (!toolName) return unreadable('the tool name');

  // pathsOf is shared with the Gemini CLI adapter: every string argument whose key looks like a file or folder.
  const { pathsOf } = require('./gemini');
  if (mcp) {
    const mp = pathsOf(args);
    const ours = znMcpServerIsOurs(mcp[1]);
    const e = { ...ev, tool: 'mcp', mcp: { server: mcp[1], tool: mcp[2], ...(ours ? { ours } : {}) }, input: { args: rawInput === undefined || rawInput === null ? {} : rawInput, paths: mp.paths, texts: [] } };
    if (mp.bad) e.unreadable = 'zn: could not read a file address in this call, so zn cannot check it.';
    return e;
  }
  if (SHELL_TOOLS.has(toolName)) {
    const cmd = firstString(args, COMMAND_KEYS);
    if (cmd === undefined) return unreadable('the command');
    return { ...ev, tool: 'bash', input: { command: cmd, texts: [] } };
  }
  if (PATCH_TOOLS.has(toolName)) {
    // Every file the patch touches is checked; a patch whose file names cannot be read is refused.
    const { patchScan, PATCH_SCAN_CAP } = require('./codex');
    const text = typeof args.patch_text === 'string' ? args.patch_text : '';
    if (!text) return unreadable('the patch');
    const tooLong = text.length > PATCH_SCAN_CAP;
    const scan = tooLong ? { files: [], suspicious: false } : patchScan(text);
    const home = os.homedir();
    const zn = scan.files.find((f) => path.resolve(cwd, f).replace(/\\/g, '/').startsWith(path.join(home, '.zn').replace(/\\/g, '/')));
    return {
      ...ev, tool: 'write', input: { paths: scan.files, path: zn || scan.files[0], tooLong, unparsed: !tooLong && (scan.files.length === 0 || scan.suspicious), texts: [] },
    };
  }
  if (WEBFETCH_TOOLS.has(toolName)) return { ...ev, tool: 'webfetch', input: { url: typeof args.url === 'string' ? args.url : '', texts: [] } };
  if (GREP_TOOLS.has(toolName)) {
    const dir = firstString(args, FILE_KEYS);
    const e = { ...ev, tool: 'grep', input: { path: dir, paths: dir ? [dir] : [], scanDir: dir ? path.resolve(cwd, dir) : cwd, texts: [] } };
    return e;
  }
  const file = firstString(args, FILE_KEYS);
  const kind = READ_TOOLS.has(toolName) ? 'read' : WRITE_TOOLS.has(toolName) ? 'write' : EDIT_TOOLS.has(toolName) ? 'edit' : null;
  if (kind) {
    const e = { ...ev, tool: kind, input: { path: file, paths: file ? [file] : [], texts: [] } };
    if (!file) e.unreadable = 'zn: could not read the file this call uses, so zn cannot check it. Name the file explicitly.';
    return e;
  }
  // Any other tool that names a file (a tool zn does not know) gets the read and write checks on every path.
  const { paths, bad } = pathsOf(args);
  if (!NAMES_ONLY_TOOLS.has(toolName) && (paths.length || bad)) {
    const e = { ...ev, tool: 'fileaccess', input: { path: paths[0], paths, texts: [] } };
    if (bad) e.unreadable = 'zn: could not read a file address in this call, so zn cannot check it.';
    return e;
  }
  return { ...ev, tool: toolName.toLowerCase(), input: { texts: [] } };
}

const preDeny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason || 'Blocked by zn' } });

/**
 * The text appended for the model after a tool that printed a secret. Zcode's PostToolUse cannot replace the
 * output, so this only tells the model (and through it the user) that the value was exposed.
 */
function postNotice(d) {
  const n = d.stats && d.stats.redacted;
  if (n > 0) {
    return 'zn: this output contains ' + n + ' secret value(s). Zcode cannot hide tool output, so the value is already in this conversation. ' +
      'Do not repeat or write it anywhere, and tell the user to rotate it if it is real. Next time keep secrets in the zn vault instead of printing them.';
  }
  if (d.stats && d.stats.withheld) {
    return 'zn: part of this output is too large for zn to check for secrets in time, and Zcode cannot withhold it. Ask for a smaller output (a line range, grep, head or tail).';
  }
  return d.message || null;
}

/**
 * Internal decision -> Zcode hook JSON, or null for "no opinion" (zn never says allow: that could skip the user's
 * own confirmation). PermissionRequest only ever gets a deny.
 */
function respond(d) {
  const ev = d && d.event;
  if (!ev || !ev.event) return null;
  if (ev.event === 'pre_tool') {
    let reason = null;
    let ask = null;
    if (d.decision === 'deny') reason = d.message || 'Blocked by zn';
    else if (ev.unreadable) reason = ev.unreadable;
    else if (d.updatedInput && d.kind === 'wrap' && typeof ev.input.command === 'string') {
      reason = 'zn: this command uses a stored secret. Run it through zn instead, exactly like this: zn run -- ' + ev.input.command +
        '  (zn puts the value only into that process, if the user allowed this command for the secret).';
    } else if (d.decision === 'ask' && !d.updatedInput) ask = d.message || 'zn asks for confirmation';
    if (ev.permissionRequest) {
      return reason === null ? null : { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } };
    }
    if (reason !== null) return preDeny(reason);
    if (ask !== null) {
      const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: ask } };
      if (d.context) out.hookSpecificOutput.additionalContext = d.context;
      return out;
    }
    return null;
  }
  if (ev.event === 'post_tool') {
    const text = d.updatedOutput !== undefined || d.decision === 'deny' || d.message ? postNotice(d) : null;
    if (!text) return null;
    const out = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
    if (d.userMessage) out.systemMessage = d.userMessage;
    return out;
  }
  if (ev.event === 'user_prompt' && d.decision === 'deny') return { continue: false, reason: d.message || 'Blocked by zn' };
  return null;
}

/* ------------------------ install / uninstall ---------------------- */

function configFile(opts = {}) {
  return path.join(opts.home || os.homedir(), '.zcode', 'cli', 'config.json');
}

/** The program and arguments zn writes into a "process" entry, or null for a plain command string. */
function processParts(h) {
  return h && h.type === 'process' && typeof h.command === 'string' ? [h.command, ...(Array.isArray(h.args) ? h.args.map(String) : [])] : null;
}

/**
 * One hook entry as the single command string the other adapters and `zn-gate check` read: the launcher path is
 * quoted like the launcher command of the other agents; the Windows form (powershell.exe ... -EncodedCommand ...) is
 * the arguments joined with spaces.
 */
function commandText(h) {
  const parts = processParts(h);
  if (!parts) return h && typeof h.command === 'string' ? h.command : '';
  if (/(^|[\\/])zn-hook-[a-z-]+\.sh$/.test(parts[0])) return shQuote(parts[0]) + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
  return parts.join(' ');
}

const isOursEntry = (h) => cfg.isOurs(commandText(h), id);

function stripOurs(groups) {
  if (!Array.isArray(groups)) return groups;
  const out = [];
  for (const g of groups) {
    if (!isObj(g) || !Array.isArray(g.hooks)) { out.push(g); continue; }
    const hooks = g.hooks.filter((h) => !(isObj(h) && isOursEntry(h)));
    if (hooks.length === g.hooks.length) out.push(g);
    else if (hooks.length) out.push({ ...g, hooks });
  }
  return out;
}

/**
 * The hook entry for each event. A user install goes through zn's launcher (lib/agents/launcher.js): Zcode lets a
 * call run when a hook cannot start, so a Node.js that has gone away must block (exit 2) instead. On Windows the
 * same three steps are an inline PowerShell script. A command given by the caller keeps the plain command.
 */
function handlerFor(opts = {}) {
  const base = { timeoutMs: HOOK_TIMEOUT_MS, statusMessage: HOOK_STATUS };
  if (opts.command) return () => ({ type: 'command', command: opts.command, ...base });
  const platform = opts.platform || process.platform;
  const node = opts.nodePath || process.execPath;
  const runner = opts.runnerPath || cfg.runnerPath();
  if (platform === 'win32') {
    return (event) => {
      const script = launcher.windowsScript(id, event, node, runner);
      if (!script) return { type: 'command', command: cfg.hookCommandWindows(id, opts), ...base };
      const [file, ...args] = launcher.windowsScriptCommand(script).split(' ');
      return { type: 'process', command: file, args, ...base };
    };
  }
  const file = launcher.writeLauncher(id, node, runner, opts);
  return (event) => ({ type: 'process', command: portablePath(file, platform), args: [event], ...base });
}

/* The hook groups zn writes, by event, for one handler (a function of the event name). */
function hookGroups(handler) {
  return {
    PreToolUse: { matcher: PRE_MATCHER, hooks: [handler('PreToolUse')] },
    // Same matcher: the approval prompt is asked only for calls zn's PreToolUse check let through.
    PermissionRequest: { matcher: PERMISSION_MATCHER, hooks: [handler('PermissionRequest')] },
    UserPromptSubmit: { hooks: [handler('UserPromptSubmit')] },
    PostToolUse: { matcher: POST_MATCHER, hooks: [handler('PostToolUse')] },
  };
}

/* "hooks" and its "events" must be objects: anything else is refused before the file is touched. */
function hooksTree(data, file) {
  const hooks = cfg.hooksOf(data, file);
  if (hooks.events !== undefined && hooks.events !== null && !isObj(hooks.events)) {
    throw new Error('"hooks.events" in ' + file + ' must be an object (left unchanged)');
  }
  const events = isObj(hooks.events) ? hooks.events : {};
  for (const [name, list] of Object.entries(events)) {
    if (!Array.isArray(list)) throw new Error('"hooks.events.' + name + '" in ' + file + ' must be a list (left unchanged)');
  }
  return { hooks, events };
}

function mcpServers(data, file, create) {
  if (data.mcp === undefined || data.mcp === null) return create ? (data.mcp = { servers: {} }).servers : {};
  if (!isObj(data.mcp)) throw new Error('"mcp" in ' + file + ' must be an object (left unchanged)');
  if (data.mcp.servers === undefined || data.mcp.servers === null) return create ? (data.mcp.servers = {}) : {};
  if (!isObj(data.mcp.servers)) throw new Error('"mcp.servers" in ' + file + ' must be an object (left unchanged)');
  return data.mcp.servers;
}

function mcpServerConfig(opts = {}) {
  const cli = path.resolve(__dirname, '..', '..', 'bin', 'cli.js');
  return { type: 'stdio', command: opts.nodePath || process.execPath, args: [opts.cliPath || cli, 'secrets-mcp', '--agent', id], enabled: true };
}

function install(opts = {}) {
  if ((opts.scope || 'user') === 'project') {
    throw new Error('Zcode ignores the hooks of a project (it only runs the ones in ~/.zcode/cli/config.json), so there is no project install. Run `zn hooks install zcode` without --project.');
  }
  const file = configFile(opts);
  const data = cfg.readJson(file);
  const { hooks, events } = hooksTree(data, file);
  const servers = mcpServers(data, file, false);
  const report = { settings: file, backup: cfg.backup(file), warnings: [] };
  const ours = hookGroups(handlerFor(opts));
  for (const [event, group] of Object.entries(ours)) {
    events[event] = [...stripOurs(events[event] || []), group];
  }
  hooks.events = events;
  const wasOff = hooks.enabled !== true;
  hooks.enabled = true;
  data.hooks = hooks;
  if (opts.mcp !== false) {
    const existing = servers[MCP_SERVER_NAME];
    if (existing !== undefined && !require('./claude-code').isZnSecretsServer(existing)) {
      report.warnings.push('an MCP server named "' + MCP_SERVER_NAME + '" already exists in ' + file + '; left unchanged');
    } else {
      mcpServers(data, file, true)[MCP_SERVER_NAME] = mcpServerConfig(opts);
      report.mcp = file;
    }
  }
  cfg.writeJson(file, data);
  report.warnings.push('zn checks tool calls (PreToolUse, PermissionRequest) and prompts before they run: it blocks reads and writes of secret files, shell commands that handle secrets, MCP calls that would send a secret and prompts that contain one.');
  report.warnings.push('Zcode cannot rewrite what a tool returns: a value printed by a command or read from a file reaches the model. zn adds a notice to the output when it holds a secret. Keep secrets in the vault.');
  report.warnings.push('Zcode runs hooks only from ' + file + ' (hooks of a project are ignored) and only when "hooks.enabled" is true' + (wasOff ? ': zn turned it on' : '') + '. Start a new Zcode session: a running one keeps the hooks it started with.');
  report.warnings.push('Zcode lets a call run when its hook cannot start or crashes (only exit code 2 blocks). If the Node.js zn was installed with goes away, zn\'s launcher blocks the call instead; run `zn-gate check` to see that the hook works.');
  if (data.features && data.features.mcp === false) report.warnings.push('"features.mcp" is false in ' + file + ', so Zcode starts no MCP server, zn\'s "secrets" server included.');
  return report;
}

function uninstall(opts = {}) {
  const file = configFile(opts);
  const report = { settings: file, backup: null, removed: 0, warnings: [] };
  if ((opts.scope || 'user') === 'project') {
    report.warnings.push('Zcode ignores the hooks of a project, so zn never installs there: nothing to remove. Run `zn hooks uninstall zcode` without --project to remove the user hooks.');
    return report;
  }
  if (!fs.existsSync(file)) return report;
  const data = cfg.readJson(file);
  const { hooks, events } = hooksTree(data, file);
  const servers = mcpServers(data, file, false);
  const before = JSON.stringify(data);
  for (const event of Object.keys(events)) {
    const kept = stripOurs(events[event]);
    if (kept.length) events[event] = kept; else delete events[event];
  }
  if (Object.keys(events).length) hooks.events = events; else delete hooks.events;
  // With nothing of the user's left, "enabled" alone is just the switch zn turned on: Zcode's default is off.
  if (Object.keys(hooks).length === 0 || (Object.keys(hooks).length === 1 && hooks.enabled === true && !hooks.events)) delete data.hooks;
  if (opts.mcp !== false && servers[MCP_SERVER_NAME] !== undefined) {
    // Only zn's own server: a user MCP server that happens to be called "secrets" is left alone.
    if (require('./claude-code').isZnSecretsServer(servers[MCP_SERVER_NAME])) {
      delete servers[MCP_SERVER_NAME];
      if (Object.keys(servers).length === 0) {
        delete data.mcp.servers;
        if (Object.keys(data.mcp).length === 0) delete data.mcp;
      }
    } else {
      report.warnings.push('left the MCP server named "' + MCP_SERVER_NAME + '" in place: it is not zn\'s');
    }
  }
  if (JSON.stringify(data) === before) return report;
  report.backup = cfg.backup(file);
  report.removed = 1;
  cfg.writeJson(file, data);
  // The launcher (see handlerFor) is shared by every config of this machine: one uninstall leaves it in place,
  // only the machine-wide uninstall (opts.removeLauncher) deletes it.
  if (opts.removeLauncher === true) {
    try { fs.unlinkSync(launcher.launcherFile(id, opts)); } catch (_) { /* none */ }
  }
  return report;
}

/**
 * Settings that stop zn's hooks from running (read-only): {problems, notes}. Zcode runs no hook unless
 * hooks.enabled is true, and a single entry can be switched off with "enabled": false.
 */
function configWarnings(opts = {}) {
  const file = opts.file || configFile(opts);
  const out = { problems: [], notes: [], fix: 'run `zn hooks install zcode` in your own terminal (it turns the hooks back on), then run `zn-gate check` again' };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') out.notes.push('could not read ' + file + ' to see whether hooks are switched on');
    return out;
  }
  if (!isObj(data)) return out;
  const hooks = isObj(data.hooks) ? data.hooks : {};
  if (hooks.enabled !== true) {
    out.problems.push('"hooks.enabled" is ' + (hooks.enabled === false ? 'false' : 'not set') + ' in ' + file + ', so Zcode runs none of the hooks in that file, zn\'s included');
    return out;
  }
  const events = isObj(hooks.events) ? hooks.events : {};
  for (const [event, groups] of Object.entries(events)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of isObj(g) && Array.isArray(g.hooks) ? g.hooks : []) {
        if (isObj(h) && isOursEntry(h) && h.enabled === false) out.problems.push('zn\'s ' + event + ' hook has "enabled": false in ' + file + ', so Zcode skips it');
        if (isObj(h) && isOursEntry(h) && h.async === true) out.problems.push('zn\'s ' + event + ' hook runs in the background (async) in ' + file + ', and a background hook cannot block anything');
      }
    }
  }
  if (isObj(data.features) && data.features.mcp === false) out.notes.push('"features.mcp" is false in ' + file + ', so Zcode does not start zn\'s "secrets" MCP server');
  return out;
}

function detect(opts = {}) {
  if (whichSync('zcode', (opts.env || process.env).PATH || '')) return true;
  return fs.existsSync(path.join(opts.home || os.homedir(), '.zcode'));
}

module.exports = {
  id,
  detect,
  install,
  uninstall,
  normalize,
  respond,
  capabilities: { ask: 'pre_tool', rewriteInput: false, rewriteOutput: false },
  HOOK_TIMEOUT_S,
  HOOK_TIMEOUT_MS,
  HOOK_STATUS,
  PRE_MATCHER,
  POST_MATCHER,
  EVENTS,
  configFile,
  hooksFile: configFile,
  hookGroups,
  commandText,
  configWarnings,
};
