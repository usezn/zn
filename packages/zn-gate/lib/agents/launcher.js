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
  // ZCode: exit code 2 blocks PreToolUse, PermissionRequest and UserPromptSubmit (docs: "Blocking shortcut"); any other failure only logs and the call runs.
  zcode: new Set(['PreToolUse', 'PermissionRequest', 'UserPromptSubmit']),
};
const BLOCK_JSON_BY_AGENT = { 'claude-code': new Set(), cursor: new Set(), gemini: new Set(), antigravity: new Set(), zcode: new Set() };
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

/** Where zn keeps its launchers: ~/.zn/hooks (or $ZN_HOME/hooks, or $ZN_HOOK_DIR itself). */
function launcherDir(opts = {}) {
  const env = opts.env || process.env;
  if (env.ZN_HOOK_DIR) return path.resolve(env.ZN_HOOK_DIR);
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
function unixScript(agentId, nodePath, runnerPath, opts = {}) {
  checkAgentId(agentId);
  // deadlineS (whole seconds, only for agents that fail open on a timeout): the launcher answers by itself when the hook has
  // not finished by then, so a hook stuck while it starts (before the runner arms its own watchdog) still blocks.
  const deadlineS = Number.isInteger(opts.deadlineS) && opts.deadlineS > 0 ? opts.deadlineS : 0;
  const run = (...w) => (deadlineS ? 'zn_run ' : '') + w.join(' ');
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
    ...(deadlineS ? [
      '# Runs a command with a deadline of ' + deadlineS + ' s: after that the command is killed (TERM, then KILL one second later; exit 143 or 137), which falls through to the block below.',
      '# The hook input (stdin) is passed on through fd 3 (a background command would otherwise get /dev/null); the timer holds no output, so it cannot keep the agent waiting.',
      'zn_run() {',
      '  # No timer, no deadline: then the hook is not run at all and the launcher blocks.',
      '  [ -x /bin/sleep ] || { ZN_RC=127; return 0; }',
      '  exec 3<&0',
      '  "$@" <&3 3<&- &',
      '  exec 3<&-',
      '  ZN_P=$!',
      '  # At the deadline the hook gets TERM; if it is still there one second later (it ignores TERM) it gets KILL. A timer that cannot sleep ends the hook too.',
      '  ( trap \'kill $ZN_SP 2>/dev/null; exit 0\' TERM; /bin/sleep ' + deadlineS + ' & ZN_SP=$!; wait $ZN_SP; kill -TERM $ZN_P 2>/dev/null; /bin/sleep 1 & ZN_SP=$!; wait $ZN_SP; kill -KILL $ZN_P 2>/dev/null ) >/dev/null 2>&1 </dev/null &',
      '  ZN_T=$!',
      '  wait $ZN_P; ZN_RC=$?',
      '  kill -TERM $ZN_T 2>/dev/null',
      '  return 0',
      '}',
    ] : []),
    'ZN_RAN=',
    'if [ -x "$ZN_NODE" ] && [ -f "$ZN_RUNNER" ]; then ZN_RAN=1; ' + (deadlineS ? run('"$ZN_NODE" "$ZN_RUNNER" ' + agentId) + '; ' : '"$ZN_NODE" "$ZN_RUNNER" ' + agentId + '; ZN_RC=$?; ') + 'case $ZN_RC in 0|2) exit $ZN_RC ;; esac; fi',
    '# Look up zn and node only in absolute PATH entries: a relative one depends on the folder the agent runs in.',
    'ZN_OLDIFS=$IFS; IFS=:; ZN_SAFE=',
    'for ZN_D in $PATH; do case "$ZN_D" in /*) ZN_SAFE="${ZN_SAFE:+$ZN_SAFE:}$ZN_D" ;; esac; done',
    'IFS=$ZN_OLDIFS',
    'ZN_CMD=; [ -z "$ZN_SAFE" ] || ZN_CMD=$(PATH="$ZN_SAFE" command -v zn 2>/dev/null)',
    'case "$ZN_CMD" in /*) ;; *) ZN_CMD= ;; esac',
    'if [ -z "$ZN_RAN" ] && [ -n "$ZN_CMD" ] && PATH="$ZN_SAFE" command -v node >/dev/null 2>&1; then ZN_RAN=1; ' + (deadlineS ? run('"$ZN_CMD" hook ' + agentId) + '; ' : '"$ZN_CMD" hook ' + agentId + '; ZN_RC=$?; ') + 'case $ZN_RC in 0|2) exit $ZN_RC ;; esac; fi',
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
  // ZN_HOOK_DIR names any folder: the launcher in it runs on every tool call, so the folder must be ours and private.
  if ((opts.env || process.env).ZN_HOOK_DIR) ensureSafeHookDir(dir, opts.platform || process.platform, { trustedRoot: opts.hookDirTrustedRoot });
  else fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // On Windows the script runs in Git Bash: write the paths with / so that `zn-gate check` can read them back.
  const platform = opts.platform || process.platform;
  writeFileAtomic(file, unixScript(agentId, portablePath(nodePath, platform), portablePath(runnerPath, platform), { deadlineS: opts.deadlineS }), 0o755);
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
  try {
    if (typeof command !== 'string') return false;
    if (command === projectShCommand(agentId)) return true;
    // A later zn-gate may word the deny differently: recognize the guard by its structure (start and the hook call).
    return command.startsWith('sh -c :;Z=$(' + ['command', '-v', 'zn'].join(IFS) + ')') && command.includes(IFS + 'hook' + IFS + agentId + ';');
  } catch (_) { return false; }
}

/** Whether a command is a Windows project hook script of this agent (the readable PowerShell text). */
function isProjectWindowsScript(script, agentId) {
  try {
    if (typeof script !== 'string') return false;
    if (script === projectWindowsScript(agentId)) return true;
    return script.startsWith("$ProgressPreference='SilentlyContinue'; $zt=0; ") && script.includes('& zn.cmd hook ' + agentId + ';') && script.endsWith('# zn hook ' + agentId);
  } catch (_) { return false; }
}

/** Whether a path can be written into a command with no quotes: only letters, digits and a few punctuation marks. */
function plainPathOk(file) {
  return /^[A-Za-z0-9_\/.@+=,:~-]+$/.test(String(file));
}

/** Why zn will not use a folder for the launchers (ZN_HOOK_DIR), and the way out. */
function unsafeDirMessage(dir, why) {
  return 'zn will not keep its hook launcher in ' + dir + ': ' + why + '. The launcher runs on every tool call, so anyone who can replace it could run commands as you. ' +
    'Use a folder that you own, whose path has no link, and where every folder above it belongs to you or to root and cannot be written by anyone else ' +
    '(/tmp and shared folders do not qualify, even with the sticky bit). For example `sudo mkdir -m 700 /opt/<you>-zn-hooks && sudo chown <you> /opt/<you>-zn-hooks`, ' +
    'or unset ZN_HOOK_DIR to use ~/.zn/hooks.';
}

/**
 * Checks one folder of the chain that leads to the launcher folder: a folder that exists, owned by root or the current
 * user, with no write for group or others (no exception for the sticky bit: /tmp itself fails). Throws a plain error otherwise.
 */
function checkAncestor(dir, leaf) {
  const st = fs.lstatSync(dir);
  if (leaf) {
    if (st.isSymbolicLink()) throw new Error(unsafeDirMessage(dir, 'it is a link'));
    if (!st.isDirectory()) throw new Error(unsafeDirMessage(dir, 'it is not a folder'));
  }
  const me = typeof process.getuid === 'function' ? process.getuid() : null;
  if (me !== null && st.uid !== me && !(!leaf && st.uid === 0)) throw new Error(unsafeDirMessage(dir, leaf ? 'it belongs to another user' : 'a folder above it (' + dir + ') belongs to another user'));
  if ((st.mode & 0o022) !== 0) {
    throw new Error(unsafeDirMessage(dir, leaf ? 'other users can write to it (mode ' + (st.mode & 0o777).toString(8) + ')' : 'a folder above it (' + dir + ') can be written by other users (mode ' + (st.mode & 0o777).toString(8) + ')'));
  }
}

/**
 * Checks the whole chain from `start` (a folder that exists) up to /: no link anywhere in the path (the real path must be
 * the path itself) and every folder trusted (checkAncestor). `trustedRoot` is internal and only for tests: the walk stops
 * before that folder, because the test folders live under the system temp folder, which is shared by design. Production
 * never passes it.
 */
function checkChain(start, trustedRoot, leafPath) {
  const real = fs.realpathSync(start);
  if (real !== start) throw new Error(unsafeDirMessage(start, 'a link is in its path (it leads to ' + real + ')'));
  let p = start;
  for (;;) {
    if (trustedRoot && p === trustedRoot) return;
    checkAncestor(p, p === leafPath);
    const up = path.dirname(p);
    if (up === p) return;
    p = up;
  }
}

/**
 * Makes sure the folder that holds the launchers can be trusted. Nothing is created or written until the whole chain is
 * checked: the folder (or its nearest existing parent) must be a real folder with no link anywhere in its path, and it and
 * every folder above it up to / must belong to the current user or root and have no write for group or others. The sticky
 * bit is no excuse, so /tmp and a folder under it are refused: they can be emptied or replaced by someone else, while the
 * hook command keeps pointing at the old path. Creates the folder (0700) when it is missing. Throws a plain error
 * otherwise. On Windows there is no uid or mode to check (the same rule as the vault and the compile cache): it only
 * has to be a real folder, and the user profile's ACLs apply.
 */
function ensureSafeHookDir(dir, platform = process.platform, opts = {}) {
  if (platform === 'win32') {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) throw new Error(unsafeDirMessage(dir, 'it is a link'));
    if (!st.isDirectory()) throw new Error(unsafeDirMessage(dir, 'it is not a folder'));
    return;
  }
  const abs = path.resolve(dir);
  const trusted = opts.trustedRoot ? path.resolve(opts.trustedRoot) : null;
  let existing = abs;
  while (!fs.existsSync(existing) && !isLink(existing)) existing = path.dirname(existing);
  if (isLink(abs)) throw new Error(unsafeDirMessage(dir, 'it is a link'));
  checkChain(existing, trusted, abs);
  fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
  checkChain(abs, trusted, abs);
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
}

/** Why zn will not install the Antigravity hook at this launcher path, and the way out. */
function spaceMessage(file) {
  return 'zn cannot install the Antigravity hook: the launcher would be at ' + file + ', and Antigravity starts a hook by splitting the command on spaces, ' +
    'without a shell or quotes, so a path with a space or another special character never starts, so the hook would protect nothing. ' +
    'Choose a folder outside the home folder whose path has only letters, digits and - _ . / (for example `sudo mkdir -m 700 /opt/<you>-zn-hooks && sudo chown <you> /opt/<you>-zn-hooks`, ' +
    'or a folder under $XDG_DATA_HOME if that path has no space), run `ZN_HOOK_DIR=<that folder> zn hooks install antigravity`, and nothing else changes. ' +
    'The folder must be one you own, with no link in its path, and every folder above it must belong to you or to root and not be writable by others: zn-gate refuses anything else, because the launcher in it runs on every tool call.';
}

/**
 * The PowerShell text (for windowsCommand-style quoting by the caller) of the
 * same three steps, ending with a comment that names the agent so that
 * isOurs() recognizes it. Null when a path holds a character that would need
 * escaping inside the script: the caller then keeps the plain command.
 */
function windowsScript(agentId, event, nodePath, runnerPath, opts = {}) {
  checkAgentId(agentId);
  // deadlineS (whole seconds, only for agents that fail open on a timeout, as in unixScript): the hook runs as a child with a deadline.
  const deadlineS = Number.isInteger(opts.deadlineS) && opts.deadlineS > 0 ? opts.deadlineS : 0;
  const n = portablePath(nodePath, 'win32');
  const r = portablePath(runnerPath, 'win32');
  if (/['‘’‚‛\u0000-\u001f]/.test(n + r)) return null;
  const reason = reasonText(agentId);
  const DENY_JSON = {
    antigravity: (r) => ({ decision: 'deny', reason: r }),
    cursor: (r) => ({ permission: 'deny', continue: false, user_message: r, agent_message: r }),
    gemini: (r) => ({ decision: 'deny', reason: r }),
  };
  const jsonDeny = Boolean(DENY_JSON[agentId]);
  // The block text (the Node.js is gone) or, when the hook ran and failed or timed out, the crash text.
  const tailOf = (reason, warn) => {
  let tail;
  // A PowerShell inside the agent's own PowerShell (Cursor) turns a nested exit 2 into 1, and both Cursor and
  // Gemini CLI read the deny JSON only with exit 0. So for them a block is the deny JSON plus exit 0; the
  // runner's own refusal (exit 2, deny JSON already on stdout) is passed on as exit 0 too.
  if (blockExit(agentId).has(event)) {
    tail = jsonDeny
      ? "[Console]::Out.WriteLine('" + JSON.stringify(DENY_JSON[agentId](reason)) + "'); [Console]::Error.WriteLine('" + reason + "'); exit 0"
      : "[Console]::Error.WriteLine('" + reason + "'); exit 2";
  }
  else if (blockJson(agentId).has(event)) tail = "[Console]::Out.WriteLine('" + JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason } } }) + "'); exit 0";
  else if (WARN_STDERR.has(agentId)) tail = "[Console]::Error.WriteLine('" + warn + "'); exit 0";
  else tail = "[Console]::Out.WriteLine('" + JSON.stringify({ systemMessage: warn }) + "'); exit 0";
  return tail;
  };
  const tail = tailOf(reason, warnText(agentId));
  // Only 0 (done) and 2 (blocked) leave early: a crash, an empty $LASTEXITCODE (a script the execution policy
  // refused) or any other code falls through to the block. zn.cmd, not zn.ps1, which Restricted refuses to run.
  const leave = jsonDeny
    ? 'if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 2) { exit 0 }'
    : 'if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 2) { exit $LASTEXITCODE }';
  if (deadlineS) {
    // zr runs the command as a child with the hook input passed on (stdin) and its output left alone; after the deadline the
    // child and everything it started are killed (taskkill /T) and zr gives -1, which falls through to the block below.
    const zr = 'function zr($f, $a) { $rc = -1; try { $i = New-Object System.Diagnostics.ProcessStartInfo; $i.FileName = $f; $i.Arguments = $a; $i.UseShellExecute = $false; ' +
      '$i.RedirectStandardInput = $true; $sw = [System.Diagnostics.Stopwatch]::StartNew(); $p = [System.Diagnostics.Process]::Start($i); ' +
      'try { $c = [Console]::OpenStandardInput().CopyToAsync($p.StandardInput.BaseStream); [void]$c.Wait(' + deadlineS * 1000 + ') } catch {}; ' +
      'try { $p.StandardInput.Close() } catch {}; ' +
      '$left = [Math]::Max(0, ' + deadlineS * 1000 + ' - $sw.ElapsedMilliseconds); ' +
      'if ($p.WaitForExit([int]$left)) { $rc = $p.ExitCode } else { try { & "$env:SystemRoot\\System32\\taskkill.exe" /PID $p.Id /T /F *> $null } catch {}; try { $p.Kill() } catch {} } } catch {}; return $rc }; ';
    const zleave = jsonDeny
      ? 'if ($rc -eq 0 -or $rc -eq 2) { exit 0 }'
      : 'if ($rc -eq 0 -or $rc -eq 2) { exit $rc }';
    return "$ProgressPreference='SilentlyContinue'; $zt=0; " + zr +
      "if ((Test-Path -LiteralPath '" + n + "') -and (Test-Path -LiteralPath '" + r + "')) { $zt=1; $rc = zr '\"" + n + "\"' '\"" + r + "\" " + agentId + "'; " + zleave + ' }; ' +
      "if (($zt -eq 0) -and (Get-Command zn.cmd -CommandType Application -ErrorAction SilentlyContinue) -and (Get-Command node -ErrorAction SilentlyContinue)) { $zt=1; $rc = zr (Get-Command zn.cmd -CommandType Application).Source 'hook " + agentId + "'; " + zleave + ' }; ' +
      'if ($zt -eq 1) { ' + tailOf(crashText(agentId), crashWarnText()) + ' }; ' + tail + ' # zn hook ' + agentId;
  }
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

module.exports = { projectShCommand, projectWindowsScript, isProjectGuard, isProjectWindowsScript, blockExit, blockJson, windowsScriptCommand, launcherDir, launcherFile, unixScript, writeLauncher, launcherCommand, plainPathOk, spaceMessage, unsafeDirMessage, ensureSafeHookDir, windowsScript, BLOCK_EXIT, BLOCK_JSON };
