#!/usr/bin/env node
'use strict';

// Rewrites test/fixtures/rules_snapshot.json from the current rule layers.
//
// It refuses to record a changed file whose layer version did not move: that
// is exactly what the snapshot test exists to catch. Pass --force only when a
// maintainer has decided the change does not need a bump.

const {
  computeSnapshot,
  readSnapshot,
  writeSnapshot,
  compareLayer,
  LAYERS,
  SNAPSHOT_FILE,
} = require('../test/helpers/rules_snapshot');

const force = process.argv.includes('--force');
const previous = readSnapshot();
const next = computeSnapshot();

if (previous && !force) {
  const unbumped = [];
  for (const name of Object.keys(LAYERS)) {
    for (const p of compareLayer(name, previous.layers[name], next.layers[name])) {
      if (p.code === 'unbumped') unbumped.push(p.message);
    }
  }
  if (unbumped.length) {
    console.error(unbumped.join('\n'));
    console.error('Nothing written. Bump the version constant(s) above, or pass --force if no bump is needed.');
    process.exit(1);
  }
}

writeSnapshot(next);
const summary = Object.entries(next.layers).map(([name, l]) => `${name} ${l.version} (${l.ids.length} ids)`).join(', ');
console.log(`wrote ${SNAPSHOT_FILE}`);
console.log(summary);
