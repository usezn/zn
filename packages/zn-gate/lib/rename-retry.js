'use strict';

/**
 * Renaming over a file that another program holds open (antivirus, an editor, an agent reading its own
 * config) fails on Windows with EPERM, EACCES or EBUSY for a moment. Shared by every writer in zn-gate.
 */

const fs = require('fs');

/** Renames over `to`; on Windows-style sharing errors waits briefly and retries. */
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

module.exports = { renameWithRetry };
