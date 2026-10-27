'use strict';

// On Windows Claude Code runs the zn-gate plugin's hooks with Git Bash, and zn-gate check looks for it the same way
// (CLAUDE_CODE_GIT_BASH_PATH first). Tests whose fixture has an empty PATH pass the runner's bash.exe through that
// setting, so the plugin checks run on Windows too. Elsewhere nothing is added.

const fs = require('fs');
const path = require('path');

function findGitBash() {
  if (process.platform !== 'win32') return null;
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean);
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, ...pf.map((d) => path.join(d, 'Git', 'bin', 'bash.exe'))];
  for (const f of candidates) {
    try { if (f && path.isAbsolute(f) && fs.statSync(f).isFile()) return f; } catch (_) { /* not there */ }
  }
  return null;
}

const GIT_BASH = findGitBash();

/** The env with CLAUDE_CODE_GIT_BASH_PATH set to the runner's Git Bash on Windows (unchanged elsewhere). */
function withGitBash(env) {
  return GIT_BASH ? { ...env, CLAUDE_CODE_GIT_BASH_PATH: GIT_BASH } : env;
}

// For the tests that need it: skipped only on a Windows machine without Git for Windows.
const NEEDS_GIT_BASH = { skip: process.platform === 'win32' && !GIT_BASH && 'Git for Windows (bash.exe) is not installed here' };

module.exports = { GIT_BASH, withGitBash, NEEDS_GIT_BASH };
