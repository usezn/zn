'use strict';

// Which check refused an action. The policy functions that decide return only a message, so the one that fires
// leaves its stable id here (family:check) and the hook runner reads it once for the evidence record. The id is
// used only when the decision message is the one the check built, so a stale note can never label another block.
// It holds no command text and no path: only an id from a fixed list.

const { AsyncLocalStorage } = require('async_hooks');

// The note lives in a per-invocation store (one per hook call), so overlapping async calls never see each other's note.
const store = new AsyncLocalStorage();

function runWithRuleNote(fn) { return store.run({ note: null }, fn); }

function tagRule(id, message) {
  const s = store.getStore();
  if (s) s.note = typeof message === 'string' ? { id, head: message.slice(0, 40) } : null;
  return message;
}

function takeRuleId(message) {
  const s = store.getStore();
  if (!s) return null;
  const n = s.note;
  s.note = null;
  return n && typeof message === 'string' && message.includes(n.head) ? n.id : null;
}

function resetRuleId() { const s = store.getStore(); if (s) s.note = null; }

module.exports = { tagRule, takeRuleId, resetRuleId, runWithRuleNote };
