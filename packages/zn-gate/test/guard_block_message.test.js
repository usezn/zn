'use strict';
// blockMessage trims the trailing dots of a reason in linear time (a regex like /\.+$/ is
// polynomial on a long run of dots that does not end the string).

const test = require('node:test');
const assert = require('node:assert');
const { blockMessage } = require('../lib/guard');

test('a reason with trailing dots keeps one final dot', () => {
  const text = blockMessage({ reason: 'Bad input...', rule: 'r' }, 't');
  assert.ok(text.includes('Reason: Bad input (rule: r).'), text);
});

test('reasons made of dots, empty or with inner dots match the old trim', () => {
  const cases = ['a.', 'a...', '...', '', '.a.', 'a.b'];
  for (const reason of cases) {
    const want = reason.replace(/\.+$/, '');
    const text = blockMessage({ reason, rule: 'r' }, 't');
    if (want) assert.ok(text.includes(`Reason: ${want} (rule: r).`), reason + ' -> ' + text);
    else assert.ok(text.includes('Reason: the input matched rule r.'), reason + ' -> ' + text);
  }
});

test('a long run of dots before other text is handled in linear time', () => {
  const start = process.hrtime.bigint();
  const text = blockMessage({ reason: '.'.repeat(100000) + 'x', rule: 'r' }, 't');
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(text.includes('x (rule: r).'));
  assert.ok(ms < 200, `took ${ms} ms`);
});
