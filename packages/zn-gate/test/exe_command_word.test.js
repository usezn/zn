'use strict';
process.env.ZN_STATS = 'off';

// commandWord picks the program name out of a typed command; hasPathSeparator tells a path from a bare name.

const test = require('node:test');
const assert = require('node:assert/strict');
const { commandWord, hasPathSeparator } = require('../lib/exe');

test('commandWord returns the first word of a plain command', () => {
  assert.equal(commandWord('git status'), 'git');
  assert.equal(commandWord('ls'), 'ls');
});

test('commandWord skips leading NAME=value assignments', () => {
  assert.equal(commandWord('FOO=bar prog arg'), 'prog');
  assert.equal(commandWord('A=1 _B2=two prog'), 'prog');
  assert.equal(commandWord('EMPTY= prog'), 'prog');
});

test('commandWord does not treat later or malformed words as assignments', () => {
  assert.equal(commandWord('prog FOO=bar'), 'prog');
  assert.equal(commandWord('1A=x prog'), '1A=x');
  assert.equal(commandWord('=x prog'), '=x');
  assert.equal(commandWord('a-b=x prog'), 'a-b=x');
});

test('commandWord removes quotes around the program name', () => {
  assert.equal(commandWord('"prog" arg'), 'prog');
  assert.equal(commandWord("'prog' arg"), 'prog');
  assert.equal(commandWord('FOO=bar "prog" arg'), 'prog');
  assert.equal(commandWord('"/opt/example/prog" arg'), '/opt/example/prog');
});

test('commandWord strips a lone quote at either end', () => {
  assert.equal(commandWord('"prog arg'), 'prog');
  assert.equal(commandWord('prog" arg'), 'prog');
});

test('commandWord splits at whitespace even inside quotes', () => {
  assert.equal(commandWord('"my prog" arg'), 'my');
});

test('commandWord handles tabs and extra blanks', () => {
  assert.equal(commandWord('  \t prog \t arg'), 'prog');
  assert.equal(commandWord('FOO=bar \t  A=1\t\tprog'), 'prog');
  assert.equal(commandWord('\n prog'), 'prog');
});

test('commandWord returns an empty string when there is no program', () => {
  assert.equal(commandWord('FOO=bar'), '');
  assert.equal(commandWord('A=1 B=2   C=3'), '');
  assert.equal(commandWord(''), '');
  assert.equal(commandWord('   \t '), '');
  assert.equal(commandWord(null), '');
  assert.equal(commandWord(undefined), '');
});

test('hasPathSeparator detects a slash or a backslash', () => {
  assert.equal(hasPathSeparator('/usr/bin/prog'), true);
  assert.equal(hasPathSeparator('dir/prog'), true);
  assert.equal(hasPathSeparator('C:\\example\\prog.exe'), true);
  assert.equal(hasPathSeparator('dir\\prog'), true);
});

test('hasPathSeparator is false for a plain name', () => {
  assert.equal(hasPathSeparator('prog'), false);
  assert.equal(hasPathSeparator('prog.exe'), false);
  assert.equal(hasPathSeparator('python3.12'), false);
});

test('hasPathSeparator counts a leading dot only with a separator', () => {
  assert.equal(hasPathSeparator('.prog'), false);
  assert.equal(hasPathSeparator('.'), false);
  assert.equal(hasPathSeparator('./prog'), true);
  assert.equal(hasPathSeparator('..\\prog'), true);
});

test('hasPathSeparator is false for empty, null and undefined', () => {
  assert.equal(hasPathSeparator(''), false);
  assert.equal(hasPathSeparator(null), false);
  assert.equal(hasPathSeparator(undefined), false);
});
