'use strict';
/*
 * ruleKey and encodePath are not exported, so they are checked through
 * toSarif: the uri of a result and the rule that a finding picks.
 */
const test = require('node:test');
const assert = require('node:assert');
const { toSarif } = require('../lib/reach/sarif');
const { RULES } = require('../lib/audit/rules');

function run(findings) {
  return JSON.parse(toSarif({ findings }, { toolVersion: '0.0.0-test' })).runs[0];
}

function uriOf(file) {
  const r = run([{ kind: 'dotenv', section: 'files', severity: 'high', title: 't', file }]);
  return r.results[0].locations[0].physicalLocation.artifactLocation.uri;
}

test('a percent sign in a path is encoded, so it is not read as an escape', () => {
  assert.strictEqual(uriOf('example/100%/.env'), 'example/100%25/.env');
  assert.strictEqual(uriOf('example/a%20b/.env'), 'example/a%2520b/.env');
});

test('a backslash is not a separator and is encoded inside the segment', () => {
  assert.strictEqual(uriOf('example\\app/.env'), 'example%5Capp/.env');
});

test('spaces and reserved characters are encoded per segment', () => {
  assert.strictEqual(uriOf('my app/a#b?c/.env'), 'my%20app/a%23b%3Fc/.env');
});

test('a very long segment is kept whole', () => {
  const seg = 'a b'.repeat(2000);
  const uri = uriOf(seg + '/.env');
  assert.strictEqual(uri, seg.replace(/ /g, '%20') + '/.env');
});

test('a reach finding picks its rule by kind, an agents section picks the agent rule', () => {
  const r = run([
    { kind: 'credential-files', section: 'files', severity: 'low', title: 't', file: 'example/c' },
    { kind: 'other', section: 'agents', severity: 'low', title: 't', file: 'example/a' },
  ]);
  assert.deepStrictEqual(r.results.map((x) => x.ruleId), ['ZNR003', 'ZNR001']);
});

test('an audit finding picks its rule by id', () => {
  const id = RULES[0].id;
  const r = run([{ kind: 'audit', id, section: 'agents', severity: 'low', title: 't', file: 'example/a' }]);
  assert.strictEqual(r.results.length, 1);
  assert.strictEqual(r.results[0].ruleId, id);
});

test('a rule name with unusual characters gives no result and does not throw', () => {
  for (const id of ['nope', '', 'ZNA 001/../x', '规则\u0000']) {
    const r = run([{ kind: 'audit', id, section: 'files', severity: 'high', title: 't', file: 'example/a' }]);
    assert.strictEqual(r.results.length, 0, JSON.stringify(id));
    assert.deepStrictEqual(r.tool.driver.rules, []);
  }
});

test('an unknown kind gives no result', () => {
  const r = run([{ kind: 'unknown kind', section: 'files', severity: 'high', title: 't', file: 'example/a' }]);
  assert.strictEqual(r.results.length, 0);
});
