'use strict';
/**
 * Scrubber engine: scan / tokenize / detokenize.
 *
 *   scan(text, ctx)        -> Span[]   synchronous and pure (no vault access)
 *       Span = {start, end, type, source: 'exact'|'pattern'|'pii', name?}
 *   tokenize(text, ctx)    -> Promise<{text, replaced: [{type, token, source}]}>
 *   detokenize(text, ctx)  -> Promise<{text, restored: [token], withheld: [{token, reason}]}>
 *
 *   ctx = {project, agent, tool, destination, vault}
 *   destination: 'assistant'|'write_ignored'|'write_tracked'|'bash_local'|'bash_network'|'mcp_input'
 */
const { notImplemented } = require('../errors');

function scan(text, ctx) { throw notImplemented('scrub/engine.scan'); }
async function tokenize(text, ctx) { throw notImplemented('scrub/engine.tokenize'); }
async function detokenize(text, ctx) { throw notImplemented('scrub/engine.detokenize'); }

module.exports = { scan, tokenize, detokenize };
