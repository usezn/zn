'use strict';
/*
 * The cap on the number of items kept in a change (MAX_ITEMS): the extra
 * items are counted in `more`, not listed.
 */
const test = require('node:test');
const assert = require('node:assert');
const { restrictionChanges, changeRecord, cleanChange, describeChange, MAX_ITEMS } = require('../lib/team/changes');

const ORG = 'org_TestOrg12345678';
const pol = (version, rules) => ({ org: ORG, version, rules });
const blocked = (n) => {
  const rules = [];
  for (let i = 0; i < n; i++) rules.push({ secret: 'FAKE_' + String(i).padStart(2, '0'), agents: ['*'], deny: true });
  return rules;
};

test('the cap is 20', () => {
  assert.strictEqual(MAX_ITEMS, 20);
});

test('25 items keep 20 and report 5 left out', () => {
  const r = restrictionChanges(pol(1, blocked(25)), pol(2, []));
  assert.strictEqual(r.items.length, 20);
  assert.strictEqual(r.more, 5);
  // The first items in secret order are the ones kept.
  assert.strictEqual(r.items[0].secret, 'FAKE_00');
  assert.strictEqual(r.items[19].secret, 'FAKE_19');
  const rec = changeRecord(pol(1, blocked(25)), pol(2, []), '2026-10-23T10:00:00.000Z');
  assert.strictEqual(rec.count, 25);
  assert.strictEqual(rec.more, 5);
  assert.ok(describeChange(rec).includes('  - and 5 more'));
});

test('exactly 20 items leave more at 0', () => {
  const r = restrictionChanges(pol(1, blocked(20)), pol(2, []));
  assert.strictEqual(r.items.length, 20);
  assert.strictEqual(r.more, 0);
  const rec = changeRecord(pol(1, blocked(20)), pol(2, []), '2026-10-23T10:00:00.000Z');
  assert.strictEqual(rec.count, 20);
  assert.ok(!describeChange(rec).some((l) => /more$/.test(l)));
});

test('21 items leave exactly 1 out', () => {
  const r = restrictionChanges(pol(1, blocked(21)), pol(2, []));
  assert.strictEqual(r.items.length, 20);
  assert.strictEqual(r.more, 1);
});

test('reading back a record with 25 items keeps 20 and counts the rest', () => {
  const items = blocked(25).map((r) => ({ kind: 'block_removed', secret: r.secret }));
  const c = cleanChange({ from: 1, to: 2, at: '2026-10-23T10:00:00.000Z', count: 25, items });
  assert.strictEqual(c.items.length, 20);
  assert.strictEqual(c.count, 25);
  assert.strictEqual(c.more, 5);
});
