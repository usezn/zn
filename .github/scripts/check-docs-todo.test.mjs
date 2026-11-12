// Tests of check-docs-todo.mjs. Run: node --test .github/scripts/check-docs-todo.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkPaths, findMarkers } from './check-docs-todo.mjs';

test('a literal TODO or FIXME is a marker, with its line number', () => {
  const hits = findMarkers('intro\nTODO: write this\nsome FIXME here\n');
  assert.deepEqual(hits.map((h) => [h.line, h.word]), [[2, 'TODO'], [3, 'FIXME']]);
});

test('the word must stand alone', () => {
  assert.deepEqual(findMarkers('TODOS and XFIXME and FIXMEs\n'), []);
});

test('lower-case prose is not a marker', () => {
  assert.deepEqual(findMarkers('a todo list, fixme later\n'), []);
});

test('a marker inside a code block counts', () => {
  assert.equal(findMarkers('```sh\n# TODO\n```\n').length, 1);
});

test('two markers on one line are two hits', () => {
  assert.equal(findMarkers('TODO and FIXME\n').length, 2);
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'docstodo-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('clean docs pass and only .md files are read', () => {
  const dir = tree({ 'docs/a.md': '# A\n', 'docs/sub/b.md': 'text\n', 'docs/notes.txt': 'TODO\n', 'README.md': '# R\n' });
  const r = checkPaths([path.join(dir, 'docs'), path.join(dir, 'README.md')]);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.hits, []);
});

test('markers in nested docs pages and in the README are reported with their file', () => {
  const dir = tree({ 'docs/a.md': '# A\n', 'docs/sub/b.md': '# B\nFIXME\n', 'README.md': 'TODO\n' });
  const r = checkPaths([path.join(dir, 'docs'), path.join(dir, 'README.md')]);
  assert.deepEqual(r.hits.map((h) => [path.relative(dir, h.file).split(path.sep).join('/'), h.line, h.word]), [
    ['docs/sub/b.md', 2, 'FIXME'],
    ['README.md', 1, 'TODO'],
  ]);
});
