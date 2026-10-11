'use strict';
/** Known exact values: sources, variants (base64/hex/url) and Aho-Corasick search. */
const { notImplemented } = require('../errors');

function collectSources(opts) { throw notImplemented('scrub/exact.collectSources'); }
function variants(value) { throw notImplemented('scrub/exact.variants'); }
function buildMatcher(entries) { throw notImplemented('scrub/exact.buildMatcher'); }

module.exports = { collectSources, variants, buildMatcher };
