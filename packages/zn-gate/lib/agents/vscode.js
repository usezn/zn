'use strict';

/**
 * VS Code agent hooks (GitHub Copilot agent mode, "Local" harness) adapter.
 * Experimental: the VS Code hooks feature is in Preview.
 *
 * Hook format (read 2026-10-18):
 *  - https://code.visualstudio.com/docs/agent-customization/hooks
 *  - https://code.visualstudio.com/docs/agents/reference/hooks-reference
 *
 *  Files: <workspace>/.github/hooks/*.json (project) and ~/.copilot/hooks/*.json (user).
 *    { "hooks": { "PreToolUse": [ { "type": "command", "command": "...",
 *                                    "windows": "...", "timeout": <seconds, default 30> } ] } }
 *  The entries are a flat list: no "matcher" and no nested "hooks" array
 *  (Claude Code's format nests them; VS Code ignores matchers in Claude-format files).
 *
 *  stdin: timestamp, cwd, session_id, hook_event_name, transcript_path, and for
 *    PreToolUse tool_name, tool_input, tool_use_id. Same key names as Claude Code.
 *  stdout: { hookSpecificOutput: { hookEventName: "PreToolUse",
 *    permissionDecision: allow|deny|ask, permissionDecisionReason, updatedInput,
 *    additionalContext } } (same as Claude Code). Several hooks: deny beats ask beats allow.
 *  Exit codes: 0 = stdout is processed, 2 = blocking error (stderr goes to the model),
 *    other = a warning and the action goes ahead (fail open).
 *
 * Not documented (so this adapter does not rely on it): the names of the Local
 * tools and the keys of their tool_input; how an MCP tool is named; whether
 * PostToolUse can rewrite output; UserPromptSubmit output. Because of that, zn
 * installs PreToolUse only, and recognises tools by name AND by the shape of
 * tool_input (a string "command" is a shell command), and it checks every file
 * path it can find in the input. A tool it cannot classify gets no opinion.
 *
 * Reuses the Claude Code adapter for the decision JSON: the output contract is the same.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config-file');
const claude = require('./claude-code');

const id = 'vscode';
const HOOK_FILE = 'zn-gate.json';
const HOOK_TIMEOUT_S = 15;
const EVENTS = ['PreToolUse'];

const SHELL_NAMES = new Set(['bash', 'runterminalcommand', 'runinterminal', 'terminal', 'shell', 'execute', 'runcommand', 'runcommandinterminal']);
const READ_NAMES = new Set(['read', 'readfile', 'readfiles', 'view', 'openfile']);
const WRITE_NAMES = new Set(['write', 'edit', 'editfiles', 'create', 'createfile', 'replacestringinfile', 'multireplacestringinfile', 'insertedit', 'applypatch', 'deletefile']);
const PATH_KEYS = ['file_path', 'filePath', 'path', 'filepath', 'uri', 'target_file'];

function key(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pathsOf(ti) {
  const out = [];
  const add = (v) => { if (typeof v === 'string' && v) out.push(v); };
  for (const k of PATH_KEYS) add(ti[k]);
  for (const k of ['files', 'filePaths', 'paths', 'uris']) {
    if (Array.isArray(ti[k])) ti[k].forEach((v) => add(v && typeof v === 'object' ? (v.path || v.filePath || v.uri) : v));
  }
  return out;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.hook_event_name !== 'PreToolUse') return { event: null, cwd: raw.cwd || process.cwd(), sessionId: raw.session_id || null, raw };
  const toolName = String(raw.tool_name || '');
  const ti = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
  const base = { event: 'pre_tool', cwd: raw.cwd || process.cwd(), sessionId: raw.session_id || null, raw, toolName };
  const k = key(toolName);
  const mcp = /^mcp[_.\-:]+(.+?)[_.\-:]+(.+)$/i.exec(toolName);
  if (mcp) return { ...base, tool: 'mcp', mcp: { server: mcp[1], tool: mcp[2] }, input: { args: ti, texts: [] } };
  if (k === 'powershell' || k === 'pwsh') return { ...base, tool: 'powershell', input: { command: typeof ti.command === 'string' ? ti.command : undefined, texts: [] } };
  if (SHELL_NAMES.has(k) || (!READ_NAMES.has(k) && !WRITE_NAMES.has(k) && typeof ti.command === 'string')) {
    return { ...base, tool: 'bash', input: { command: typeof ti.command === 'string' ? ti.command : '', texts: [] } };
  }
  const paths = pathsOf(ti);
  if (READ_NAMES.has(k)) return { ...base, tool: 'read', input: { path: paths[0], paths, texts: [] } };
  if (WRITE_NAMES.has(k)) return { ...base, tool: 'write', input: { path: paths[0], paths, texts: [] } };
  return { ...base, tool: k || 'unknown', input: { texts: [] } };
}

// Decision JSON: identical contract to Claude Code. Rewrites touch only "command"
// (the one key whose name is the same in both agents); text rewrites are not offered.
function respond(d) {
  if (!d || !d.event || d.event.event !== 'pre_tool') return null;
  const noText = d.updatedInput && typeof d.updatedInput.command !== 'string';
  return claude.respond(noText ? { ...d, updatedInput: undefined, decision: d.decision === 'deny' ? 'deny' : 'ask' } : d);
}

/* ------------------------ install / uninstall ---------------------- */

function hooksFile(opts = {}) {
  if ((opts.scope || 'user') === 'project') return path.join(path.resolve(opts.projectDir || process.cwd()), '.github', 'hooks', HOOK_FILE);
  return path.join(opts.home || os.homedir(), '.copilot', 'hooks', HOOK_FILE);
}

function strip(list) {
  return Array.isArray(list) ? list.filter((h) => !(h && cfg.isOurs(h.command, id))) : [];
}

function install(opts = {}) {
  const file = hooksFile(opts);
  const data = cfg.readJson(file);
  const report = { settings: file, backup: cfg.backup(file), warnings: [] };
  data.hooks = cfg.hooksOf(data, file);
  const entry = { type: 'command', command: cfg.hookCommand(id, opts), timeout: HOOK_TIMEOUT_S };
  if ((opts.scope || 'user') !== 'project' && !opts.command) entry.windows = cfg.hookCommandWindows(id, opts);
  for (const event of EVENTS) {
    data.hooks[event] = strip(data.hooks[event]);
    data.hooks[event].push(entry);
  }
  cfg.writeJson(file, data);
  report.warnings.push('VS Code agent hooks are in Preview. zn checks tool calls before they run (PreToolUse): it blocks reads and writes of secret files and shell commands that handle secrets. It cannot rewrite tool output in VS Code.');
  report.warnings.push('Hooks apply to the Local agent harness, not to Copilot cloud or CLI sessions. The setting chat.useHooks must be on, the workspace trusted, and the organization must not disable hooks.');
  report.warnings.push('A hook that fails or times out lets the action go ahead in VS Code (only exit code 2 blocks).');
  return report;
}

function uninstall(opts = {}) {
  const file = hooksFile(opts);
  const report = { settings: file, backup: null, removed: 0, warnings: [] };
  if (!fs.existsSync(file)) return report;
  const data = cfg.readJson(file);
  if (!data.hooks || typeof data.hooks !== 'object') return report;
  const before = JSON.stringify(data.hooks);
  for (const event of Object.keys(data.hooks)) {
    const kept = strip(data.hooks[event]);
    if (kept.length) data.hooks[event] = kept; else delete data.hooks[event];
  }
  if (JSON.stringify(data.hooks) === before) return report;
  report.backup = cfg.backup(file);
  report.removed = 1;
  if (Object.keys(data.hooks).length === 0 && Object.keys(data).every((k) => k === 'hooks')) fs.unlinkSync(file);
  else cfg.writeJson(file, data);
  return report;
}

function detect(opts = {}) {
  return fs.existsSync(path.join(opts.home || os.homedir(), '.copilot')) || fs.existsSync(path.join(opts.home || os.homedir(), '.vscode'));
}

module.exports = {
  id,
  detect,
  install,
  uninstall,
  normalize,
  respond,
  capabilities: { ask: 'shell', rewriteInput: 'command', rewriteOutput: false },
  EVENTS,
  hooksFile,
};
