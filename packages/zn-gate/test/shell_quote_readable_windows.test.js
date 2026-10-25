'use strict';

// readableWindowsCommand() turns the -EncodedCommand spelling of a
// windowsCommand() result into the readable -Command spelling and leaves
// every other command as it is.

const test = require('node:test');
const assert = require('node:assert/strict');

const sq = require('../lib/shell-quote');

const HEAD = sq.powershellExe() + ' -NoProfile -NonInteractive ';

test('an encoded windowsCommand() result comes back in the readable form', () => {
  const encoded = sq.windowsCommand('C:/example/zn.exe', ['run', 'a b'], [], { encoded: true });
  assert.ok(encoded.startsWith(HEAD + '-EncodedCommand '));
  const script = sq.windowsCommandScript(encoded);
  assert.equal(sq.readableWindowsCommand(encoded), HEAD + '-Command "' + script + '"');
  assert.ok(script.includes("'C:/example/zn.exe'"));
});

test('a command that does not start with the encoded prefix is returned unchanged', () => {
  const readable = sq.windowsCommand('C:/example/zn.exe', ['run']);
  assert.ok(readable.startsWith(HEAD + '-Command "'));
  assert.equal(sq.readableWindowsCommand(readable), readable);
  assert.equal(sq.readableWindowsCommand("echo 'hello'"), "echo 'hello'");
});

test('an encoded command that cannot be decoded is returned unchanged', () => {
  const bad = HEAD + '-EncodedCommand not*base64!';
  assert.equal(sq.windowsCommandScript(bad), null);
  assert.equal(sq.readableWindowsCommand(bad), bad);
});

test('empty, undefined and null give an empty string', () => {
  assert.equal(sq.readableWindowsCommand(''), '');
  assert.equal(sq.readableWindowsCommand(undefined), '');
  assert.equal(sq.readableWindowsCommand(null), '');
});
