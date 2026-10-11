'use strict';
/**
 * Claude Code adapter.
 *   normalize(rawEvent) -> {event: 'pre_tool'|'post_tool'|'user_prompt', tool, input, output, cwd, sessionId}
 *   respond(decision)   -> raw agent JSON for {allow|deny|ask, updatedInput?, updatedOutput?, message?}
 */
const { notImplemented } = require('../errors');

module.exports = {
  id: 'claude-code',
  detect() { throw notImplemented('agents/claude-code.detect'); },
  install(opts) { throw notImplemented('agents/claude-code.install'); },
  uninstall() { throw notImplemented('agents/claude-code.uninstall'); },
  normalize(rawEvent) { throw notImplemented('agents/claude-code.normalize'); },
  respond(internalDecision) { throw notImplemented('agents/claude-code.respond'); },
};
