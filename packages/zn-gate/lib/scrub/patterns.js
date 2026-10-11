'use strict';
/** Secret patterns (prefix or verifiable structure) and PII validators. */
const { notImplemented } = require('../errors');

function findPatterns(text, opts) { throw notImplemented('scrub/patterns.findPatterns'); }
function findPii(text, opts) { throw notImplemented('scrub/patterns.findPii'); }

module.exports = { findPatterns, findPii };
