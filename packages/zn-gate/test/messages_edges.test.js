'use strict';
/* Edge cases for four messages in lib/messages.js: empty and odd input, and the
 * ZN_VERBOSE detail rules. These pin today's behaviour. */

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/messages');

const DASH = 'https://example.com/api-keys';
const VERBOSE = { ZN_VERBOSE: '1' };

test('clipboardUnreadable lists one, many or no tried programs', () => {
  assert.match(m.clipboardUnreadable(['xclip']), /^could not read the clipboard \(tried xclip\)\. /);
  assert.match(m.clipboardUnreadable(['a', 'b', 'c']), /\(tried a, b, c\)\./);
  assert.match(m.clipboardUnreadable([]), /\(tried \)\./);
  assert.match(m.clipboardUnreadable(['']), /\(tried \)\./);
});

test('clipboardUnreadable always ends with the next step', () => {
  assert.match(m.clipboardUnreadable(['xsel']), /without --clipboard to type it at the hidden prompt\.$/);
});

test('clipboardUnreadable needs a list', () => {
  assert.throws(() => m.clipboardUnreadable(), TypeError);
  assert.throws(() => m.clipboardUnreadable('xclip'), TypeError);
});

test('connectFullAccess puts the url in the middle and ends with "Nothing was saved."', () => {
  const out = m.connectFullAccess('https://example.com/connect');
  assert.ok(out.endsWith('connect\nNothing was saved.'));
  assert.equal(out.split('\n').length, 2);
});

test('connectFullAccess does not check the url', () => {
  assert.match(m.connectFullAccess(''), /paste that one: \nNothing was saved\.$/);
  assert.match(m.connectFullAccess(undefined), /paste that one: undefined\nNothing was saved\.$/);
});

test('connectSaveFailed repeats the detail as given', () => {
  assert.equal(m.connectSaveFailed(''),
    'Could not save the key: . Nothing was kept. Run `zn-gate connect` to try again.');
  assert.match(m.connectSaveFailed(undefined), /^Could not save the key: undefined\. /);
  assert.match(m.connectSaveFailed(null), /^Could not save the key: null\. /);
  assert.match(m.connectSaveFailed('a\nb'), /^Could not save the key: a\nb\. /);
});

test('revokeNotReached treats empty detail as a network failure', () => {
  for (const d of [undefined, null, '']) {
    const out = m.revokeNotReached(d, 'zn_abc...', DASH, {});
    assert.equal(out, 'Could not reach usezn.com, so key zn_abc... was not revoked. Check your internet connection and run `zn-gate disconnect --revoke` again, or revoke it yourself at ' + DASH + '.');
  }
});

test('revokeNotReached treats Node error codes and odd text as network failures', () => {
  for (const d of ['ECONNRESET', 'timed out', 'HTTP 5xx', 'HTTP ', 'http 500', 'HTTP 500 extra']) {
    assert.match(m.revokeNotReached(d, 'k', DASH, {}), /^Could not reach usezn\.com, so key k was not revoked\./, d);
  }
});

test('revokeNotReached for an HTTP status says the key may still work', () => {
  assert.equal(m.revokeNotReached('HTTP 503', 'k1', DASH, {}),
    'usezn.com is not answering properly right now, so key k1 may still work. Revoke it at ' + DASH + '.');
  assert.match(m.revokeNotReached('HTTP 7', 'k1', DASH, {}), /may still work/);
});

test('revokeNotReached passes a settings sentence through', () => {
  const d = 'HTTPS_PROXY is set to something zn cannot use.';
  assert.equal(m.revokeNotReached(d, 'k2', DASH, VERBOSE),
    d + ' Key k2 was not revoked. Revoke it at ' + DASH + '.');
});

test('revokeNotReached shows detail only in verbose mode, cut at 120 characters', () => {
  assert.ok(!m.revokeNotReached('ECONNRESET', 'k', DASH, {}).includes('Detail'));
  assert.ok(m.revokeNotReached('ECONNRESET', 'k', DASH, VERBOSE).endsWith(' Detail: ECONNRESET.'));
  assert.ok(m.revokeNotReached('HTTP 500', 'k', DASH, VERBOSE).endsWith(' Detail: HTTP 500.'));
  const long = 'E'.repeat(200);
  const out = m.revokeNotReached(long, 'k', DASH, VERBOSE);
  assert.ok(out.endsWith(' Detail: ' + 'E'.repeat(120) + '.'));
  assert.ok(!out.includes('E'.repeat(121)));
});

test('revokeNotReached with empty detail never adds a detail line, even in verbose mode', () => {
  assert.ok(!m.revokeNotReached('', 'k', DASH, VERBOSE).includes('Detail'));
});
