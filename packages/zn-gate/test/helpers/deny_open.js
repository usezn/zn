'use strict';
// Preloaded with `node -r`: opening the file named in ZN_TEST_DENY fails with EACCES.
const fs = require('fs');
const real = fs.openSync;
fs.openSync = function (p, ...rest) {
  if (typeof p === 'string' && p === process.env.ZN_TEST_DENY) {
    const e = new Error("EACCES: permission denied, open '" + p + "'");
    e.code = 'EACCES';
    throw e;
  }
  return real.call(fs, p, ...rest);
};
