'use strict';

// Fails when a rule layer changes without a version bump, or when its rule ids
// change without an updated snapshot. Regenerate the snapshot with
// node scripts/update-rules-snapshot.js (see CONTRIBUTING.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const { LAYERS, SNAPSHOT_FILE, computeLayer, compareLayer, compareVersions, readSnapshot } = require('./helpers/rules_snapshot');

const snapshot = readSnapshot();

test('the rules snapshot is committed', () => {
  assert.ok(snapshot, `missing ${SNAPSHOT_FILE}: run node scripts/update-rules-snapshot.js`);
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
