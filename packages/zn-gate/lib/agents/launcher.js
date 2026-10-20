'use strict';

/**
 * Fail-closed launcher for agents whose hooks fail OPEN when the hook command
 * cannot start.
 *
 * `zn hooks install` used to write `<node> <runner.js> <agent>` with the
 * absolute path of the Node.js that ran the install. When that Node.js goes
 * away (nvm removes a version, an upgrade, a reinstall) the command exits 127
 * and the agent runs the call with no check. Codex documents only two ways to
 * block: a PreToolUse (or UserPromptSubmit) hook that exits with code 2 and
 * writes the reason to stderr, or one that prints a deny decision. Any other
 * failure "marks the hook run as failed, reports the error, and continues".
 *
 * So the hook command is now a small POSIX sh script owned by zn
 * (~/.zn/hooks/zn-hook-<agent>.sh, rewritten on every install):
 *  1. the Node.js and runner recorded at install time, if both still exist;
 *  2. else `zn hook <agent>` from the PATH of the hook (it needs `node` too);
 *  3. else it needs no Node.js at all: it blocks (exit 2 + reason on stderr,
 *     or the documented deny JSON for PermissionRequest) on the events where
 *     that is the documented way to block, and only warns (a systemMessage the
 *     user sees) on the others, where blocking would hide a tool result or loop
 *     the model.
 * The event name is the script's one argument, because without Node.js the
 * script cannot read it from stdin.
 *
 * Windows has no such script file: `commandWindows` is a PowerShell command
 * with the same three steps written inline (windowsCommand below).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../broker/files');
const { shQuote, portablePath } = require('../shell-quote');

// Events where exit 2 with a reason on stderr is the documented block.
const BLOCK_EXIT = new Set(['PreToolUse', 'UserPromptSubmit']);
// PermissionRequest blocks with a decision on stdout (exit 2 is not documented there).
const BLOCK_JSON = new Set(['PermissionRequest']);
// Claude Code: exit 2 blocks PreToolUse, UserPromptSubmit and UserPromptExpansion; PermissionRequest is not hooked.
// Every other event (PostToolUse) only warns: exit 2 there cannot undo the tool call.
// Cursor: exit code 2 blocks, "equivalent to returning permission: deny"; the events that can deny are listed (postToolUse only observes).
// Gemini CLI: exit 2 "aborts" the tool; zn registers BeforeTool only.
const BLOCK_EXIT_BY_AGENT = {
  'claude-code': new Set(['PreToolUse', 'UserPromptSubmit', 'UserPromptExpansion']),
  cursor: new Set(['beforeMCPExecution', 'beforeReadFile', 'beforeShellExecution', 'beforeSubmitPrompt', 'preToolUse']),
  gemini: new Set(['BeforeTool']),
};
const BLOCK_JSON_BY_AGENT = { 'claude-code': new Set(), cursor: new Set(), gemini: new Set() };
// Agents whose non-blocking events get the warning on stderr (exit 0) instead of a systemMessage on stdout.
const WARN_STDERR = new Set(['cursor']);
const blockExit = (agentId) => BLOCK_EXIT_BY_AGENT[agentId] || BLOCK_EXIT;
const blockJson = (agentId) => BLOCK_JSON_BY_AGENT[agentId] || BLOCK_JSON;

const FIX = 'run `npm install -g zn-gate` and then `zn hooks install codex` in your own terminal';

function reasonText(agentId) {
  return 'zn: its hook cannot start because the Node.js or the zn-gate files it was installed with are gone, so this was blocked. Ask the user to ' +
    FIX.replace('codex', agentId) + '.';
}

function warnText(agentId) {
  return 'zn is NOT protecting this session: its hook cannot start because the Node.js or the zn-gate files it was installed with are gone. Please ' +
    FIX.replace('codex', agentId) + '.';
}

/** Where zn keeps its launchers: ~/.zn/hooks (or $ZN_HOME/hooks). */
function launcherDir(opts = {}) {
  const env = opts.env || process.env;
  const base = env.ZN_HOME ? path.resolve(env.ZN_HOME) : path.join(opts.home || os.homedir(), '.zn');
  return path.join(base, 'hooks');
}

function launcherFile(agentId, opts = {}) {
  return path.join(launcherDir(opts), 'zn-hook-' + agentId + '.sh');
}

function checkAgentId(agentId) {
  if (!/^[a-z-]+$/.test(agentId)) throw new Error('zn: bad agent id ' + agentId);
  return agentId;
}

/** The text of the launcher script. */
function unixScript(agentId, nodePath, runnerPath) {
  checkAgentId(agentId);
  const reason = reasonText(agentId);
  const warn = warnText(agentId);
  const exitEvents = [...blockExit(agentId)];
  const jsonEvents = [...blockJson(agentId)];
  return [
    '#!/bin/sh',
    '# Written by `zn hooks install ' + agentId + '`; replaced on every install. Do not edit.',
    '# Runs the zn hook; if the Node.js or zn-gate it was installed with is gone, it blocks instead of letting the call run.',
    'ZN_EVENT="${1:-}"',
    'ZN_NODE=' + shQuote(nodePath),
    'ZN_RUNNER=' + shQuote(runnerPath),
    'if [ -x "$ZN_NODE" ] && [ -f "$ZN_RUNNER" ]; then exec "$ZN_NODE" "$ZN_RUNNER" ' + agentId + '; fi',
    'ZN_CMD=$(command -v zn 2>/dev/null)',
    'case "$ZN_CMD" in /*) ;; *) ZN_CMD= ;; esac',
    'if [ -n "$ZN_CMD" ] && command -v node >/dev/null 2>&1; then exec "$ZN_CMD" hook ' + agentId + '; fi',
    'case "$ZN_EVENT" in',
    '  ' + exitEvents.join('|') + ')',
    '    printf ' + shQuote('%s\\n') + ' ' + shQuote(reason) + ' >&2',
    '    exit 2 ;;',
    ...(jsonEvents.length ? [
      '  ' + jsonEvents.join('|') + ')',
      '    printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } })) + '',
      '    exit 0 ;;',
    ] : []),
    '  *)',
    WARN_STDERR.has(agentId)
      ? '    printf ' + shQuote('%s\\n') + ' ' + shQuote(warn) + ' >&2'
      : '    printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify({ systemMessage: warn })) + '',
    '    exit 0 ;;',
    'esac',
    '',
  ].join('\n');
}

/** Writes the launcher (directory 0700, file 0755) and returns its path. */
function writeLauncher(agentId, nodePath, runnerPath, opts = {}) {
  const file = launcherFile(agentId, opts);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(file, unixScript(agentId, nodePath, runnerPath), 0o755);
  try { fs.chmodSync(file, 0o755); } catch (_) { /* best effort */ }
  return file;
}

/** The hook command for one event: the launcher, then the event name. */
function launcherCommand(file, event, platform = process.platform) {
  return shQuote(portablePath(file, platform)) + ' ' + event;
}

/**
 * The PowerShell text (for windowsCommand-style quoting by the caller) of the
 * same three steps, ending with a comment that names the agent so that
 * isOurs() recognizes it. Null when a path holds a character that would need
 * escaping inside the script: the caller then keeps the plain command.
 */
function windowsScript(agentId, event, nodePath, runnerPath) {
  checkAgentId(agentId);
  const n = portablePath(nodePath, 'win32');
  const r = portablePath(runnerPath, 'win32');
  if (/['‘’‚‛\u0000-\u001f]/.test(n + r)) return null;
  const reason = reasonText(agentId);
  let tail;
  if (blockExit(agentId).has(event)) tail = "[Console]::Error.WriteLine('" + reason + "'); exit 2";
  else if (blockJson(agentId).has(event)) tail = "[Console]::Out.WriteLine('" + JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } }) + "'); exit 0";
  else if (WARN_STDERR.has(agentId)) tail = "[Console]::Error.WriteLine('" + warnText(agentId) + "'); exit 0";
  else tail = "[Console]::Out.WriteLine('" + JSON.stringify({ systemMessage: warnText(agentId) }) + "'); exit 0";
  return "if ((Test-Path -LiteralPath '" + n + "') -and (Test-Path -LiteralPath '" + r + "')) { & '" + n + "' '" + r + "' " + agentId + '; exit $LASTEXITCODE }; ' +
    "if ((Get-Command zn -ErrorAction SilentlyContinue) -and (Get-Command node -ErrorAction SilentlyContinue)) { & zn hook " + agentId + '; exit $LASTEXITCODE }; ' +
    tail + ' # zn hook ' + agentId;
}

/**
 * A powershell.exe call of the script, passed as -EncodedCommand (base64 of UTF-16LE): the script holds `$`, quotes and
 * backticks that cmd.exe, PowerShell or Git Bash would otherwise act on (the same encoding lib/shell-quote.js uses).
 */
function windowsScriptCommand(script) {
  return 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
}

module.exports = { blockExit, blockJson, windowsScriptCommand, launcherDir, launcherFile, unixScript, writeLauncher, launcherCommand, windowsScript, BLOCK_EXIT, BLOCK_JSON };
