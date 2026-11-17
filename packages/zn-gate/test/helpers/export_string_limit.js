'use strict';
/*
 * Preload for CLI tests of `evidence --export` (node -r <this file>): it stands in for a log too large
 * for one JavaScript string without writing hundreds of megabytes. Reading the whole evidence log
 * with fs.readFileSync fails the way V8 fails past its string limit once the log is over
 * ZN_TEST_STRING_LIMIT bytes, and the export reads in chunks of ZN_TEST_EXPORT_CHUNK bytes.
 * With ZN_TEST_EXPORT_FAIL_AT=<offset>, the read at or past that offset fails with EIO.
 */
const fs = require('fs');
const path = require('path');

const limit = Number(process.env.ZN_TEST_STRING_LIMIT || 1024);
const realReadFileSync = fs.readFileSync;
fs.readFileSync = function readFileSync(file, ...rest) {
  if (typeof file === 'string' && path.basename(file) === 'evidence.jsonl') {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* missing: let the real call answer */ }
    if (size > limit) {
      const e = new Error(`Cannot create a string longer than ${limit} characters`);
      e.code = 'ERR_STRING_TOO_LONG';
      throw e;
    }
  }
  return realReadFileSync.call(this, file, ...rest);
};

const ev = require('../../lib/evidence');
ev._testHooks.exportChunkSize = Number(process.env.ZN_TEST_EXPORT_CHUNK || 50);
if (process.env.ZN_TEST_EXPORT_FAIL_AT) {
  const at = Number(process.env.ZN_TEST_EXPORT_FAIL_AT);
  ev._testHooks.beforeExportRead = (pos) => {
    if (pos >= at) { const e = new Error('i/o error'); e.code = 'EIO'; throw e; }
  };
}
