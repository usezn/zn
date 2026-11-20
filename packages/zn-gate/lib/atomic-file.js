'use strict';
/**
 * Atomic file writes: the new content goes to a temp file next to the target, which is then renamed over it.
 * When any step fails (a full disk, a full quota, a rename that is refused) the temp file is removed, so no
 * 0-byte or half-written file is left behind, and the error names the real target file, so the caller can print
 * the plain sentence from errors.js for it.
 *
 * Depends only on fs and path: lib/cloud-key.js is loaded by the hooks, and the vault client file list in
 * lib/hooks/runner.js must not grow.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Creates a new temp file (never reusing an existing one), writes data to it, then calls commit(tmpFile).
 * If any step fails, the temp file is removed, so a full disk never leaves a 0-byte or half-written file behind.
 * The temp file is only removed once it was created by this call (an open that fails with EEXIST is not ours).
 */
function writeTempThen(tmpFile, data, mode, commit) {
  let fd;
  let ours = false;
  try {
    fd = fs.openSync(tmpFile, 'wx', mode);
    ours = true;
    let off = 0;
    while (off < data.length) {
      const n = fs.writeSync(fd, data, off, data.length - off);
      if (!(n > 0)) throw Object.assign(new Error('write made no progress'), { code: 'EIO' });
      off += n;
    }
    const toClose = fd;
    fd = undefined;
    fs.closeSync(toClose);
    try {
      fs.chmodSync(tmpFile, mode);
    } catch {}
    commit(tmpFile);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (ours) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
    // Name the file that was being written (the temp name maps back to the real name in the message).
    if (err && typeof err === 'object' && !err.path) err.path = tmpFile;
    throw err;
  }
}

/** Renames over target; on Windows-style sharing errors waits briefly and retries. */
function renameWithRetry(from, to) {
  const busy = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!busy.has(err.code)) throw err;
      if (attempt >= 5) {
        throw new Error(`could not replace ${to}: it is in use by another program; close it and run again`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    }
  }
}

/**
 * Replaces target with data (a string or a Buffer) through a temp file next to it. The folder must exist.
 * On failure the temp file is gone, the target is unchanged, and err.path is the target (not the temp name).
 */
function writeFileAtomic(target, data, mode = 0o600) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, '.' + path.basename(target) + '.zn-tmp.' + process.pid + '.' + crypto.randomBytes(6).toString('hex'));
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  try {
    writeTempThen(tmp, buf, mode, (t) => renameWithRetry(t, target));
  } catch (err) {
    if (err && typeof err === 'object') err.path = target;
    throw err;
  }
}

module.exports = { writeTempThen, renameWithRetry, writeFileAtomic };
