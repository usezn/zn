'use strict';
/*
 * SARIF output of `zn-gate reach --sarif` for a small fixture: rules, levels,
 * locations, notifications and stable fingerprints.
 */
const test = require('node:test');
const assert = require('node:assert');
const { toSarif } = require('../lib/reach/sarif');

const FINDINGS = [
  { kind: 'dotenv', section: 'files', severity: 'high', title: '1 secret in .env', file: 'my app/.env', line: 3 },
  { kind: 'dotenv', section: 'files', severity: 'medium', title: '2 secrets in .env', file: 'my app/.env' },
  { kind: 'agents', section: 'agents', severity: 'high', title: 'Example agent is not protected' },
  { kind: 'credential-files', section: 'files', severity: 'low', title: 'Credential file', file: '~/.example/credentials' },
  { kind: 'dotenv', section: 'files', severity: 'info', title: 'Already protected', file: 'x/.env' },
];

function run(findings = FINDINGS) {
  return JSON.parse(toSarif({ findings }, { toolVersion: '0.0.0-test' }));
}

test('document shape and tool metadata', () => {
  const s = run();
  assert.strictEqual(s.version, '2.1.0');
  assert.strictEqual(s.runs.length, 1);
  const run0 = s.runs[0];
  assert.strictEqual(run0.tool.driver.name, 'zn-gate reach');
  assert.strictEqual(run0.tool.driver.version, '0.0.0-test');
  assert.ok(run0.originalUriBaseIds['%SRCROOT%']);
  assert.ok(toSarif({ findings: [] }).endsWith('\n'));
});

test('file findings become results with level, location and rule index', () => {
  const run0 = run().runs[0];
  assert.strictEqual(run0.results.length, 2);
  const [a, b] = run0.results;
  assert.strictEqual(a.ruleId, 'ZNR002');
  assert.strictEqual(a.level, 'error');
  assert.strictEqual(b.level, 'warning');
  assert.strictEqual(a.locations[0].physicalLocation.artifactLocation.uri, 'my%20app/.env');
  assert.strictEqual(a.locations[0].physicalLocation.artifactLocation.uriBaseId, '%SRCROOT%');
  assert.strictEqual(a.locations[0].physicalLocation.region.startLine, 3);
  assert.strictEqual(b.locations[0].physicalLocation.region.startLine, 1);
  assert.strictEqual(a.properties['security-severity'], '8.0');
  assert.strictEqual(run0.tool.driver.rules.length, 1);
  assert.strictEqual(run0.tool.driver.rules[a.ruleIndex].id, 'ZNR002');
});

test('machine findings and info findings do not become results', () => {
  const run0 = run().runs[0];
  const notes = run0.invocations[0].toolExecutionNotifications;
  assert.deepStrictEqual(notes.map((n) => n.level), ['error', 'note']);
  assert.strictEqual(notes[0].properties.section, 'agents');
  assert.ok(!JSON.stringify(run0).includes('Already protected'));
});

test('fingerprints are stable and differ for repeated findings in one file', () => {
  const same = [FINDINGS[0], FINDINGS[0]];
  const r1 = run(same).runs[0].results;
  const r2 = run(same).runs[0].results;
  assert.notStrictEqual(r1[0].partialFingerprints['znReach/v1'], r1[1].partialFingerprints['znReach/v1']);
  assert.deepStrictEqual(r1, r2);
});

test('an audit finding keeps its ZNA rule and an unknown rule is skipped', () => {
  const s = run([
    { kind: 'audit', id: 'ZNA001', section: 'files', severity: 'high', title: 'Auto-run', file: 'a.json', line: 2 },
    { kind: 'audit', id: 'ZNA999', section: 'files', severity: 'high', title: 'Unknown', file: 'b.json' },
  ]);
  const res = s.runs[0].results;
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].ruleId, 'ZNA001');
  assert.match(s.runs[0].tool.driver.rules[0].help.text, /Fix: /);
});
