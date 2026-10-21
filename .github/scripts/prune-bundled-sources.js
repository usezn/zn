#!/usr/bin/env node
'use strict';
// Removes TypeScript sources and source maps from the dependencies bundled into the npm tarball.
// The bundled packages run from their compiled .js files; their src/*.ts and *.map files only make
// the package bigger. Type declarations (.d.ts) and licence files are kept.
// Usage: node prune-bundled-sources.js <package dir>   (run after `npm ci`, before `npm pack`)
const fs = require('fs');
const path = require('path');

const pkgDir = path.resolve(process.argv[2] || '.');
const lock = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package-lock.json'), 'utf8'));
// The same set check-npm-pack.js treats as bundled: every non-dev package in the lockfile.
const dirs = Object.entries(lock.packages || {})
  .filter(([key, meta]) => key.startsWith('node_modules/') && !meta.dev)
  .map(([key]) => path.join(pkgDir, key));

const isSource = (name) => /\.(ts|mts|cts)$/.test(name) && !/\.d\.(ts|mts|cts)$/.test(name);
const isMap = (name) => name.endsWith('.map');

let removed = 0;
let bytes = 0;
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    // Nested packages are listed in the lockfile on their own; do not descend into them twice.
    if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p); continue; }
    if (ent.isFile() && (isSource(ent.name) || isMap(ent.name))) {
      bytes += fs.statSync(p).size;
      fs.unlinkSync(p);
      removed++;
    }
  }
}
for (const d of dirs) walk(d);
console.log(`pruned ${removed} source and map files (${bytes} bytes) from ${dirs.length} bundled packages`);
