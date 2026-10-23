'use strict';
// recoveryHint tells the user how to move a damaged evidence log aside.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { recoveryHint, EVIDENCE_FILE } = require('../lib/evidence');

function setPlatform(t, value) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', original));
  Object.defineProperty(process, 'platform', { value });
}

const file = path.join('example', 'logs', 'evidence.jsonl');
const sibling = path.join('example', 'logs', 'evidence.damaged.jsonl');

test('recoveryHint names the file and a damaged sibling in the same folder', () => {
  const text = recoveryHint(file);
  assert.ok(text.includes(file));
  assert.ok(text.includes(sibling));
});

test('recoveryHint suggests mv on a POSIX platform', (t) => {
  setPlatform(t, 'linux');
  const text = recoveryHint(file);
  assert.ok(text.includes(`mv "${file}" "${sibling}"`));
  assert.ok(!text.includes('move "'));
});

test('recoveryHint suggests move with quoted paths on win32', (t) => {
  setPlatform(t, 'win32');
  const text = recoveryHint(file);
  assert.ok(text.includes(`move "${file}" "${sibling}"`));
});

test('recoveryHint without an argument uses the default log path', () => {
  const text = recoveryHint();
  assert.ok(text.includes(EVIDENCE_FILE));
  assert.ok(text.includes(path.join(path.dirname(EVIDENCE_FILE), 'evidence.damaged.jsonl')));
});
