'use strict';
/*
 * Text from the organization's admin or server must not carry invisible characters, Unicode tag characters
 * (U+E0000-E007F) included: the policy note reaches the agent and the organization name reaches the dialogs.
 */
const test = require('node:test');
const assert = require('node:assert');
const policy = require('../lib/team/policy');
const { warnNotice } = require('../lib/team/effective');
const { printable } = require('../lib/team/daemon-ops');
const { field } = require('../lib/vault/confirm');

// Neutral letters hidden as tag characters; built from code points on purpose.
const tags = (s) => Array.from(s).map((c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
const HIDDEN = tags('abc');
const DAY = 86400000;

function pol(reason) {
  const day = Math.floor(Date.parse('2026-10-13T10:00:00Z') / DAY) * DAY;
  return {
    org: 'org_TestOrg12345678', version: 1,
    issued_at: new Date(day).toISOString(), expires_at: new Date(day + 7 * DAY).toISOString(),
    rules: [{ secret: 'PROD_*', agents: ['claude-code'], warn: true, reason }],
  };
}

test('checkShape rejects a rule reason with tag characters, and accepts the clean one', () => {
  assert.strictEqual(policy.checkShape(pol('Needs review')), null);
  const err = policy.checkShape(pol('Needs review' + HIDDEN));
  assert.match(err, /invalid reason/);
  assert.match(err, /Unicode tag/);
  assert.match(policy.checkShape(pol(HIDDEN)), /invalid reason/);
});

test('checkShape rejects the astral invisible ranges and controls in a reason', () => {
  const cps = [0xE0000, 0xE0020, 0xE007F, 0xE0100, 0xE01EF, 0x0A, 0x1B, 0x7F];
  for (const cp of cps) {
    assert.match(policy.checkShape(pol('ok' + String.fromCodePoint(cp) + 'ok')), /invalid reason/, 'U+' + cp.toString(16));
  }
  // the BMP invisibles stay valid in a signed policy; they are removed when the text is shown
  assert.strictEqual(policy.checkShape(pol('ok\u200bok')), null);
  assert.strictEqual(policy.checkShape(pol('caf\u00e9 \u4e2d\u6587 \ud83d\ude00')), null);
});

test('checkShape counts the reason length in code points', () => {
  assert.strictEqual(policy.checkShape(pol('\ud83d\ude00'.repeat(200))), null);
  assert.match(policy.checkShape(pol('\ud83d\ude00'.repeat(201))), /invalid reason/);
});

test('warnNotice strips tag characters and variation selectors', () => {
  const n = warnNotice('PROD_DB', 'Needs' + HIDDEN + ' review\ufe0f\u200b\u202e\u3164' + String.fromCodePoint(0xE0100));
  assert.strictEqual(n, 'zn: your team policy would block PROD_DB here (policy note: "Needs review"). It was allowed and recorded for your organization.');
  for (const c of Array.from(n)) assert.ok(c.codePointAt(0) < 0xE0000);
});

test('warnNotice cuts at 200 code points without splitting a surrogate pair', () => {
  const n = warnNotice('PROD_DB', '\ud83d\ude00'.repeat(300));
  const note = n.match(/policy note: "(.*)"\)/)[1];
  assert.strictEqual(Array.from(note).length, 200);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(n));
});

test('printable strips tag characters and cuts by code points', () => {
  assert.strictEqual(printable('Acme' + HIDDEN + ' Corp', 100), 'Acme Corp');
  assert.strictEqual(printable(HIDDEN, 100), '');
  assert.strictEqual(printable('x\u200by\ufe0fz\u3164', 100), 'xyz');
  const cut = printable('\ud83d\ude00'.repeat(10), 3);
  assert.strictEqual(cut, '\ud83d\ude00'.repeat(3));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut));
  assert.strictEqual(printable(5, 10), null);
});

test('dialog fields show tag characters as escapes instead of hiding them', () => {
  const shown = field('a' + String.fromCodePoint(0xE0041) + 'b');
  assert.strictEqual(shown, 'a\\u{e0041}b');
});
