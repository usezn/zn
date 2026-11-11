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

// The ids the hooks emit, besides the destructive:* ones (those come from the destructive rule table). The evidence
// log keeps a rule_id only if it is in this list, so a caller can never store free text (a token, a path) there.
const FIXED_RULE_IDS = Object.freeze([
  'secret-file:dotenv',
  'secret-file:credential',
  'egress-check',
  'size:command-too-long',
  'size:patch-too-long',
  'size:mcp-call-too-large',
  'vault:unavailable',
]);
const FIXED_SET = new Set(FIXED_RULE_IDS);

function isKnownRuleId(id) {
  if (typeof id !== 'string') return false;
  if (FIXED_SET.has(id)) return true;
  // Loaded only for a destructive id, so the evidence module does not pull in the rule engine for the others.
  return id.startsWith('destructive:') && require('../destructive').RULES.includes(id);
}

function resetRuleId() { const s = store.getStore(); if (s) s.note = null; }

module.exports = { tagRule, takeRuleId, resetRuleId, runWithRuleNote, isKnownRuleId, FIXED_RULE_IDS };
