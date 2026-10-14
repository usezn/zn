'use strict';

// Fails when a rule layer changes without a version bump, or when its rule ids
// change without an updated snapshot. Regenerate the snapshot with
// node scripts/update-rules-snapshot.js (see CONTRIBUTING.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const { LAYERS, SNAPSHOT_FILE, computeLayer, compareLayer, readSnapshot } = require('./helpers/rules_snapshot');

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
