'use strict';

// Fails when a rule layer changes without a version bump, or when its rule ids
// change without an updated snapshot. Regenerate the snapshot with
// node scripts/update-rules-snapshot.js (see CONTRIBUTING.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const { LAYERS, SNAPSHOT_DIR, computeLayer, compareLayer, compareVersions, readSnapshot } = require('./helpers/rules_snapshot');

const snapshot = readSnapshot();

test('the rules snapshot is committed', () => {
  assert.ok(snapshot, `missing ${SNAPSHOT_DIR}: run node packages/zn-gate/scripts/update-rules-snapshot.js from the repository root`);
});

for (const name of Object.keys(LAYERS)) {
  test(`${name} layer matches the committed snapshot`, () => {
    const actual = computeLayer(name);
    const expected = snapshot && snapshot.layers[name];
    const problems = compareLayer(name, expected, actual).map((p) => p.message);
    assert.equal(problems.length, 0, problems.join('\n'));
  });
}

test('versions compare the integer suffix numerically, not as text', () => {
  assert.ok(compareVersions('2026-10-22.10', '2026-10-22.9') > 0);
  assert.ok(compareVersions('2026-10-22.9', '2026-10-22.10') < 0);
  assert.ok(compareVersions('2026-10-22.6', '2026-10-22.57') < 0);
  assert.equal(compareVersions('2026-10-22.9', '2026-10-22.9'), 0);
  assert.ok(compareVersions('2026-10-23.1', '2026-10-22.99') > 0);
  assert.ok(compareVersions('2026-10-21.99', '2026-10-22.1') < 0);
});

// compareLayer keeps the same verdicts as the single-file snapshot had.
const entry = (version, hash, ids = ['a']) => ({ version, ids, sha256: { 'lib/rules.js': hash } });
const codes = (entries, actual) => compareLayer('rules', entries, actual).map((p) => p.code);

test('a changed file with the same version is unbumped', () => {
  assert.deepEqual(codes([entry('2026-11-11.2', 'h1')], entry('2026-11-11.2', 'h2')), ['unbumped']);
});

test('a changed file with a lower version is backwards', () => {
  assert.deepEqual(codes([entry('2026-11-11.2', 'h1')], entry('2026-11-11.1', 'h2')), ['backwards']);
});

test('a newer version without an entry is stale until the snapshot is regenerated', () => {
  assert.deepEqual(codes([entry('2026-11-11.2', 'h1')], entry('2026-11-11.3', 'h1')), ['stale']);
  assert.deepEqual(codes([entry('2026-11-11.2', 'h1')], entry('2026-11-11.3', 'h2')), ['stale']);
});

test('going back to an older recorded version is rejected', () => {
  const entries = [entry('2026-11-11.2', 'h1'), entry('2026-11-11.3', 'h2')];
  assert.deepEqual(codes(entries, entry('2026-11-11.2', 'h1')), ['backwards']);
});

test('added or removed ids are reported', () => {
  assert.deepEqual(codes([entry('2026-11-11.2', 'h1', ['a'])], entry('2026-11-11.2', 'h1', ['a', 'b'])), ['ids']);
});

test('a layer with no entries is invalid', () => {
  assert.deepEqual(codes([], entry('2026-11-11.2', 'h1')), ['invalid']);
});
