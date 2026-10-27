'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { plainText, colorEnabled, styles, sym, ruleLine } = require('../lib/term');

const tty = { isTTY: true };
const pipe = { isTTY: false };

test('plainText: NO_COLOR with a value or TERM=dumb asks for plain text', () => {
  assert.strictEqual(plainText({ NO_COLOR: '1' }), true);
  assert.strictEqual(plainText({ TERM: 'dumb' }), true);
  assert.strictEqual(plainText({ NO_COLOR: '', TERM: 'xterm' }), false);
  assert.strictEqual(plainText({}), false);
  assert.strictEqual(plainText(undefined), false);
});

test('colorEnabled: needs a TTY and no plain-text request', () => {
  assert.strictEqual(colorEnabled(tty, {}), true);
  assert.strictEqual(colorEnabled(pipe, {}), false);
  assert.strictEqual(colorEnabled(undefined, {}), false);
  assert.strictEqual(colorEnabled({}, {}), false);
  assert.strictEqual(colorEnabled(tty, { NO_COLOR: '1' }), false);
  assert.strictEqual(colorEnabled(tty, { TERM: 'dumb' }), false);
});

test('styles: wraps text in ANSI codes on a TTY', () => {
  const t = styles(tty, {});
  assert.strictEqual(t.red('x'), '\x1b[31mx\x1b[0m');
  assert.strictEqual(t.green('x'), '\x1b[32mx\x1b[0m');
  assert.strictEqual(t.yellow('x'), '\x1b[33mx\x1b[0m');
  assert.strictEqual(t.gray('x'), '\x1b[90mx\x1b[0m');
});

test('styles: returns plain strings without a TTY or with NO_COLOR', () => {
  assert.strictEqual(styles(pipe, {}).red('x'), 'x');
  assert.strictEqual(styles(tty, { NO_COLOR: '1' }).red('x'), 'x');
  assert.strictEqual(styles(pipe, {}).green(42), '42');
});

test('sym: symbol with gap, colored by style, empty in plain text', () => {
  assert.strictEqual(sym({}, '✔'), '✔ ');
  assert.strictEqual(sym({}, '✔', null, '  '), '✔  ');
  assert.strictEqual(sym({}, '✔', (s) => '<' + s + '>'), '<✔> ');
  assert.strictEqual(sym({ NO_COLOR: '1' }, '✔'), '');
  assert.strictEqual(sym({ TERM: 'dumb' }, '✔', (s) => s), '');
});

test('ruleLine: box characters, or dashes in plain text', () => {
  assert.strictEqual(ruleLine({}, 4), '────');
  assert.strictEqual(ruleLine({ NO_COLOR: '1' }, 4), '----');
  assert.strictEqual(ruleLine({}, 0), '');
});
