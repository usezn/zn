#!/usr/bin/env node
'use strict';

// Rewrites test/fixtures/rules_snapshot.json from the current rule layers.
//
// It refuses to record a change whose layer version did not increase: that is
// exactly what the snapshot test exists to catch. --force writes anyway and
// prints a loud warning; a reviewer must justify any such change in the pull
// request (see CONTRIBUTING.md).

const path = require('path');
const {
  computeSnapshot,
  readSnapshot,
  writeSnapshot,
  compareLayer,
  BLOCKING_CODES,
  LAYERS,
  SNAPSHOT_FILE,
} = require('../test/helpers/rules_snapshot');

const force = process.argv.includes('--force');
const previous = readSnapshot();
const next = computeSnapshot();

if (previous) {
  const blocking = [];
  for (const name of Object.keys(LAYERS)) {
    for (const p of compareLayer(name, previous.layers[name], next.layers[name])) {
      if (BLOCKING_CODES.includes(p.code)) blocking.push(p.message);
    }
  }
  if (blocking.length && !force) {
    console.error(blocking.join('\n'));
    console.error('Nothing written. Bump the version constant(s) above so they increase, or pass --force if a reviewer has approved a change without a bump.');
    process.exit(1);
  }
  if (blocking.length && force) {
    const bar = '!'.repeat(72);
    console.error(bar);
    console.error('WARNING: --force is writing a rule change without a version increase.');
    console.error('A reviewer must justify this in the pull request:');
    for (const m of blocking) console.error('  - ' + m);
    console.error(bar);
  }
}

writeSnapshot(next);
const summary = Object.entries(next.layers).map(([name, l]) => `${name} ${l.version} (${l.ids.length} ids)`).join(', ');
console.log(`wrote ${path.relative(process.cwd(), SNAPSHOT_FILE) || SNAPSHOT_FILE}`);
console.log(summary);
