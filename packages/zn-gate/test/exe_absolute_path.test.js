'use strict';
process.env.ZN_STATS = 'off';

// absolutePath (lib/exe.js) keeps only the absolute entries of a PATH-style string, with the separator of the platform
// it is given. On the current platform it also drops entries in the project or in a node_modules folder; for another
// platform the rule is purely textual.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { absolutePath } = require('../lib/exe');
const { tempDir } = require('./helpers/tmp');

const notWindows = { skip: process.platform === 'win32' };
// A POSIX platform that is not the one running the tests, so only the textual rule applies.
const OTHER_POSIX = process.platform === 'freebsd' ? 'openbsd' : 'freebsd';

// A folder zn runs in and a separate home folder, both temporary, so the project rule has nothing real to look at.
function where(t) {
  return { cwd: tempDir(t, 'zn-abs-work-'), env: { HOME: tempDir(t, 'zn-abs-home-') } };
}

test('linux: only absolute entries are kept, joined with a colon', (t) => {
  const value = 'bin:/zn-example/usr/bin::/zn-example/opt/x';
  assert.equal(absolutePath(value, 'linux', where(t)), '/zn-example/usr/bin:/zn-example/opt/x');
  assert.equal(absolutePath('./bin:..:tools/', 'linux', where(t)), '');
});

test('win32: drive and UNC entries are kept, relative ones dropped, joined with a semicolon', notWindows, () => {
  const value = ['C:\\Tools', 'bin', '', '\\\\server\\share', '.\\local', 'd:/Example/bin', 'C:relative', '..'].join(';');
  assert.equal(absolutePath(value, 'win32'), 'C:\\Tools;\\\\server\\share;d:/Example/bin');
  assert.equal(absolutePath('/zn-example/bin', 'win32'), '', 'a POSIX path is not absolute on Windows');
});

test('an empty, undefined or null value gives an empty string', (t) => {
  for (const platform of ['linux', 'win32', OTHER_POSIX]) {
    const w = platform === process.platform ? where(t) : {};
    assert.equal(absolutePath('', platform, w), '');
    assert.equal(absolutePath(undefined, platform, w), '');
    assert.equal(absolutePath(null, platform, w), '');
  }
});

test('for another platform the rule is textual; on the current one project folders are dropped', notWindows, (t) => {
  const w = where(t);
  const inProject = path.join(w.cwd, 'bin');
  const modules = '/zn-example/app/node_modules/.bin';
  const value = [inProject, modules, '/zn-example/usr/bin', 'rel'].join(':');
  assert.equal(absolutePath(value, OTHER_POSIX, w), [inProject, modules, '/zn-example/usr/bin'].join(':'));
  assert.equal(absolutePath(value, process.platform, w), '/zn-example/usr/bin');
});
