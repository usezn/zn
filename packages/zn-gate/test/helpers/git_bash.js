'use strict';
/*
 * Running the sh scripts of zn-gate on Windows. The launchers and the quoted commands are POSIX sh: on Windows they
 * run in Git Bash (what Claude Code uses there). Git Bash is found the way the product finds it (check.js gitBash:
 * CLAUDE_CODE_GIT_BASH_PATH, else the bin\bash.exe of the Git for Windows whose git is on the PATH), so a test that
 * needs sh is skipped only when there is no Git Bash, not because the platform is Windows.
 */

const fs = require('fs');
const path = require('path');

const WIN = process.platform === 'win32';

let cached;
/** The Git Bash executable on Windows, or null (never looked up on other systems). */
function gitBashExe() {
  if (!WIN) return null;
  if (cached === undefined) {
    try { cached = require('../../lib/check')._internal.gitBash(process.env) || null; } catch (_) { cached = null; }
  }
  return cached;
}

/** A POSIX shell for the tests: /bin/sh outside Windows; on Windows the sh or bash of Git Bash (or null: no Git Bash). */
function shellFor(name = 'sh') {
  if (!WIN) return name === 'sh' && fs.existsSync('/bin/sh') ? '/bin/sh' : name;
  const bash = gitBashExe();
  if (!bash) return null;
  if (name === 'bash') return bash;
  const sibling = path.join(path.dirname(bash), 'sh.exe');
  return fs.existsSync(sibling) ? sibling : bash;
}

/** The POSIX sh the launcher tests run, or null on Windows without Git Bash. */
const SH = shellFor('sh');

/** A path as a POSIX shell takes it: C:/dir/file on Windows (Git Bash cannot open C:\dir\file). */
function fwd(p) { return WIN ? String(p).replace(/\\/g, '/') : String(p); }

/** A PATH value from a list of directories: ';' on Windows (Git Bash turns it into its own list), ':' elsewhere. */
function pathList(dirs) { return dirs.join(WIN ? ';' : ':'); }

/**
 * The environment a shell test gives sh. Windows needs SystemRoot for the msys runtime to start, and the PATH ends with the
 * usr\bin of Git for Windows (cat, sleep...), which Claude Code's Git Bash has on its PATH too.
 */
function shEnv(env) {
  if (!WIN) return env;
  const out = { SystemRoot: process.env.SystemRoot || 'C:\\Windows', ...env };
  const bash = gitBashExe();
  if (bash && typeof out.PATH === 'string') out.PATH += ';' + path.resolve(path.dirname(bash), '..', 'usr', 'bin');
  return out;
}

/**
 * The sh launcher of an agent. On Windows zn writes none for Codex, Cursor, Gemini and Antigravity (their hooks are
 * PowerShell there), so a test that runs the sh script in Git Bash writes it the way the adapter does on other systems:
 * `timeoutS` is the hook timeout of the agent (the launcher answers two seconds before it). Returns the file.
 */
function ensureShLauncher(id, { env, home, nodePath, runnerPath, timeoutS }) {
  const launcher = require('../../lib/agents/launcher');
  const file = launcher.launcherFile(id, { env, home });
  if (!fs.existsSync(file)) {
    launcher.writeLauncher(id, nodePath || process.execPath, runnerPath, { env, home, deadlineS: launcher.launcherDeadlineS(timeoutS), deadlineSoft: true });
  }
  return file;
}

/** A node on a PATH directory for a test: a symlink named node, on Windows a copy named node.exe (a link needs a privilege). */
function putNode(dir) {
  if (WIN) fs.copyFileSync(process.execPath, path.join(dir, 'node.exe'));
  else fs.symlinkSync(process.execPath, path.join(dir, 'node'));
}

module.exports = { WIN, SH, gitBashExe, shellFor, fwd, pathList, shEnv, ensureShLauncher, putNode };
