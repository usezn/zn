'use strict';
/* Temporary directories for node:test tests, removed when the test ends (passed or failed). */

const fs = require('fs');
const os = require('os');
const path = require('path');

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// `t` is the node:test context of the test that owns the directory.
function tempDir(t, prefix, base = os.tmpdir()) {
  // realpath: on macOS os.tmpdir() is under /var, a link to /private/var, and tools report the real path.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, prefix)));
  t.after(() => removeDir(dir));
  return dir;
}

module.exports = { tempDir, removeDir };
