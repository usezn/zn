'use strict';

// The Claude Code plugin is added with `claude plugin marketplace add`, and Claude Code downloads the marketplace with
// Git. On a clean machine (a new Windows PC, above all) there is no Git: the first command then fails with "Command
// 'git' not found", and the second with a misleading "Plugin not found in marketplace". This module finds out
// whether Git is there (a lookup on PATH: Git is never started, no shell is used) and words the first step.

const exe = require('./exe');

/* true when no `git` program is on PATH (only absolute PATH entries count, as for every program zn-gate looks up). */
function gitMissing(env) {
  try { return !exe.findProgram('git', env || process.env); } catch (err) { return false; }
}

const INSTALL = 'Windows: run `winget install --id Git.Git -e`, or download it from https://git-scm.com/download/win; '
  + 'macOS: run `xcode-select --install`; Linux: use your package manager, for example `sudo apt install git`';
const NO_GIT_ROUTE = 'If you would rather not install Git, run `zn hooks install claude-code` in your own terminal instead '
  + '(it needs an interactive terminal)';
const MISLEADING = 'If you see "Plugin not found in marketplace", the marketplace step failed first (usually for lack of Git)';

/* For `zn-gate check`: goes in front of the steps of the plugin. */
function checkFirst() {
  return 'first install Git, because the plugin route needs it and Git was not found (' + INSTALL + '), then open a new terminal';
}
function checkAfter() {
  return NO_GIT_ROUTE + '. ' + MISLEADING;
}

/* The note for `zn-gate init`, printed before the steps. */
function initNote() {
  return [
    '  First step, before the plugin steps: install Git. The Claude Code plugin needs it and Git was not found on this machine.',
    '    ' + INSTALL.split('; ').join('\n    '),
    '    Then open a new terminal and run `npx -y zn-gate init` again.',
    '  No Git? The other route is `zn hooks install claude-code` (it needs an interactive terminal).',
    '  If you see "Plugin not found in marketplace", the marketplace step failed first (usually for lack of Git).',
  ].join('\n');
}

module.exports = { gitMissing, checkFirst, checkAfter, initNote };
