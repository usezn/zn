// Tests of check-changelog-fragment-names.mjs. Run: node --test .github/scripts/check-changelog-fragment-names.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { badNames, checkDir } from './check-changelog-fragment-names.mjs';

test('lowercase .md fragments and the README pass', () => {
  assert.deepEqual(badNames(['README.md', 'fix-init-guard.md', 'docs-cli-2.md']), []);
});

test('a name with another extension is named', () => {
  assert.deepEqual(badNames(['fix.txt', 'fix.md']), [{ name: 'fix.txt', reason: 'does not end with .md' }]);
});

test('an upper-case name is named', () => {
  assert.deepEqual(badNames(['Fix-Init.md']), [{ name: 'Fix-Init.md', reason: 'has upper-case letters' }]);
});

test('a hidden file that is not a fragment is named', () => {
  assert.deepEqual(badNames(['.gitkeep']), [{ name: '.gitkeep', reason: 'does not end with .md' }]);
});

test('a README in another case is not skipped', () => {
  assert.deepEqual(badNames(['readme.md']), []);
  assert.deepEqual(badNames(['Readme.md']), [{ name: 'Readme.md', reason: 'has upper-case letters' }]);
});

test('checkDir lists the bad entries of a folder, README excluded', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fragnames-'));
  try {
    for (const n of ['README.md', 'good.md', 'Bad.md', 'notes.txt']) fs.writeFileSync(path.join(dir, n), 'x');
    fs.mkdirSync(path.join(dir, 'nested'));
    const r = checkDir(dir);
    assert.equal(r.checked, 5);
    assert.deepEqual(r.problems.map((p) => p.name), ['Bad.md', 'nested', 'notes.txt']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
