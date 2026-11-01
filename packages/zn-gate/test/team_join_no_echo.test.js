'use strict';
/*
 * `zn team join -` on a terminal: the token is read with the echo switched off, and the terminal mode is put back on
 * every way out (Enter, Ctrl-D, Ctrl-C, end of input, a read error, SIGINT, process exit). A fake TTY stream stands in
 * for the terminal. Without a terminal the line is read as it is.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { readStdinToken } = require('../lib/team/cli');

const TOKEN = 'znj_EXAMPLE_NOT_A_REAL_TOKEN_000000';

function fakeTty() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.isRaw = false;
  s.modes = [];
  s.setRawMode = (m) => { s.modes.push(m); s.isRaw = m; };
  s.resume = () => {};
  s.pause = () => {};
  s.type = (text) => s.emit('data', Buffer.from(text, 'utf8'));
  return s;
}

function fakeOutput() {
  return { text: '', write(s) { this.text += s; return true; } };
}

// Echo is off while reading and the mode the terminal had before is back afterwards.
function assertEchoOffThenRestored(s) {
  assert.deepStrictEqual(s.modes, [true, false]);
  assert.strictEqual(s.isRaw, false);
  assert.strictEqual(s.listenerCount('data'), 0);
  assert.strictEqual(s.listenerCount('end'), 0);
  assert.strictEqual(s.listenerCount('error'), 0);
}

test('typed token + Enter: echo off while reading, restored after success, token never written', async () => {
  const s = fakeTty();
  const out = fakeOutput();
  const p = readStdinToken(s, out);
  assert.deepStrictEqual(s.modes, [true]);
  s.type(TOKEN + '\r');
  assert.strictEqual(await p, TOKEN);
  assertEchoOffThenRestored(s);
  assert.ok(!out.text.includes(TOKEN), 'token must not be printed');
  assert.match(out.text, /Paste the join token and press Enter:/);
});

test('pasted text with a trailing newline and blank lines first: first non-empty line wins', async () => {
  const s = fakeTty();
  const out = fakeOutput();
  const p = readStdinToken(s, out);
  s.type('\r\n   \n  ' + TOKEN + '  \nsecond-line-ignored\n');
  assert.strictEqual(await p, TOKEN);
  assertEchoOffThenRestored(s);
  assert.ok(!out.text.includes(TOKEN));
});

test('Backspace removes the last typed character; arrow keys are ignored', async () => {
  const s = fakeTty();
  const p = readStdinToken(s, fakeOutput());
  s.type('abc\x7fd\x1b[D\x1bOA\r');
  assert.strictEqual(await p, 'abd');
  assertEchoOffThenRestored(s);
});

test('Ctrl-C gives up: resolves empty, mode restored, nothing is read', async () => {
  const s = fakeTty();
  const out = fakeOutput();
  const p = readStdinToken(s, out);
  s.type(TOKEN.slice(0, 10) + '\x03');
  assert.strictEqual(await p, '');
  assertEchoOffThenRestored(s);
  assert.ok(!out.text.includes(TOKEN));
});

test('Ctrl-D ends the input with what was typed', async () => {
  const s = fakeTty();
  const p = readStdinToken(s, fakeOutput());
  s.type(TOKEN + '\x04');
  assert.strictEqual(await p, TOKEN);
  assertEchoOffThenRestored(s);
});

test('end of input without Enter: resolves empty and restores the mode', async () => {
  const s = fakeTty();
  const p = readStdinToken(s, fakeOutput());
  s.type(TOKEN.slice(0, 8));
  s.emit('end');
  assert.strictEqual(await p, '');
  assertEchoOffThenRestored(s);
});

test('read error: resolves empty and restores the mode', async () => {
  const s = fakeTty();
  const p = readStdinToken(s, fakeOutput());
  s.emit('error', new Error('simulated read failure'));
  assert.strictEqual(await p, '');
  assertEchoOffThenRestored(s);
});

test('SIGINT from outside: resolves empty and restores the mode, the SIGINT listener is removed', async () => {
  const s = fakeTty();
  const before = process.listenerCount('SIGINT');
  const p = readStdinToken(s, fakeOutput());
  assert.strictEqual(process.listenerCount('SIGINT'), before + 1);
  process.emit('SIGINT');
  assert.strictEqual(await p, '');
  assertEchoOffThenRestored(s);
  assert.strictEqual(process.listenerCount('SIGINT'), before);
});

test('process exit while waiting: the terminal mode is restored by the exit hook', async () => {
  const s = fakeTty();
  const p = readStdinToken(s, fakeOutput());
  assert.deepStrictEqual(s.modes, [true]);
  process.emit('exit', 0);
  assert.deepStrictEqual(s.modes, [true, false]);
  s.emit('end'); // let the read finish so no listener is left behind
  await p;
  assert.strictEqual(s.isRaw, false);
});

test('a terminal that refuses raw mode: fails closed, reads nothing, says to pipe the token', async () => {
  const s = fakeTty();
  s.setRawMode = () => { throw new Error('simulated: no raw mode'); };
  const out = fakeOutput();
  const v = await readStdinToken(s, out);
  assert.strictEqual(v, '');
  assert.strictEqual(s.listenerCount('data'), 0);
  assert.match(out.text, /Pipe the token in instead/);
});

test('not a terminal: the first non-empty line of standard input is read as it is', async () => {
  const p = new PassThrough();
  p.isTTY = false;
  const out = fakeOutput();
  const v = readStdinToken(p, out);
  p.end('\n   \n  ' + TOKEN + '  \nnext\n');
  assert.strictEqual(await v, TOKEN);
  assert.strictEqual(out.text, '', 'no prompt when standard input is not a terminal');
});

test('not a terminal and nothing on standard input: resolves empty', async () => {
  const p = new PassThrough();
  p.isTTY = false;
  const v = readStdinToken(p, fakeOutput());
  p.end();
  assert.strictEqual(await v, '');
});
