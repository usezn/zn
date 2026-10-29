'use strict';

// patchFiles of the Codex adapter: the file names an apply_patch text names,
// for each kind of change, for all of them together, and for text that is not
// a patch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../lib/agents/codex');

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-patch-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const wrap = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

test('patchFiles: an update names the file', () => {
  assert.deepEqual(codex.patchFiles(wrap('*** Update File: src/a.js', '@@', '-old', '+new')), ['src/a.js']);
});

test('patchFiles: an add names the file', () => {
  assert.deepEqual(codex.patchFiles(wrap('*** Add File: src/b.js', '+content')), ['src/b.js']);
});

test('patchFiles: a delete names the file', () => {
  assert.deepEqual(codex.patchFiles(wrap('*** Delete File: src/c.js')), ['src/c.js']);
});

test('patchFiles: a move names the old and the new file', () => {
  const out = codex.patchFiles(wrap('*** Update File: src/old.js', '*** Move to: src/new.js', '@@', '-a', '+b'));
  assert.deepEqual(out.sort(), ['src/new.js', 'src/old.js']);
});

test('patchFiles: update, add, delete and move together, with temporary paths', () => {
  const t = tmpDir();
  try {
    const f = (n) => path.join(t.dir, n);
    const patch = wrap(
      '*** Update File: ' + f('u.txt'), '@@', '-1', '+2',
      '*** Add File: ' + f('a.txt'), '+hello',
      '*** Delete File: ' + f('d.txt'),
      '*** Update File: ' + f('m-old.txt'),
      '*** Move to: ' + f('m-new.txt'),
      '@@', '-x', '+y'
    );
    const out = codex.patchFiles(patch);
    assert.deepEqual(
      out.sort(),
      [f('u.txt'), f('a.txt'), f('d.txt'), f('m-old.txt'), f('m-new.txt')].sort()
    );
  } finally {
    t.done();
  }
});

test('patchFiles: an empty text names nothing', () => {
  assert.deepEqual(codex.patchFiles(''), []);
  assert.deepEqual(codex.patchFiles(undefined), []);
  assert.deepEqual(codex.patchFiles(null), []);
});

test('patchFiles: text that is not a patch names nothing', () => {
  assert.deepEqual(codex.patchFiles('just some words\nand a second line'), []);
  assert.deepEqual(codex.patchFiles('npm test && echo done'), []);
});
