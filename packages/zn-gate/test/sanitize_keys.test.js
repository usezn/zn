'use strict';
/** The library API sanitizeToolResult redacts secrets used as object keys, like values, and no value is lost. Fake values only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeToolResult } = require('../lib/rules');
const { guardTool } = require('../lib/guard');

const A = 'AKIA' + 'IOSFODNN7EXAMPLE';
const B = 'AKIA' + 'IOSFODNN7EXAMPLF';
const C = 'sk-test-FAKE' + '0123456789abcdefghijkl';
const san = (v) => sanitizeToolResult(v);

test('a secret as a key is redacted and the value kept', () => {
  const { sanitized, detections } = san({ [A]: 'v' });
  assert.ok(!JSON.stringify(sanitized).includes(A));
  assert.deepEqual(Object.values(sanitized), ['v']);
  assert.ok(detections.length >= 1);
});

test('two keys with different secrets keep both values', () => {
  const { sanitized } = san({ [A]: 'first', [B]: 'second', plain: 'x' });
  assert.equal(Object.keys(sanitized).length, 3);
  assert.deepEqual(Object.values(sanitized).sort(), ['first', 'second', 'x']);
  assert.ok(!JSON.stringify(sanitized).includes(A) && !JSON.stringify(sanitized).includes(B));
  assert.equal(sanitized.plain, 'x');
});

test('a masked key next to a clean key with the same text keeps both values', () => {
  const masked = Object.keys(san({ [A]: 1 }).sanitized)[0];
  assert.notEqual(masked, A);
  const { sanitized } = san({ [masked]: 'clean', [A]: 'secret' });
  assert.equal(sanitized[masked], 'clean');
  assert.deepEqual(Object.values(sanitized).sort(), ['clean', 'secret']);
  assert.ok(!JSON.stringify(sanitized).includes(A));
});

test('three secrets in one object are numbered', () => {
  const { sanitized } = san({ [A]: 1, [B]: 2, [C]: 3 });
  assert.equal(Object.keys(sanitized).length, 3);
  assert.ok(Object.keys(sanitized).some((k) => / #2$/.test(k)));
});

test('nested objects and arrays of objects are covered', () => {
  const { sanitized } = san({ o: { [A]: 1, [B]: 2 }, l: [{ [A]: 3, [B]: 4 }] });
  assert.deepEqual(Object.values(sanitized.o).sort(), [1, 2]);
  assert.deepEqual(Object.values(sanitized.l[0]).sort(), [3, 4]);
  assert.ok(!JSON.stringify(sanitized).includes(A));
});

test('input without secrets is unchanged, key order included', () => {
  const d = { b: 1, a: [1, { c: 'x' }], z: null, 3: 'n' };
  const { sanitized, detections } = san(d);
  assert.deepEqual(sanitized, d);
  assert.deepEqual(Object.keys(sanitized), Object.keys(d));
  assert.equal(detections.length, 0);
});

test('a __proto__ key stays an own property and never sets the prototype', () => {
  const input = JSON.parse('{"__proto__": {"polluted": "yes"}, "' + A + '": "v"}');
  const { sanitized } = san(input);
  assert.equal(Object.getPrototypeOf(sanitized), Object.prototype);
  assert.equal(sanitized.polluted, undefined);
  assert.ok(Object.prototype.hasOwnProperty.call(sanitized, '__proto__'));
  assert.equal(Object.keys(sanitized).length, 2);
});

test('guardTool maskSecrets redacts a secret used as a key of the result', () => {
  const g = guardTool(() => ({ [A]: 'one', [B]: 'two' }), { maskSecrets: true });
  const out = g();
  assert.ok(!JSON.stringify(out).includes(A) && !JSON.stringify(out).includes(B));
  assert.deepEqual(Object.values(out).sort(), ['one', 'two']);
});
