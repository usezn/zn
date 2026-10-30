'use strict';
/*
 * toSarif and the REACH_RULES table: an empty result, one finding, several
 * findings, a long path and the fields of every table entry.
 */
const test = require('node:test');
const assert = require('node:assert');
const { toSarif, REACH_RULES } = require('../lib/reach/sarif');

function doc(findings, meta) {
  return JSON.parse(toSarif({ findings }, meta));
}

test('an empty result has no results, rules or notifications', () => {
  const s = doc([], { toolVersion: '1.2.3' });
  const run = s.runs[0];
  assert.deepStrictEqual(run.results, []);
  assert.deepStrictEqual(run.tool.driver.rules, []);
  assert.deepStrictEqual(run.invocations, [{ executionSuccessful: true, toolExecutionNotifications: [] }]);
  assert.strictEqual(run.tool.driver.semanticVersion, '1.2.3');
});

test('without meta the tool version is left out', () => {
  const driver = doc([]).runs[0].tool.driver;
  assert.strictEqual(driver.version, undefined);
  assert.strictEqual(driver.semanticVersion, undefined);
});

test('one finding gives one result and one rule', () => {
  const s = doc([{ kind: 'dotenv', section: 'files', severity: 'low', title: '1 secret in .env', detail: 'in the project', fix: 'use zn', file: 'app/.env', line: 7 }]);
  const run = s.runs[0];
  assert.strictEqual(run.results.length, 1);
  assert.strictEqual(run.tool.driver.rules.length, 1);
  const r = run.results[0];
  assert.strictEqual(r.ruleId, 'ZNR002');
  assert.strictEqual(r.ruleIndex, 0);
  assert.strictEqual(r.level, 'note');
  assert.strictEqual(r.message.text, '1 secret in .env: in the project Fix: use zn');
  assert.strictEqual(r.properties['security-severity'], '3.0');
  assert.match(r.partialFingerprints['znReach/v1'], /^[0-9a-f]{64}$/);
});

test('several findings share one rule entry per rule, in order of first use', () => {
  const run = doc([
    { kind: 'dotenv', section: 'files', severity: 'high', title: 'a', file: 'a/.env' },
    { kind: 'audit', id: 'ZNA001', section: 'files', severity: 'medium', title: 'Auto-run', file: 'b.json' },
    { kind: 'dotenv', section: 'files', severity: 'medium', title: 'c', file: 'c/.env' },
  ]).runs[0];
  assert.deepStrictEqual(run.results.map((r) => r.ruleId), ['ZNR002', 'ZNA001', 'ZNR002']);
  assert.deepStrictEqual(run.results.map((r) => r.ruleIndex), [0, 1, 0]);
  assert.deepStrictEqual(run.tool.driver.rules.map((r) => r.id), ['ZNR002', 'ZNA001']);
  assert.strictEqual(run.results[1].properties['security-severity'], '5.0');
});

test('a long path is kept whole and encoded one segment at a time', () => {
  const dir = Array.from({ length: 60 }, (_, i) => 'dir ' + i).join('/');
  const file = dir + '/.env';
  const uri = doc([{ kind: 'dotenv', section: 'files', severity: 'high', title: 't', file }])
    .runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
  assert.strictEqual(uri, file.replace(/ /g, '%20'));
  assert.ok(uri.length > 400);
  assert.strictEqual(uri.split('/').length, 61);
});

test('absolute paths become notifications, not results', () => {
  const run = doc([
    { kind: 'dotenv', section: 'files', severity: 'high', title: 'u', file: '/srv/example/.env' },
    { kind: 'dotenv', section: 'files', severity: 'high', title: 'w', file: 'C:\\example\\.env' },
  ]).runs[0];
  assert.strictEqual(run.results.length, 0);
  assert.strictEqual(run.invocations[0].toolExecutionNotifications.length, 2);
});

test('every table entry has the same fields and a unique ZNR id', () => {
  const keys = Object.keys(REACH_RULES);
  assert.deepStrictEqual(keys, ['agent', 'dotenv', 'credential-files', 'environment']);
  const ids = new Set();
  for (const k of keys) {
    const e = REACH_RULES[k];
    assert.deepStrictEqual(Object.keys(e).sort(), ['help', 'id', 'name', 'title']);
    for (const f of Object.values(e)) assert.ok(typeof f === 'string' && f.length > 0);
    assert.match(e.id, /^ZNR\d{3}$/);
    assert.match(e.name, /^[A-Z][A-Za-z]+$/);
    ids.add(e.id);
  }
  assert.strictEqual(ids.size, keys.length);
});

test('every table entry becomes a SARIF rule with its own text', () => {
  const cases = [
    ['agent', { kind: 'agents', section: 'agents' }],
    ['dotenv', { kind: 'dotenv', section: 'files' }],
    ['credential-files', { kind: 'credential-files', section: 'files' }],
    ['environment', { kind: 'environment', section: 'files' }],
  ];
  for (const [key, extra] of cases) {
    const e = REACH_RULES[key];
    const run = doc([{ ...extra, severity: 'high', title: 't', file: 'x/file' }]).runs[0];
    assert.strictEqual(run.results.length, 1, key);
    assert.deepStrictEqual(run.tool.driver.rules[0], {
      id: e.id,
      name: e.name,
      shortDescription: { text: e.title },
      fullDescription: { text: e.help },
      help: { text: e.help },
    });
  }
});
