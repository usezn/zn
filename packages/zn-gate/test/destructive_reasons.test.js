'use strict';

// The reason texts of the destructive-command policy: each one is a short, plain, one-line sentence with no absolute
// path, and each rule is reached by at least one command in the shared corpus.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkCommand, denial, RULES } = require('../lib/destructive');
const corpus = require('./fixtures/destructive_commands.json');

const PREFIX = 'Destructive command: ';

// Reason text for each rule key, taken from what checkCommand returns for the corpus commands.
function reasonsByRule() {
  const out = new Map();
  for (const r of corpus.risky) {
    const res = checkCommand(r.cmd);
    if (res.verdict === 'block' && !out.has(res.rule)) out.set(res.rule, res.reason);
  }
  return out;
}

// The overflow reason is not a rule key: it comes from a command line that is too long to check.
function overflowReason() {
  const res = checkCommand('echo ' + 'a'.repeat(200 * 1024 + 1));
  assert.equal(res.verdict, 'block');
  return res;
}

function assertPlainReason(text, label) {
  assert.equal(typeof text, 'string', label);
  assert.ok(text.trim().length > 0, label + ': empty');
  assert.ok(!/[\r\n]/.test(text), label + ': more than one line');
  assert.ok(text.length < 160, label + ': ' + text.length + ' characters');
  assert.ok(!/(^|[\s'"(])(?:\/[\w.-]+|[A-Za-z]:[\\/]|~\/)/.test(text), label + ': has an absolute path');
}

test('every reason key is produced by at least one command in the corpus', () => {
  const seen = reasonsByRule();
  assert.ok(RULES.length > 0);
  for (const rule of RULES) assert.ok(seen.has(rule), 'no corpus command produces ' + rule);
});

test('every reason text is one plain line, under 160 characters, with no absolute path', () => {
  const seen = reasonsByRule();
  for (const rule of RULES) {
    const full = seen.get(rule);
    assert.ok(full.startsWith(PREFIX), rule);
    const text = full.slice(PREFIX.length);
    assertPlainReason(text, rule);
    assertPlainReason(full, rule + ' (full)');
  }
});

test('the too-many-commands reason follows the same rules', () => {
  const res = overflowReason();
  assert.equal(res.rule, 'destructive:too_many_commands');
  assertPlainReason(res.reason.slice(PREFIX.length), 'too_many_commands');
});

test('the deny message for each rule keeps the reason on one line', () => {
  for (const r of corpus.risky) {
    const msg = denial(r.cmd, null);
    if (msg === null) continue;
    assert.ok(!/[\r\n]/.test(msg), r.cmd);
  }
});

test('each rule has its own reason text', () => {
  const texts = [...reasonsByRule().values()];
  assert.equal(new Set(texts).size, texts.length);
});
