'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SEED_DEFAULT,
  SECRET_TYPES,
  PII_TYPES,
  generateAll,
  validate,
  luhnValid,
  ibanValid,
} = require('./fixtures/fake_secrets');

test('fake_secrets - 30 secret types and 6 PII types', () => {
  assert.equal(SECRET_TYPES.length, 30);
  assert.equal(PII_TYPES.length, 6);
});

test('fake_secrets - deterministic for a fixed seed', () => {
  const a = generateAll(SEED_DEFAULT, { perType: 2, piiPerType: 2 });
  const b = generateAll(SEED_DEFAULT, { perType: 2, piiPerType: 2 });
  assert.deepEqual(a, b);
  const c = generateAll(SEED_DEFAULT + 1, { perType: 2, piiPerType: 2 });
  assert.notDeepEqual(a, c);
});

test('fake_secrets - every generated value matches its format and checksum', () => {
  const data = generateAll(SEED_DEFAULT, { perType: 3, piiPerType: 3 });
  assert.equal(data.secrets.length, SECRET_TYPES.length * 3);
  assert.equal(data.pii.length, PII_TYPES.length * 3);
  for (const entry of [...data.secrets, ...data.pii]) {
    assert.equal(validate(entry), null, entry.type + ': ' + entry.value.slice(0, 16));
    assert.ok(entry.sensitive.length >= 8, entry.type + ' sensitive too short');
    assert.ok(entry.value.includes(entry.sensitive), entry.type + ' sensitive not in value');
  }
});

test('fake_secrets - values are unique within a generated batch', () => {
  const data = generateAll(SEED_DEFAULT, { perType: 4, piiPerType: 4 });
  const seen = new Set();
  for (const entry of [...data.secrets, ...data.pii]) {
    const key = entry.type + ':' + entry.value;
    assert.ok(!seen.has(key), 'duplicate value for ' + entry.type);
    seen.add(key);
  }
});

test('fake_secrets - checksum primitives agree with known vectors', () => {
  assert.equal(luhnValid('4242424242424242'), true);
  assert.equal(luhnValid('378282246310005'), true);
  assert.equal(luhnValid('4242424242424241'), false);

  const data = generateAll(SEED_DEFAULT);
  const iban = data.pii.find((p) => p.type === 'iban').value;
  assert.equal(ibanValid(iban), true);
  const mutated = iban.slice(0, -1) + String((Number(iban.slice(-1)) + 1) % 10);
  assert.equal(ibanValid(mutated), false);

  assert.equal(validate({ type: 'dni', value: '12345678Z' }), null);
  assert.notEqual(validate({ type: 'dni', value: '12345678A' }), null);
  assert.equal(validate({ type: 'nie', value: 'X0000000T' }), null);
});
