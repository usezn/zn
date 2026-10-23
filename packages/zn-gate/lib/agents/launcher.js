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
 *  1. the Node.js and runner recorded at install time, if both still exist and
 *     the runner still has the SHA-256 recorded at install time (a runner that
 *     was edited, replaced or updated is NOT run: that counts as gone, with its
 *     own reason telling the user to run `zn hooks install` again);
 *  2. else (nothing is run from the PATH: an unverified `zn` could be anything)
 *     it needs no Node.js at all: it blocks (exit 2 + reason on stderr,
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

const crypto = require('crypto');
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
  // Antigravity: the hook answers with {decision:'deny',reason} on stdout (exit 0); its docs do not say what a failed hook does.
  antigravity: new Set(['PreToolUse']),
};
const BLOCK_JSON_BY_AGENT = { 'claude-code': new Set(), cursor: new Set(), gemini: new Set(), antigravity: new Set() };
// Agents that read a block from a deny JSON on stdout with exit 0 (not from exit code 2).
const DENY_STDOUT = {
  antigravity: (r) => ({ decision: 'deny', reason: r }),
};
// Agents whose non-blocking events get the warning on stderr (exit 0) instead of a systemMessage on stdout.
const WARN_STDERR = new Set(['cursor']);
const blockExit = (agentId) => BLOCK_EXIT_BY_AGENT[agentId] || BLOCK_EXIT;
const blockJson = (agentId) => BLOCK_JSON_BY_AGENT[agentId] || BLOCK_JSON;

const FIX = 'run `npm install -g zn-gate` and then `zn hooks install codex` in your own terminal';

function reasonText(agentId) {
  return 'zn: its hook cannot start because the Node.js or the zn-gate files it was installed with are gone, so this was blocked. Ask the user to ' +
    FIX.replace('codex', agentId).replace('in your own terminal', 'in their terminal') + '.';
}

function changedText(agentId) {
  return 'zn: its hook was blocked because zn-gate changed since the hooks were installed (or its files could not be checked), so zn will not run them. Ask the user to run `zn hooks install ' + agentId + '` again in their terminal.';
}

function changedWarnText(agentId) {
  return 'zn is NOT protecting this session: zn-gate changed since the hooks were installed (or its files could not be checked). Please run `zn hooks install ' + agentId + '` again in your own terminal.';
}

/** SHA-256 (hex) of the runner file, or '' when it cannot be read. */
function runnerSha(runnerPath) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex'); } catch (_) { return ''; }
}

function crashText(agentId) {
  return 'zn: its hook failed, so this was blocked. Ask the user to run `zn-gate check` in their terminal to see why.';
}

function crashWarnText() {
  return 'zn is NOT protecting this session: its hook failed. Please run `zn-gate check` in your own terminal to see why.';
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
function unixScript(agentId, nodePath, runnerPath, runnerDigest) {
  checkAgentId(agentId);
  const sha = runnerDigest === undefined ? runnerSha(runnerPath) : runnerDigest;
  if (!/^[0-9a-f]*$/.test(sha)) throw new Error('zn: bad runner digest');
  const reason = reasonText(agentId);
  const warn = warnText(agentId);
  const changed = changedText(agentId);
  const changedWarn = changedWarnText(agentId);
  const exitEvents = [...blockExit(agentId)];
  const jsonEvents = [...blockJson(agentId)];
  const crash = crashText(agentId);
  const crashWarn = crashWarnText();
  const pick = (ifRan, ifGone, ifChanged) => 'if [ -n "$ZN_RAN" ]; then ' + ifRan + '; elif [ -n "$ZN_CHANGED" ]; then ' + ifChanged + '; else ' + ifGone + '; fi';
  const deny = (r) => 'printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: r } } }));
  return [
    '#!/bin/sh',
    '# Written by `zn hooks install ' + agentId + '`; replaced on every install. Do not edit.',
    '# Runs the zn hook; if the Node.js or zn-gate it was installed with is gone, it blocks instead of letting the call run.',
    'ZN_EVENT="${1:-}"',
    'ZN_NODE=' + shQuote(nodePath),
    'ZN_RUNNER=' + shQuote(runnerPath),
    'ZN_SHA=' + shQuote(sha),
    '# Exit codes other than 0 (done) and 2 (blocked) are failures: they fall through to the block below.',
    'ZN_RAN=; ZN_CHANGED=',
    '# Tools are looked up only in absolute PATH entries: a relative one depends on the folder the agent runs in.',
    'ZN_OLDIFS=$IFS; IFS=:; ZN_SAFE=',
    'for ZN_D in $PATH; do case "$ZN_D" in /*) ZN_SAFE="${ZN_SAFE:+$ZN_SAFE:}$ZN_D" ;; esac; done',
    'IFS=$ZN_OLDIFS',
    '# The runner is run only if its SHA-256 is the one recorded at install time. No hash tool, or another digest, means "changed".',
    'if [ -x "$ZN_NODE" ] && [ -f "$ZN_RUNNER" ]; then',
    '  ZN_GOT=',
    '  if PATH="$ZN_SAFE" command -v sha256sum >/dev/null 2>&1; then ZN_GOT=$(PATH="$ZN_SAFE" sha256sum <"$ZN_RUNNER" 2>/dev/null); ZN_GOT=${ZN_GOT%% *}',
    '  elif PATH="$ZN_SAFE" command -v shasum >/dev/null 2>&1; then ZN_GOT=$(PATH="$ZN_SAFE" shasum -a 256 <"$ZN_RUNNER" 2>/dev/null); ZN_GOT=${ZN_GOT%% *}',
    '  elif PATH="$ZN_SAFE" command -v openssl >/dev/null 2>&1; then ZN_GOT=$(PATH="$ZN_SAFE" openssl dgst -sha256 <"$ZN_RUNNER" 2>/dev/null); ZN_GOT=${ZN_GOT##* }',
    '  fi',
    '  if [ -n "$ZN_SHA" ] && [ "$ZN_GOT" = "$ZN_SHA" ]; then',
    '    ZN_RAN=1; "$ZN_NODE" "$ZN_RUNNER" ' + agentId + '; ZN_RC=$?; case $ZN_RC in 0|2) exit $ZN_RC ;; esac',
    '  else ZN_CHANGED=1; fi',
    'fi',
    'case "$ZN_EVENT" in',
    '  ' + exitEvents.join('|') + ')',
    DENY_STDOUT[agentId]
      ? '    ' + pick('printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify(DENY_STDOUT[agentId](crash))), 'printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify(DENY_STDOUT[agentId](reason))), 'printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify(DENY_STDOUT[agentId](changed))))
      : '    ' + pick('printf ' + shQuote('%s\\n') + ' ' + shQuote(crash) + ' >&2', 'printf ' + shQuote('%s\\n') + ' ' + shQuote(reason) + ' >&2', 'printf ' + shQuote('%s\\n') + ' ' + shQuote(changed) + ' >&2'),
    DENY_STDOUT[agentId] ? '    exit 0 ;;' : '    exit 2 ;;',
    ...(jsonEvents.length ? [
      '  ' + jsonEvents.join('|') + ')',
      '    ' + pick(deny(crash), deny(reason), deny(changed)),
      '    exit 0 ;;',
    ] : []),
    '  *)',
    WARN_STDERR.has(agentId)
      ? '    ' + pick('printf ' + shQuote('%s\\n') + ' ' + shQuote(crashWarn) + ' >&2', 'printf ' + shQuote('%s\\n') + ' ' + shQuote(warn) + ' >&2', 'printf ' + shQuote('%s\\n') + ' ' + shQuote(changedWarn) + ' >&2')
      : '    ' + pick('printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify({ systemMessage: crashWarn })), 'printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify({ systemMessage: warn })), 'printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify({ systemMessage: changedWarn }))),
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
  // On Windows the script runs in Git Bash: write the paths with / so that `zn-gate check` can read them back.
  const platform = opts.platform || process.platform;
  writeFileAtomic(file, unixScript(agentId, portablePath(nodePath, platform), portablePath(runnerPath, platform)), 0o755);
  try { fs.chmodSync(file, 0o755); } catch (_) { /* best effort */ }
  return file;
}

/** The hook command for one event: the launcher, then the event name. */
function launcherCommand(file, event, platform = process.platform, opts = {}) {
  // `plain`: no quotes, for an agent that splits the command on spaces and runs it with no shell (Antigravity).
  // The caller has checked that the path needs no quoting (see plainPathOk).
  if (opts.plain) return portablePath(file, platform) + ' ' + event;
  return shQuote(portablePath(file, platform)) + ' ' + event;
}

/** Whether a path can be written into a command with no quotes: only letters, digits and a few punctuation marks. */
function plainPathOk(file) {
  return /^[A-Za-z0-9_\/.@+=,:~-]+$/.test(String(file));
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
  const DENY_JSON = {
    antigravity: (r) => ({ decision: 'deny', reason: r }),
    cursor: (r) => ({ permission: 'deny', continue: false, user_message: r, agent_message: r }),
    gemini: (r) => ({ decision: 'deny', reason: r }),
  };
  let tail;
  // A PowerShell inside the agent's own PowerShell (Cursor) turns a nested exit 2 into 1, and both Cursor and
  // Gemini CLI read the deny JSON only with exit 0. So for them a block is the deny JSON plus exit 0; the
  // runner's own refusal (exit 2, deny JSON already on stdout) is passed on as exit 0 too.
  const jsonDeny = Boolean(DENY_JSON[agentId]);
  if (blockExit(agentId).has(event)) {
    tail = jsonDeny
      ? "[Console]::Out.WriteLine('" + JSON.stringify(DENY_JSON[agentId](reason)) + "'); [Console]::Error.WriteLine('" + reason + "'); exit 0"
      : "[Console]::Error.WriteLine('" + reason + "'); exit 2";
  }
  else if (blockJson(agentId).has(event)) tail = "[Console]::Out.WriteLine('" + JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } }) + "'); exit 0";
  else if (WARN_STDERR.has(agentId)) tail = "[Console]::Error.WriteLine('" + warnText(agentId) + "'); exit 0";
  else tail = "[Console]::Out.WriteLine('" + JSON.stringify({ systemMessage: warnText(agentId) }) + "'); exit 0";
  // Only 0 (done) and 2 (blocked) leave early: a crash, an empty $LASTEXITCODE (a script the execution policy
  // refused) or any other code falls through to the block. zn.cmd, not zn.ps1, which Restricted refuses to run.
  const leave = jsonDeny
    ? 'if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 2) { exit 0 }'
    : 'if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 2) { exit $LASTEXITCODE }';
  return "$ProgressPreference='SilentlyContinue'; $zt=0; " +
    "if ((Test-Path -LiteralPath '" + n + "') -and (Test-Path -LiteralPath '" + r + "')) { $zt=1; & '" + n + "' '" + r + "' " + agentId + '; ' + leave + ' }; ' +
    "if (($zt -eq 0) -and (Get-Command zn.cmd -CommandType Application -ErrorAction SilentlyContinue) -and (Get-Command node -ErrorAction SilentlyContinue)) { & zn.cmd hook " + agentId + '; ' + leave + ' }; ' +
    tail + ' # zn hook ' + agentId;
}

/**
 * A powershell.exe call of the script, passed as -EncodedCommand (base64 of UTF-16LE): the script holds `$`, quotes and
 * backticks that cmd.exe, PowerShell or Git Bash would otherwise act on (the same encoding lib/shell-quote.js uses).
 */
function windowsScriptCommand(script) {
  return 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
}

module.exports = { runnerSha, blockExit, blockJson, windowsScriptCommand, launcherDir, launcherFile, unixScript, writeLauncher, launcherCommand, plainPathOk, windowsScript, BLOCK_EXIT, BLOCK_JSON };
