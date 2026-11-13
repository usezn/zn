'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMasker, variantsOf } = require('../lib/broker/mask');

test('mask: an empty value adds nothing and leaves text unchanged', () => {
  assert.deepEqual(variantsOf(''), []);
  const m = createMasker([{ name: 'EMPTY', value: '' }, { name: 'NONE', value: null }]);
  assert.equal(m.size, 0);
  assert.equal(m.maskText('plain text'), 'plain text');
  assert.equal(m.stream().write(Buffer.from('abc')).toString(), 'abc');
});

test('mask: a short value is masked as raw text only', () => {
  const m = createMasker([{ name: 'SHORT', value: 'ab1' }]);
  assert.equal(m.maskText('x ab1 y'), 'x __ZN_SHORT__ y');
  assert.ok(variantsOf('ab1').every((v) => v.length >= 3));
});

test('mask: a long value is masked in raw, hex and base64 forms', () => {
  const v = 'fake-long-value--' + 'q1w2e3r4'.repeat(8);
  const m = createMasker([{ name: 'LONG', value: v }]);
  const hex = Buffer.from(v).toString('hex');
  const b64 = Buffer.from(v).toString('base64');
  for (const form of [v, hex, b64]) {
    assert.equal(m.maskText('a ' + form + ' b'), 'a __ZN_LONG__ b');
  }
});

test('mask: a repeated-character value is masked as a whole', () => {
  const v = 'abababababababab';
  const m = createMasker([{ name: 'REP', value: v }]);
  assert.equal(m.maskText('<' + v + '>'), '<__ZN_REP__>');
  assert.equal(m.maskText('<' + v + v + '>'), '<__ZN_REP____ZN_REP__>');
});

test('mask: a non-ASCII value is masked in text and in a stream', () => {
  const v = 'pässwörd-日本語-fake';
  const m = createMasker([{ name: 'UNI', value: v }]);
  assert.equal(m.maskText('x ' + v + ' y'), 'x __ZN_UNI__ y');
  const enc = encodeURIComponent(v);
  assert.equal(m.maskText('q=' + enc), 'q=__ZN_UNI__');
  const s = m.stream();
  const buf = Buffer.from('x ' + v + ' y');
  const out = Buffer.concat([s.write(buf.subarray(0, 9)), s.write(buf.subarray(9)), s.end()]);
  assert.equal(out.toString('utf8'), 'x __ZN_UNI__ y');
});

test('mask: a value that appears twice in one line is masked both times', () => {
  const v = 'fake-secret-value-1';
  const m = createMasker([{ name: 'TWICE', value: v }]);
  assert.equal(m.maskText(v + ' and ' + v), '__ZN_TWICE__ and __ZN_TWICE__');
  const s = m.stream();
  const line = Buffer.from('a=' + v + ' b=' + v + '\n');
  const out = Buffer.concat([s.write(line.subarray(0, 10)), s.write(line.subarray(10)), s.end()]);
  assert.equal(out.toString(), 'a=__ZN_TWICE__ b=__ZN_TWICE__\n');
});
