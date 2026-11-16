'use strict';
/*
 * Gemini adapter: the fixed system settings path and the paths read from
 * tool arguments (a string, a list, a missing key, a non-string value).
 * Only fake values are used; no file is read or written.
 */
process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../lib/agents/gemini');

test('systemSettingsFile returns the fixed system path, whatever it is given', () => {
  assert.equal(gemini.systemSettingsFile(), '/etc/gemini-cli/settings.json');
  assert.equal(gemini.systemSettingsFile({ home: '/tmp/example-home', scope: 'project' }), '/etc/gemini-cli/settings.json');
});

test('pathsOf reads a path given as a string', () => {
  assert.deepEqual(gemini.pathsOf({ file_path: '/work/example/a.txt' }), { paths: ['/work/example/a.txt'], bad: false });
});

test('pathsOf reads every string of a list', () => {
  const r = gemini.pathsOf({ include: ['a.txt', 'b.txt', 7, '', null] });
  assert.deepEqual(r, { paths: ['a.txt', 'b.txt'], bad: false });
});

test('pathsOf finds nothing when no key names a path', () => {
  assert.deepEqual(gemini.pathsOf({}), { paths: [], bad: false });
  assert.deepEqual(gemini.pathsOf({ command: 'ls', content: '/work/example/a.txt' }), { paths: [], bad: false });
});

test('pathsOf ignores a value that is not a string', () => {
  const r = gemini.pathsOf({ file_path: 42, dir_path: true, source: null, target: { x: 1 } });
  assert.deepEqual(r, { paths: [], bad: false });
});
