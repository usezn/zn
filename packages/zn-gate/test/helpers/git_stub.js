'use strict';
/* A folder with a stub `git` program, to put on a test's PATH: zn-gate only looks Git up (it never starts it), and init and
 * check say so when Git is missing. Tests of the plugin steps use it so that they read the steps and nothing else. */
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');

function gitStubDir(t) {
  const dir = tempDir(t, 'zn-gitstub-');
  const win = process.platform === 'win32';
  fs.writeFileSync(path.join(dir, win ? 'git.exe' : 'git'), win ? '' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

module.exports = { gitStubDir };
