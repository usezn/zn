'use strict';

// zn's own API key format is found by the scrubber (the layer the agent hooks use
// for tool output and prompts), so it never reaches the model. Keys are generated
// at run time.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const engine = require('../lib/scrub/engine');
const { findPatterns, SCRUB_RULES_VERSION } = require('../lib/scrub/patterns');
const { compareVersions } = require('./helpers/rules_snapshot');

const hex = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);
const key = () => 'zn_' + hex(48);

const found = (text) => engine.scan(text);
const covers = (text, k) => {
  const at = text.indexOf(k);
  return found(text).some((d) => d.type === 'ZN_API_KEY' && d.start <= at && d.end >= at + k.length);
};

test('a zn API key is found, whole, wherever it appears', () => {
  const k = key();
  for (const text of [
    k,
    'Authorization: Bearer ' + k,
    'export ZN_API_KEY=' + k,
    '{"apiKey":"' + k + '"}',
    'curl -H "Authorization: Bearer ' + k + '" https://api.example.invalid/x',
    'line one\n' + k + '\nline three',
    '(' + k + ')',
    'stdout: ' + k + '.',
  ]) {
    assert.ok(covers(text, k), 'not covered: ' + text.replace(k, '<key>'));
  }
});

test('the type is named, and the rules version moved with it', () => {
  const k = key();
  assert.deepEqual(findPatterns('x ' + k + ' y').map((d) => d.type), ['ZN_API_KEY']);
  assert.ok(compareVersions(SCRUB_RULES_VERSION, '2026-10-17.3') >= 0);
});

test('look-alikes are left alone: wrong length, uppercase, other prefixes, longer words', () => {
  for (const text of [
    'zn_' + hex(47),
    'zn_' + hex(49),
    'zn_' + hex(48).toUpperCase(),
    'zn_live_placeholder',
    'zn_your_key_here',
    'azn_' + hex(48),
    'zn-' + hex(48),
    'ZN_' + hex(48),
    'zn_' + hex(24) + '_' + hex(24),
  ]) {
    assert.ok(!found(text).some((d) => d.type === 'ZN_API_KEY'), 'matched: ' + text);
  }
});
