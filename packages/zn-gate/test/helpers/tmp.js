'use strict';
/* Temporary directories for node:test tests, removed when the test ends (passed or failed). */

const fs = require('fs');
const os = require('os');
const path = require('path');

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    // On Windows a child process that was just stopped can hold the folder for a moment longer; a temporary folder
    // left behind must not fail the test that owns it (its assertions already ran).
    if (process.platform === 'win32' && (err.code === 'EBUSY' || err.code === 'EPERM')) return;
    throw err;
  }
}

// `t` is the node:test context of the test that owns the directory.
function tempDir(t, prefix, base = os.tmpdir()) {
  // realpath: on macOS os.tmpdir() is under /var, a link to /private/var, and tools report the real path.
  // The native form also expands a Windows 8.3 short name (RUNNER~1), whose "~" zn refuses in a path it must run.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(base, prefix)));
  t.after(() => removeDir(dir));
  return dir;
}

module.exports = { tempDir, removeDir };
