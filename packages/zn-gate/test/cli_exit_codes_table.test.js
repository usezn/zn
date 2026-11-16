'use strict';
// The exit code table of docs/cli.md matches the codes the program uses:
//   - every code in the table is used by bin/cli.js, or by the broker code that turns an
//     error code of lib/errors.js (and ZN_USAGE) into an exit status;
//   - every code those files use appears in the table.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const docs = read(repoRoot, 'docs', 'cli.md');
const cliSrc = read(pkgRoot, 'bin', 'cli.js');
const errorsSrc = read(pkgRoot, 'lib', 'errors.js');
const brokerSrcs = [read(pkgRoot, 'lib', 'broker', 'run.js'), read(pkgRoot, 'lib', 'broker', 'cli.js')];

function documentedCodes() {
  const section = docs.split(/^## Exit codes\s*$/m)[1];
  assert.ok(section, 'docs/cli.md has an "Exit codes" section');
  const rows = section.split(/^## /m)[0].split('\n').filter((l) => /^\|\s*`\d+`\s*\|/.test(l));
  return rows.map((l) => Number(/`(\d+)`/.exec(l)[1]));
}

function usedCodes() {
  const used = new Set([0]); // success is always possible
  const numbers = (text) => (text.match(/\b\d+\b/g) || []).map(Number);
  // process.exit(N), process.exit(cond ? A : B), process.exitCode = N
  for (const m of cliSrc.matchAll(/process\.exit\(([^()]*)\)|process\.exitCode = ([^;(]*);/g)) {
    for (const n of numbers(m[1] !== undefined ? m[1] : m[2])) used.add(n);
  }
  // `err.code === 'ZN_X' ? N` / `if (err.code === 'ZN_X') return N` in the broker
  for (const src of brokerSrcs) {
    for (const m of src.matchAll(/code === 'ZN_[A-Z_]+'\)?\s*(?:\?|return)\s*(\d+)/g)) used.add(Number(m[1]));
    for (const m of src.matchAll(/:\s*(\d+)\s*;/g)) if (/code === 'ZN_/.test(src)) used.add(Number(m[1]));
  }
  return used;
}

test('the exit code table lists each code once', () => {
  const codes = documentedCodes();
  assert.ok(codes.length >= 6);
  assert.strictEqual(new Set(codes).size, codes.length);
});

test('every code in the table is used by the program', () => {
  const used = usedCodes();
  for (const code of documentedCodes()) {
    assert.ok(used.has(code), 'exit code ' + code + ' is in docs/cli.md but no code path uses it');
  }
});

test('every code the program uses is in the table', () => {
  const documented = new Set(documentedCodes());
  for (const code of usedCodes()) {
    assert.ok(documented.has(code), 'exit code ' + code + ' is used but missing from docs/cli.md');
  }
});

test('the codes of lib/errors.js that map to an exit status are covered', () => {
  // ZN_POLICY_DENIED -> 77 and ZN_NOT_FOUND -> 127 in the broker; both must be in the table.
  assert.match(errorsSrc, /POLICY_DENIED: 'ZN_POLICY_DENIED'/);
  assert.match(errorsSrc, /NOT_FOUND: 'ZN_NOT_FOUND'/);
  const used = usedCodes();
  for (const code of [64, 77, 127]) assert.ok(used.has(code), 'broker status ' + code + ' is found');
});
