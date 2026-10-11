'use strict';
/** MCP server "secrets": list, http_request, render_file, request. There is no get. */
const { notImplemented } = require('../errors');

async function start(opts) { throw notImplemented('broker/mcp.start'); }

module.exports = { start };
