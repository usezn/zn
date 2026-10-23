// Tests for check-rule-versions.mjs: run with `node --test .github/scripts/check-rule-versions.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPECS, PARITY, compareVersions, extractVersion, checkVersions } from './check-rule-versions.mjs';

const ids = SPECS.map((s) => s.id);
const all = (v) => Object.fromEntries(ids.map((id) => [id, v]));
const run = (head, base, changedFiles = []) =>
  checkVersions({ head: { ...all('2026-10-22.5'), ...head }, base: { ...all('2026-10-22.5'), ...base }, changedFiles });

test('compareVersions orders the integer suffix numerically', () => {
  assert.ok(compareVersions('2026-10-22.10', '2026-10-22.9') > 0);
  assert.ok(compareVersions('2026-10-22.9', '2026-10-22.10') < 0);
  assert.ok(compareVersions('2026-10-22.6', '2026-10-22.57') < 0);
  assert.ok(compareVersions('2026-10-22.57', '2026-10-22.6') > 0);
  assert.equal(compareVersions('2026-10-22.6', '2026-10-22.6'), 0);
  assert.ok(compareVersions('2026-10-23.1', '2026-10-22.99') > 0);
  assert.ok(compareVersions('2026-11-01.1', '2026-10-31.1') > 0);
});

test('.10 after .9, and a new date with a lower suffix, pass', () => {
  assert.deepEqual(
    run({ 'node:RULES_VERSION': '2026-10-22.10', 'py:RULES_VERSION': '2026-10-22.10' }, { 'node:RULES_VERSION': '2026-10-22.9', 'py:RULES_VERSION': '2026-10-22.9' }),
    [],
  );
  assert.deepEqual(run({ 'node:SCRUB_RULES_VERSION': '2026-10-23.6' }, { 'node:SCRUB_RULES_VERSION': '2026-10-22.57' }), []);
});

test('a lower suffix on the same date is backwards', () => {
  const p = run({ 'node:AUDIT_RULES_VERSION': '2026-10-22.9' }, { 'node:AUDIT_RULES_VERSION': '2026-10-22.10' });
  assert.equal(p.length, 1);
  assert.match(p[0], /AUDIT_RULES_VERSION/);
  assert.match(p[0], /went backwards/);
  assert.match(p[0], /2026-10-22\.9/);
  assert.match(p[0], /2026-10-22\.10/);
  assert.equal(run({ 'node:AUDIT_RULES_VERSION': '2026-10-22.6' }, { 'node:AUDIT_RULES_VERSION': '2026-10-22.57' }).length, 1);
});

test('an earlier date is backwards even with a larger suffix', () => {
  const p = run({ 'node:POLICY_RULES_VERSION': '2026-10-21.99' }, { 'node:POLICY_RULES_VERSION': '2026-10-22.1' });
  assert.equal(p.length, 1);
  assert.match(p[0], /went backwards/);
});

test('an equal version with no changed layer files passes', () => {
  assert.deepEqual(run({}, {}, ['README.md', 'packages/zn-gate/lib/other.js']), []);
});

test('changed layer files with an unchanged version fail, naming file and value', () => {
  const p = run({}, {}, ['packages/zn-gate/lib/mcp-secrets.js']);
  assert.equal(p.length, 1);
  assert.match(p[0], /packages\/zn-gate\/lib\/mcp-secrets\.js/);
  assert.match(p[0], /RULES_VERSION/);
  assert.match(p[0], /2026-10-22\.5/);
});

test('the same files with a bumped version pass', () => {
  assert.deepEqual(
    run({ 'node:RULES_VERSION': '2026-10-22.6', 'py:RULES_VERSION': '2026-10-22.6' }, {}, ['packages/zn-gate/lib/rules.js', 'packages/zn-gate-py/src/zn_gate/rules.py']),
    [],
  );
});

test('python and command files each need their own bump', () => {
  assert.equal(run({}, {}, ['packages/zn-gate-py/src/zn_gate/destructive.py']).length, 1);
  assert.equal(run({}, {}, ['packages/zn-gate/lib/destructive.js']).length, 2); // policy layer and command constant
});

test('a bump to a new date passes with changed files', () => {
  assert.deepEqual(
    run({ 'node:SCRUB_RULES_VERSION': '2026-10-23.1' }, { 'node:SCRUB_RULES_VERSION': '2026-10-22.5' }, ['packages/zn-gate/lib/scrub/exact.js']),
    [],
  );
});

test('a constant that is missing at the base is accepted', () => {
  const p = run({}, { 'node:COMMAND_RULES_VERSION': undefined, 'py:COMMAND_RULES_VERSION': null }, [
    'packages/zn-gate/lib/destructive.js',
    'packages/zn-gate-py/src/zn_gate/destructive.py',
  ]);
  assert.equal(p.filter((m) => /COMMAND_RULES_VERSION/.test(m)).length, 0);
});

test('malformed versions at HEAD fail', () => {
  for (const bad of ['2026-10-22', '2026-10-22.', '2026-10-22.x', '26-10-22.1', '2026-10-22.1-rc', ' 2026-10-22.1', '', null, undefined]) {
    const p = run({ 'node:AUDIT_RULES_VERSION': bad }, {});
    assert.equal(p.length, 1, String(bad));
    assert.match(p[0], /AUDIT_RULES_VERSION/);
    assert.match(p[0], /YYYY-MM-DD\.N/);
  }
});

test('a malformed base value cannot be compared and is skipped', () => {
  assert.deepEqual(run({}, { 'node:AUDIT_RULES_VERSION': 'garbage' }, ['packages/zn-gate/lib/audit/rules.js']), []);
});

test('Node and Python must agree on rules and command versions', () => {
  const a = run({ 'node:RULES_VERSION': '2026-10-22.10', 'py:RULES_VERSION': '2026-10-22.9' }, {});
  assert.equal(a.length, 1);
  assert.match(a[0], /differs between packages/);
  const b = run({ 'py:COMMAND_RULES_VERSION': '2026-10-22.6' }, {});
  assert.equal(b.length, 1);
  assert.match(b[0], /COMMAND_RULES_VERSION differs/);
  assert.equal(PARITY.length, 2);
});

test('extractVersion reads JS and Python constants and ignores comments', () => {
  const js = SPECS.find((s) => s.id === 'node:RULES_VERSION');
  const py = SPECS.find((s) => s.id === 'py:RULES_VERSION');
  assert.equal(extractVersion(" * RULES_VERSION: 2026-10-22.9\nconst RULES_VERSION = '2026-10-22.9';\n", js), '2026-10-22.9');
  assert.equal(extractVersion('RULES_VERSION: 2026-10-19.1\n"""\nRULES_VERSION = "2026-10-22.9"\n', py), '2026-10-22.9');
  assert.equal(extractVersion('const OTHER = 1;', js), null);
  assert.equal(extractVersion(null, js), null);
  assert.equal(extractVersion('const RULES_VERSION = `2026-10-22.9`;', js), null);
});
