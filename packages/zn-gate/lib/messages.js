'use strict';
/**
 * The error and refusal messages people read at the terminal, in one place.
 *
 * Each message says what happened, why when it helps, and what to do next, in
 * one short line of plain English. The wording is pinned by test/messages.test.js,
 * so a change here shows up in review. Callers must not rebuild these strings.
 * Other code and tests match on parts of some of them (for example
 * "needs an interactive terminal"), so keep those phrases when you reword.
 *
 * This module has no dependencies, so any module can load it.
 */

/* ------------------------- terminal and AI agents ------------------------- */

/* The end of a refusal, in words for someone who does not program. */
function agentNote(agent) {
  if (/^started from /.test(agent)) {
    return ' (zn found it was ' + agent + '). If you are not using an AI agent, open a new terminal window and try again.';
  }
  return ' (detected ' + agent + ').';
}

function agentRefusal(what, agent) {
  return what + ' must be run by you in your own terminal, not by an AI agent' + agentNote(agent);
}

function notInteractive(what) {
  return what + ' needs an interactive terminal. Open a terminal window yourself and run it there.';
}

const PROMPT_CANCELLED = 'Cancelled: nothing was entered. Run the command again when you are ready.';

const CLIPBOARD_NO_POWERSHELL = 'could not read the clipboard: the system PowerShell (Windows PowerShell 5.1) was not found. ' +
  'Run the command without --clipboard to type the value at the hidden prompt.';

function clipboardUnreadable(tried) {
  return 'could not read the clipboard (tried ' + tried.join(', ') + '). ' +
    'Copy the value again, or run the command without --clipboard to type it at the hidden prompt.';
}

/* ------------------------------ the vault ------------------------------ */

function invalidDuration(value) {
  return 'invalid duration "' + value + '" (use e.g. 30m, 8h)';
}

const DURATION_RANGE = 'The --ttl and --idle times must be between 1m and 24h, for example 8h.';

function unknownBackend(name, known) {
  return 'Unknown vault backend "' + name + '". Use one of: ' + known.join(', ') + '.';
}

const UNLOCK_NEEDS_TERMINAL = 'zn unlock needs an interactive terminal: run it in your own terminal window';

const FOREGROUND_NEEDS_TERMINAL = '--foreground needs an interactive terminal (it asks you there). Run it in your own terminal window.';

const PASSPHRASE_NEEDS_TERMINAL = 'zn needs a terminal to ask for the passphrase. Run this command in your terminal, or pass it with --passphrase-stdin.';

const PASSPHRASE_CANCELLED = 'Cancelled: no passphrase was entered. Run `zn unlock` again when you are ready.';

const PASSPHRASE_MISMATCH = 'The two passphrases do not match. Nothing was created; run `zn unlock` again.';

const FORGET_LOCK_FIRST = 'Lock the vault first (`zn lock`): the daemon may hold this project in memory.';

/* --------------------------- zn-gate connect --------------------------- */

const CONNECT_KEY_ON_COMMAND_LINE = 'Never put the key on the command line. Run `zn-gate connect` and paste it at the hidden prompt.';

const CONNECT_CANCELLED = 'Cancelled. Nothing was saved.';

const CONNECT_NOT_A_KEY = 'That does not look like a zn API key (they start with zn_). Nothing was saved. Run `zn-gate connect` and paste the key again.';

const CONNECT_REJECTED = 'usezn.com did not accept this key (it may be revoked or mistyped). Nothing was saved. Run `zn-gate connect` and paste a valid key.';

function connectFullAccess(url) {
  return 'This key can do more than analyze text, and zn-gate only accepts a key limited to analyzing. ' +
    'Create an analysis-only key on the connect page and paste that one: ' + url + '\nNothing was saved.';
}

function connectUnverified(detail) {
  return 'Could not verify the key with usezn.com (' + detail + '), so nothing was saved. Try again later.';
}

function connectSaveFailed(detail) {
  return 'Could not save the key: ' + detail + '. Nothing was kept. Run `zn-gate connect` to try again.';
}

/* ------------------------------ MCP pins ------------------------------ */

const PINS_USAGE_APPROVE = 'usage: zn-gate pins approve <server>|--all';

function pinsAgentRefusal(agent) {
  return agentRefusal('zn-gate pins approve', agent);
}

const PINS_NEEDS_TERMINAL = 'zn-gate pins approve runs only in your own terminal, so that an agent cannot approve tool changes. Run it there.';

const PINS_NOT_APPROVED = 'Not approved: what you typed did not match, so nothing was changed. Run the command again to retry.';

function pinsError(reason) {
  return 'zn-gate pins: ' + reason + '. Run `zn-gate pins` to see the servers and their full keys.';
}

/* ------------------------------- teams ------------------------------- */

const TEAM_INVALID_JOIN_TOKEN = 'invalid join token (expected znj_...). Copy it again from the invitation your administrator sent.';

const TEAM_INVALID_REQUEST = 'invalid request: the name, kind or value is not valid, so nothing was approved.';

const TEAM_NOTHING_TO_APPROVE = 'nothing to approve: this machine has no organization policy waiting for your answer. Run `zn team status` to check.';

const TEAM_NOT_ASKED = 'the organization policy does not ask for this, so nothing was approved.';

const TEAM_INVALID_ORG_KEY = 'the server sent an invalid organization key, so this machine was not connected. Ask your administrator.';

function teamJoinFailed(why) {
  return 'join failed (' + why + '). This machine was not connected.';
}

/* ----------------------- agent hooks: calls zn cannot read ----------------------- */

const UNREADABLE_FILE = 'zn could not tell which file this call uses, so it blocked it. ' +
  'Next step: name the file explicitly in your request. If it keeps happening, run `zn-gate check`.';

/* what: "the command", "the tool name"... of a call the agent sent in a shape zn does not know. */
function unreadableCall(what) {
  return 'zn could not read ' + what + ' of this call, so it blocked it. ' +
    'Next step: run `zn-gate check`. If it keeps happening, update zn-gate with `npm install -g zn-gate@latest`.';
}

/* The secret check did not run, so the call, the message or the output is held back (fail closed). */
const SECRETS_CHECK_STEP = 'Next step: run `zn-gate check`, then `zn hooks install opencode`.';
const OPENCODE_CALL_BLOCKED = 'zn could not check this call for secrets, so it was blocked. ' + SECRETS_CHECK_STEP;
const OPENCODE_MESSAGE_BLOCKED = 'zn could not check this message for secrets, so it was not sent. ' + SECRETS_CHECK_STEP;
const OPENCODE_OUTPUT_WITHHELD = '[zn: output withheld because zn could not check it for secrets. Run `zn-gate check`.]';

/* The end of the line that says a team policy rule would have blocked a secret. */
const TEAM_WARN_END = '. It was allowed and recorded for your organization. Ask your administrator if this should be allowed.';
module.exports = {
  UNREADABLE_FILE, unreadableCall, OPENCODE_CALL_BLOCKED, OPENCODE_MESSAGE_BLOCKED, OPENCODE_OUTPUT_WITHHELD, TEAM_WARN_END,
  agentNote, agentRefusal, notInteractive, PROMPT_CANCELLED, CLIPBOARD_NO_POWERSHELL, clipboardUnreadable,
  invalidDuration, DURATION_RANGE, unknownBackend, UNLOCK_NEEDS_TERMINAL, FOREGROUND_NEEDS_TERMINAL,
  PASSPHRASE_NEEDS_TERMINAL, PASSPHRASE_CANCELLED, PASSPHRASE_MISMATCH, FORGET_LOCK_FIRST,
  CONNECT_KEY_ON_COMMAND_LINE, CONNECT_CANCELLED, CONNECT_NOT_A_KEY, CONNECT_REJECTED,
  connectFullAccess, connectUnverified, connectSaveFailed,
  PINS_USAGE_APPROVE, pinsAgentRefusal, PINS_NEEDS_TERMINAL, PINS_NOT_APPROVED, pinsError,
  TEAM_INVALID_JOIN_TOKEN, TEAM_INVALID_REQUEST, TEAM_NOTHING_TO_APPROVE, TEAM_NOT_ASKED, TEAM_INVALID_ORG_KEY,
  teamJoinFailed,
};
