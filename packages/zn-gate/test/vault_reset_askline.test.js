'use strict';
// zn vault reset asks for the confirmation phrase on a terminal: askLine reads one line from the input and writes the
// question. Streams stand in for the terminal; nothing touches a vault.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('stream');
const reset = require('../lib/vault/reset');

function terminal(text) {
  const input = new PassThrough();
  input.isTTY = true;
  const written = [];
  const output = new Writable({ write(chunk, _enc, cb) { written.push(String(chunk)); cb(); } });
  input.end(text);
  return { io: { stdin: input, stderr: output }, written };
}

test('askLine returns the first line typed and writes the question first', async () => {
  const term = terminal('reset my vault\nsecond line is ignored\n');
  assert.equal(await reset.askLine('To go on: ', term.io), 'reset my vault');
  assert.deepEqual(term.written, ['To go on: ']);
});

test('askLine answers an empty string when the input ends without a line', async () => {
  const term = terminal('');
  assert.equal(await reset.askLine('To go on: ', term.io), '');
});

test('askLine keeps a last line that has no newline', async () => {
  const term = terminal('no');
  assert.equal(await reset.askLine('To go on: ', term.io), 'no');
});
