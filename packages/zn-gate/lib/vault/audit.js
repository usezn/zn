'use strict';
/** Local audit log (~/.zn/audit.jsonl), HMAC-chained with a local key. Metadata only: never values, never hashes of values. */
const { notImplemented } = require('../errors');

function append(event, opts) { throw notImplemented('vault/audit.append'); }
function verify(opts) { throw notImplemented('vault/audit.verify'); }

module.exports = { append, verify };
