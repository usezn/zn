'use strict';
/* Pins the exact wording of the error and refusal messages in lib/messages.js.
 * If you reword a message on purpose, change it here in the same pull request, and
 * update docs/troubleshooting.md when that page quotes it. */

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/messages');
const tty = require('../lib/broker/tty');
const { parseDuration } = require('../lib/vault/cli');

test('terminal and agent refusals', () => {
  assert.equal(m.agentNote('CLAUDECODE'), ' (detected CLAUDECODE).');
  assert.equal(m.agentNote('started from claude'),
    ' (zn found it was started from claude). If you are not using an AI agent, open a new terminal window and try again.');
  assert.equal(m.agentRefusal('zn unlock', 'CLAUDECODE'),
    'zn unlock must be run by you in your own terminal, not by an AI agent (detected CLAUDECODE).');
  assert.equal(m.notInteractive('zn hooks install'),
    'zn hooks install needs an interactive terminal. Open a terminal window yourself and run it there.');
  assert.equal(m.PROMPT_CANCELLED, 'Cancelled: nothing was entered. Run the command again when you are ready.');
  assert.equal(m.clipboardUnreadable(['/usr/bin/xclip', '/usr/bin/xsel']),
    'could not read the clipboard (tried /usr/bin/xclip, /usr/bin/xsel). Copy the value again, or run the command without --clipboard to type it at the hidden prompt.');
  assert.equal(m.CLIPBOARD_NO_POWERSHELL,
    'could not read the clipboard: the system PowerShell (Windows PowerShell 5.1) was not found. Run the command without --clipboard to type the value at the hidden prompt.');
});

test('vault messages', () => {
  assert.equal(m.invalidDuration('5x'), 'invalid duration "5x" (use e.g. 30m, 8h)');
  assert.equal(m.DURATION_RANGE, 'The --ttl and --idle times must be between 1m and 24h, for example 8h.');
  assert.equal(m.unknownBackend('foo', ['keychain', 'passphrase']), 'Unknown vault backend "foo". Use one of: keychain, passphrase.');
  assert.equal(m.unknownBackend('foo', require('../lib/vault/keychain').BACKENDS),
    'Unknown vault backend "foo". Use one of: macos, windows, libsecret, passphrase.');
  assert.equal(m.UNLOCK_NEEDS_TERMINAL, 'zn unlock needs an interactive terminal: run it in your own terminal window');
  assert.equal(m.FOREGROUND_NEEDS_TERMINAL, '--foreground needs an interactive terminal (it asks you there). Run it in your own terminal window.');
  assert.equal(m.PASSPHRASE_NEEDS_TERMINAL,
    'zn needs a terminal to ask for the passphrase. Run this command in your terminal, or pass it with --passphrase-stdin.');
  assert.equal(m.PASSPHRASE_CANCELLED, 'Cancelled: no passphrase was entered. Run `zn unlock` again when you are ready.');
  assert.equal(m.PASSPHRASE_MISMATCH, 'The two passphrases do not match. Nothing was created; run `zn unlock` again.');
  assert.equal(m.FORGET_LOCK_FIRST, 'Lock the vault first (`zn lock`): the daemon may hold this project in memory.');
});

test('connect messages', () => {
  assert.equal(m.CONNECT_KEY_ON_COMMAND_LINE, 'Never put the key on the command line. Run `zn-gate connect` and paste it at the hidden prompt.');
  assert.equal(m.CONNECT_CANCELLED, 'Cancelled. Nothing was saved.');
  assert.equal(m.CONNECT_NOT_A_KEY,
    'That does not look like a zn API key (they start with zn_). Nothing was saved. Run `zn-gate connect` and paste the key again.');
  assert.equal(m.CONNECT_REJECTED,
    'usezn.com did not accept this key (it may be revoked or mistyped). Nothing was saved. Run `zn-gate connect` and paste a valid key.');
  assert.equal(m.connectFullAccess('https://example.com/connect'),
    'This key can do more than analyze text, and zn-gate only accepts a key limited to analyzing. Create an analysis-only key on the connect page and paste that one: https://example.com/connect\nNothing was saved.');
  assert.equal(m.connectUnverified('http', 'HTTP 500', null, {}), 'usezn.com had a problem checking the key, so nothing was saved. Try again in a few minutes.');
  assert.equal(m.connectUnverified('network', 'ENOTFOUND', null, {}), 'Could not reach usezn.com (check your internet connection, then run `zn-gate connect` again). Nothing was saved.');
  assert.equal(m.connectSaveFailed('disk full'), 'Could not save the key: disk full. Nothing was kept. Run `zn-gate connect` to try again.');
});

test('pins messages', () => {
  assert.equal(m.PINS_USAGE_APPROVE, 'usage: zn-gate pins approve <server>|--all');
  assert.equal(m.pinsAgentRefusal('CLAUDECODE'),
    'zn-gate pins approve must be run by you in your own terminal, not by an AI agent (detected CLAUDECODE).');
  assert.equal(m.PINS_NEEDS_TERMINAL,
    'zn-gate pins approve runs only in your own terminal, so that an agent cannot approve tool changes. Run it there.');
  assert.equal(m.PINS_NOT_APPROVED, 'Not approved: what you typed did not match, so nothing was changed. Run the command again to retry.');
  assert.equal(m.pinsError('unknown server'), 'zn-gate pins: unknown server. Run `zn-gate pins` to see the servers and their full keys.');
});

test('team messages', () => {
  assert.equal(m.TEAM_INVALID_JOIN_TOKEN, 'invalid join token (expected znj_...). Copy it again from the invitation your administrator sent.');
  assert.equal(m.TEAM_INVALID_REQUEST, 'invalid request: the name, kind or value is not valid, so nothing was approved.');
  assert.equal(m.TEAM_NOTHING_TO_APPROVE,
    'nothing to approve: this machine has no organization policy waiting for your answer. Run `zn team status` to check.');
  assert.equal(m.TEAM_NOT_ASKED, 'the organization policy does not ask for this, so nothing was approved.');
  assert.equal(m.TEAM_INVALID_ORG_KEY, 'the server sent an invalid organization key, so this machine was not connected. Ask your administrator.');
  assert.equal(m.teamJoinFailed('HTTP 403'), 'join failed (HTTP 403). This machine was not connected.');
  assert.equal(m.teamJoinFailed('this join token is invalid, expired or used up; ask your administrator for a new one'),
    'join failed (this join token is invalid, expired or used up; ask your administrator for a new one). This machine was not connected.');
  assert.equal(m.teamJoinFailed('this organization has no active Team subscription'),
    'join failed (this organization has no active Team subscription). This machine was not connected.');
});

test('the callers use the shared messages', () => {
  assert.equal(tty.agentNote, m.agentNote);
  assert.throws(() => tty.requireHuman('zn hooks install', { env: {}, stdin: { isTTY: false }, ancestry: () => null }),
    { message: m.notInteractive('zn hooks install') });
  assert.throws(() => tty.requireHuman('zn env shadow', { env: { CLAUDECODE: '1' }, stdin: { isTTY: true } }),
    { message: m.agentRefusal('zn env shadow', 'CLAUDECODE') });
  assert.throws(() => parseDuration('5x'), { message: m.invalidDuration('5x') });
  assert.throws(() => parseDuration('1s'), { message: m.DURATION_RANGE });
});
