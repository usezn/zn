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

test('plainText: FORCE_COLOR does not change the answer', () => {
  assert.strictEqual(plainText({ FORCE_COLOR: '1' }), false);
  assert.strictEqual(plainText({ FORCE_COLOR: '1', NO_COLOR: '1' }), true);
  assert.strictEqual(plainText({ FORCE_COLOR: '1', TERM: 'dumb' }), true);
});

test('colorEnabled: FORCE_COLOR does not turn colors on without a terminal', () => {
  assert.strictEqual(colorEnabled(pipe, { FORCE_COLOR: '1' }), false);
  assert.strictEqual(colorEnabled(undefined, { FORCE_COLOR: '1' }), false);
  assert.strictEqual(colorEnabled(tty, { FORCE_COLOR: '1' }), true);
  assert.strictEqual(colorEnabled(tty, { FORCE_COLOR: '1', NO_COLOR: '1' }), false);
});

test('colorEnabled: a missing environment is treated as empty', () => {
  assert.strictEqual(colorEnabled(tty, undefined), true);
  assert.strictEqual(colorEnabled(pipe, undefined), false);
  assert.strictEqual(colorEnabled(null, {}), false);
  assert.strictEqual(colorEnabled({ isTTY: 'true' }, {}), false);
});

test('styles: no terminal gives plain text for every color, with FORCE_COLOR too', () => {
  for (const env of [{}, { FORCE_COLOR: '1' }, { NO_COLOR: '1', FORCE_COLOR: '1' }]) {
    for (const stream of [pipe, undefined, {}]) {
      const t = styles(stream, env);
      for (const name of ['red', 'green', 'yellow', 'gray']) {
        assert.strictEqual(t[name]('ok'), 'ok');
      }
    }
  }
});

test('styles: TERM=dumb on a terminal gives plain text', () => {
  assert.strictEqual(styles(tty, { TERM: 'dumb' }).yellow('x'), 'x');
  assert.strictEqual(styles(tty, { FORCE_COLOR: '1' }).yellow('x'), '\x1b[33mx\x1b[0m');
});

test('sym: FORCE_COLOR does not change symbols, NO_COLOR still wins', () => {
  assert.strictEqual(sym({ FORCE_COLOR: '1' }, '✔'), '✔ ');
  assert.strictEqual(sym({ FORCE_COLOR: '1', NO_COLOR: '1' }, '✔'), '');
  assert.strictEqual(sym({ NO_COLOR: '1' }, '✔', null, '  '), '');
});

test('sym: an undefined environment and an empty gap', () => {
  assert.strictEqual(sym(undefined, '✔'), '✔ ');
  assert.strictEqual(sym({}, '✔', null, ''), '✔');
});

test('ruleLine: narrow widths and plain text', () => {
  assert.strictEqual(ruleLine({}, 1), '─');
  assert.strictEqual(ruleLine({ NO_COLOR: '1' }, 1), '-');
  assert.strictEqual(ruleLine({ NO_COLOR: '1' }, 0), '');
  assert.strictEqual(ruleLine({ TERM: 'dumb' }, 3), '---');
  assert.strictEqual(ruleLine({ FORCE_COLOR: '1' }, 2), '──');
  assert.strictEqual(ruleLine(undefined, 2), '──');
});

test('ruleLine: a negative width is rejected', () => {
  assert.throws(() => ruleLine({}, -1), RangeError);
});
