'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMasker, variantsOf } = require('../lib/broker/mask');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('mask cores: a 7-byte value is caught at all three base64 alignments', () => {
  const value = 'abcdefg';
  const m = createMasker([{ name: 'SEVEN', value }]);
  for (const prefix of ['', 'x', 'xy']) {
    const blob = b64(prefix + value);
    const masked = m.maskText('out ' + blob + ' end');
    assert.ok(masked.includes('__ZN_SEVEN__'), 'prefix length ' + prefix.length);
    assert.ok(!masked.includes(blob.slice(4, 12)), 'prefix length ' + prefix.length);
  }
  const b64Variants = variantsOf(value).filter((v) => /^[A-Za-z0-9+/_-]+$/.test(v) && v !== value);
  assert.ok(b64Variants.length >= 3);
});

test('mask cores: a 6-byte value yields only the aligned base64 core', () => {
  const value = 'abcdef';
  const vs = variantsOf(value);
  assert.ok(vs.includes(b64(value)));
  assert.ok(!vs.includes(b64('x' + value).slice(2, 9)));
});

test('mask cores: an empty value has no variants and an empty masker passes text through', () => {
  assert.deepEqual(variantsOf(''), []);
  const m = createMasker([{ name: 'E', value: '' }]);
  assert.equal(m.size, 0);
  assert.equal(m.maskText('a.b*c'), 'a.b*c');
  assert.equal(m.stream().end().length, 0);
});

test('mask escape: regular expression characters in a value are matched literally', () => {
  const value = 'a.b*c+d?e^f${g}h(i)j|k[l]m\\n';
  const m = createMasker([{ name: 'RE', value }]);
  assert.equal(m.maskText('see ' + value + ' now'), 'see __ZN_RE__ now');
  const dotted = createMasker([{ name: 'DOT', value: 'abc.defgh' }]);
  assert.equal(dotted.maskText('abcXdefgh'), 'abcXdefgh');
  assert.equal(dotted.maskText('abc.defgh'), '__ZN_DOT__');
});

test('mask escape: a value made only of special characters is masked and does not throw', () => {
  const value = '.*+?^${}()|[]\\';
  const m = createMasker([{ name: 'SYM', value }]);
  assert.equal(m.maskText('<' + value + '>'), '<__ZN_SYM__>');
  assert.equal(m.maskText('plain'), 'plain');
});
