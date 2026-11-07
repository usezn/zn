'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const { getAdapter } = require('../lib/agents');
const { tempDir } = require('./helpers/tmp');

const { pathsOf } = getAdapter('gemini');

test('pathsOf reads a nested key that names a path', () => {
  const r = pathsOf({ options: { target_file: '/work/example/a.txt' } });
  assert.deepEqual(r, { paths: ['/work/example/a.txt'], bad: false });
});

test('pathsOf reads a path key inside objects in a list', () => {
  const r = pathsOf({ edits: [{ file_path: '/work/example/one.txt' }, { file_path: '/work/example/two.txt' }] });
  assert.deepEqual(r.paths, ['/work/example/one.txt', '/work/example/two.txt']);
  assert.equal(r.bad, false);
});

test('pathsOf ignores a nested key that does not name a path', () => {
  const r = pathsOf({ options: { mode: '/work/example/a.txt', note: 'hello' } });
  assert.deepEqual(r, { paths: [], bad: false });
});

test('pathsOf ignores a content-like key even when it also looks like a path key', () => {
  const r = pathsOf({ nested: { file_content: '/work/example/a.txt' } });
  assert.deepEqual(r, { paths: [], bad: false });
});

test('pathsOf turns a nested file: URL into a path', (t) => {
  const dir = tempDir(t, 'zn-gem-paths-');
  const file = path.join(dir, 'notes.txt');
  const r = pathsOf({ options: { uri: pathToFileURL(file).href } });
  assert.deepEqual(r, { paths: [file], bad: false });
});

test('pathsOf marks a broken nested file: URL as bad and adds no path', () => {
  const r = pathsOf({ options: { uri: 'file:///%zz' } });
  assert.deepEqual(r, { paths: [], bad: true });
});

test('pathsOf leaves out a nested value with a line break', () => {
  const r = pathsOf({ options: { file_path: '/work/example/a.txt\n/work/example/b.txt', dir_path: '/work/example/c\rd' } });
  assert.deepEqual(r, { paths: [], bad: false });
});

test('pathsOf leaves out a nested value over the length limit and keeps one at the limit', () => {
  const atLimit = '/' + 'a'.repeat(4095);
  const tooLong = '/' + 'a'.repeat(4096);
  const r = pathsOf({ options: { file_path: tooLong, dir_path: atLimit } });
  assert.deepEqual(r, { paths: [atLimit], bad: false });
});
