'use strict';
// Symbols follow the stream a line is written to. A line written to stderr gets
// emoji and box-drawing characters only when stderr itself is a terminal, even
// when stdout is one. Callers that write to stderr must pass process.stderr.

const test = require('node:test');
const assert = require('node:assert');
const { sym, ruleLine } = require('../lib/term');

const tty = { isTTY: true };
const pipe = { isTTY: false };
const SYMBOLS = /[\u{1F6E1}\u{1F512}✔✖○↳─]/u;

test('stdout is a terminal, stderr is piped: a stderr line has no emoji or box characters', () => {
  const streams = { stdout: tty, stderr: pipe };
  const line = sym({}, '✖', null, ' ', streams.stderr) + 'Tamper detected: bad link';
  assert.strictEqual(line, '[x] Tamper detected: bad link');
  assert.doesNotMatch(line, SYMBOLS);
  assert.strictEqual(sym({}, '\u{1F6E1}️', undefined, '  ', streams.stderr), '[+]  ');
  assert.strictEqual(sym({}, '\u{1F512}', undefined, ' ', streams.stderr), '[ok] ');
  assert.strictEqual(ruleLine({}, 5, streams.stderr), '-----');
});

test('both stdout and stderr are terminals: stderr lines keep the symbols as before', () => {
  assert.strictEqual(sym({}, '✖', null, ' ', tty), '✖ ');
  assert.strictEqual(sym({}, '\u{1F6E1}️', undefined, '  ', tty), '\u{1F6E1}️  ');
  assert.strictEqual(ruleLine({}, 3, tty), '───');
});

test('the stream written to decides: a terminal stderr gets symbols even when stdout is piped', () => {
  assert.strictEqual(sym({}, '✔', null, ' ', tty), '✔ ');
  assert.strictEqual(ruleLine({}, 2, tty), '──');
  assert.strictEqual(sym({}, '✔', null, ' ', pipe), '[ok] ');
});

test('without a stream argument, sym and ruleLine use process.stdout as before', () => {
  const on = process.stdout.isTTY === true;
  assert.strictEqual(sym({}, '✔'), on ? '✔ ' : '[ok] ');
  assert.strictEqual(ruleLine({}, 3), on ? '───' : '---');
});

test('NO_COLOR, TERM=dumb and CI still turn symbols off on a stderr terminal', () => {
  assert.strictEqual(sym({ NO_COLOR: '1' }, '✖', null, ' ', tty), '[x] ');
  assert.strictEqual(sym({ TERM: 'dumb' }, '✖', null, ' ', tty), '[x] ');
  assert.strictEqual(sym({ CI: 'true' }, '✖', null, ' ', tty), '[x] ');
  assert.strictEqual(ruleLine({ NO_COLOR: '1' }, 3, tty), '---');
  assert.strictEqual(ruleLine({ TERM: 'dumb' }, 3, tty), '---');
  assert.strictEqual(ruleLine({ CI: 'true' }, 3, tty), '---');
});

test('an empty NO_COLOR does not turn symbols off on a stderr terminal', () => {
  assert.strictEqual(sym({ NO_COLOR: '' }, '✖', null, ' ', tty), '✖ ');
});
