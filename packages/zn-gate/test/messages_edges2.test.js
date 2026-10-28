'use strict';
/* Edge cases for connectNoStore, agentRefusal, notInteractive and invalidDuration in lib/messages.js.
 * These pin today's behaviour for empty, odd and non-string input. */

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/messages');

test('agentRefusal with an empty or unusual agent', () => {
  assert.equal(m.agentRefusal('zn unlock', ''),
    'zn unlock must be run by you in your own terminal, not by an AI agent (detected ).');
  assert.equal(m.agentRefusal('', 'EXAMPLE_AGENT'),
    ' must be run by you in your own terminal, not by an AI agent (detected EXAMPLE_AGENT).');
});

test('agentRefusal uses the started-from note only when the name starts with it', () => {
  assert.match(m.agentRefusal('zn unlock', 'started from example'), /If you are not using an AI agent/);
  assert.doesNotMatch(m.agentRefusal('zn unlock', 'was started from example'), /If you are not using an AI agent/);
  assert.doesNotMatch(m.agentRefusal('zn unlock', 'Started from example'), /If you are not using an AI agent/);
  assert.doesNotMatch(m.agentRefusal('zn unlock', 'started fromexample'), /If you are not using an AI agent/);
});

test('agentRefusal turns a non-string agent into text', () => {
  assert.ok(m.agentRefusal('zn unlock', 42).endsWith('(detected 42).'));
});

test('agentRefusal does not trim or escape its input', () => {
  assert.equal(m.agentRefusal(' zn x ', ' a\n'),
    ' zn x  must be run by you in your own terminal, not by an AI agent (detected  a\n).');
});

test('notInteractive with empty and non-string input', () => {
  assert.equal(m.notInteractive(''), ' needs an interactive terminal. Open a terminal window yourself and run it there.');
  assert.equal(m.notInteractive(undefined), 'undefined needs an interactive terminal. Open a terminal window yourself and run it there.');
  assert.equal(m.notInteractive(null).startsWith('null needs'), true);
  assert.equal(m.notInteractive('a "quoted" command').startsWith('a "quoted" command needs'), true);
});

test('invalidDuration quotes empty, blank and odd values as given', () => {
  assert.equal(m.invalidDuration(''), 'invalid duration "" (use e.g. 30m, 8h)');
  assert.equal(m.invalidDuration('  '), 'invalid duration "  " (use e.g. 30m, 8h)');
  assert.equal(m.invalidDuration('0m'), 'invalid duration "0m" (use e.g. 30m, 8h)');
  assert.equal(m.invalidDuration('-5m'), 'invalid duration "-5m" (use e.g. 30m, 8h)');
  assert.equal(m.invalidDuration('25h'), 'invalid duration "25h" (use e.g. 30m, 8h)');
  assert.equal(m.invalidDuration('a"b'), 'invalid duration "a"b" (use e.g. 30m, 8h)');
  assert.equal(m.invalidDuration(undefined), 'invalid duration "undefined" (use e.g. 30m, 8h)');
  assert.equal(m.invalidDuration(null), 'invalid duration "null" (use e.g. 30m, 8h)');
  assert.equal(m.invalidDuration(0), 'invalid duration "0" (use e.g. 30m, 8h)');
});

test('connectNoStore puts the command in the next step', () => {
  const out = m.connectNoStore('zn unlock');
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /never in a plain file/);
  assert.equal(lines[1], 'Next step: run `zn unlock` (it asks you for a passphrase), then run `zn-gate connect` again.');
});

test('connectNoStore with empty, missing and npx-style commands', () => {
  assert.match(m.connectNoStore(''), /Next step: run `` \(it asks/);
  assert.match(m.connectNoStore(undefined), /Next step: run `undefined` \(it asks/);
  assert.match(m.connectNoStore('npx example-zn unlock'), /run `npx example-zn unlock` \(it asks/);
});

test('connectNoStore text is the same apart from the command', () => {
  const a = m.connectNoStore('AAA');
  const b = m.connectNoStore('BBB');
  assert.equal(a.replace('AAA', 'BBB'), b);
  assert.equal(a.includes('$'), false);
});
