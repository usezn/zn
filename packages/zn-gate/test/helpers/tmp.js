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

// Points os.tmpdir() at `dir` until the returned function restores the old values.
// Lets a test say which folder is the temp dir, so its result does not depend on
// where the checkout lives (a checkout under TMPDIR is a common setup).
function setTempDir(dir) {
  const keys = ['TMPDIR', 'TMP', 'TEMP'];
  const saved = keys.map((k) => [k, process.env[k]]);
  for (const k of keys) process.env[k] = dir;
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

module.exports = { tempDir, removeDir, setTempDir };
