'use strict';
/* Pins the help text that `zn team <word>` prints for a sub-command that does not exist
 * (teamNotACommand in lib/messages.js). Pure string checks: no files, no network. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { teamNotACommand } = require('../lib/messages');

const COMMANDS = 'Commands: zn team join <token>, zn team status, zn team sync, zn team leave. All options: zn team --help';

test('login has its own sentence that points to zn team join <token>', () => {
  const msg = teamNotACommand('login');
  assert.equal(msg,
    "'zn team login' is not a zn command. To connect this machine run: zn team join <token>. To export the audit log run: zn vault log export --otlp");
  assert.match(msg, /zn team join <token>/);
});

test('export has its own sentence that points to zn team join <token>', () => {
  const msg = teamNotACommand('export');
  assert.equal(msg,
    "'zn team export' is not a zn command. To export the audit log run: zn vault log export --otlp. To connect this machine run: zn team join <token>");
  assert.match(msg, /zn team join <token>/);
});

test('a word that looks like a join token gives the join hint and is not echoed', () => {
  const hint = 'That looks like a join token. Run: zn team join <token>';
  for (const word of ['znj_FAKE0000example', 'ZNJ_fake1111example', 'Znj_Fake2222', '  znj_fake3333  ']) {
    const msg = teamNotACommand(word);
    assert.equal(msg, hint);
    assert.ok(!msg.includes(word.trim()), 'the token-like word must not be echoed');
  }
});

test('a word longer than 20 characters is shown as "that"', () => {
  const long = 'a'.repeat(21);
  const msg = teamNotACommand(long);
  assert.equal(msg, "'zn team that' is not a zn command. " + COMMANDS);
  assert.ok(!msg.includes(long));
  // Exactly 20 characters is still echoed.
  assert.equal(teamNotACommand('b'.repeat(20)), "'zn team " + 'b'.repeat(20) + "' is not a zn command. " + COMMANDS);
});

test('control characters in a short word are replaced by spaces', () => {
  const msg = teamNotACommand('ab\u001b[2Jc\nd\u007f');
  assert.equal(msg, "'zn team ab [2Jc d ' is not a zn command. " + COMMANDS);
  assert.doesNotMatch(msg, /[\u0000-\u001f\u007f]/);
});

test('an ordinary word is echoed in quotes with the list of real sub-commands', () => {
  const msg = teamNotACommand('frobnicate');
  assert.equal(msg, "'zn team frobnicate' is not a zn command. " + COMMANDS);
  for (const sub of ['join', 'status', 'sync', 'leave']) {
    assert.ok(msg.includes('zn team ' + sub), 'lists zn team ' + sub);
  }
});
