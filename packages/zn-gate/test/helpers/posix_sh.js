'use strict';
/*
 * Whether the tests that run the hook launchers (shell scripts) can run here: a POSIX sh must start as
 * /bin/sh and as sh from the PATH. That is always true on Linux and macOS. On Windows it is true only when
 * Git for Windows is installed and its usr/bin folder is reachable as \bin on the current drive (a link or a
 * copy) and on the PATH, which is the layout Claude Code gives its hooks through Git Bash. A Windows machine
 * without it skips these tests instead of failing.
 */

const { spawnSync } = require('child_process');

function starts(program) {
  try {
    const r = spawnSync(program, ['-c', 'exit 0'], { stdio: 'ignore', timeout: 20000 });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

const hasPosixSh = process.platform !== 'win32' || (starts('/bin/sh') && starts('sh'));

const NEEDS = 'needs a POSIX sh: on Windows, Git for Windows with its usr/bin folder linked as \bin and on the PATH';

/**
 * The value for the `skip` option of a test that needs a POSIX sh. On Windows the test is skipped with the
 * given reason even when sh is there: use it for a test that is known to fail on Windows today.
 */
function skipUnlessPosixSh(failsOnWindows) {
  if (!hasPosixSh) return NEEDS;
  if (process.platform === 'win32' && failsOnWindows) return failsOnWindows;
  return false;
}

module.exports = { hasPosixSh, skipUnlessPosixSh };
