'use strict';

// Which check refused an action. The policy functions that decide return only a message, so the one that fires
// leaves its stable id here (family:check) and the hook runner reads it once for the evidence record. The id is
// used only when the decision message is the one the check built, so a stale note can never label another block.
// It holds no command text and no path: only an id from a fixed list.

let note = null;

function tagRule(id, message) {
  note = typeof message === 'string' ? { id, head: message.slice(0, 40) } : null;
  return message;
}

function takeRuleId(message) {
  const n = note;
  note = null;
  return n && typeof message === 'string' && message.includes(n.head) ? n.id : null;
}

function resetRuleId() { note = null; }

module.exports = { tagRule, takeRuleId, resetRuleId };
