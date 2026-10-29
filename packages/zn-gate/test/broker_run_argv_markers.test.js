'use strict';

// argvMarkers (lib/broker/run.js): the secret names written in a parsed command's arguments.
// Fictitious names only.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRunArgs, argvMarkers } = require('../lib/broker/run');

const names = (...command) => argvMarkers(parseRunArgs(['--', ...command]));

test('a command with no marker has no argument markers', () => {
  assert.deepEqual(names('echo', 'hello', '--flag=1'), []);
  assert.deepEqual(names('echo'), []);
});

test('one marker is reported once by its name', () => {
  assert.deepEqual(names('tool', '__ZN_DB_PASSWORD__'), ['DB_PASSWORD']);
});

test('the same marker twice is reported once', () => {
  assert.deepEqual(names('tool', '__ZN_TOKEN_A__', '__ZN_TOKEN_A__'), ['TOKEN_A']);
  assert.deepEqual(names('tool', '__ZN_TOKEN_A__ and __ZN_TOKEN_A__'), ['TOKEN_A']);
});

test('a marker inside a quoted argument is found', () => {
  assert.deepEqual(names('sh', '-c', 'echo "__ZN_API_KEY__"'), ['API_KEY']);
  assert.deepEqual(names('tool', "--header='Authorization: __ZN_API_KEY__'"), ['API_KEY']);
});

test('secrets named with --secrets are not argument markers', () => {
  assert.deepEqual(argvMarkers(parseRunArgs(['--secrets', 'DB_PASSWORD', '--', 'tool', 'plain'])), []);
});
