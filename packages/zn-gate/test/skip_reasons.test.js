'use strict';
// Every skipped test says why. A skip with no reason prints "skipped" and nothing else, so nobody
// can tell a platform limit from a missing tool from a known gap. helpers/skip_reasons.js finds the
// skips whose reason can never be a string; this test runs it over every test file and tests the
// checker itself on small samples.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findUnreasoned } = require('./helpers/skip_reasons');

const testDir = __dirname;

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') out.push(...sourceFiles(full)); } else if (/\.[cm]?js$/.test(e.name)) out.push(full);
  }
  return out;
}

test('every skipped test in the Node suite names its reason', () => {
  const bad = [];
  for (const file of sourceFiles(testDir)) {
    for (const f of findUnreasoned(fs.readFileSync(file, 'utf8'))) bad.push(path.relative(testDir, file).split(path.sep).join('/') + ':' + f.line + '  ' + f.why);
  }
  assert.deepEqual(bad, [], 'give each skip a reason string, for example: { skip: process.platform === \'win32\' && \'POSIX only\' }');
});

const flagged = (src) => findUnreasoned(src).length;

test('checker: a bare condition, true, a shorthand and a bare t.skip() have no reason', () => {
  assert.equal(flagged("test('a', { skip: process.platform === 'win32' }, () => {});"), 1);
  assert.equal(flagged("test('a', { skip: !posix }, () => {});"), 1);
  assert.equal(flagged("test('a', { skip: true }, () => {});"), 1);
  assert.equal(flagged("test('a', { skip: !haveGit || isRoot }, () => {});"), 1);
  assert.equal(flagged("test('a', { skip: cond ? true : false }, () => {});"), 1);
  assert.equal(flagged("const skip = false;\nconst x = { skip };"), 1);
  assert.equal(flagged("test('a', (t) => { t.skip(); });"), 1);
  assert.equal(flagged("test('a', (t) => { t.skip(''); });"), 1);
  assert.equal(flagged("test('a', (t) => { t.skip('  '); });"), 1);
});

test('checker: test.skip, it.skip and describe.skip have no place for a reason', () => {
  assert.equal(flagged("test.skip('a', () => {});"), 1);
  assert.equal(flagged("it.skip('a', () => {});"), 1);
  assert.equal(flagged("describe.skip('a', () => {});"), 1);
  assert.equal(flagged("const run = cond ? test : test.skip;"), 1);
});

test('checker: a reason string in the result of the expression is accepted', () => {
  assert.equal(flagged("test('a', { skip: process.platform === 'win32' && 'POSIX only' }, () => {});"), 0);
  assert.equal(flagged("test('a', { skip: (!posix || isRoot) && 'POSIX only, not as root' }, () => {});"), 0);
  assert.equal(flagged("test('a', { skip: isWin ? 'POSIX only' : false }, () => {});"), 0);
  assert.equal(flagged("test('a', { skip: isWin ? false : 'Windows only' }, () => {});"), 0);
  assert.equal(flagged("test('a', { skip: 'not adapted yet' }, () => {});"), 0);
  assert.equal(flagged("test('a', { skip: `needs ${tool}` }, () => {});"), 0);
  assert.equal(flagged("test('a', { skip: skipUnlessPosixSh('reason') }, () => {});"), 0);
  assert.equal(flagged("test('a', (t) => { t.skip('no /proc here'); });"), 0);
  assert.equal(flagged("test('a', (t) => { t.skip(`cannot link (${e.code})`); });"), 0);
  assert.equal(flagged("test('a', (t) => { t.skip(why); });"), 0);
});

test('checker: a string that only sits in a comparison is not a reason', () => {
  assert.equal(flagged("test('a', { skip: process.platform === 'win32' }, () => {});"), 1);
  assert.equal(flagged("test('a', { skip: process.platform !== 'linux' }, () => {});"), 1);
  assert.equal(flagged("test('a', { skip: !fs.existsSync('docs') }, () => {});"), 1);
  assert.equal(flagged("test('a', { skip: list.includes('x') }, () => {});"), 1);
});

test('checker: a named condition counts only when its declaration in the file carries a reason', () => {
  assert.equal(flagged("const needSh = !SH && 'needs sh';\ntest('a', { skip: needSh }, () => {});"), 0);
  assert.equal(flagged("const NO_PY = PYTHON ? false : 'no python';\ntest('a', { skip: NO_PY }, () => {});"), 0);
  assert.equal(flagged("const WIN = process.platform === 'win32';\ntest('a', { skip: WIN }, () => {});"), 1);
  assert.equal(flagged("test('a', { skip: unknownName }, () => {});"), 1);
  assert.equal(flagged("const skip = present ? false : 'docs are not here';\ntest('a', { skip }, () => {});"), 0);
  // An options object is judged where its skip: is written.
  assert.equal(flagged("const posix = { skip: process.platform === 'win32' };\ntest('a', posix, () => {});"), 1);
  assert.equal(flagged("const posix = { skip: process.platform === 'win32' && 'POSIX only' };\ntest('a', posix, () => {});"), 0);
});

test('checker: no skip, skip: false, and the word skip in text or comments are not flagged', () => {
  assert.equal(flagged("test('a', () => {});"), 0);
  assert.equal(flagged("test('a', { skip: false }, () => {});"), 0);
  assert.equal(flagged("// skip: true\n/* t.skip() */\nconst s = 'skip: true and t.skip()';"), 0);
  assert.equal(flagged("const s = `skip: ${x}`;\nconst r = /skip: true/;\nconst d = a / b; const e = { skip: false };"), 0);
  assert.equal(flagged("const c = { skipOn: ['win32'] };\nfoo.skipped(1);\nconst m = { skip: cond && 'why', other: 1 };"), 0);
});

test('checker: reports the line of each skip', () => {
  const found = findUnreasoned("const a = 1;\n\ntest('a', { skip: !posix }, () => {});\ntest('b', { skip: !posix && 'POSIX only' }, () => {});\ntest('c', (t) => { t.skip(); });\n");
  assert.deepEqual(found.map((f) => f.line), [3, 5]);
});
