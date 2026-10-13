'use strict';
/*
 * Run a command line the way a shell reads it, for tests that check what the
 * commands zn writes do once a shell runs them. The command is written to a
 * script file in a directory of its own and the shell reads it from there
 * (`sh script`, `bash script`, `pwsh -File script.ps1`): the same parsing as
 * `-c`, without building a shell command line in the test process.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./tmp');

/**
 * t: the node:test context (the script directory is removed when the test ends).
 * shell: 'sh', 'bash' or 'pwsh'. flags: extra shell flags (e.g. ['-l']).
 * opts: spawnSync options (cwd, env, input).
 */
function runScript(t, shell, command, opts = {}, flags = []) {
  const dir = tempDir(t, 'zn-script-');
  const ps = /pwsh|powershell/i.test(path.basename(shell));
  const file = path.join(dir, ps ? 'command.ps1' : 'command.sh');
  fs.writeFileSync(file, command + '\n');
  const args = ps ? ['-NoProfile', '-NonInteractive', ...flags, '-File', file] : [...flags, file];
  return spawnSync(shell, args, { encoding: 'utf8', ...opts });
}

module.exports = { runScript };
