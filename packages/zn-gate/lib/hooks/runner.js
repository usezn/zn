'use strict';
/** Single hook entry point: agent event -> internal event -> agent response. */
const { notImplemented } = require('../errors');

async function handle(agentId, rawEvent, opts) { throw notImplemented('hooks/runner.handle'); }

module.exports = { handle };
