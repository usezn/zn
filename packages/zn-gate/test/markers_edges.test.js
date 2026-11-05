'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/broker/markers');

test('findNamedMarkers returns an empty list for non-string input', () => {
  for (const v of [undefined, null, 42, {}, [], true]) {
    assert.deepEqual(m.findNamedMarkers(v), []);
  }
});

test('findNamedMarkers returns an empty list for empty text and text without markers', () => {
  assert.deepEqual(m.findNamedMarkers(''), []);
  assert.deepEqual(m.findNamedMarkers('plain text __ZN_ only'), []);
});

test('findNamedMarkers ignores malformed markers', () => {
  assert.deepEqual(m.findNamedMarkers('__ZN___'), []);
  assert.deepEqual(m.findNamedMarkers('__ZN_a__'), []);
  assert.deepEqual(m.findNamedMarkers('__ZN_1ABC__'), []);
  assert.deepEqual(m.findNamedMarkers('__ZN_ABC_'), []);
});

test('findNamedMarkers deduplicates and keeps first-seen order', () => {
  const r = m.findNamedMarkers('__ZN_B__ __ZN_A__ __ZN_B__ __ZN_C_2__ __ZN_A__');
  assert.deepEqual(r.map((x) => x.name), ['B', 'A']);
  assert.deepEqual(r[0], { marker: '__ZN_B__', name: 'B', detected: false });
});

test('findNamedMarkers drops every detected marker, including single-digit and long ones', () => {
  assert.deepEqual(m.findNamedMarkers('__ZN_AWS_KEY_1__ __ZN_X_123456__ __ZN_A1__').map((x) => x.name), ['A1']);
});

test('findNamedMarkers finds markers next to other text and each other', () => {
  const names = m.findNamedMarkers('x__ZN_A__y=__ZN_B__').map((x) => x.name);
  assert.deepEqual(names, ['A', 'B']);
});

test('findNamedMarkers is stable across repeated calls', () => {
  const t = '__ZN_A__ __ZN_B__';
  assert.deepEqual(m.findNamedMarkers(t), m.findNamedMarkers(t));
});

test('markerFor wraps any value without validating it', () => {
  assert.equal(m.markerFor(''), '__ZN___');
  assert.equal(m.markerFor('lower case'), '__ZN_lower case__');
  assert.equal(m.markerFor(undefined), '__ZN_undefined__');
  assert.equal(m.markerFor(null), '__ZN_null__');
  assert.equal(m.markerFor(7), '__ZN_7__');
});

test('markerFor output for a valid name is found again, for an invalid name it is not', () => {
  assert.deepEqual(m.findNamedMarkers(m.markerFor('A')).map((x) => x.name), ['A']);
  assert.deepEqual(m.findNamedMarkers(m.markerFor('a')), []);
  assert.deepEqual(m.findNamedMarkers(m.markerFor('')), []);
  assert.deepEqual(m.findNamedMarkers(m.markerFor('A_1')), []);
});
