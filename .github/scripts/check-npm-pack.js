#!/usr/bin/env node
// Checks the file list of the zn-gate npm tarball.
//
// Usage: node .github/scripts/check-npm-pack.js <pack.json> <package dir>
//   <pack.json>    output of `npm pack --json` (or `npm pack --dry-run --json`)
//   <package dir>  directory holding package.json, package-lock.json and
//                  THIRD_PARTY_NOTICES.md (packages/zn-gate)
//
// Fails when:
//   - a required file is missing (entry points, type definitions, LICENSE, THIRD_PARTY_NOTICES.md);
//   - a bundled dependency from package-lock.json is missing from the tarball,
//     or is not listed with its exact version in THIRD_PARTY_NOTICES.md;
//   - the tarball contains the test suite, env files, keys or certificates.
'use strict';

const fs = require('fs');
const path = require('path');

const [packJsonPath, pkgDir] = process.argv.slice(2);
if (!packJsonPath || !pkgDir) {
  console.error('usage: check-npm-pack.js <pack.json> <package dir>');
  process.exit(2);
}

// npm may print lifecycle output before the JSON; start at the first '['.
const raw = fs.readFileSync(packJsonPath, 'utf8');
const pack = JSON.parse(raw.slice(raw.indexOf('[')))[0];
const files = pack.files.map((f) => f.path.replace(/\\/g, '/'));
const has = new Set(files);
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package-lock.json'), 'utf8'));
const notices = fs.readFileSync(path.join(pkgDir, 'THIRD_PARTY_NOTICES.md'), 'utf8');

// Table rows of THIRD_PARTY_NOTICES.md: | name | version | license | source |
const noticeRows = notices.split(/\r?\n/)
  .filter((line) => line.startsWith('|'))
  .map((line) => line.split('|').map((c) => c.trim()));

const errors = [];

const required = ['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', pkg.main];
if (pkg.types) required.push(pkg.types);
else errors.push('package.json has no "types" field');
for (const target of new Set(Object.values(pkg.bin || {}))) required.push(target);
for (const f of required) {
  const p = f.replace(/^\.\//, '');
  if (!has.has(p)) errors.push(`missing required file: ${p}`);
}

// Every non-dev package in the lockfile must ship inside the tarball.
const bundledEntries = Object.entries(lock.packages || {})
  .filter(([key, meta]) => key.startsWith('node_modules/') && !meta.dev);
if (bundledEntries.length === 0) errors.push('package-lock.json lists no bundled dependencies');
for (const [key, meta] of bundledEntries) {
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (!has.has(`${key}/package.json`)) errors.push(`bundled dependency not in tarball: ${key}`);
  if (!files.some((f) => f.startsWith(`${key}/`) && /^licen[cs]e/i.test(path.posix.basename(f)))) {
    errors.push(`bundled dependency ships without a LICENSE file: ${key}`);
  }
  if (!noticeRows.some((c) => c[1] === name && c[2] === meta.version)) {
    errors.push(`THIRD_PARTY_NOTICES.md has no row for ${name} ${meta.version}`);
  }
}
for (const name of pkg.bundleDependencies || pkg.bundledDependencies || []) {
  if (!has.has(`node_modules/${name}/package.json`)) errors.push(`bundleDependencies entry not in tarball: ${name}`);
}

// Nothing that belongs to development or to a local machine.
const forbidden = [
  [/^test\//, 'test suite'],
  [/(^|\/)\.env(\.|$)/, 'env file'],
  [/\.(pem|key|p12|pfx)$/i, 'key or certificate'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, 'SSH key'],
  [/(^|\/)\.npmrc$/, '.npmrc'],
  [/\.tgz$/, 'nested tarball'],
];
for (const f of files) {
  for (const [re, what] of forbidden) {
    if (re.test(f)) errors.push(`unexpected ${what} in tarball: ${f}`);
  }
}

const top = files.filter((f) => !f.startsWith('node_modules/')).length;
console.log(`${pack.name}@${pack.version}: ${files.length} files (${top} own, ${files.length - top} bundled), ` +
  `${pack.unpackedSize} bytes unpacked, ${bundledEntries.length} bundled packages`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
console.log('npm package contents OK');
