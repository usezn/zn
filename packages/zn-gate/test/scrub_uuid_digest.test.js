'use strict';
// The scrubber leaves a UUID and a 64-hex git SHA-256 object id alone: they look random but are not secrets.
// Both values are made up for this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/scrub/engine');

const UUID = '3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b';
const SHA256 = 'a3f1c9e5b7d2468013579bdf02468ace13579bdf02468ace97531fdb86420eca';

const spans = (text) => E.scan(text, { exactFiles: false }).map((s) => ({ type: s.type, text: text.slice(s.start, s.end) }));

test('a UUID is not flagged', () => {
  assert.equal(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(UUID), true);
  for (const text of [UUID, `request id ${UUID} done`, `{"id":"${UUID}"}`, `id: ${UUID}`, `export REQUEST_ID=${UUID}`]) {
    assert.deepEqual(spans(text), [], text);
  }
});

test('a 64-hex git SHA-256 object id is not flagged', () => {
  assert.equal(SHA256.length, 64);
  for (const text of [SHA256, `commit ${SHA256}`, `git show ${SHA256}`, `{"oid":"${SHA256}"}`, `export COMMIT=${SHA256}`]) {
    assert.deepEqual(spans(text), [], text);
  }
});

test('tokenize leaves both values unchanged', async () => {
  const vault = { async mapToken() { throw new Error('the vault must not be asked to mask these'); } };
  const text = `id ${UUID} and commit ${SHA256}`;
  const r = await E.tokenize(text, { vault, exactFiles: false });
  assert.equal(r.text, text);
  assert.deepEqual(r.replaced, []);
});
