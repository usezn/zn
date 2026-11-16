'use strict';
/* Property checks for the terminal and passphrase messages in lib/messages.js.
 * The exact wording is pinned in messages.test.js; these tests check what each
 * message must contain and that none of them leaks a home path or terminal codes. */

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/messages');

const UNLOCK = /unlock/;

test('notInteractive embeds the action text', () => {
  const msg = m.notInteractive('example-action --flag');
  assert.ok(msg.startsWith('example-action --flag '));
});

test('agentRefusal embeds the action text and the agent name', () => {
  const msg = m.agentRefusal('example-action', 'example-agent');
  assert.ok(msg.startsWith('example-action '));
  assert.ok(msg.includes('example-agent'));
});

test('passphrase messages name the unlock command', () => {
  assert.match(m.passphraseMismatch(), UNLOCK);
  assert.match(m.passphraseCancelled(), UNLOCK);
});

test('clipboardUnreadable lists every program tried', () => {
  const msg = m.clipboardUnreadable(['fake-clip-one', 'fake-clip-two']);
  assert.ok(msg.includes('fake-clip-one'));
  assert.ok(msg.includes('fake-clip-two'));
});

const cases = {
  notInteractive: () => m.notInteractive('example-action'),
  agentRefusal: () => m.agentRefusal('example-action', 'example-agent'),
  passphraseMismatch: () => m.passphraseMismatch(),
  passphraseCancelled: () => m.passphraseCancelled(),
  clipboardUnreadable: () => m.clipboardUnreadable(['fake-clip-one', 'fake-clip-two']),
  unlockNeedsTerminal: () => m.unlockNeedsTerminal(),
  forgetLockFirst: () => m.forgetLockFirst(),
  powershellMissing: () => m.powershellMissing(),
};

for (const [name, make] of Object.entries(cases)) {
  test(name + ' is one clean non-empty string', () => {
    const msg = make();
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 0);
    assert.equal(msg, msg.trimEnd());
    assert.ok(!msg.includes('\u001b'), 'no ANSI escape');
    assert.ok(!/(^|[\s(`"'])(\/home\/|\/Users\/|[A-Za-z]:\\Users\\|~\/)/.test(msg), 'no home path');
  });
}
