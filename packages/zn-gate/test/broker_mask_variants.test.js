'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMasker, variantsOf } = require('../lib/broker/mask');

const VALUE = 'café pass word 42';

test('an empty value has no variants', () => {
  assert.deepEqual(variantsOf(''), []);
});

test('an empty value adds nothing to the masker', () => {
  const m = createMasker([{ name: 'EMPTY', value: '' }, { name: 'NONE', value: null }]);
  assert.equal(m.size, 0);
  assert.equal(m.maskText('plain text'), 'plain text');
});

test('a value with spaces and accents has base64, hex and URL forms', () => {
  const variants = variantsOf(VALUE);
  const buf = Buffer.from(VALUE, 'utf8');
  assert.ok(variants.includes(buf.toString('latin1')));
  assert.ok(variants.includes(buf.toString('base64')));
  assert.ok(variants.includes(buf.toString('hex')));
  assert.ok(variants.includes(buf.toString('hex').toUpperCase()));
  assert.ok(variants.includes(encodeURIComponent(VALUE)));
  assert.ok(variants.includes(encodeURIComponent(VALUE).replace(/%20/g, '+')));
});

test('each variant of the value is masked with its marker', () => {
  const m = createMasker([{ name: 'PW', value: VALUE }]);
  for (const v of variantsOf(VALUE)) {
    const text = Buffer.from('x=' + v + ';', 'latin1').toString('utf8');
    const out = m.maskText(text);
    assert.ok(out.includes('__ZN_PW__'), 'variant not masked: ' + v);
  }
});

test('masking twice changes nothing more', () => {
  const m = createMasker([{ name: 'PW', value: VALUE }]);
  const input = [
    'raw ' + VALUE,
    'b64 ' + Buffer.from(VALUE, 'utf8').toString('base64'),
    'hex ' + Buffer.from(VALUE, 'utf8').toString('hex'),
    'url ' + encodeURIComponent(VALUE),
  ].join('\n');
  const once = m.maskText(input);
  assert.ok(!once.includes('caf'));
  assert.equal(m.maskText(once), once);
});
