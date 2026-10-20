#!/usr/bin/env node
// Checks a CycloneDX SBOM written during the release build: it must be a
// CycloneDX 1.6 JSON document that names zn-gate at the version being released
// and lists its dependencies as components.
//
// Usage: node check-sbom.js <sbom.cdx.json> <version>
'use strict';

const fs = require('node:fs');

const [file, version] = process.argv.slice(2);
if (!file || !version) {
  console.error('usage: check-sbom.js <sbom.cdx.json> <version>');
  process.exit(2);
}

let bom;
try {
  bom = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`::error::${file} is not readable JSON: ${err.message}`);
  process.exit(1);
}

const main = bom.metadata && bom.metadata.component;
const problems = [];
if (bom.bomFormat !== 'CycloneDX') problems.push('bomFormat is not CycloneDX');
if (bom.specVersion !== '1.6') problems.push(`specVersion is ${bom.specVersion}, not 1.6`);
if (!main) problems.push('metadata.component is missing');
else {
  if (main.name !== 'zn-gate') problems.push(`describes ${main.name}, not zn-gate`);
  if (main.version !== version) problems.push(`describes version ${main.version}, not ${version}`);
}
// A package with no dependencies (the Python one) has no component list at all.
if (bom.components !== undefined && !Array.isArray(bom.components)) problems.push('components is not a list');

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${file}: ${p}`);
  process.exit(1);
}
console.log(`${file.split('/').pop()}: zn-gate ${version}, ${(bom.components || []).length} dependencies`);
