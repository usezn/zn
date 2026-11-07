'use strict';
process.env.ZN_STATS = 'off';
// Exact wording of describeFsError and writableFix for the cases the other launcher message tests do not pin down.
const test = require('node:test');
const assert = require('node:assert/strict');
const launcher = require('../lib/agents/launcher');

const { describeFsError, writableFix } = launcher;

test('describeFsError: ELOOP says the links lead in a circle', () => {
  assert.equal(describeFsError({ code: 'ELOOP' }, '/example/loop'), 'the links at /example/loop lead in a circle');
});

test('describeFsError: EPERM is worded like EACCES', () => {
  assert.equal(describeFsError({ code: 'EPERM' }, '/example/p'), describeFsError({ code: 'EACCES' }, '/example/p'));
  assert.equal(describeFsError({ code: 'EACCES' }, '/example/p'), 'you are not allowed to read or create /example/p');
});

test('describeFsError: ENOENT and ENOTDIR full sentences', () => {
  assert.equal(describeFsError({ code: 'ENOTDIR' }, '/example/f'), '/example/f is a file, not a folder, so nothing can be created in or below it');
  assert.equal(describeFsError({ code: 'ENOENT' }, '/example/m'), 'the folder /example/m does not exist (or it was removed while zn was checking it)');
});

test('describeFsError: a missing code or error still gives a sentence naming the path', () => {
  assert.equal(describeFsError({}, '/example/x'), 'the system refused to use /example/x (unknown error)');
  assert.equal(describeFsError(null, '/example/x'), 'the system refused to use /example/x (unknown error)');
  assert.equal(describeFsError(undefined, '/example/x'), 'the system refused to use /example/x (unknown error)');
});

test('describeFsError: wording for the four codes never shows the raw code', () => {
  for (const code of ['ENOENT', 'EACCES', 'ENOTDIR', 'ELOOP']) {
    assert.ok(!describeFsError({ code }, '/example/d').includes(code), code);
  }
});

test('writableFix: a sticky folder gets no command, even when you own it or it belongs to root', () => {
  const expected = '/example/shared is a shared folder (sticky bit), so do not change it; choose a folder somewhere else.';
  assert.equal(writableFix('/example/shared', { uid: 1000, mode: 0o41777 }, 1000), expected);
  assert.equal(writableFix('/example/shared', { uid: 0, mode: 0o41777 }, 1000), expected);
  assert.equal(writableFix('/example/shared', { uid: 0, mode: 0o41777 }, null), expected);
});

test('writableFix: your own folder gets chmod without sudo, and a path with a space is quoted', () => {
  assert.equal(writableFix('/example/mine', { uid: 1000, mode: 0o40777 }, 1000), 'To close it, run `chmod g-w,o-w /example/mine`.');
  assert.equal(writableFix('/example/my dir', { uid: 1000, mode: 0o40775 }, 1000), "To close it, run `chmod g-w,o-w '/example/my dir'`.");
});

test('writableFix: a root folder names sudo and suggests another folder', () => {
  assert.equal(
    writableFix('/example/rootdir', { uid: 0, mode: 0o40775 }, 1000),
    '/example/rootdir belongs to root, so closing it takes administrator rights (`sudo chmod g-w,o-w /example/rootdir`), and other users of this machine may rely on it being shared; the safer way is to choose another folder.'
  );
  assert.match(writableFix('/example/my dir', { uid: 0, mode: 0o40775 }, 1000), /`sudo chmod g-w,o-w '\/example\/my dir'`/);
});

test('writableFix: when the current user is unknown, a folder is never treated as your own', () => {
  assert.match(writableFix('/example/x', { uid: 1000, mode: 0o40775 }, null), /belongs to another user/);
  assert.match(writableFix('/example/x', { uid: 0, mode: 0o40775 }, null), /belongs to root/);
});
