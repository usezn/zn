'use strict';
// Source hygiene: every file in lib/ and every test file starts with 'use strict'
// within its first three lines, and no test file leaves a `.only` behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'fixtures', 'helpers']);

// Files that are not meant to be strict, relative to the package root, each with the reason.
const EXCEPTIONS = [
  // (none yet)
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && /\.(js|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const libFiles = walk(path.join(root, 'lib'), []);
const testFiles = walk(path.join(root, 'test'), []).filter((f) => f.endsWith('.test.js'));
const strictFiles = [...libFiles, ...testFiles].filter((f) => !EXCEPTIONS.includes(rel(f)));

test('the file lists are not empty', () => {
  assert.ok(libFiles.length > 0);
  assert.ok(testFiles.length > 0);
});

test("every lib file and test file has 'use strict' in its first three lines", () => {
  const bad = strictFiles.filter((f) => {
    const head = fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(0, 3);
    return !head.some((line) => /^\s*(['"])use strict\1;?\s*$/.test(line));
  });
  assert.deepEqual(bad.map(rel), []);
});

test('no test file calls .only', () => {
  const bad = testFiles.filter((f) => /\b(?:test|it|describe|suite)\.only\s*\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map(rel), []);
});
