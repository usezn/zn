'use strict';
/*
 * describeItem() turns one change item into a printable line, and
 * MAX_ITEMS caps how many items a change keeps.
 */
const test = require('node:test');
const assert = require('node:assert');
const { describeItem, restrictionChanges, cleanChange, MAX_ITEMS } = require('../lib/team/changes');

test('describeItem words the kinds that only name a secret', () => {
  assert.strictEqual(describeItem({ kind: 'block_removed', secret: 'PROD_KEY' }), 'secret PROD_KEY is no longer blocked');
  assert.strictEqual(describeItem({ kind: 'warn_removed', secret: 'PROD_KEY' }), 'secret PROD_KEY no longer warns');
  assert.strictEqual(describeItem({ kind: 'proxy_removed', secret: 'PROD_KEY' }), 'secret PROD_KEY no longer has to use proxy mode');
  assert.strictEqual(describeItem({ kind: 'hosts_unlimited', secret: 'PROD_KEY' }), 'secret PROD_KEY is no longer limited to a list of hosts');
  assert.strictEqual(describeItem({ kind: 'commands_unlimited', secret: 'PROD_KEY' }), 'secret PROD_KEY is no longer limited to a list of commands');
  assert.strictEqual(describeItem({ kind: 'placement_unlimited', secret: 'PROD_KEY' }),
    'secret PROD_KEY is no longer limited in where it can be put in an HTTP request');
});

test('describeItem says "every secret" for the * pattern', () => {
  assert.strictEqual(describeItem({ kind: 'block_removed', secret: '*' }), 'every secret is no longer blocked');
});

test('describeItem lists the values of widened kinds', () => {
  assert.strictEqual(describeItem({ kind: 'hosts_widened', secret: 'API_KEY', values: ['a.example.com', 'b.example.com'] }),
    'secret API_KEY may now go to more hosts: a.example.com, b.example.com');
  assert.strictEqual(describeItem({ kind: 'commands_widened', secret: 'API_KEY', values: ['git push'] }),
    'secret API_KEY may now be used with more commands: git push');
  assert.strictEqual(describeItem({ kind: 'placement_widened', secret: '*', values: ['header', 'body'] }),
    'every secret may now be put in more places in an HTTP request: header, body');
});

test('describeItem names a removed detector without a secret', () => {
  assert.strictEqual(describeItem({ kind: 'detector_removed', values: ['acme_token'] }),
    'custom secret format acme_token is no longer redacted');
});

test('describeItem returns an empty line for an unknown kind', () => {
  assert.strictEqual(describeItem({ kind: 'something_else', secret: 'X' }), '');
});

test('MAX_ITEMS is 20', () => {
  assert.strictEqual(MAX_ITEMS, 20);
});

test('restrictionChanges keeps at most MAX_ITEMS items and counts the rest in more', () => {
  const rules = [];
  for (let n = 0; n < MAX_ITEMS + 3; n++) rules.push({ secret: 'KEY_' + String(n).padStart(2, '0'), agents: ['*'], deny: true });
  const r = restrictionChanges({ version: 1, rules }, { version: 2, rules: [] });
  assert.strictEqual(r.items.length, MAX_ITEMS);
  assert.strictEqual(r.more, 3);
});

test('cleanChange reads back at most MAX_ITEMS items', () => {
  const items = [];
  for (let n = 0; n < MAX_ITEMS + 5; n++) items.push({ kind: 'block_removed', secret: 'KEY_' + n });
  const c = cleanChange({ from: 1, to: 2, at: '2026-01-01T00:00:00Z', count: items.length, items });
  assert.strictEqual(c.items.length, MAX_ITEMS);
  assert.strictEqual(c.count, MAX_ITEMS + 5);
  assert.strictEqual(c.more, 5);
});
