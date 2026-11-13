'use strict';
/* teamSyncInactive in lib/messages.js: the message shown by `zn team sync` when the
 * organization is not active. It counts the audit records that wait on this machine,
 * with singular and plural forms, and always ends with the command to run later. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { teamSyncInactive } = require('../lib/messages');
const { znCommand } = require('../lib/zn-command');

const NEXT_STEP = 'Once it is active, run: ' + znCommand('team sync');

test('no waiting records: nothing is lost and no count is shown', () => {
  const text = teamSyncInactive(0);
  assert.match(text, /^Your organization is not active on zn right now: ask your organization admin\. /);
  assert.ok(text.includes('Nothing is lost. '), text);
  assert.ok(!/\d/.test(text.replace(NEXT_STEP, '')), text);
  assert.ok(!/audit record/.test(text), text);
});

test('one waiting record uses the singular forms', () => {
  const text = teamSyncInactive(1);
  assert.ok(text.includes('Nothing is lost: 1 audit record stays on this machine'), text);
  assert.ok(text.includes(' is sent when it is active again. '), text);
  assert.ok(!/records|stay |are sent/.test(text), text);
});

test('several waiting records use the plural forms', () => {
  for (const n of [2, 3, 1000]) {
    const text = teamSyncInactive(n);
    assert.ok(text.includes(`Nothing is lost: ${n} audit records stay on this machine`), text);
    assert.ok(text.includes(' are sent when it is active again. '), text);
    assert.ok(!/ stays | is sent /.test(text), text);
  }
});

test('every variant ends with the command to run once active', () => {
  for (const n of [0, 1, 2, 7, undefined, -1]) {
    assert.ok(teamSyncInactive(n).endsWith(NEXT_STEP), String(n));
  }
});

test('undefined and a negative number read like zero', () => {
  const zero = teamSyncInactive(0);
  assert.equal(teamSyncInactive(undefined), zero);
  assert.equal(teamSyncInactive(), zero);
  assert.equal(teamSyncInactive(-1), zero);
  assert.equal(teamSyncInactive(-5), zero);
});
