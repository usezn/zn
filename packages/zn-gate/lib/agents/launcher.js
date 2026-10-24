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
function unixScript(agentId, nodePath, runnerPath) {
  checkAgentId(agentId);
  const reason = reasonText(agentId);
  const warn = warnText(agentId);
  const exitEvents = [...blockExit(agentId)];
  const jsonEvents = [...blockJson(agentId)];
  const crash = crashText(agentId);
  const crashWarn = crashWarnText();
  const pick = (ifRan, ifGone) => 'if [ -n "$ZN_RAN" ]; then ' + ifRan + '; else ' + ifGone + '; fi';
  const deny = (r) => 'printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: r } } }));
  return [
    '#!/bin/sh',
    '# Written by `zn hooks install ' + agentId + '`; replaced on every install. Do not edit.',
    '# Runs the zn hook; if the Node.js or zn-gate it was installed with is gone, it blocks instead of letting the call run.',
    'ZN_EVENT="${1:-}"',
    'ZN_NODE=' + shQuote(nodePath),
    'ZN_RUNNER=' + shQuote(runnerPath),
    '# Exit codes other than 0 (done) and 2 (blocked) are failures: they fall through to the block below.',
    'ZN_RAN=',
    'if [ -x "$ZN_NODE" ] && [ -f "$ZN_RUNNER" ]; then ZN_RAN=1; "$ZN_NODE" "$ZN_RUNNER" ' + agentId + '; ZN_RC=$?; case $ZN_RC in 0|2) exit $ZN_RC ;; esac; fi',
    '# Look up zn and node only in absolute PATH entries: a relative one depends on the folder the agent runs in.',
    'ZN_OLDIFS=$IFS; IFS=:; ZN_SAFE=',
    'for ZN_D in $PATH; do case "$ZN_D" in /*) ZN_SAFE="${ZN_SAFE:+$ZN_SAFE:}$ZN_D" ;; esac; done',
    'IFS=$ZN_OLDIFS',
    'ZN_CMD=; [ -z "$ZN_SAFE" ] || ZN_CMD=$(PATH="$ZN_SAFE" command -v zn 2>/dev/null)',
    'case "$ZN_CMD" in /*) ;; *) ZN_CMD= ;; esac',
    'if [ -z "$ZN_RAN" ] && [ -n "$ZN_CMD" ] && PATH="$ZN_SAFE" command -v node >/dev/null 2>&1; then ZN_RAN=1; "$ZN_CMD" hook ' + agentId + '; ZN_RC=$?; case $ZN_RC in 0|2) exit $ZN_RC ;; esac; fi',
    'case "$ZN_EVENT" in',
    '  ' + exitEvents.join('|') + ')',
    DENY_STDOUT[agentId]
      ? '    ' + pick('printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify(DENY_STDOUT[agentId](crash))), 'printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify(DENY_STDOUT[agentId](reason))))
      : '    ' + pick('printf ' + shQuote('%s\\n') + ' ' + shQuote(crash) + ' >&2', 'printf ' + shQuote('%s\\n') + ' ' + shQuote(reason) + ' >&2'),
    DENY_STDOUT[agentId] ? '    exit 0 ;;' : '    exit 2 ;;',
    ...(jsonEvents.length ? [
      '  ' + jsonEvents.join('|') + ')',
      '    ' + pick(deny(crash), deny(reason)),
      '    exit 0 ;;',
    ] : []),
    '  *)',
    WARN_STDERR.has(agentId)
      ? '    ' + pick('printf ' + shQuote('%s\\n') + ' ' + shQuote(crashWarn) + ' >&2', 'printf ' + shQuote('%s\\n') + ' ' + shQuote(warn) + ' >&2')
      : '    ' + pick('printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify({ systemMessage: crashWarn })), 'printf ' + shQuote('%s\\n') + ' ' + shQuote(JSON.stringify({ systemMessage: warn }))),
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

/*
 * The hook command of a project install for an agent that reads a deny JSON on stdout and runs the command split on
 * spaces with no shell (Antigravity). A project file is shared through the repository, so it cannot name this
 * machine's launcher: it names `zn` on the PATH, and a `zn` or `node` that is missing must still end in a deny with
 * the repair step, where a plain `zn hook <agent>` would be exit 127 with no text from zn.
 *
 * The command is `sh -c <script>` with a script that holds no space, quote-free of anything the split could break:
 * each space is the expansion ${IFS} (field splitting turns it back into spaces) and each space inside the JSON text
 * is the printf escape \040. Only simple commands joined by ; && || are used, because a compound command
 * (if, case) is told apart by real whitespace. Steps: the first `zn` and `node` found on the PATH (`zn` must be an
 * absolute path: a relative PATH entry depends on the folder the agent runs in); run `zn hook <agent>`; its exit
 * code 0 (an answer) or 2 (its own refusal, deny JSON already printed) ends it; anything else, or no zn or node, prints
 * the deny JSON and exits 0, the way the user launcher does.
 */
const IFS = '${IFS}';
const SH_SAFE_TEXT = /^[^'"\\%$\n\r]+$/;

function projectTexts(agentId) {
  const missing = 'zn: its hook cannot start because zn or Node.js was not found on the PATH, so this was blocked. Ask the user to run `npm install -g zn-gate` in their terminal.';
  const crash = crashText(agentId);
  for (const t of [missing, crash]) if (!SH_SAFE_TEXT.test(t)) throw new Error('zn: unsafe text in the project hook');
  return { missing, crash };
}

/** The POSIX project hook command (see above), or throws for an agent without a deny JSON answer. */
function projectShCommand(agentId) {
  checkAgentId(agentId);
  if (!DENY_STDOUT[agentId]) throw new Error('zn: no project guard for ' + agentId);
  const t = projectTexts(agentId);
  const sp = (...w) => w.join(IFS);
  const say = (r) => sp("printf", "'" + JSON.stringify(DENY_STDOUT[agentId](r)).replace(/ /g, '\\040') + "\\n'");
  const test = (...w) => '[' + IFS + w.join(IFS) + IFS + ']';
  const script = [
    ':',
    'Z=$(' + sp('command', '-v', 'zn') + ')',
    'N=$(' + sp('command', '-v', 'node') + ')',
    'R=missing',
    test('-n', '"$N"') + '&&' + test('"${Z#/}"', '!=', '"$Z"') + '&&R=ran&&"$Z"' + IFS + 'hook' + IFS + agentId,
    'C=$?',
    test('"$R"', '=', 'ran') + '&&' + test('"$C"', '=', '0') + '&&' + sp('exit', '0'),
    test('"$R"', '=', 'ran') + '&&' + test('"$C"', '=', '2') + '&&' + sp('exit', '2'),
    test('"$R"', '=', 'ran') + '&&' + say(t.crash) + '||' + say(t.missing),
    sp('exit', '0'),
  ].join(';');
  if (/\s/.test(script)) throw new Error('zn: the project hook script holds a space');
  return 'sh -c ' + script;
}

/** The PowerShell text of the same project hook (for windowsScriptCommand). Ends with the comment that isOurs() reads. */
function projectWindowsScript(agentId) {
  checkAgentId(agentId);
  if (!DENY_STDOUT[agentId]) throw new Error('zn: no project guard for ' + agentId);
  const t = projectTexts(agentId);
  const say = (r) => "[Console]::Out.WriteLine('" + JSON.stringify(DENY_STDOUT[agentId](r)) + "')";
  const leave = 'if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 2) { exit 0 }';
  return "$ProgressPreference='SilentlyContinue'; $zt=0; " +
    "if ((Get-Command zn.cmd -CommandType Application -ErrorAction SilentlyContinue) -and (Get-Command node -ErrorAction SilentlyContinue)) { $zt=1; & zn.cmd hook " + agentId + '; ' + leave + ' }; ' +
    'if ($zt -eq 1) { ' + say(t.crash) + ' } else { ' + say(t.missing) + ' }; exit 0 # zn hook ' + agentId;
}

/** Whether a command is the POSIX project hook of this agent as written by projectShCommand. */
function isProjectGuard(command, agentId) {
  try { return typeof command === 'string' && command === projectShCommand(agentId); } catch (_) { return false; }
}

/** Whether a command is a Windows project hook script of this agent (the readable PowerShell text). */
function isProjectWindowsScript(script, agentId) {
  try { return typeof script === 'string' && script === projectWindowsScript(agentId); } catch (_) { return false; }
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

module.exports = { projectShCommand, projectWindowsScript, isProjectGuard, isProjectWindowsScript, blockExit, blockJson, windowsScriptCommand, launcherDir, launcherFile, unixScript, writeLauncher, launcherCommand, plainPathOk, windowsScript, BLOCK_EXIT, BLOCK_JSON };
